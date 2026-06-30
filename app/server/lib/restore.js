// restore.js：v1.1.0 校验 + 预览 + 恢复
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const validators = require('./validators');
const backup = require('./backup-engine');
const storage = require('./storage');
const audit = require('./audit');

function list() {
    return backup.listBackups().filter(b => b.status === 'success');
}

async function verify(id) {
    return backup.verifyBackup(id);
}

// v1.1.4 改：加 timeout 保护，默认 30 分钟（Bug #3）
function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const ttl = typeof timeoutMs === 'number' ? timeoutMs : 30 * 60 * 1000;
        const child = spawn(cmd, args, { stdio: 'pipe' });
        let stdout = '', stderr = '';
        let timedOut = false;
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            reject(new Error(`${cmd} 超时（${ttl}ms），已终止子进程`));
        }, ttl);
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return;
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${cmd} 退出码=${code}: ${stderr.slice(-500)}`));
        });
    });
}

// v1.1.4 改：允许多个顶级条目（Bug #7）
//   旧版硬要求只有 1 个顶级条目，第三方导入的归档无法恢复
//   如果有多个顶级条目，返回 tmpDir 本身作为 extracted 路径
async function extractToTmp(item, password) {
    const tmpDir = path.join(storage.TMP_DIR, `restore_${item.id}_${process.pid}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const dec = await backup.decryptArchiveToTmp(item, password);
    try { await run('tar', ['--zstd', '-xf', dec.archive, '-C', tmpDir]); } finally { dec.cleanup(); }
    const children = fs.readdirSync(tmpDir);
    if (children.length === 0) throw new Error(`解压后目录为空: ${item.archive}`);
    const extracted = children.length === 1 ? path.join(tmpDir, children[0]) : tmpDir;
    return { tmpDir, extracted };
}



function riskLevel(targetPath) {
    const p = path.resolve(targetPath || '');
    const rules = [
        { level: '极高', keyword: '/vol3/@appcenter/', message: '目标是应用前端/运行目录，恢复会覆盖已安装程序文件' },
        { level: '高', keyword: '/vol3/@appdata/', message: '目标是应用真实数据目录，恢复会覆盖生产数据' },
        { level: '高', keyword: '/vol3/@appshare/com.dustinky.qwenpaw', message: '目标是 QwenPaw 应用共享目录，恢复前必须确认' },
        { level: '低', keyword: '/restore-test', message: '目标看起来是测试恢复目录' }
    ];
    const hit = rules.find(r => p.includes(r.keyword));
    return hit || { level: '中', keyword: '', message: '普通路径，仍建议先预览差异' };
}

async function snapshotTarget(targetPath) {
    if (!fs.existsSync(targetPath)) return { skipped: true, reason: 'target-not-exists' };
    const base = path.basename(path.resolve(targetPath));
    const dir = path.join(storage.APP_DATA_DIR, 'restore-snapshots');
    storage.ensureDir(dir, 0o700);
    const out = path.join(dir, `${base}-pre-restore-${Date.now()}.tar.zst`);
    await run('tar', ['--zstd', '-cf', out, '-C', path.dirname(path.resolve(targetPath)), base]);
    const size = fs.statSync(out).size;
    return { skipped: false, path: out, size, human: storage.humanSize(size) };
}


function parentWritable(targetPath) {
    const abs = path.resolve(targetPath || '');
    let p = fs.existsSync(abs) ? abs : path.dirname(abs);
    while (p && p !== path.dirname(p) && !fs.existsSync(p)) p = path.dirname(p);
    try { fs.accessSync(p, fs.constants.W_OK); return { ok: true, path: p }; }
    catch (e) { return { ok: false, path: p, error: e.message }; }
}

async function archiveEntries(item, password, limit) {
    const dec = await backup.decryptArchiveToTmp(item, password);
    try {
        const out = await run('tar', ['--zstd', '-tf', dec.archive], 5 * 60 * 1000);
        return out.stdout.split('\n').filter(Boolean).slice(0, limit || 5000);
    } finally { dec.cleanup(); }
}

