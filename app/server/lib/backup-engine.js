// backup-engine.js：v1.1.0 动态存储路径 + 分类归档 + 下载/导入/健康状态
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const validators = require('./validators');
const storage = require('./storage');
const notifier = require('./notifier');

const CONFIG_FILE = storage.CONFIG_FILE;
const LOCK_FILE = path.join(storage.TMP_DIR, 'agent_backup.lock');
const STATUS_FILE = path.join(storage.TMP_DIR, 'backup_status.json');

function lock() {
    storage.ensureDir(path.dirname(LOCK_FILE), 0o700);
    if (fs.existsSync(LOCK_FILE)) {
        let stalePid = null;
        try { stalePid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10); } catch (_) { /* ignore */ }
        if (stalePid && stalePid > 0) {
            try {
                process.kill(stalePid, 0);
                throw new Error('已有备份任务在运行');
            } catch (e) {
                if (e.code === 'ESRCH') {
                    logger.warn(`[lock] 清理陈旧锁文件（PID ${stalePid} 已死）`);
                    try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
                } else {
                    throw e;
                }
            }
        } else {
            try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
        }
    }
    let fd;
    try { fd = fs.openSync(LOCK_FILE, 'wx'); }
    catch (e) {
        if (e.code === 'EEXIST') throw new Error('已有备份任务在运行');
        throw e;
    }
    try { fs.writeSync(fd, String(process.pid)); fs.fchmodSync(fd, 0o600); } catch (_) { /* ignore */ }
    return fd;
}

function unlock(fd) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
}

function loadMeta(config) { return storage.loadMeta(config); }
function saveMeta(meta, config) { return storage.saveMeta(meta, config); }

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function run(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, Object.assign({ stdio: 'pipe' }, opts || {}));
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${cmd} 退出码=${code}: ${stderr.slice(-500)}`));
        });
    });
}

function writeStatus(source, phase, percent, extra) {
    try {
        storage.ensureDir(storage.TMP_DIR, 0o700);
        fs.writeFileSync(STATUS_FILE, JSON.stringify(Object.assign({
            sourceId: source && source.id,
            sourceName: source && source.name,
            phase,
            percent,
            startTime: Date.now(),
        }, extra || {})));
    } catch (_) { /* ignore */ }
}

async function checkDiskSpace(estimatedSize, config) {
    try {
        const root = storage.ensureBackupRoot(config);
        const free = storage.getFreeBytes(root);
        const need = estimatedSize * ((config.retention && config.retention.warnRatio) || 1.5);
        if (free < need) {
            const msg = `磁盘空间不足: free=${free}, need=${need}`;
            logger.warn(msg);
            await notifier.notify(`[Agent 备份] 警告: ${msg}`, 'failure');
        }
        return free;
    } catch (e) {
        logger.warn(`磁盘检查失败: ${e.message}`);
        return 0;
    }
}

function getLinkDestCacheDir(sourceId) {
    return path.join(storage.TMP_DIR, `link_dest_${String(sourceId).replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}

async function extractForLinkDest(sourceId, archive) {
    const cacheDir = getLinkDestCacheDir(sourceId);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    fs.mkdirSync(cacheDir, { recursive: true });
    await run('tar', ['--zstd', '-xf', archive, '-C', cacheDir]);
    return cacheDir;
}

function findLatestBackup(sourceId, config) {
    const meta = loadMeta(config);
    const latest = meta.backups
        .filter(b => b.sourceId === sourceId && b.status === 'success' && b.archive && fs.existsSync(b.archive))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
    return latest ? latest.archive : null;
}

function estimateDirSize(targetPath) {
    try {
        const out = execFileSync('du', ['-sb', targetPath], { encoding: 'utf8' }).trim();
        return parseInt(out.split(/\s+/)[0], 10) || 0;
    } catch (_) { return 0; }
}

