// routes/config.js：v1.1.0 读写配置 + 导入导出
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const cron = require('../lib/cron-engine');
const validators = require('../lib/validators');
const storage = require('../lib/storage');

const requireAuth = auth.requireToken;
const CONFIG_FILE = storage.CONFIG_FILE;

router.get('/', requireAuth, (req, res) => {
    try { res.json(storage.loadConfig()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') return res.status(400).json({ error: 'config 必须是对象' });
    if (Array.isArray(newConfig.sources)) {
        const v = validators.validateSourcesBatch(newConfig.sources);
        if (!v.valid) return res.status(400).json({ error: v.errors.join('; ') });
    }
    try {
        storage.saveConfig(newConfig);
        if (newConfig.schedule) cron.updateSchedule(newConfig.schedule);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export', requireAuth, (req, res) => {
    try {
        const config = storage.loadConfig();
        if (req.query.mask !== 'false' && config.notify && config.notify.channels) {
            for (const ch of Object.values(config.notify.channels)) {
                if (ch.url) ch.url = ch.url.slice(0, 12) + '***MASKED***';
            }
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="agent-backup-config.json"');
        res.end(JSON.stringify(config, null, 2));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/import', requireAuth, (req, res) => {
    try {
        const config = storage.normalizeConfig(req.body || {});
        if (Array.isArray(config.sources)) {
            const v = validators.validateSourcesBatch(config.sources);
            if (!v.valid) return res.status(400).json({ error: v.errors.join('; ') });
        }
        storage.saveConfig(config);
        res.json({ ok: true, config });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
