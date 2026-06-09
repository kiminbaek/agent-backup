// routes/notify.js：测试通知
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const notifier = require('../lib/notifier');

// v1.0.17 改：统一使用 lib/auth 的 requireToken 中间件
const requireAuth = auth.requireToken;

// POST /api/notify/test
router.post('/test', requireAuth, async (req, res) => {
    const { message } = req.body || {};
    const text = message || '[Agent 备份] 测试通知';
    try {
        const ok = await notifier.notify(text);
        res.json({ ok, message: text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
