// notifier.js：v1.1.0 可配置 QQ/飞牛 webhook 通知，email 明确暂未启用
const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger');
const storage = require('./storage');
const smtp = require('./smtp');

const SUPPRESS_WINDOW = 5 * 60 * 1000;
const MAX_ALERTS_CACHE = 100;
const recentAlerts = new Map();

function trimAlerts() {
    const now = Date.now();
    for (const [k, t] of recentAlerts.entries()) {
        if (now - t >= SUPPRESS_WINDOW) recentAlerts.delete(k);
    }
    while (recentAlerts.size > MAX_ALERTS_CACHE) {
        recentAlerts.delete(recentAlerts.keys().next().value);
    }
}

function postJson(urlStr, data) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const mod = url.protocol === 'http:' ? http : https;
        const req = mod.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

function shouldSend(config, event) {
    const n = config.notify || {};
    if (!n.enabled) return false;
    if (event === 'success' && n.onSuccess === false) return false;
    if (event === 'failure' && n.onFailure === false) return false;
    if (event === 'nosource' && n.onNoSource === false) return false;
    return true;
}

async function sendOne(channel, target, payload) {
    if (!target || !target.enabled) return { channel, ok: false, skipped: true, error: '未启用' };
    if (channel === 'email') {
        // v2.6.0：真实 SMTP 发送（lib/smtp.js）
        if (!target.host || !target.user || !target.to) {
            return { channel, ok: false, skipped: true, error: '邮件配置不完整（需 host/user/to）' };
        }
        try {
            const res = await smtp.sendMail({
                host: target.host,
                port: target.port,
                secure: target.secure !== false && (Number(target.port) === 465 || target.secure === true),
                user: target.user,
                pass: target.pass || target.password || '',
                from: target.from || target.user,
                fromName: target.fromName || '智能体时光机',
                to: target.to,
                subject: target.subject || '智能体时光机通知',
                text: payload,
            });
            return { channel, ok: !!res.ok, accepted: res.accepted };
        } catch (e) {
            logger.warn(`邮件通知失败: ${e.message}`);
            return { channel, ok: false, error: e.message };
        }
    }
    if (!target.url) return { channel, ok: false, skipped: true, error: 'URL 为空' };
    try {
        const data = channel === 'qq'
            ? JSON.stringify({ msg_type: 'text', content: { text: payload } })
            : JSON.stringify({ title: '智能体时光机', content: payload });
        const res = await postJson(target.url, data);
        const ok = res.status >= 200 && res.status < 300;
        return { channel, ok, status: res.status, body: String(res.body || '').slice(0, 500) };
    } catch (e) {
        logger.warn(`通知失败 channel=${channel}: ${e.message}`);
        return { channel, ok: false, error: e.message };
    }
}

async function notify(payload, event) {
    trimAlerts();
    const config = storage.loadConfig();
    const ev = event || 'failure';
    if (!shouldSend(config, ev)) return { ok: false, skipped: true, error: '通知未启用或场景关闭', results: [] };

    const key = ev + ':' + payload;
    const now = Date.now();
    if (recentAlerts.has(key) && now - recentAlerts.get(key) < SUPPRESS_WINDOW) {
        return { ok: false, skipped: true, error: '5 分钟内重复通知已抑制', results: [] };
    }
    recentAlerts.set(key, now);

    const channels = (config.notify && config.notify.channels) || {};
    const order = ['qq', 'feiniu', 'email'];
    const results = [];
    for (const ch of order) results.push(await sendOne(ch, channels[ch], payload));
    return { ok: results.some(r => r.ok), results };
}

function getConfig() {
    const config = storage.loadConfig();
    return config.notify || storage.defaultConfig().notify;
}

function saveNotifyConfig(notify) {
    const config = storage.loadConfig();
    config.notify = storage.normalizeConfig({ notify }).notify;
    storage.saveConfig(config);
    return config.notify;
}

module.exports = { notify, sendOne, getConfig, saveNotifyConfig };
