// routes/config.js：读写 config.json
const express = require('express');
const router = express.Router();
const fs = require('fs');
const auth = require('../lib/auth');
const cron = require('../lib/cron-engine');
const validators = require('../lib/validators');
const logger = require('../lib/logger');

const CONFIG_FILE = '/vol3/@appdata/com.dustinky.agentbackup/config/config.json';

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

    // 校验每个源
    if (Array.isArray(newConfig.sources)) {
        for (const s of newConfig.sources) {
            if (s.enabled) {
                const v = validators.validateSource(s);
                if (!v.valid) {
                    return res.status(400).json({ error: `源 ${s.id} 校验失败: ${v.errors.join(', ')}` });
                }
            }
        }
    }

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        fs.chmodSync(CONFIG_FILE, 0o600);
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