async function precheck(sources, config) {
    const checks = [];
    const c = storage.normalizeConfig(config || storage.loadConfig());
    const enabled = (sources || c.sources || []).filter(s => s.enabled !== false);
    const rootCheck = storage.validateBackupRoot(storage.getBackupRoot(c), true);
    checks.push({ name: '备份目录可写', ok: !!rootCheck.ok, detail: rootCheck.ok ? storage.getBackupRoot(c) : rootCheck.error });
    for (const bin of ['rsync', 'tar', 'zstd']) {
        try { execFileSync('which', [bin], { stdio: 'ignore' }); checks.push({ name: `${bin} 可用`, ok: true }); }
        catch (_) { checks.push({ name: `${bin} 可用`, ok: false, detail: '未找到命令' }); }
    }
    checks.push({ name: '备份源数量', ok: enabled.length > 0, detail: `已启用 ${enabled.length} 个` });
    for (const s of enabled) {
        const v = validators.validateSource(s);
        checks.push({ name: `源 ${s.name || s.id}`, ok: v.valid, detail: v.valid ? s.path : v.errors.join('; ') });
    }
    checks.push({ name: '剩余空间', ok: rootCheck.ok && rootCheck.free > 0, detail: rootCheck.ok ? storage.humanSize(rootCheck.free) : '未知' });
    return { ok: checks.every(c => c.ok), checks };
}

async function backupOne(source, config, options) {
    const v = validators.validateSource(source);
    if (!v.valid) throw new Error(`源校验失败: ${v.errors.join(', ')}`);

    const ts = new Date();
    const tsStr = ts.toISOString().replace(/[:.]/g, '-');
    const id = `${source.id}_${tsStr}`;
    const root = storage.ensureBackupRoot(config);
    const workDir = path.join(storage.TMP_DIR, `work_${id}`);
    const archive = storage.archivePathFor(source.id, id, ts, config);
    const latestBackup = findLatestBackup(source.id, config);
    const timeline = [];
    const mark = (phase, detail) => timeline.push({ ts: Date.now(), phase, detail: detail || '' });

    function setStatus(phase, percent, extra) { writeStatus(source, phase, percent, extra); mark(phase, extra && extra.detail); }
    setStatus('start', 0);

    const estSize = estimateDirSize(source.path);
    await checkDiskSpace(estSize, config);

    fs.mkdirSync(workDir, { recursive: true });
    const rsyncArgs = ['-a', '--delete'];
    if (Array.isArray(source.exclude)) {
        for (const ex of source.exclude.filter(Boolean)) rsyncArgs.push('--exclude', ex);
    }
    if (latestBackup) {
        try {
            const linkDest = await extractForLinkDest(source.id, latestBackup);
            rsyncArgs.push('--link-dest', linkDest);
        } catch (e) {
            logger.warn(`link-dest 解压失败，回退到无 link-dest: ${e.message}`);
        }
    }
    rsyncArgs.push(source.path + '/', workDir + '/');

    logger.info(`rsync 增量: ${source.path} → ${workDir}`);
    setStatus('rsync', 30);
    await run('rsync', rsyncArgs);
    setStatus('rsync-done', 60);

    logger.info(`tar.zst 压缩: ${workDir} → ${archive}`);
    setStatus('tar', 75);
    await run('tar', ['--zstd', '-cf', archive, '-C', storage.TMP_DIR, path.basename(workDir)]);

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    setStatus('sha256', 90);
    const sha256 = await sha256File(archive);
    const stat = fs.statSync(archive);

    const meta = loadMeta(config);
    const item = {
        id,
        sourceId: source.id,
        sourceName: source.name,
        sourcePath: source.path,
        archive,
        path: archive,
        size: stat.size,
        timestamp: ts.getTime(),
        sha256,
        status: 'success',
        manual: !!(options && options.manual),
        note: options && options.note || '',
        tags: options && options.tags || [],
        protected: !!(options && options.protected),
        timeline,
        verifiedAt: Date.now(),
    };
    meta.backups.push(item);
    saveMeta(meta, config);

    setStatus('done', 100, { id, archive });
    logger.info(`备份完成: ${id} size=${stat.size} sha256=${sha256}`);
    return item;
}

