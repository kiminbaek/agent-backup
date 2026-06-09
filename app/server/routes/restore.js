// routes/restore.js：列出可用备份、校验、执行恢复
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const restore = require('../lib/restore');

// v1.0.17 改：统一使用 lib/auth 的 requireToken 中间件
const requireAuth = auth.requireToken;

// GET /api/restore/list
router.get('/list', requireAuth, (req, res) => {
    try {
        const list = restore.list();
        res.json({ ok: true, count: list.length, backups: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/restore/verify/:id
router.get('/verify/:id', requireAuth, async (req, res) => {
    try {
        const result = await restore.verify(req.params.id);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/restore/execute
router.post('/execute', requireAuth, async (req, res) => {
    const { id, targetPath, confirm } = req.body || {};
    if (!id || !targetPath) {
        return res.status(400).json({ error: '缺少 id 或 targetPath' });
    }
    if (confirm !== 'YES') {
        return res.status(400).json({ error: '需在 confirm 字段输入 "YES" 二次确认' });
    }
    try {
        const result = await restore.restore(id, targetPath);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
