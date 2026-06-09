// routes/history.js：备份历史查询
const express = require('express');
const router = express.Router();
const fs = require('fs');
const auth = require('../lib/auth');
const backup = require('../lib/backup-engine');

// v1.0.17 改：统一使用 lib/auth 的 requireToken 中间件
const requireAuth = auth.requireToken;

// GET /api/history?limit=50&source=src-001
router.get('/', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const sourceFilter = req.query.source;

    try {
        const meta = backup.loadMeta();
        let list = meta.backups.slice();
        if (sourceFilter) {
            list = list.filter(b => b.sourceId === sourceFilter);
        }
        list = list.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
        res.json({ ok: true, count: list.length, history: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
