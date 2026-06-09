// backup-engine.js：rsync 增量 + tar.zst 压缩 + sha256 校验
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const validators = require('./validators');
const notifier = require('./notifier');

const BACKUP_ROOT = '/vol3/@appdata/com.dustinky.agentbackup/backups';
const META_FILE = path.join(BACKUP_ROOT, 'index.json');
const LOCK_FILE = '/vol3/@appdata/com.dustinky.agentbackup/tmp/agent_backup.lock';
const TMP_DIR = '/vol3/@appdata/com.dustinky.agentbackup/tmp';

// 互斥锁（v1.0.19 修：Node.js 22 没有 fs.flockSync，改用 O_EXCL 原子文件锁 + PID 校验）
function lock() {
    // 确保父目录存在
    const lockDir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }

    // 如果已存在锁文件，检查持有者 PID 是否还活着；死了就清理
    if (fs.existsSync(LOCK_FILE)) {
        let stalePid = null;
        try {
            stalePid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
        } catch (e) { /* ignore */ }
        if (stalePid && stalePid > 0) {
            try {
                process.kill(stalePid, 0); // signal 0：检查进程是否存在
                throw new Error('已有备份任务在运行');
            } catch (e) {
                if (e.code === 'ESRCH') {
                    // 进程已死，清理陈旧锁
                    logger.warn(`[lock] 清理陈旧锁文件（PID ${stalePid} 已死）`);
                    try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
                } else {
                    throw e;
                }
            }
        } else {
            // 锁文件内容异常，删了
            try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
        }
    }

    // O_EXCL 原子创建（已存在则失败 → 并发抢锁安全）
    let fd;
    try {
        fd = fs.openSync(LOCK_FILE, 'wx');
    } catch (e) {
        if (e.code === 'EEXIST') {
            throw new Error('已有备份任务在运行');
        }
        throw e;
    }
    try {
        fs.writeSync(fd, String(process.pid));
        fs.fchmodSync(fd, 0o600);
    } catch (e) { /* ignore */ }
    return fd;
}

