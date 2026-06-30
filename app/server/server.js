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
const VERSION = '2.11.0'; // 时光机闭环：Diff 弹窗支持恢复旧版本单文件，restoreFile 兼容 work_<id> 前缀解析
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

function readTailLines(file, lines) {
    if (!file || !fs.existsSync(file)) {
        return { exists: false, path: file || '', lines: [], total: 0 };
    }
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
        const start = Math.max(0, stat.size - 512 * 1024);
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const allLines = buf.toString('utf8').split('\n').filter(l => l.length > 0);
        return { exists: true, path: file, lines: allLines.slice(-lines), total: allLines.length, size: stat.size };
    } finally {
        fs.closeSync(fd);
    }
}

function logFileByType(type) {
    const t = String(type || 'server');
    if (t === 'backup') return logger.BACKUP_LOG;
    if (t === 'audit') return path.join('/vol3/@appdata/com.dustinky.agentbackup/logs', 'audit.log');
    if (t === 'cmd') return path.join('/vol3/@appdata/com.dustinky.agentbackup', 'info.log');
    return logger.SERVER_LOG;
}

// v1.2.0 日志中心（需鉴权）：server / backup / cmd / audit
app.get('/api/logs', auth.requireToken, (req, res) => {
    const type = String(req.query.type || 'server');
    const lines = Math.min(parseInt(req.query.lines) || 200, 2000);
    try {
        const result = readTailLines(logFileByType(type), lines);
        res.json({ ok: true, type, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 兼容旧前端：默认读取运行日志
app.get('/api/log', auth.requireToken, (req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 200, 2000);
    try { res.json({ ok: true, ...readTailLines(logger.SERVER_LOG, lines) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
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
app.use('/api/qwenpaw', require('./routes/qwenpaw'));

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
    const uiCheckFiles = ['index.html', 'css/style.css', 'lib/api.js', 'lib/app.js'];
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
