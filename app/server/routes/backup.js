// routes/backup.js：v1.1.0 备份、下载、导入、详情、trash、预检查
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const auth = require('../lib/auth');
const backup = require('../lib/backup-engine');
const storage = require('../lib/storage');

const requireAuth = auth.requireToken;
const STATUS_FILE = backup.STATUS_FILE;

router.get('/status', requireAuth, (req, res) => {
    try {
        if (!fs.existsSync(STATUS_FILE)) return res.json({ running: false });
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        res.json({ running: status.percent < 100, ...status });
    } catch (e) {
        res.json({ running: false, error: e.message });
    }
});

router.post('/precheck', requireAuth, async (req, res) => {
    try { res.json(await backup.precheck(null, storage.loadConfig())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/run', requireAuth, async (req, res) => {
    try {
        const config = storage.loadConfig();
        const result = await backup.runBackup(config.sources || [], req.body || {});
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/list', requireAuth, (req, res) => {
    try {
        const list = backup.listBackups().filter(b => !req.query.status || b.status === req.query.status);
        res.json({ ok: true, count: list.length, backups: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/detail/:id', requireAuth, (req, res) => {
    try { res.json({ ok: true, backup: backup.getBackup(req.params.id) }); }
    catch (e) { res.status(404).json({ error: e.message }); }
});

router.get('/files/:id', requireAuth, async (req, res) => {
    try { res.json(await backup.listArchiveFiles(req.params.id, Math.min(parseInt(req.query.limit) || 500, 2000))); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/download/:id', (req, res) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token || !auth.verifyToken(token)) return res.status(401).json({ error: '未授权' });
    try {
        const item = backup.getBackup(req.params.id);
        if (!item.exists) return res.status(404).json({ error: `归档文件丢失: ${item.archive}` });
        res.setHeader('Content-Type', 'application/zstd');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.filename || item.id + '.tar.zst')}"`);
        res.setHeader('Content-Length', fs.statSync(item.archive).size);
        fs.createReadStream(item.archive).pipe(res);
    } catch (e) { res.status(404).json({ error: e.message }); }
});

router.post('/import', requireAuth, async (req, res) => {
    const original = path.basename(req.headers['x-import-filename'] || 'imported.tar.zst');
    if (!original.endsWith('.tar.zst')) return res.status(400).json({ error: '只允许导入 .tar.zst 文件' });
    const config = storage.loadConfig();
    const maxBytes = Number(config.storage && config.storage.maxUploadGB || 20) * 1024 * 1024 * 1024;
    storage.ensureDir(storage.TMP_DIR, 0o700);
    const tmp = path.join(storage.TMP_DIR, `import_${process.pid}_${Date.now()}_${original.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    let written = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    req.on('data', chunk => {
        written += chunk.length;
        if (written > maxBytes) {
            req.destroy(new Error('导入文件超过大小限制'));
        }
    });
    req.pipe(out);
    out.on('finish', async () => {
        try {
            const item = await backup.importArchive(tmp, {
                originalFilename: original,
                sourceId: req.headers['x-source-id'] || 'imported',
                sourceName: req.headers['x-source-name'] || '手动导入',
                sha256: req.headers['x-sha256'] || '',
                note: req.headers['x-note'] || ''
            });
            res.json({ ok: true, backup: item });
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
            res.status(400).json({ error: e.message });
        }
    });
    out.on('error', e => res.status(500).json({ error: e.message }));
    req.on('error', e => {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
        if (!res.headersSent) res.status(400).json({ error: e.message });
    });
});

router.post('/trash/:id', requireAuth, (req, res) => {
    try { res.json(backup.trashBackup(req.params.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/protect/:id', requireAuth, (req, res) => {
    try { res.json(backup.setProtected(req.params.id, !!(req.body && req.body.protected))); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/retention/run', requireAuth, async (req, res) => {
    try {
        const config = storage.loadConfig();
        const days = (config.retention && config.retention.days) || 30;
        const cleaned = await backup.applyRetention(days);
        res.json({ ok: true, days, cleaned });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
