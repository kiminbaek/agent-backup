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

// v2.23.0：对外掩码源密码——不把明文 encryptionPassword 发到浏览器，只给 hasEncryptionPassword 标志
function maskConfig(config) {
    const c = JSON.parse(JSON.stringify(config || {}));
    if (Array.isArray(c.sources)) {
        c.sources = c.sources.map(s => {
            const x = Object.assign({}, s);
            if (x.encryptionPassword) { x.hasEncryptionPassword = true; delete x.encryptionPassword; }
            else x.hasEncryptionPassword = false;
            return x;
        });
    }
    return c;
}

router.get('/', requireAuth, (req, res) => {
    try { res.json(maskConfig(storage.loadConfig())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, (req, res) => {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') return res.status(400).json({ error: 'config 必须是对象' });
    // v2.23.0：前端不回传明文密码。合并策略——某源本次没带 encryptionPassword 但仍要求加密，则保留旧密码
    if (Array.isArray(newConfig.sources)) {
        const old = storage.loadConfig();
        const oldById = {};
        (old.sources || []).forEach(s => { if (s.id) oldById[s.id] = s; });
        newConfig.sources = newConfig.sources.map(s => {
            const x = Object.assign({}, s);
            delete x.hasEncryptionPassword; // 仅展示用，不入库
            if (x.requiresEncryption) {
                // 本次没带明文密码 → 沿用旧密码
                if (!x.encryptionPassword && oldById[x.id] && oldById[x.id].encryptionPassword) {
                    x.encryptionPassword = oldById[x.id].encryptionPassword;
                }
            } else {
                delete x.encryptionPassword; // 取消加密则清掉密码
            }
            return x;
        });
    }
    if (Array.isArray(newConfig.sources)) {
        const v = validators.validateSourcesBatch(newConfig.sources);
        if (!v.valid) return res.status(400).json({ error: v.errors.join('; ') });
    }
    try {
        storage.saveConfig(newConfig);
        audit.write('config.save', { sources: Array.isArray(newConfig.sources) ? newConfig.sources.length : 0 });
        // v2.6.0：每次保存都重载调度（全局 + 每源独立计划）
        try { cron.reload(); } catch (e) { /* ignore */ }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});



router.get('/schedule/status', requireAuth, (req, res) => {
    try { res.json({ ok: true, ...cron.getStatus() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule/source/:id', requireAuth, (req, res) => {
    const { enabled, cron: cronExpr } = req.body || {};
    try {
        const config = storage.loadConfig();
        const s = (config.sources || []).find(x => x.id === req.params.id);
        if (!s) return res.status(404).json({ error: '备份源不存在' });
        s.scheduleEnabled = !!enabled;
        if (cronExpr) s.schedule = String(cronExpr);
        storage.saveConfig(config);
        cron.reload();
        audit.write('schedule.source.save', { id: s.id, enabled: s.scheduleEnabled, cron: s.schedule || '' });
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/templates', requireAuth, (req, res) => {
    res.json({ ok: true, templates: [
        { id: 'qwenpaw-workspaces', name: 'QwenPaw 工作区', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/', mode: 'exclude', excludes: ['**/node_modules/**', '**/.git/**', '**/.cache/**', '**/tool_results/**'] },
        { id: 'qwenpaw-memory', name: 'QwenPaw Agent 记忆（通用）', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/', mode: 'include', include: ['workspaces/*/MEMORY.md', 'workspaces/*/SOUL.md', 'workspaces/*/PROFILE.md', 'workspaces/*/memory/***'], excludes: [] },
        { id: 'qwenpaw-config', name: 'QwenPaw 配置（通用）', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/', mode: 'include', include: ['config.json', 'settings.json', 'workspaces/*/agent.json', 'workspaces/*/skill.json'], excludes: [] },
        { id: 'qwenpaw-skill-pool', name: 'QwenPaw 技能池', path: '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/skill_pool/', mode: 'exclude', excludes: [] },
        { id: 'qwenpaw-appdata', name: 'QwenPaw appdata', path: '/vol3/@appdata/com.dustinky.qwenpaw/', mode: 'exclude', excludes: ['logs/*.log'] },
        { id: 'agentbackup-appdata', name: '智能体时光机自身配置', path: '/vol3/@appdata/com.dustinky.agentbackup/', mode: 'exclude', excludes: ['tmp/**'] },
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
        if (req.query.mask !== 'false') {
            if (config.notify && config.notify.channels) {
                for (const ch of Object.values(config.notify.channels)) {
                    if (ch.url) ch.url = ch.url.slice(0, 12) + '***MASKED***';
                }
            }
            // v2.23.0：默认不导出源加密密码明文
            if (Array.isArray(config.sources)) {
                config.sources.forEach(s => { if (s.encryptionPassword) delete s.encryptionPassword; });
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
            // v2.23.0：导入若缺密码，尽量沿用现有配置里的旧密码（按 id 匹配）
            try {
                const old = storage.loadConfig();
                const oldById = {};
                (old.sources || []).forEach(s => { if (s.id) oldById[s.id] = s; });
                config.sources.forEach(s => {
                    if (s.requiresEncryption && !s.encryptionPassword && oldById[s.id] && oldById[s.id].encryptionPassword) {
                        s.encryptionPassword = oldById[s.id].encryptionPassword;
                    }
                });
            } catch (_) { /* ignore */ }
        }
        storage.saveConfig(config);
        audit.write('config.import', { sources: Array.isArray(config.sources) ? config.sources.length : 0 });
        res.json({ ok: true, config: maskConfig(config) });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