async function runBackup(sources, options) {
    const config = storage.loadConfig();
    const fd = lock();
    const results = [];
    try {
        const enabled = (sources || config.sources || []).filter(s => s.enabled !== false);
        if (enabled.length === 0) {
            await notifier.notify('[Agent 备份] 今日无启用备份源，未执行备份', 'nosource');
            return { ok: true, empty: true, results: [] };
        }
        for (const s of enabled) {
            try {
                const item = await backupOne(s, config, options || {});
                results.push({ ok: true, id: item.id, source: s.name, archive: item.archive, size: item.size });
            } catch (e) {
                logger.error(`备份失败 source=${s.id}: ${e.message}`);
                results.push({ ok: false, source: s.name || s.id, error: e.message });
            }
        }
        const ok = results.every(r => r.ok);
        await notifier.notify(`[Agent 备份] ${ok ? '备份完成' : '备份存在失败'}\n${results.map(r => r.ok ? `✅ ${r.source}: ${storage.humanSize(r.size)}` : `❌ ${r.source}: ${r.error}`).join('\n')}`, ok ? 'success' : 'failure');
        return { ok, results };
    } finally {
        unlock(fd);
    }
}

async function applyRetention(days) {
    const config = storage.loadConfig();
    const root = storage.ensureBackupRoot(config);
    const meta = loadMeta(config);
    const now = Date.now();
    const keepLast = Number(config.retention && config.retention.keepLast || 0);
    const bySource = new Map();
    for (const b of meta.backups.filter(b => b.status === 'success')) {
        const arr = bySource.get(b.sourceId) || [];
        arr.push(b);
        bySource.set(b.sourceId, arr);
    }
    const protectedIds = new Set();
    for (const arr of bySource.values()) {
        arr.sort((a, b) => b.timestamp - a.timestamp).slice(0, keepLast).forEach(b => protectedIds.add(b.id));
    }
    const cleaned = [];
    for (const b of meta.backups) {
        if (b.status !== 'success' || b.protected || protectedIds.has(b.id)) continue;
        if (now - (b.timestamp || 0) <= days * 86400 * 1000) continue;
        if (b.archive && fs.existsSync(b.archive)) {
            const target = storage.trashPathFor(b.archive, config);
            fs.renameSync(b.archive, target);
            b.trashPath = target;
        }
        b.status = 'trashed';
        b.trashedAt = now;
        cleaned.push(b.id);
    }
    saveMeta(meta, config);
    logger.info(`保留策略完成 root=${root} cleaned=${cleaned.length}`);
    return cleaned;
}

function listBackups(opts) {
    const config = storage.loadConfig();
    const o = opts || {};
    return loadMeta(config).backups
        .filter(b => {
            if (b.status === 'deleted' && !o.includeDeleted) return false;
            if (b.status === 'trashed' && !o.includeTrashed) return false;
            if (o.status && b.status !== o.status) return false;
            return true;
        })
        .slice()
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .map(b => storage.enrichBackup(b, config));
}

function getBackup(id) {
    const config = storage.loadConfig();
    const item = loadMeta(config).backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    return storage.enrichBackup(item, config);
}

async function verifyBackup(id) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (!item.archive || !fs.existsSync(item.archive)) throw new Error(`归档文件丢失: ${item.archive}`);
    const actual = await sha256File(item.archive);
    if (actual !== item.sha256) throw new Error(`sha256 校验失败: 期望 ${item.sha256}，实际 ${actual}`);
    item.verifiedAt = Date.now();
    saveMeta(meta, config);
    return { ok: true, size: fs.statSync(item.archive).size, sha256: actual, verifiedAt: item.verifiedAt };
}

