// server.js：Agent 备份 Express 入口
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('./lib/logger');
const cron = require('./lib/cron-engine');
const appdb = require('./lib/appdb-sync');
const auth = require('./lib/auth');

const PORT = 12083;
const VERSION = '1.0.19'; // v1.0.19 修复 fs.flockSync 不存在的备份失败
const UI_DIR = path.join(__dirname, '..', 'ui');
const LOG_FILE = '/vol3/@appdata/com.dustinky.agentbackup/logs/server.log';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(UI_DIR, { index: 'index.html' }));

// 健康检查（公开）
app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'agent-backup', port: PORT });
});

// v1.0.17 新增：应用信息（版本 + IP + hostname）
app.get('/api/info', (req, res) => {
    // 获取本机第一个非回环 IPv4 地址
    const ifaces = os.networkInterfaces();
    let ip = '127.0.0.1';
    const all = Object.values(ifaces).flat();
    const found = all.find(i => i && i.family === 'IPv4' && !i.internal);
    if (found) ip = found.address;
    res.json({
        version: VERSION,
        ip: ip,
        hostname: os.hostname(),
        port: PORT,
        url: `http://${ip}:${PORT}`,
    });
});

// v1.0.17 新增：日志查看（需鉴权）
app.get('/api/log', auth.requireToken, (req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 200, 2000);
    try {
        if (!fs.existsSync(LOG_FILE)) {
            return res.json({ ok: true, lines: [], total: 0 });
        }
        const data = fs.readFileSync(LOG_FILE, 'utf8');
        const allLines = data.split('\n').filter(l => l.length > 0);
        const tail = allLines.slice(-lines);
        res.json({ ok: true, lines: tail, total: allLines.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 路由挂载
app.use('/api/auth', require('./routes/auth'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/restore', require('./routes/restore'));
app.use('/api/config', require('./routes/config'));
app.use('/api/history', require('./routes/history'));
app.use('/api/notify', require('./routes/notify'));

// 全局错误处理
app.use((err, req, res, next) => {
    logger.error(`express 异常: ${err.message}`);
    res.status(500).json({ error: err.message });
});

// 启动
function main() {
    logger.info(`==== Agent 备份启动 PORT=${PORT} ====`);
    logger.info(`UI 目录: ${UI_DIR}`);

    // 检查 UI/config 文件是否存在（M129）
    // v1.0.17 改：升级为 fatal 检查 + UI 关键文件全检
    const uiCheckFiles = ['index.html'];
    let uiMissing = [];
    for (const f of uiCheckFiles) {
        const fp = path.join(UI_DIR, f);
        if (!fs.existsSync(fp)) uiMissing.push(fp);
    }
    if (uiMissing.length > 0) {
        logger.error(`UI 关键文件缺失（fpk 损坏？）: ${uiMissing.join(', ')}`);
        // 不退出（让 /api/* 仍可用），但显著告警
    }

    // 启动 HTTP server
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`HTTP server 监听 0.0.0.0:${PORT}`);

        // 同步状态机（M99/M100）
        try {
            appdb.syncStatus('running');
        } catch (e) {
            logger.warn(`状态机同步失败: ${e.message}`);
        }

        // 启动 cron 调度
        try {
            cron.start();
        } catch (e) {
            logger.warn(`cron 启动失败: ${e.message}`);
        }
    });
}

// 优雅退出
process.on('SIGTERM', () => {
    logger.info('收到 SIGTERM，准备退出');
    cron.stop();
    appdb.syncStatus('stop');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('收到 SIGINT，准备退出');
    cron.stop();
    appdb.syncStatus('stop');
    process.exit(0);
});

if (require.main === module) {
    main();
}

module.exports = app;
