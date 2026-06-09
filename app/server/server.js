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
const VERSION = '1.1.3'; // v1.1.3 改：回收站闭环/恢复安全/审计/备注标签/模板/大文件扫描
const UI_DIR = path.join(__dirname, '..', 'ui');
const LOG_FILE = logger.SERVER_LOG;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(UI_DIR, { index: 'index.html' }));

// v1.0.20 改：IP 维度 rate limit（防 /api/auth/login 暴力破解）
const rateLimitMap = new Map();
function rateLimit(maxPerMinute, maxPerHour) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        const rec = rateLimitMap.get(ip) || { min: [], hour: [] };
        rec.min = rec.min.filter(t => now - t < 60 * 1000);
        rec.hour = rec.hour.filter(t => now - t < 60 * 60 * 1000);
        if (rec.min.length >= maxPerMinute) {
            return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        }
        if (rec.hour.length >= maxPerHour) {
            return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        }
        rec.min.push(now);
        rec.hour.push(now);
        rateLimitMap.set(ip, rec);
        // 定期清理过期 IP 记录
        if (rateLimitMap.size > 1000) {
            for (const [k, v] of rateLimitMap.entries()) {
                if (v.min.length === 0 && v.hour.length === 0) rateLimitMap.delete(k);
            }
        }
        next();
    };
}
// 登录接口限流：10 次/分钟, 50 次/小时
app.use('/api/auth/login', rateLimit(10, 50));
app.use('/api/auth/setup', rateLimit(5, 20));

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
        // v1.0.20 改：大日志只读末尾 256KB（避免 readFileSync 卡死）
        const stat = fs.statSync(LOG_FILE);
        const fd = fs.openSync(LOG_FILE, 'r');
        const start = Math.max(0, stat.size - 256 * 1024);
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const text = buf.toString('utf8');
        const allLines = text.split('\n').filter(l => l.length > 0);
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
app.use('/api/storage', require('./routes/storage'));
app.use('/api/audit', require('./routes/audit'));

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

// 优雅退出（v1.0.20 修：先等 DB 写完再退出，避免 SIGTERM 同步 DB 写不进去）
async function gracefulExit(signal) {
    logger.info(`收到 ${signal}，准备退出`);
    try { cron.stop(); } catch (_) { /* ignore */ }
    try {
        const ok = await new Promise(resolve => {
            // 200ms 限时写 DB
            const t = setTimeout(() => resolve(false), 200);
            try {
                const result = appdb.syncStatus('stop');
                clearTimeout(t);
                resolve(result);
            } catch (e) { clearTimeout(t); resolve(false); }
        });
        if (!ok) logger.warn('DB 状态同步超时，进程直接退出');
    } catch (e) { /* ignore */ }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

if (require.main === module) {
    main();
}

module.exports = app;
