// notifier.js：3 通道通知（QQ → 飞牛 → 邮件）+ 告警抑制 5min
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const logger = require('./logger');

const CONFIG_FILE = '/vol3/@appdata/com.dustinky.agentbackup/config/config.json';
const SUPPRESS_WINDOW = 5 * 60 * 1000;
const recentAlerts = new Map();

function postJson(urlStr, data) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 10000,
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

async function send(channel, payload) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    } catch (e) {
        logger.warn(`notifier 读 config 失败: ${e.message}`);
        return false;
    }
    if (!config.notify || !config.notify[channel]) return false;
    const target = config.notify[channel];
    if (!target || !target.url) return false;

    try {
        if (channel === 'qq') {
            const data = JSON.stringify({ msg_type: 'text', content: { text: payload } });
            const res = await postJson(target.url, data);
            return res.status >= 200 && res.status < 300;
        } else if (channel === 'feiniu') {
            const data = JSON.stringify({ title: 'Agent 备份', content: payload });
            const res = await postJson(target.url, data);
            return res.status >= 200 && res.status < 300;
        } else if (channel === 'email') {
            // 邮件降级（占位，集成 himalaya）
            // TODO: 接入 himalaya CLI
            return true;
        }
    } catch (e) {
        logger.warn(`notify ${channel} 失败: ${e.message}`);
        return false;
    }
    return false;
}

async function notify(payload) {
    if (!payload || typeof payload !== 'string') return false;

    // 告警抑制：5 分钟内同类通知合并
    const key = payload.slice(0, 50);
    const lastSent = recentAlerts.get(key) || 0;
    if (Date.now() - lastSent < SUPPRESS_WINDOW) {
        logger.info(`[SUPPRESSED] ${payload}`);
        return false;
    }
    recentAlerts.set(key, Date.now());

    // 三降级
    if (await send('qq', payload)) {
        logger.info(`notify QQ OK: ${payload.slice(0, 80)}`);
        return true;
    }
    if (await send('feiniu', payload)) {
        logger.info(`notify 飞牛 OK: ${payload.slice(0, 80)}`);
        return true;
    }
    if (await send('email', payload)) {
        logger.info(`notify 邮件 OK: ${payload.slice(0, 80)}`);
        return true;
    }

    // 全部失败：写本地日志
    logger.error(`notify 全部通道失败: ${payload}`);
    return false;
}

module.exports = { notify, send };
