// logger.js：统一日志（带时间戳 + 等级）
const fs = require('fs');
const path = require('path');

const LOG_DIR = '/vol3/@appdata/com.dustinky.agentbackup/logs';
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
const BACKUP_LOG = path.join(LOG_DIR, 'backup.log');

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
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
