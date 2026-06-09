// restore.js：v1.1.0 校验 + 预览 + 恢复
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const validators = require('./validators');
const backup = require('./backup-engine');
const storage = require('./storage');

function list() {
    return backup.listBackups().filter(b => b.status === 'success');
}

async function verify(id) {
    return backup.verifyBackup(id);
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'pipe' });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} 退出码=${code}: ${stderr.slice(-500)}`)));
    });
}

async function extractToTmp(item) {
    const tmpDir = path.join(storage.TMP_DIR, `restore_${item.id}_${process.pid}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    await run('tar', ['--zstd', '-xf', item.archive, '-C', tmpDir]);
    const children = fs.readdirSync(tmpDir);
    if (children.length !== 1) throw new Error(`解压目录异常: ${children.join(',')}`);
    return { tmpDir, extracted: path.join(tmpDir, children[0]) };
}

async function preview(id, targetPath) {
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);
    const item = backup.getBackup(id);
    if (!item.exists) throw new Error(`归档文件丢失: ${item.archive}`);
    const { tmpDir, extracted } = await extractToTmp(item);
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
        return { ok: true, id, targetPath, added, updated, deleted, same, total: lines.length, lines: lines.slice(0, 500) };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

async function restore(id, targetPath) {
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);
    const item = backup.getBackup(id);
    if (!item.exists) throw new Error(`归档文件丢失: ${item.archive}`);
    await backup.verifyBackup(id);
    const { tmpDir, extracted } = await extractToTmp(item);
    try {
        await run('rsync', ['-a', `${extracted}/`, `${targetPath}/`]);
        logger.info(`恢复完成: ${id} → ${targetPath}`);
        return { ok: true, id, targetPath };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

module.exports = { list, verify, preview, restore };
