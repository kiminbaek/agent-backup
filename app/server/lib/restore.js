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
        await run('tar', ['--zstd', '-xf', dec.archive, '-C', tmpDir, member]);
        const src = path.join(tmpDir, member);
        if (!fs.existsSync(src)) throw new Error('归档成员未解出');
        fs.mkdirSync(targetPath, { recursive: true });
        const out = path.join(targetPath, path.basename(member));
        await run('rsync', ['-a', src, out]);
        audit.write('restore.file', { id, member, targetPath, out });
        return { ok: true, id, member, targetPath, out };
    } finally {
        dec.cleanup();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

module.exports = { list, verify, preview, restore, restoreFile, riskLevel, snapshotTarget };