async function listArchiveFiles(id, limit) {
    const item = getBackup(id);
    if (!item.exists) throw new Error(`归档文件丢失: ${item.archive}`);
    const out = await run('tar', ['--zstd', '-tf', item.archive]);
    const all = out.stdout.split('\n').filter(Boolean);
    return { ok: true, id, total: all.length, limit: limit || 500, files: all.slice(0, limit || 500) };
}

async function importArchive(tmpFile, opts) {
    const config = storage.loadConfig();
    const sourceId = opts.sourceId || 'imported';
    const sourceName = opts.sourceName || '手动导入';
    const ts = new Date();
    const id = `${sourceId}_${ts.toISOString().replace(/[:.]/g, '-')}`;
    await run('tar', ['--zstd', '-tf', tmpFile]);
    const sha256 = await sha256File(tmpFile);
    if (opts.sha256 && opts.sha256 !== sha256) throw new Error(`sha256 不一致: 期望 ${opts.sha256}，实际 ${sha256}`);
    const archive = storage.archivePathFor(sourceId, id, ts, config);
    fs.renameSync(tmpFile, archive);
    const stat = fs.statSync(archive);
    const meta = loadMeta(config);
    const item = {
        id, sourceId, sourceName, sourcePath: opts.originalFilename || '', archive, path: archive,
        size: stat.size, timestamp: ts.getTime(), sha256, status: 'success', imported: true,
        importedAt: Date.now(), originalFilename: opts.originalFilename || path.basename(archive),
        note: opts.note || '', tags: ['导入'], verifiedAt: Date.now(), timeline: [{ ts: Date.now(), phase: 'import', detail: opts.originalFilename || '' }]
    };
    meta.backups.push(item);
    saveMeta(meta, config);
    return storage.enrichBackup(item, config);
}

function trashBackup(id) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (item.protected) throw new Error('受保护备份不能删除');
    if (item.archive && fs.existsSync(item.archive)) {
        const target = storage.trashPathFor(item.archive, config);
        fs.renameSync(item.archive, target);
        item.trashPath = target;
    }
    item.status = 'trashed';
    item.trashedAt = Date.now();
    saveMeta(meta, config);
    return { ok: true, id, trashPath: item.trashPath || '' };
}

function setProtected(id, value) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    item.protected = !!value;
    saveMeta(meta, config);
    return { ok: true, id, protected: item.protected };
}


function updateBackupMeta(id, patch) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (Object.prototype.hasOwnProperty.call(patch, 'note')) item.note = String(patch.note || '').slice(0, 500);
    if (Array.isArray(patch.tags)) item.tags = patch.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 20);
    if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) item.displayName = String(patch.displayName || '').slice(0, 120);
    item.updatedAt = Date.now();
    saveMeta(meta, config);
    return storage.enrichBackup(item, config);
}

function listTrash() {
    const config = storage.loadConfig();
    return loadMeta(config).backups
        .filter(b => b.status === 'trashed')
        .slice()
        .sort((a, b) => (b.trashedAt || b.timestamp || 0) - (a.trashedAt || a.timestamp || 0))
        .map(b => storage.enrichBackup(b, config));
}

function trashStats() {
    const items = listTrash();
    let bytes = 0;
    for (const b of items) {
        const p = b.trashPath || b.archive;
        try { if (p && fs.existsSync(p)) bytes += fs.statSync(p).size; } catch (_) { /* ignore */ }
    }
    return { ok: true, count: items.length, bytes, human: storage.humanSize(bytes), items };
}

function latestSuccessBySource(meta, sourceId) {
    return meta.backups
        .filter(b => b.sourceId === sourceId && b.status === 'success')
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
}

function deleteWarnings(item, meta) {
    const warnings = [];
    if (item.protected) warnings.push('受保护备份');
    const latest = latestSuccessBySource(meta, item.sourceId);
    if (latest && latest.id === item.id) warnings.push('该来源最近一次成功备份');
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (tags.includes('重要') || tags.includes('升级前')) warnings.push('包含重要标签');
    return warnings;
}

