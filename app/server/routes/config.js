// routes/config.js：读写 config.json
const express = require('express');
const router = express.Router();
const fs = require('fs');
const auth = require('../lib/auth');
const cron = require('../lib/cron-engine');
const validators = require('../lib/validators');
const logger = require('../lib/logger');

// v1.0.20 改：CONFIG_FILE 走 lib/backup-engine 的常量（不再写死）
const { CONFIG_FILE } = require('../lib/backup-engine');

// v1.0.17 改：统一使用 lib/auth 的 requireToken 中间件
const requireAuth = auth.requireToken;

// GET /api/config
router.get('/', requireAuth, (req, res) => {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            return res.json({ sources: [], schedule: '0 3 * * *' });
        }
        res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/config
router.post('/', requireAuth, (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
        return res.status(400).json({ error: 'config 必须是对象' });
    }

    // v1.0.20 改：用 validateSourcesBatch 统一校验（id 唯一性 + 路径不重复）
    if (Array.isArray(newConfig.sources)) {
        const v = validators.validateSourcesBatch(newConfig.sources);
        if (!v.valid) {
            return res.status(400).json({ error: v.errors.join('; ') });
        }
    }

    try {
        // v1.0.20 改：atomic write（tmp + rename）
        const tmp = CONFIG_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(newConfig, null, 2));
        try { fs.chmodSync(tmp, 0o600); } catch (_) { /* ignore */ }
        fs.renameSync(tmp, CONFIG_FILE);
        // 重新加载 cron
        if (newConfig.schedule) {
            cron.updateSchedule(newConfig.schedule);
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