function qwenpawEntryStats(entries) {
    const hasWorkspaces = entries.some(e => /(^|\/)workspaces\//.test(e));
    const hasAgents = entries.filter(e => /(^|\/)workspaces\/[^/]+\/MEMORY\.md$/.test(e)).length;
    const hasGlobal = entries.some(e => /(^|)(config\.json|settings\.json)$/.test(e));
    const hasSkills = entries.some(e => /(^|\/)skill_pool\//.test(e) || /(^|\/)skills\//.test(e));
    return { hasWorkspaces, agentsWithMemory: hasAgents, hasGlobal, hasSkills };
}

async function preflight(id, targetPath, opts) {
    opts = opts || {};
    if (!validators.isPathAllowed(targetPath)) throw new Error('目标路径不在白名单');
    const abs = path.resolve(targetPath);
    const exists = fs.existsSync(abs);
    const checks = [];
    checks.push({ name: '目标路径白名单', ok: true, detail: abs });
    if (exists) {
        const st = fs.statSync(abs);
        checks.push({ name: '目标目录存在', ok: st.isDirectory(), detail: st.isDirectory() ? '存在且是目录' : '路径存在但不是目录' });
        try { fs.accessSync(abs, fs.constants.W_OK); checks.push({ name: '目标目录可写', ok: true }); }
        catch (e) { checks.push({ name: '目标目录可写', ok: false, detail: e.message }); }
    } else {
        checks.push({ name: '目标目录存在', ok: !!opts.createMissing, detail: opts.createMissing ? '目录不存在，恢复时将自动创建' : '目录不存在' });
        const pw = parentWritable(abs);
        checks.push({ name: '父目录可写', ok: pw.ok, detail: pw.ok ? pw.path : (pw.path + ': ' + pw.error) });
    }
    const item = backup.getBackup(id);
    checks.push({ name: '备份记录存在', ok: !!item && !!item.id, detail: item && item.id || id });
    checks.push({ name: '归档文件存在', ok: !!item && !!item.exists, detail: item && item.archive || '' });
    if (!item || !item.exists) return { ok: false, id, targetPath: abs, createMissing: !!opts.createMissing, risk: riskLevel(abs), checks };
    try { const v = await backup.verifyBackup(id); checks.push({ name: '归档校验', ok: !!v.ok, detail: v.ok ? 'sha256 匹配' : (v.error || '校验失败') }); }
    catch (e) { checks.push({ name: '归档校验', ok: false, detail: e.message }); }
    let entries = [];
    try { entries = await archiveEntries(item, opts.password || '', 3000); checks.push({ name: '归档可读取', ok: entries.length > 0, detail: `${entries.length} 条目` }); }
    catch (e) { checks.push({ name: '归档可读取', ok: false, detail: e.message }); }
    const qs = qwenpawEntryStats(entries);
    if (opts.qwenpaw) {
        checks.push({ name: 'QwenPaw workspaces', ok: !!qs.hasWorkspaces, detail: qs.hasWorkspaces ? `检测到 ${qs.agentsWithMemory} 个 MEMORY.md` : '未检测到 workspaces/' });
        checks.push({ name: '技能/全局配置检测', ok: true, detail: `全局配置=${qs.hasGlobal?'有':'无'}，技能=${qs.hasSkills?'有':'无'}` });
    }
    const ok = checks.every(c => c.ok !== false);
    return { ok, id, targetPath: abs, createMissing: !!opts.createMissing, qwenpaw: !!opts.qwenpaw, risk: riskLevel(abs), archive: { encrypted: !!item.encrypted, size: item.size, sourceName: item.sourceName, sourcePath: item.sourcePath }, qwenpawStats: qs, checks, sampleEntries: entries.slice(0, 50) };
}

async function restoreQwenPaw(id, targetPath, opts) {
    opts = opts || {};
    const pf = await preflight(id, targetPath, { password: opts.password || '', createMissing: true, qwenpaw: true });
    if (!pf.ok) throw new Error('恢复预检未通过: ' + pf.checks.filter(c => c.ok === false).map(c => c.name + ':' + c.detail).join('; '));
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    await backup.verifyBackup(id);
    const snapshot = await snapshotTarget(abs);
    const item = backup.getBackup(id);
    const { tmpDir, extracted } = await extractToTmp(item, opts.password || '');
    try {
        await run('rsync', ['-a', `${extracted}/`, `${abs}/`]);
        audit.write('restore.qwenpaw', { id, targetPath: abs, snapshot, preflight: pf.qwenpawStats });
        logger.info(`QwenPaw 整体恢复完成: ${id} → ${abs}`);
        return { ok: true, id, targetPath: abs, snapshot, preflight: pf };
    } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
}

async function preview(id, targetPath, password) {
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);
    const item = backup.getBackup(id);
    if (!item.exists) throw new Error(`归档文件丢失: ${item.archive}`);
    const { tmpDir, extracted } = await extractToTmp(item, password);
    try {
        const out = await run('rsync', ['-ani', `${extracted}/`, `${targetPath}/`]);
        const lines = out.stdout.split('\n').filter(Boolean);
        let added = 0, updated = 0, deleted = 0, same = 0;
        for (const line of lines) {
            if (line.startsWith('>f+++++++++')) added++;
            else if (line.startsWith('>f')) updated++;
            else if (line.startsWith('*deleting')) deleted++;
            else same++;
        }
        return { ok: true, id, targetPath, risk: riskLevel(targetPath), added, updated, deleted, same, total: lines.length, lines: lines.slice(0, 500) };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

async function restore(id, targetPath, password) {
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);
    const item = backup.getBackup(id);
    if (!item.exists) throw new Error(`归档文件丢失: ${item.archive}`);
    await backup.verifyBackup(id);
    const snapshot = await snapshotTarget(targetPath);
    const { tmpDir, extracted } = await extractToTmp(item, password);
    try {
        await run('rsync', ['-a', `${extracted}/`, `${targetPath}/`]);
        logger.info(`恢复完成: ${id} → ${targetPath}`);
        audit.write('restore.execute', { id, targetPath, snapshot });
        return { ok: true, id, targetPath, snapshot, risk: riskLevel(targetPath) };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}


function safeArchiveMember(member) {
    if (!member || typeof member !== 'string') return false;
    if (member.startsWith('/') || member.split('/').includes('..')) return false;
    return true;
}

async function restoreFile(id, member, targetPath, password) {
    if (!safeArchiveMember(member)) throw new Error('非法归档路径');
    const item = backup.getBackup(id);
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);
    const tmpDir = path.join(storage.TMP_DIR, `restore_file_${id}_${process.pid}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const dec = await backup.decryptArchiveToTmp(item, password);
    try {
        // 归档内通常带 work_<id>/ 顶层目录；兼容前端传 workspaces/<agent>/<file> 的短路径
        const listOut = await run('tar', ['--zstd', '-tf', dec.archive]);
        const entries = listOut.stdout.split('\n').filter(Boolean);
        let resolved = entries.find(e => e === member);
        if (!resolved) resolved = entries.find(e => e.endsWith('/' + member) && !e.endsWith('/'));
        if (!resolved) throw new Error('归档中未找到成员: ' + member);
        await run('tar', ['--zstd', '-xf', dec.archive, '-C', tmpDir, resolved]);
        const src = path.join(tmpDir, resolved);
        if (!fs.existsSync(src)) throw new Error('归档成员未解出');
        fs.mkdirSync(targetPath, { recursive: true });
        const out = path.join(targetPath, path.basename(resolved));
        const snapshot = await snapshotTarget(targetPath);
        await run('rsync', ['-a', src, out]);
        audit.write('restore.file', { id, member, resolved, targetPath, out, snapshot });
        return { ok: true, id, member, resolved, targetPath, out, snapshot };
    } finally {
        dec.cleanup();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

module.exports = { list, verify, preview, restore, restoreFile, riskLevel, snapshotTarget, preflight, restoreQwenPaw };
