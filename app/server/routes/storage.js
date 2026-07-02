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

// v2.21.5：迁移预览 —— 统计当前位置有多少备份文件、总大小，用于切换位置前询问
router.get('/migrate-preview', requireAuth, (req, res) => {
    try { res.json(Object.assign({ ok: true }, storage.previewMigrate())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// v2.21.5：切换存储位置 + 可选迁移。mode: migrate | copy | switch
router.post('/migrate', requireAuth, (req, res) => {
    try {
        const { root, mode } = req.body || {};
        if (!root) return res.status(400).json({ error: '请提供新的存储位置' });
        const m = ['migrate', 'copy', 'switch'].includes(mode) ? mode : 'switch';
        const result = storage.migrateStorage(root, m, {});
        res.json(Object.assign({ ok: result.ok }, result, { info: storage.storageInfo() }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
