// routes/backup.js：触发备份、列出备份
const express = require('express');
const router = express.Router();
const fs = require('fs');
const auth = require('../lib/auth');
const backup = require('../lib/backup-engine');

// v1.0.17 改：统一使用 lib/auth 的 requireToken 中间件
const requireAuth = auth.requireToken;

// POST /api/backup/run：手动触发备份
router.post('/run', requireAuth, async (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync('/vol3/@appdata/com.dustinky.agentbackup/config/config.json', 'utf8'));
        const result = await backup.runBackup(config.sources || []);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/backup/list：列出所有备份
router.get('/list', requireAuth, (req, res) => {
    try {
        const meta = backup.loadMeta();
        const list = meta.backups
            .filter(b => b.status === 'success')
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(b => ({
                id: b.id,
                sourceId: b.sourceId,
                sourceName: b.sourceName,
                size: b.size,
                timestamp: b.timestamp,
                sha256: b.sha256,
            }));
        res.json({ ok: true, count: list.length, backups: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/backup/retention/run：手动执行保留策略
router.post('/retention/run', requireAuth, async (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync('/vol3/@appdata/com.dustinky.agentbackup/config/config.json', 'utf8'));
        const days = (config.retention && config.retention.days) || 30;
        const cleaned = await backup.applyRetention(days);
        res.json({ ok: true, days, cleaned });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
