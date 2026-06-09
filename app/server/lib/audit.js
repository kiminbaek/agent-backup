// audit.js：v1.1.3 操作审计日志
const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const AUDIT_FILE = path.join(storage.APP_DATA_DIR, 'logs/audit.log');

function write(action, detail) {
    try {
        storage.ensureDir(path.dirname(AUDIT_FILE), 0o700);
        const rec = {
            ts: Date.now(),
            time: new Date().toISOString(),
            action,
            detail: detail || {}
        };
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
        return rec;
    } catch (_) {
        return null;
    }
}

function list(limit) {
    const n = Math.min(parseInt(limit, 10) || 200, 2000);
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const text = fs.readFileSync(AUDIT_FILE, 'utf8');
    return text.split('\n').filter(Boolean).slice(-n).map(line => {
        try { return JSON.parse(line); } catch (_) { return { raw: line }; }
    }).reverse();
}

module.exports = { AUDIT_FILE, write, list };
