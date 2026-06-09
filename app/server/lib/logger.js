// logger.js：统一日志（带时间戳 + 等级 + 日志轮转）
const fs = require('fs');
const path = require('path');

const LOG_DIR = '/vol3/@appdata/com.dustinky.agentbackup/logs';
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
const BACKUP_LOG = path.join(LOG_DIR, 'backup.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // v1.0.20 加：单文件最大 10MB，超出轮转
const MAX_LOG_KEEP = 5; // v1.0.20 加：保留 5 个历史文件

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

// v1.0.20 加：日志轮转（文件大小超限 → server.log.1 → server.log.2 ... → server.log.5 后删除）
function rotate(file) {
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.size < MAX_LOG_SIZE) return;
    // 删最老的
    const oldest = `${file}.${MAX_LOG_KEEP}`;
    if (fs.existsSync(oldest)) {
        try { fs.unlinkSync(oldest); } catch (_) { /* ignore */ }
    }
    // 依次后移 .4 → .5, .3 → .4, ...
    for (let i = MAX_LOG_KEEP - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) {
            try { fs.renameSync(from, to); } catch (_) { /* ignore */ }
        }
    }
    // 当前 → .1
    try { fs.renameSync(file, `${file}.1`); } catch (_) { /* ignore */ }
}

function format(level, msg, extra) {
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] ${msg}`;
    if (extra) {
        line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    }
    return line + '\n';
}

function writeLog(file, level, msg, extra) {
    try {
        ensureLogDir();
        // v1.0.20 加：写入前先轮转
        rotate(file);
        fs.appendFileSync(file, format(level, msg, extra));
    } catch (e) {
        // 日志写入失败不能阻塞主流程
        process.stderr.write(`[logger] write failed: ${e.message}\n`);
    }
}

function info(msg, extra) {
    const line = format('INFO', msg, extra);
    process.stdout.write(line);
    writeLog(SERVER_LOG, 'INFO', msg, extra);
}

function warn(msg, extra) {
    const line = format('WARN', msg, extra);
    process.stdout.write(line);
    writeLog(SERVER_LOG, 'WARN', msg, extra);
}

function error(msg, extra) {
    const line = format('ERROR', msg, extra);
    process.stderr.write(line);
    writeLog(SERVER_LOG, 'ERROR', msg, extra);
}

function backup(msg, extra) {
    writeLog(BACKUP_LOG, 'BACKUP', msg, extra);
    info(msg, extra);
}

module.exports = { info, warn, error, backup, format };
