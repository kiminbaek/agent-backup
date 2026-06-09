// storage.js：v1.1.0 统一存储配置、元数据、分类整理、trash
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_NAME = 'com.dustinky.agentbackup';
const APP_DATA_DIR = '/vol3/@appdata/com.dustinky.agentbackup';
const CONFIG_FILE = path.join(APP_DATA_DIR, 'config/config.json');
const TMP_DIR = path.join(APP_DATA_DIR, 'tmp');
const DEFAULT_BACKUP_ROOT = path.join(APP_DATA_DIR, 'backups');
const ALLOWED_ROOTS = ['/vol3/@appshare/', '/vol3/@appdata/', '/vol3/1000/'];

function ensureDir(dir, mode) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (mode) {
        try { fs.chmodSync(dir, mode); } catch (_) { /* ignore */ }
    }
}

function atomicWriteJson(file, obj, mode) {
    ensureDir(path.dirname(file), 0o700);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (mode) {
        try { fs.chmodSync(tmp, mode); } catch (_) { /* ignore */ }
    }
    fs.renameSync(tmp, file);
}

function defaultConfig() {
    return {
        sources: [{
            id: 'src-001',
            name: '默认备份源（示例）',
            path: '/vol3/1000/nas',
            enabled: false,
            include: ['*.md', '*.json', '*.txt'],
            exclude: ['node_modules', '.git', '*.log', '*.tmp']
        }],
        schedule: '0 3 * * *',
        storage: {
            root: DEFAULT_BACKUP_ROOT,
            layout: 'year-month-source',
            trashDays: 7,
            maxUploadGB: 20
        },
        retention: {
            days: 30,
            keepLast: 10,
            maxTotalSizeGB: 100,
            warnRatio: 1.5
        },
        notify: {
            enabled: false,
            onSuccess: true,
            onFailure: true,
            onNoSource: true,
            channels: {
                qq: { enabled: false, url: '' },
                feiniu: { enabled: false, url: '' },
                email: { enabled: false, smtp: '', user: '', note: 'v1.1.0 暂未启用邮件发送' }
            }
        }
    };
}

function normalizeConfig(config) {
    const d = defaultConfig();
    const c = Object.assign({}, d, config || {});
    c.sources = Array.isArray(c.sources) ? c.sources : [];
    c.schedule = c.schedule || d.schedule;
    c.storage = Object.assign({}, d.storage, c.storage || {});
    c.retention = Object.assign({}, d.retention, c.retention || {});
    // 兼容 v1.0.x notify.qq.url / notify.feiniu.url
    const oldNotify = c.notify || {};
    const channels = Object.assign({}, d.notify.channels, oldNotify.channels || {});
    if (oldNotify.qq && oldNotify.qq.url) channels.qq = Object.assign({}, channels.qq, { enabled: true, url: oldNotify.qq.url });
    if (oldNotify.feiniu && oldNotify.feiniu.url) channels.feiniu = Object.assign({}, channels.feiniu, { enabled: true, url: oldNotify.feiniu.url });
    c.notify = Object.assign({}, d.notify, oldNotify, { channels });
    delete c.notify.qq;
    delete c.notify.feiniu;
    delete c.notify.email;
    return c;
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
}

function saveConfig(config) {
    atomicWriteJson(CONFIG_FILE, normalizeConfig(config), 0o600);
}

function pathAllowed(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    if (targetPath.split('/').includes('..')) return false;
    const abs = path.resolve(targetPath);
    try {
        const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
        return ALLOWED_ROOTS.some(root => real.startsWith(root));
    } catch (_) {
        return ALLOWED_ROOTS.some(root => abs.startsWith(root));
    }
}

