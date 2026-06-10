// routes/qwenpaw.js：v1.4.0 QwenPaw 深度适配分析（按智能体拆分记忆/配置）
const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../lib/auth');
const validators = require('../lib/validators');

const router = express.Router();
const requireAuth = auth.requireToken;
const SENSITIVE_RE = /(token|api[_-]?key|secret|password|credential|authorization|access[_-]?key|client[_-]?secret)/i;

function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function statSafe(p) { try { return fs.statSync(p); } catch (_) { return null; } }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return []; } }
function fileSize(p) { const st = statSafe(p); return st && st.isFile() ? st.size : 0; }
function dirSize(root, limitFiles) {
    let total = 0, count = 0;
    function walk(p) {
        if (count >= limitFiles) return;
        for (const e of listDir(p)) {
            if (count >= limitFiles) return;
            const fp = path.join(p, e.name);
            if (e.isDirectory()) walk(fp);
            else if (e.isFile()) { total += fileSize(fp); count++; }
        }
    }
    if (exists(root)) walk(root);
    return { bytes: total, files: count, truncated: count >= limitFiles };
}
function human(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(1) + ' MB';
    return (n/1024/1024/1024).toFixed(2) + ' GB';
}
function detectSensitive(file) {
    const hits = [];
    try {
        if (!exists(file) || fileSize(file) > 1024 * 1024) return hits;
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, idx) => { if (SENSITIVE_RE.test(line)) hits.push({ file, line: idx + 1, key: line.slice(0, 80) }); });
    } catch (_) { /* ignore */ }
    return hits.slice(0, 20);
}
function makeGroup(id, name, root, include, exclude, risk, defaultSelected, desc, stats, sensitiveHits) {
    return { id, name, path: root, mode: include && include.length ? 'include' : 'exclude', include: include || [], exclude: exclude || [], risk, defaultSelected, desc, stats: stats || {}, sensitiveHits: sensitiveHits || [] };
}

router.post('/analyze', requireAuth, (req, res) => {
    const root = path.resolve((req.body && req.body.root) || '');
    if (!root) return res.status(400).json({ error: 'root 必填' });
    if (!validators.isPathAllowed(root)) return res.status(400).json({ error: 'root 不在允许路径白名单' });
    if (!exists(root)) return res.status(400).json({ error: 'root 不存在' });

    const workspaces = path.join(root, 'workspaces');
    const agents = listDir(workspaces).filter(e => e.isDirectory()).map(e => e.name).sort();
    const groups = [];

    for (const agent of agents) {
        const agentDir = path.join(workspaces, agent);
        const memoryDir = path.join(agentDir, 'memory');
        const memFiles = ['MEMORY.md', 'SOUL.md', 'PROFILE.md'].filter(f => exists(path.join(agentDir, f)));
        const memDirStats = dirSize(memoryDir, 5000);
        const memSize = memFiles.reduce((sum, f) => sum + fileSize(path.join(agentDir, f)), 0) + memDirStats.bytes;
        const memInclude = memFiles.map(f => `workspaces/${agent}/${f}`);
        if (exists(memoryDir)) memInclude.push(`workspaces/${agent}/memory/***`);
        groups.push(makeGroup(`agent-${agent}-memory`, `Agent ${agent} 记忆`, root,
            memInclude, [], 'medium', true, `只备份智能体 ${agent} 的 MEMORY/SOUL/PROFILE 和 memory 日记忆。`,
            { agent, size: human(memSize), files: memFiles.length + memDirStats.files }));

        const cfgFiles = ['agent.json', 'skill.json', 'chats.json'].filter(f => exists(path.join(agentDir, f)));
        const cfgInclude = cfgFiles.map(f => `workspaces/${agent}/${f}`);
        if (cfgInclude.length > 0) {
            groups.push(makeGroup(`agent-${agent}-config`, `Agent ${agent} 配置`, root,
                cfgInclude, [], 'medium', true, `只备份智能体 ${agent} 的 agent/skill/chats 配置。`,
                { agent, files: cfgFiles.length }));
        }
    }

    const globalFiles = ['config.json', 'settings.json', 'HEARTBEAT.md', 'token_usage.json', 'inbox_events.json'].filter(f => exists(path.join(root, f)));
    const globalHits = globalFiles.flatMap(f => detectSensitive(path.join(root, f)));
    groups.push(makeGroup('global-settings', '全局设置', root,
        globalFiles, [], globalHits.length ? 'high' : 'medium', false, 'QwenPaw 全局配置、语言设置、用量统计和事件记录。', { files: globalFiles.length }, globalHits));

    const secretFiles = [];
    function scanSecrets(p, rel, depth) {
        if (depth > 4 || secretFiles.length >= 50) return;
        for (const e of listDir(p)) {
            if (secretFiles.length >= 50) return;
            const fp = path.join(p, e.name), rp = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) {
                if (!['logs','dialog','sessions','tool_results','.npm','media','.trash'].some(x => rp.includes(x))) scanSecrets(fp, rp, depth + 1);
            } else if (e.isFile() && (SENSITIVE_RE.test(e.name) || ['config.json','.env'].includes(e.name))) {
                const hits = detectSensitive(fp);
                if (hits.length || SENSITIVE_RE.test(e.name)) secretFiles.push({ rel: rp, hits });
            }
        }
    }
    scanSecrets(root, '', 0);
    groups.push(makeGroup('secrets', '密钥 / 令牌 / 账号信息', root,
        secretFiles.map(x => x.rel), [], 'critical', false, '检测 token/api_key/secret/password 等敏感信息；建议加密备份，不建议公开分享。', { files: secretFiles.length }, secretFiles.flatMap(x => x.hits)));

    const skillPool = path.join(root, 'skill_pool');
    const sp = dirSize(skillPool, 20000);
    groups.push(makeGroup('skill-pool', '技能池', root,
        ['skill_pool/***'], ['skill_pool/**/node_modules/**', 'skill_pool/**/.git/**'], 'low', true, '全局技能池，可迁移能力资产。', { size: human(sp.bytes), files: sp.files }));

    groups.push(makeGroup('plugins-tools', '插件 / MCP 工具', root,
        ['plugins/***', 'tools/***'], ['tools/**/node_modules/**'], 'medium', false, '插件、MCP 工具和本地工具链配置。', {}));

    groups.push(makeGroup('dialogs-sessions', '对话 / 会话记录', root,
        ['workspaces/*/dialog/***', 'workspaces/*/sessions/***'], [], 'high', false, '历史对话和会话状态，通常包含隐私，体积也会增长。', {}));

    groups.push(makeGroup('logs-cache', '日志 / 缓存 / 媒体', root,
        ['qwenpaw.log*', 'logs/***', 'workspaces/*/tool_results/***', 'workspaces/*/.npm/***', 'workspaces/*/media/***'], [], 'low', false, '排障时有用，日常迁移和长期备份通常不建议选择。', {}));

    res.json({ ok: true, root, summary: { agents: agents.length, groups: groups.length, hasGlobalConfig: exists(path.join(root, 'config.json')), sensitiveFiles: secretFiles.length }, groups });
});

module.exports = router;