function restoreTrash(id) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (item.status !== 'trashed') throw new Error('该备份不在回收站');
    const src = item.trashPath || item.archive;
    if (!src || !fs.existsSync(src)) throw new Error(`回收站文件丢失: ${src || ''}`);
    const dest = item.archive || storage.archivePathFor(item.sourceId || 'restored', item.id, new Date(item.timestamp || Date.now()), config);
    if (fs.existsSync(dest)) throw new Error(`恢复目标已存在: ${dest}`);
    storage.ensureDir(path.dirname(dest), 0o700);
    fs.renameSync(src, dest);
    item.archive = dest;
    item.path = dest;
    item.trashPath = '';
    item.status = 'success';
    item.restoredFromTrashAt = Date.now();
    saveMeta(meta, config);
    return { ok: true, id, archive: dest };
}

function deleteTrash(id, opts) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (item.status !== 'trashed') throw new Error('只能永久删除回收站里的备份');
    const warnings = deleteWarnings(item, meta);
    if (item.protected && !(opts && opts.forceProtected)) throw new Error('受保护备份不能永久删除，请先取消保护');
    const p = item.trashPath || item.archive;
    let freed = 0;
    try { if (p && fs.existsSync(p)) freed = fs.statSync(p).size; } catch (_) { /* ignore */ }
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    item.status = 'deleted';
    item.deletedAt = Date.now();
    item.deleteWarnings = warnings;
    item.deletedArchive = p;
    item.trashPath = '';
    saveMeta(meta, config);
    return { ok: true, id, freedBytes: freed, freedHuman: storage.humanSize(freed), warnings };
}

function emptyTrash(opts) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const now = Date.now();
    let deleted = 0, skipped = 0, failed = 0, freed = 0;
    const details = [];
    for (const item of meta.backups.filter(b => b.status === 'trashed')) {
        if (item.protected && !(opts && opts.forceProtected)) { skipped++; details.push({ id: item.id, skipped: true, reason: 'protected' }); continue; }
        const p = item.trashPath || item.archive;
        try {
            let size = 0;
            if (p && fs.existsSync(p)) size = fs.statSync(p).size;
            if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
            freed += size;
            deleted++;
            item.status = 'deleted';
            item.deletedAt = now;
            item.deletedArchive = p;
            item.trashPath = '';
            details.push({ id: item.id, deleted: true, size });
        } catch (e) {
            failed++;
            details.push({ id: item.id, failed: true, error: e.message });
        }
    }
    saveMeta(meta, config);
    return { ok: failed === 0, deleted, skipped, failed, freedBytes: freed, freedHuman: storage.humanSize(freed), details };
}

function cleanupTrash(days) {
    const config = storage.loadConfig();
    const trashDays = Number(days || (config.storage && config.storage.trashDays) || 7);
    const cutoff = Date.now() - trashDays * 86400 * 1000;
    const meta = loadMeta(config);
    let deleted = 0, skipped = 0, freed = 0;
    for (const item of meta.backups.filter(b => b.status === 'trashed')) {
        if ((item.trashedAt || item.timestamp || 0) > cutoff) { skipped++; continue; }
        if (item.protected) { skipped++; continue; }
        const p = item.trashPath || item.archive;
        try {
            let size = 0;
            if (p && fs.existsSync(p)) size = fs.statSync(p).size;
            if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
            freed += size;
            deleted++;
            item.status = 'deleted';
            item.deletedAt = Date.now();
            item.deletedArchive = p;
            item.trashPath = '';
        } catch (_) { skipped++; }
    }
    saveMeta(meta, config);
    return { ok: true, trashDays, deleted, skipped, freedBytes: freed, freedHuman: storage.humanSize(freed) };
}

