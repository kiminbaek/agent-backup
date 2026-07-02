// server.js：智能体时光机 Express 入口
const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./lib/logger');
const cron = require('./lib/cron-engine');
const appdb = require('./lib/appdb-sync');
const auth = require('./lib/auth');

const PORT = 12083;
const VERSION = '2.22.0'; // 备份结果8秒自动收起+关闭按钮; 恢复智能探测QwenPaw路径+预检两步流程+恢复前快照; 修复禁用加密源误触发校验+通用恢复自动建目录
const UI_DIR = path.join(__dirname, '..', 'ui');
const LOG_FILE = logger.SERVER_LOG;
const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
// 安全响应头
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
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

// 应用信息（版本号 + 探测到的 QwenPaw 数据目录，供恢复默认路径用；不泄露 IP/hostname）
app.get('/api/info', auth.requireToken, (req, res) => {
    res.json({ version: VERSION, qwenpaw: detectQwenpawRoot() });
});

// 探测 QwenPaw 数据根目录（.qwenpaw），返回候选与推荐值。用于恢复时智能填默认目标路径。
// 不写死单一路径：优先环境变量，其次常见安装位置，校验其下是否含 workspaces / config.json。
function detectQwenpawRoot() {
    const candidates = [];
    const push = (p, source) => { if (p && !candidates.some(c => c.path === path.resolve(p))) candidates.push({ path: path.resolve(p), source }); };
    // 1) 环境变量（若 QwenPaw 有导出）
    if (process.env.QWENPAW_DATA_DIR) push(process.env.QWENPAW_DATA_DIR, 'env:QWENPAW_DATA_DIR');
    if (process.env.QWENPAW_HOME) push(path.join(process.env.QWENPAW_HOME, '.qwenpaw'), 'env:QWENPAW_HOME');
    // 2) 常见安装位置（飞牛 fnOS 默认）
    push('/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw', 'fnos-appshare');
    // 3) 从本应用数据目录反推同级 appshare
    for (const base of ['/vol1', '/vol2', '/vol3', '/vol4']) {
        push(path.join(base, '@appshare/com.dustinky.qwenpaw/.qwenpaw'), 'scan-vol');
    }
    // 4) 用户家目录
    if (process.env.HOME) push(path.join(process.env.HOME, '.qwenpaw'), 'home');

    const results = candidates.map(c => {
        let exists = false, hasWorkspaces = false, hasConfig = false, agents = 0;
        try {
            exists = fs.existsSync(c.path) && fs.statSync(c.path).isDirectory();
            if (exists) {
                const ws = path.join(c.path, 'workspaces');
                hasWorkspaces = fs.existsSync(ws) && fs.statSync(ws).isDirectory();
                hasConfig = fs.existsSync(path.join(c.path, 'config.json'));
                if (hasWorkspaces) {
                    try { agents = fs.readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory()).length; } catch (_) { /* ignore */ }
                }
            }
        } catch (_) { /* ignore */ }
        // 打分：存在+有workspaces 最高
        const score = (exists ? 1 : 0) + (hasWorkspaces ? 4 : 0) + (hasConfig ? 2 : 0) + Math.min(agents, 5) * 0.1;
        return { path: c.path, source: c.source, exists, hasWorkspaces, hasConfig, agents, score };
    });
    results.sort((a, b) => b.score - a.score);
    const best = results.find(r => r.score > 0) || results[0] || null;
    return {
        root: best ? best.path : '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw',
        workspaces: best ? path.join(best.path, 'workspaces') : '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces',
        detected: !!(best && best.hasWorkspaces),
        agents: best ? best.agents : 0,
        candidates: results.filter(r => r.exists)
    };
}

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
        res.status(500).json({ error: '服务器内部错误' });
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
    res.status(500).json({ error: '服务器内部错误' });
});

// 启动
function main() {
    logger.info(`==== 智能体时光机启动 PORT=${PORT} ====`);
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
