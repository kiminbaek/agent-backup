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

function listBackups() {
    const config = storage.loadConfig();
    return loadMeta(config).backups
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

module.exports = {
    CONFIG_FILE, STATUS_FILE,
    loadMeta, saveMeta, sha256File, run,
    precheck, runBackup, backupOne, applyRetention,
    listBackups, getBackup, verifyBackup, listArchiveFiles,
    importArchive, trashBackup, setProtected
};