function scanLargeFiles(targetPath, limit) {
    const max = Math.min(parseInt(limit, 10) || 20, 100);
    const base = path.resolve(targetPath || '.');
    const items = [];
    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const ent of entries) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (['node_modules', '.git', '.cache', 'tmp', 'logs', '__pycache__'].includes(ent.name)) continue;
                walk(p);
            } else if (ent.isFile()) {
                try { const st = fs.statSync(p); items.push({ path: p, rel: path.relative(base, p), size: st.size, human: storage.humanSize(st.size) }); } catch (_) { /* ignore */ }
            }
        }
    }
    walk(base);
    items.sort((a, b) => b.size - a.size);
    return { ok: true, path: base, total: items.length, limit: max, files: items.slice(0, max) };
}

function recommendedExcludes() {
    return ['node_modules', '.git', '.cache', 'tmp', 'logs', '*.log', '*.tmp', '.DS_Store', '__pycache__'];
}

function sizeAnomalyReport(sourceId, currentSize) {
    const config = storage.loadConfig();
    const meta = loadMeta(config);
    const latest = meta.backups
        .filter(b => b.sourceId === sourceId && b.status === 'success' && b.size > 0)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    if (!latest) return { ok: true, anomalous: false, reason: 'no-history' };
    const ratio = Number(config.alert && config.alert.sizeGrowthRatio || 3);
    const growth = currentSize / latest.size;
    return { ok: true, anomalous: growth >= ratio, ratio, growth, previousSize: latest.size, previousHuman: storage.humanSize(latest.size), currentSize, currentHuman: storage.humanSize(currentSize), latestId: latest.id };
}

function wizardScan(targetPath, opts) {
    const base = path.resolve(targetPath || '.');
    if (!storage.pathAllowed(base)) throw new Error('扫描路径不在白名单内');
    const large = scanLargeFiles(base, (opts && opts.limit) || 20);
    const suggestions = recommendedExcludes().map(pattern => ({
        type: 'exclude',
        pattern,
        label: excludeLabel(pattern),
        reason: excludeReason(pattern),
        checked: ['node_modules', '.git', '.cache', 'tmp', 'logs', '*.log', '*.tmp', '__pycache__'].includes(pattern)
    }));
    const totalSize = large.files.reduce((sum, f) => sum + (f.size || 0), 0);
    return { ok: true, path: base, largeFiles: large.files, suggestions, summary: { scannedFiles: large.total, topFiles: large.files.length, topFilesSize: totalSize, topFilesSizeHuman: storage.humanSize(totalSize) } };
}

function excludeLabel(pattern) {
    const map = {
        'node_modules': '排除 node_modules 依赖目录', '.git': '排除 Git 历史目录', '.cache': '排除缓存目录',
        'tmp': '排除临时目录', 'logs': '排除日志目录', '*.log': '排除日志文件', '*.tmp': '排除临时文件',
        '.DS_Store': '排除 macOS 系统文件', '__pycache__': '排除 Python 缓存目录'
    };
    return map[pattern] || `排除 ${pattern}`;
}

function excludeReason(pattern) {
    if (['node_modules', '.git', '.cache', 'tmp', 'logs', '__pycache__'].includes(pattern)) return '通常体积大且可重新生成，不建议进入备份包。';
    if (['*.log', '*.tmp'].includes(pattern)) return '日志/临时文件会持续增长，容易撑大备份。';
    return '常见无须备份文件。';
}

function estimateWizard(sourcePath, excludes) {
    const scan = wizardScan(sourcePath, { limit: 50 });
    return { ok: true, path: scan.path, excludes: Array.isArray(excludes) ? excludes : [], summary: scan.summary, note: '估算基于 Top 大文件扫描，完整精确大小将在正式备份时计算。' };
}

module.exports = {
    CONFIG_FILE, STATUS_FILE,
    loadMeta, saveMeta, sha256File, run,
    precheck, runBackup, backupOne, applyRetention,
    listBackups, getBackup, verifyBackup, listArchiveFiles,
    importArchive, trashBackup, setProtected, updateBackupMeta,
    listTrash, trashStats, restoreTrash, deleteTrash, emptyTrash, cleanupTrash,
    scanLargeFiles, recommendedExcludes, sizeAnomalyReport, wizardScan, estimateWizard
};
