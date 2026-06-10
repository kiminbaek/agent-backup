// routes/config.js：v1.1.0 读写配置 + 导入导出
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const cron = require('../lib/cron-engine');
const validators = require('../lib/validators');
const storage = require('../lib/storage');
const audit = require('../lib/audit');

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
        audit.write('config.save', { sources: Array.isArray(newConfig.sources) ? newConfig.sources.length : 0 });
        if (newConfig.schedule) cron.updateSchedule(newConfig.schedule);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});



router.get('/templates', requireAuth, (req, res) => {
    res.json({ ok: true, templates: [
        { id: 'qwenpaw-workspaces', name: 'QwenPaw 工作区', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/', mode: 'exclude', excludes: ['**/node_modules/**', '**/.git/**', '**/.cache/**', '**/tool_results/**'] },
        { id: 'qwenpaw-memory', name: 'QwenPaw Agent 记忆（通用）', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/', mode: 'include', include: ['workspaces/*/MEMORY.md', 'workspaces/*/SOUL.md', 'workspaces/*/PROFILE.md', 'workspaces/*/memory/***'], excludes: [] },
        { id: 'qwenpaw-config', name: 'QwenPaw 配置（通用）', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/', mode: 'include', include: ['config.json', 'settings.json', 'workspaces/*/agent.json', 'workspaces/*/skill.json'], excludes: [] },
        { id: 'qwenpaw-skill-pool', name: 'QwenPaw 技能池', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/skill_pool/', mode: 'exclude', excludes: [] },
        { id: 'qwenpaw-appdata', name: 'QwenPaw appdata', path: '/vol3/@appdata/com.dustinky.qwenpaw/', mode: 'exclude', excludes: ['logs/*.log'] },
        { id: 'agentbackup-appdata', name: 'Agent 备份自身配置', path: '/vol3/@appdata/com.dustinky.agentbackup/', mode: 'exclude', excludes: ['tmp/**'] },
        { id: 'fpk-files', name: 'fpk 文件夹', path: '/vol3/1000/nas/小虾米的fpk文件/', mode: 'exclude', excludes: ['.trash*/**'] },
        { id: 'xray-data', name: 'xray-proxy-native 数据', path: '/vol3/@appdata/xray-proxy-native/', mode: 'exclude', excludes: ['logs/**'] },
        { id: 'proc-guardian-data', name: 'proc-guardian 数据', path: '/vol3/@appdata/proc-guardian/', mode: 'exclude', excludes: ['logs/**'] }
    ]});
});

router.get('/recommended', requireAuth, (req, res) => {
    const now = Date.now();
    res.json({ ok: true, config: storage.normalizeConfig({
        sources: [
            { id: 'qwenpaw-workspaces', name: 'QwenPaw 工作区', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/', enabled: true, exclude: ['node_modules', '.git', '.cache'] },
            { id: 'fpk-files', name: 'fpk 文件夹', path: '/vol3/1000/nas/小虾米的fpk文件/', enabled: true, exclude: ['.trash*'] }
        ],
        schedule: '0 3 * * *',
        retention: { days: 30, keepLast: 10 },
        storage: { trashDays: 7, layout: 'year-month-source' },
        alert: { staleDays: 2, sizeGrowthRatio: 3 },
        updatedAt: now
    })});
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
        audit.write('config.import', { sources: Array.isArray(config.sources) ? config.sources.length : 0 });
        res.json({ ok: true, config });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
