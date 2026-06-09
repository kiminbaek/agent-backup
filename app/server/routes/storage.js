// routes/storage.js：v1.1.0 存储设置、路径校验、分类整理
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const storage = require('../lib/storage');

const requireAuth = auth.requireToken;

router.get('/info', requireAuth, (req, res) => {
    try { res.json(storage.storageInfo()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/validate', requireAuth, (req, res) => {
    const { root, create } = req.body || {};
    res.json(storage.validateBackupRoot(root, !!create));
});

router.post('/save', requireAuth, (req, res) => {
    try {
        const { root, layout, trashDays, maxUploadGB } = req.body || {};
        const v = storage.validateBackupRoot(root, true);
        if (!v.ok) return res.status(400).json({ error: v.error });
        const config = storage.loadConfig();
        config.storage = Object.assign({}, config.storage || {}, {
            root: v.path,
            layout: layout || 'year-month-source',
            trashDays: Number(trashDays || 7),
            maxUploadGB: Number(maxUploadGB || 20)
        });
        storage.saveConfig(config);
        res.json({ ok: true, storage: config.storage, info: storage.storageInfo(config) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/organize', requireAuth, (req, res) => {
    try { res.json(storage.organize()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
