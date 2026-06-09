// restore.js：原子恢复（先 dry-run → 二次确认 → rsync 恢复）
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const validators = require('./validators');
const backup = require('./backup-engine');

const BACKUP_ROOT = '/vol3/@appdata/com.dustinky.agentbackup/backups';

// 列出可用备份
function list() {
    const meta = backup.loadMeta();
    return meta.backups
        .filter(b => b.status === 'success')
        .sort((a, b) => b.timestamp - a.timestamp);
}

// 校验备份完整性
async function verify(id) {
    const meta = backup.loadMeta();
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);

    if (!fs.existsSync(item.archive)) {
        throw new Error(`归档文件丢失: ${item.archive}`);
    }

    // sha256 校验
    const actual = await backup.sha256File(item.archive);
    if (actual !== item.sha256) {
        throw new Error(`sha256 校验失败: 期望 ${item.sha256}，实际 ${actual}`);
    }
    return { ok: true, size: item.size, sha256: actual };
}

// 原子恢复：先解压到临时目录，再 rsync 到目标
async function restore(id, targetPath) {
    // 1. 校验目标
    const v = validators.validateRestoreTarget(targetPath);
    if (!v.valid) throw new Error(v.error);

    // 2. 校验备份
    const meta = backup.loadMeta();
    const item = meta.backups.find(b => b.id === id);
    if (!item) throw new Error(`备份不存在: ${id}`);
    if (!fs.existsSync(item.archive)) throw new Error(`归档文件丢失: ${item.archive}`);

    // 3. 解压到临时目录
    const tmpDir = path.join('/vol3/@appdata/com.dustinky.agentbackup/tmp', `restore_${id}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // 解压
        await new Promise((resolve, reject) => {
            const child = spawn('tar', ['--zstd', '-xf', item.archive, '-C', tmpDir]);
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`tar 解压失败 code=${code}`));
            });
        });

        // 解压后目录：tmpDir/<id>/  (因为 backup-engine 打包时是 -C BACKUP_ROOT id)
        const extracted = path.join(tmpDir, id);
        if (!fs.existsSync(extracted)) {
            throw new Error(`解压后目录不存在: ${extracted}`);
        }

        // 4. rsync 到目标
        const rsyncArgs = ['-a', `${extracted}/`, `${targetPath}/`];
        await new Promise((resolve, reject) => {
            const child = spawn('rsync', rsyncArgs);
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`rsync 退出码=${code}`));
            });
        });

        logger.info(`恢复完成: ${id} → ${targetPath}`);
        return { ok: true, source: item.archive, target: targetPath };
    } finally {
        // 清理临时目录
        try {
            execSync(`rm -rf ${tmpDir}`);
        } catch (e) { /* ignore */ }
    }
}

module.exports = { list, verify, restore };