function validateBackupRoot(root, create) {
    if (!root || typeof root !== 'string') return { ok: false, error: '缺少备份目录' };
    const abs = path.resolve(root);
    if (!pathAllowed(abs)) return { ok: false, error: '备份目录不在白名单内' };
    try {
        if (!fs.existsSync(abs)) {
            if (!create) return { ok: false, exists: false, error: '目录不存在' };
            fs.mkdirSync(abs, { recursive: true });
        }
        const st = fs.statSync(abs);
        if (!st.isDirectory()) return { ok: false, error: '路径不是目录' };
        fs.accessSync(abs, fs.constants.W_OK | fs.constants.R_OK);
        return { ok: true, path: abs, exists: true, free: getFreeBytes(abs) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function getBackupRoot(config) {
    const c = normalizeConfig(config || loadConfig());
    return path.resolve(c.storage.root || DEFAULT_BACKUP_ROOT);
}

function getMetaFile(config) {
    return path.join(getBackupRoot(config), 'index.json');
}

function ensureBackupRoot(config) {
    const root = getBackupRoot(config);
    const v = validateBackupRoot(root, true);
    if (!v.ok) throw new Error(v.error);
    ensureDir(path.join(root, '.trash'), 0o700);
    return root;
}

function loadMeta(config) {
    const root = ensureBackupRoot(config);
    const file = path.join(root, 'index.json');
    if (!fs.existsSync(file)) return { version: 2, backups: [] };
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.version = meta.version || 1;
    meta.backups = Array.isArray(meta.backups) ? meta.backups : [];
    return meta;
}

function saveMeta(meta, config) {
    const file = getMetaFile(config);
    meta.version = 2;
    meta.backups = Array.isArray(meta.backups) ? meta.backups : [];
    atomicWriteJson(file, meta, 0o600);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function sourceSafe(sourceId) {
    return String(sourceId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function archiveDirFor(sourceId, ts, config) {
    const root = ensureBackupRoot(config);
    const c = normalizeConfig(config || loadConfig());
    if (c.storage.layout === 'flat') return root;
    const d = ts instanceof Date ? ts : new Date(ts || Date.now());
    return path.join(root, String(d.getFullYear()), pad2(d.getMonth() + 1), sourceSafe(sourceId));
}

function archivePathFor(sourceId, id, ts, config) {
    const dir = archiveDirFor(sourceId, ts, config);
    ensureDir(dir, 0o700);
    return path.join(dir, `${id}.tar.zst`);
}

function trashPathFor(file, config) {
    const root = ensureBackupRoot(config);
    const name = path.basename(file);
    return path.join(root, '.trash', `${Date.now()}_${name}`);
}

function getFreeBytes(dir) {
    try {
        const out = execFileSync('df', ['-B1', dir], { encoding: 'utf8' }).trim().split('\n').pop();
        const cols = out.trim().split(/\s+/);
        return parseInt(cols[3], 10) || 0;
    } catch (_) {
        return 0;
    }
}

function dirSizeBytes(dir) {
    try {
        const out = execFileSync('du', ['-sb', dir], { encoding: 'utf8' }).trim();
        return parseInt(out.split(/\s+/)[0], 10) || 0;
    } catch (_) {
        return 0;
    }
}

function humanSize(bytes) {
    let n = Number(bytes || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function enrichBackup(b, config) {
    const exists = !!(b.archive && fs.existsSync(b.archive));
    let stat = null;
    if (exists) {
        try { stat = fs.statSync(b.archive); } catch (_) { stat = null; }
    }
    return Object.assign({}, b, {
        filename: b.archive ? path.basename(b.archive) : '',
        backupRoot: getBackupRoot(config),
        exists,
        size: stat ? stat.size : (b.size || 0),
        sizeHuman: humanSize(stat ? stat.size : (b.size || 0)),
        createdAt: new Date(b.timestamp || 0).toLocaleString('zh-CN', { hour12: false }),
        mtime: stat ? stat.mtimeMs : null,
        health: b.status === 'trashed' ? 'trashed' : (!exists ? 'missing' : (b.verifiedAt ? 'ok' : 'unchecked'))
    });
}

function storageInfo(config) {
    const c = normalizeConfig(config || loadConfig());
    const root = ensureBackupRoot(c);
    const meta = loadMeta(c);
    const total = meta.backups.reduce((sum, b) => sum + (b.status === 'success' && b.archive && fs.existsSync(b.archive) ? fs.statSync(b.archive).size : 0), 0);
    return {
        ok: true,
        root,
        layout: c.storage.layout,
        trashDays: c.storage.trashDays,
        count: meta.backups.length,
        successCount: meta.backups.filter(b => b.status === 'success').length,
        totalSize: total,
        totalSizeHuman: humanSize(total),
        free: getFreeBytes(root),
        freeHuman: humanSize(getFreeBytes(root))
    };
}

function organize(config) {
    const c = normalizeConfig(config || loadConfig());
    const meta = loadMeta(c);
    let moved = 0, skipped = 0, failed = 0;
    const errors = [];
    for (const b of meta.backups) {
        if (b.status !== 'success' || !b.archive || !fs.existsSync(b.archive)) { skipped++; continue; }
        try {
            const target = archivePathFor(b.sourceId || 'imported', b.id, b.timestamp || Date.now(), c);
            if (path.resolve(target) === path.resolve(b.archive)) { skipped++; continue; }
            if (fs.existsSync(target)) throw new Error(`目标已存在: ${target}`);
            fs.renameSync(b.archive, target);
            b.archive = target;
            moved++;
        } catch (e) {
            failed++;
            errors.push(`${b.id}: ${e.message}`);
        }
    }
    saveMeta(meta, c);
    return { ok: failed === 0, moved, skipped, failed, errors };
}

module.exports = {
    APP_NAME, APP_DATA_DIR, CONFIG_FILE, TMP_DIR, DEFAULT_BACKUP_ROOT, ALLOWED_ROOTS,
    ensureDir, atomicWriteJson, defaultConfig, normalizeConfig, loadConfig, saveConfig,
    pathAllowed, validateBackupRoot, getBackupRoot, getMetaFile, ensureBackupRoot,
    loadMeta, saveMeta, archivePathFor, archiveDirFor, trashPathFor,
    getFreeBytes, dirSizeBytes, humanSize, enrichBackup, storageInfo, organize
};
