// routes/notify.js：v1.1.0 通知配置 + 测试通知
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const notifier = require('../lib/notifier');

const requireAuth = auth.requireToken;

router.get('/config', requireAuth, (req, res) => {
    try { res.json({ ok: true, notify: notifier.getConfig() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/config', requireAuth, (req, res) => {
    try { res.json({ ok: true, notify: notifier.saveNotifyConfig(req.body && req.body.notify || req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/test', requireAuth, async (req, res) => {
    const { message } = req.body || {};
    const text = message || '[Agent 备份] 测试通知';
    try { res.json(await notifier.notify(text, 'failure')); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
