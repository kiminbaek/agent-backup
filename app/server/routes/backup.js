// routes/backup.js：v1.1.0 备份、下载、导入、详情、trash、预检查
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');  // v1.1.4 加：Transform 流做导入大小检测
const auth = require('../lib/auth');
const backup = require('../lib/backup-engine');
const storage = require('../lib/storage');
const audit = require('../lib/audit');

const requireAuth = auth.requireToken;
const STATUS_FILE = backup.STATUS_FILE;

function startBackgroundBackup(sources, options) {
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({
            running: true,
            phase: 'queued',
            percent: 0,
            sourceId: sources && sources[0] && sources[0].id,
            sourceName: sources && sources[0] && sources[0].name,
            ts: Date.now()
        }, null, 2));
    } catch (_) { /* ignore */ }
    setImmediate(() => backup.runBackup(sources, options || {}).catch(e => {
        try {
            fs.writeFileSync(STATUS_FILE, JSON.stringify({
                running: false, phase: 'error', percent: 100, error: e.message, ts: Date.now()
            }, null, 2));
        } catch (_) { /* ignore */ }
        console.error('[backup-background] failed:', e);
    }));
}

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

router.post('/run', requireAuth, (req, res) => {
    try {
        const config = storage.loadConfig();
        startBackgroundBackup(config.sources || [], req.body || {});
        res.json({ ok: true, started: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/list', requireAuth, (req, res) => {
    try {
        const list = backup.listBackups({
            status: req.query.status || '',
            includeTrashed: req.query.includeTrashed === '1' || req.query.includeTrashed === 'true',
            includeDeleted: req.query.includeDeleted === '1' || req.query.includeDeleted === 'true'
        });
        res.json({ ok: true, count: list.length, backups: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/detail/:id', requireAuth, (req, res) => {
    try { res.json({ ok: true, backup: backup.getBackup(req.params.id) }); }
    catch (e) { res.status(404).json({ error: e.message }); }
});

router.get('/files/:id', requireAuth, async (req, res) => {
    try { res.json(await backup.listArchiveFiles(req.params.id, Math.min(parseInt(req.query.limit) || 500, 2000), req.query.password || '')); }
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
    // v1.1.4 修：Transform 流替代 req.on('data') + req.pipe(out)（Bug #4）
    //   旧版二者并发消费，req.destroy() 后 out.finish 不触发 → 响应丢失
    let written = 0;
    const sizeChecker = new Transform({
        transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > maxBytes) {
                callback(new Error(`导入文件超过大小限制 (${maxBytes} bytes)`));
            } else {
                callback(null, chunk);
            }
        }
    });
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    req.pipe(sizeChecker).pipe(out);
    function cleanup() {
        try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
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
            cleanup();
            if (!res.headersSent) res.status(400).json({ error: e.message });
        }
    });
    sizeChecker.on('error', e => {
        cleanup();
        if (!res.headersSent) res.status(400).json({ error: e.message });
    });
    out.on('error', e => {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: e.message });
    });
    req.on('error', e => {
        cleanup();
        if (!res.headersSent) res.status(400).json({ error: e.message });
    });
});

router.post('/protect/:id', requireAuth, (req, res) => {
    try { res.json(backup.setProtected(req.params.id, !!(req.body && req.body.protected))); }
    catch (e) { res.status(400).json({ error: e.message }); }
});



router.patch('/meta/:id', requireAuth, (req, res) => {
    try { const r = backup.updateBackupMeta(req.params.id, req.body || {}); audit.write('backup.meta', { id: req.params.id, patch: req.body || {} }); res.json({ ok: true, backup: r }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/trash/list', requireAuth, (req, res) => {
    try { const items = backup.listTrash(); res.json({ ok: true, count: items.length, backups: items }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/trash/stats', requireAuth, (req, res) => {
    try { res.json(backup.trashStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/trash/restore/:id', requireAuth, (req, res) => {
    try { const r = backup.restoreTrash(req.params.id); audit.write('trash.restore', { id: req.params.id }); res.json(r); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/trash/delete/:id', requireAuth, (req, res) => {
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: '永久删除需要输入 DELETE' });
    try { const r = backup.deleteTrash(req.params.id, { forceProtected: !!req.body.forceProtected }); audit.write('trash.delete', { id: req.params.id, freedBytes: r.freedBytes }); res.json(r); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/trash/empty', requireAuth, (req, res) => {
    if (!req.body || req.body.confirm !== 'EMPTY') return res.status(400).json({ error: '清空回收站需要输入 EMPTY' });
    try { const r = backup.emptyTrash({ forceProtected: !!req.body.forceProtected }); audit.write('trash.empty', { deleted: r.deleted, skipped: r.skipped, freedBytes: r.freedBytes }); res.json(r); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/trash/cleanup', requireAuth, (req, res) => {
    try { const r = backup.cleanupTrash(req.body && req.body.days); audit.write('trash.cleanup', r); res.json(r); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/scan/large-files', requireAuth, (req, res) => {
    try { res.json(backup.scanLargeFiles(req.body && req.body.path, req.body && req.body.limit)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/wizard/scan', requireAuth, (req, res) => {
    try { res.json(backup.wizardScan(req.body && req.body.path, req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/wizard/estimate', requireAuth, (req, res) => {
    try { res.json(backup.estimateWizard(req.body && req.body.path, req.body && req.body.excludes)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/wizard/run', requireAuth, (req, res) => {
    try {
        const body = req.body || {};
        const source = { id: body.id || `wizard-${Date.now()}`, name: body.name || '备份向导', path: body.path, enabled: true, include: ['*'], exclude: Array.isArray(body.excludes) ? body.excludes : [] };
        startBackgroundBackup([source], { manual: true, wizard: true });
        res.json({ ok: true, started: true, sourceId: source.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/recommended/excludes', requireAuth, (req, res) => {
    try { res.json({ ok: true, excludes: backup.recommendedExcludes() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/size/anomaly', requireAuth, (req, res) => {
    try { res.json(backup.sizeAnomalyReport(req.body && req.body.sourceId, Number(req.body && req.body.currentSize || 0))); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/trash/:id', requireAuth, (req, res) => {
    try { const r = backup.trashBackup(req.params.id); audit.write('trash.move', { id: req.params.id }); res.json(r); }
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
