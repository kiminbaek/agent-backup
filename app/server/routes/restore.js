// routes/restore.js：v1.1.0 列出、校验、预览、执行恢复
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const restore = require('../lib/restore');

const requireAuth = auth.requireToken;

router.get('/list', requireAuth, (req, res) => {
    try { res.json({ ok: true, count: restore.list().length, backups: restore.list() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/verify/:id', requireAuth, async (req, res) => {
    try { res.json(await restore.verify(req.params.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/preview', requireAuth, async (req, res) => {
    const { id, targetPath } = req.body || {};
    if (!id || !targetPath) return res.status(400).json({ error: '缺少 id 或 targetPath' });
    try { res.json(await restore.preview(id, targetPath)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/execute', requireAuth, async (req, res) => {
    const { id, targetPath, confirm } = req.body || {};
    if (!id || !targetPath) return res.status(400).json({ error: '缺少 id 或 targetPath' });
    if (confirm !== 'YES') return res.status(400).json({ error: '需在 confirm 字段输入 "YES" 二次确认' });
    try { res.json(await restore.restore(id, targetPath)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