function unlock(fd) {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

// 加载元数据
function loadMeta() {
    if (!fs.existsSync(META_FILE)) return { backups: [] };
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
}

function saveMeta(meta) {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// sha256
function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// 同步执行命令
function run(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, Object.assign({ stdio: 'pipe' }, opts || {}));
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${cmd} 退出码=${code}: ${stderr.slice(-200)}`));
        });
    });
}

// 磁盘空间检查（warnRatio 倍）
async function checkDiskSpace(estimatedSize) {
    try {
        const out = execSync(`df -B1 ${BACKUP_ROOT} | tail -1 | awk '{print $4}'`).toString().trim();
        const free = parseInt(out, 10);
        const need = estimatedSize * 1.5; // warnRatio
        if (free < need) {
            const msg = `磁盘空间不足: free=${free}, need=${need}`;
            logger.warn(msg);
            await notifier.notify(`[Agent 备份] 警告: ${msg}`);
        }
        return free;
    } catch (e) {
        logger.warn(`磁盘检查失败: ${e.message}`);
        return 0;
    }
}

// 找最近一次 backup（--link-dest 源）
function findLatestBackup(sourceId) {
    const meta = loadMeta();
    const candidates = meta.backups
        .filter(b => b.sourceId === sourceId && b.status === 'success')
        .sort((a, b) => b.timestamp - a.timestamp);
    return candidates.length > 0 ? candidates[0].path : null;
}

// 单个源备份
async function backupOne(source) {
    const v = validators.validateSource(source);
    if (!v.valid) {
        throw new Error(`源校验失败: ${v.errors.join(', ')}`);
    }

    const ts = new Date();
    const tsStr = ts.toISOString().replace(/[:.]/g, '-');
    const id = `${source.id}_${tsStr}`;
    const backupDir = path.join(BACKUP_ROOT, id);
    const archive = `${backupDir}.tar.zst`;
    const latestBackup = findLatestBackup(source.id);

    // 估算大小
    let estSize = 0;
    try {
        estSize = parseInt(execSync(`du -sb ${source.path} 2>/dev/null | awk '{print $1}'`).toString().split('\n')[0], 10) || 0;
    } catch (e) {
        logger.warn(`估算大小失败: ${e.message}`);
    }
    await checkDiskSpace(estSize);

    // 1. rsync 增量到 backupDir
    fs.mkdirSync(backupDir, { recursive: true });
    const rsyncArgs = ['-a', '--delete'];
    if (latestBackup) {
        rsyncArgs.push('--link-dest', latestBackup);
    }
    rsyncArgs.push(source.path + '/', backupDir + '/');

    logger.info(`rsync 增量: ${source.path} → ${backupDir}`);
    await run('rsync', rsyncArgs);

    // 2. 打包 tar.zst
    logger.info(`tar.zst 压缩: ${backupDir} → ${archive}`);
    await run('tar', ['--zstd', '-cf', archive, '-C', BACKUP_ROOT, id]);

    // 3. sha256
    const sha = await sha256File(archive);
    logger.info(`sha256: ${sha}`);

    // 4. 记录元数据
    const meta = loadMeta();
    const archiveSize = fs.statSync(archive).size;
    meta.backups.push({
        id,
        sourceId: source.id,
        sourceName: source.name,
        path: backupDir,
        archive,
        sha256: sha,
        size: archiveSize,
        timestamp: ts.getTime(),
        status: 'success',
    });
    saveMeta(meta);

    // 5. 清理 backupDir（保留 archive）
    // v1.0.17 修：用 fs.rmSync 替代 execSync('rm -rf')，避免 shell 注入
    try {
        fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }

    return { id, archive, sha256: sha, size: archiveSize };
}

// 保留策略：30 天
async function applyRetention(days) {
    const meta = loadMeta();
    const now = Date.now();
    const expired = meta.backups.filter(b => {
        const age = (now - b.timestamp) / (1000 * 60 * 60 * 24);
        return age > days;
    });
    for (const b of expired) {
        try {
            if (fs.existsSync(b.archive)) fs.unlinkSync(b.archive);
            logger.info(`清理过期备份: ${b.id}`);
        } catch (e) {
            logger.warn(`清理失败 ${b.id}: ${e.message}`);
        }
    }
    if (expired.length > 0) {
        meta.backups = meta.backups.filter(b => !expired.find(e => e.id === b.id));
        saveMeta(meta);
    }
    return expired.length;
}

// 主入口
async function runBackup(sources) {
    let fd;
    try {
        fd = lock();
    } catch (e) {
        logger.warn(`锁定失败: ${e.message}`);
        await notifier.notify(`[Agent 备份] ${e.message}`);
        return { ok: false, error: e.message };
    }

    try {
        const results = [];
        for (const source of sources) {
            if (!source.enabled) continue;
            try {
                const r = await backupOne(source);
                results.push({ source: source.id, ok: true, ...r });
            } catch (e) {
                logger.error(`备份失败 ${source.id}: ${e.message}`);
                results.push({ source: source.id, ok: false, error: e.message });
            }
        }

        // 保留策略
        const cleaned = await applyRetention(30);

        // 通知
        const successCount = results.filter(r => r.ok).length;
        const failCount = results.filter(r => !r.ok).length;
        await notifier.notify(
            `[Agent 备份] 完成: 成功 ${successCount}，失败 ${failCount}，清理 ${cleaned}`
        );

        return { ok: true, results, cleaned };
    } catch (e) {
        logger.error(`runBackup 异常: ${e.message}`);
        await notifier.notify(`[Agent 备份] 异常: ${e.message}`);
        return { ok: false, error: e.message };
    } finally {
        unlock(fd);
    }
}

module.exports = { runBackup, backupOne, applyRetention, loadMeta, sha256File };
