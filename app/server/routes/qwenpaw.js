// routes/qwenpaw.js：v1.4.0 QwenPaw 深度适配分析（按智能体拆分记忆/配置）
//   v2.6.0：新增 /dashboard 智能体仪表盘（每个 agent 的记忆体量/文件数/最近备份）
const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../lib/auth');
const validators = require('../lib/validators');
const backup = require('../lib/backup-engine');
const diffLib = require('../lib/diff');

const router = express.Router();
const requireAuth = auth.requireToken;
const SENSITIVE_RE = /(token|api[_-]?key|secret|password|credential|authorization|access[_-]?key|client[_-]?secret)/i;
const DEFAULT_ROOT = '/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw';

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

// v2.6.0：智能体仪表盘 —— 每个 agent 的记忆体量/文件数/最近修改/最近备份
function countMdFiles(dir, limit) {
    let notes = 0, dialogs = 0, memDays = 0;
    for (const e of listDir(dir)) {
        if (e.isFile() && e.name.endsWith('_dev_notes.md')) notes++;
    }
    const memDir = path.join(dir, 'memory');
    if (exists(memDir)) {
        for (const e of listDir(memDir)) {
            if (e.isFile() && e.name.endsWith('.md')) memDays++;
        }
    }
    const dialogDir = path.join(dir, 'dialog');
    if (exists(dialogDir)) {
        for (const e of listDir(dialogDir)) {
            if (e.isFile()) dialogs++;
        }
    }
    return { notes, dialogs, memDays };
}

router.post('/dashboard', requireAuth, (req, res) => {
    const root = path.resolve((req.body && req.body.root) || DEFAULT_ROOT);
    if (!validators.isPathAllowed(root)) return res.status(400).json({ error: 'root 不在允许路径白名单' });
    if (!exists(root)) return res.status(400).json({ error: 'root 不存在: ' + root });

    const workspaces = path.join(root, 'workspaces');
    const agents = listDir(workspaces).filter(e => e.isDirectory()).map(e => e.name).sort();

    // 备份历史：按 sourceId 前缀 agent-<id>-* 匹配最近备份
    let backups = [];
    try { backups = backup.listBackups({}); } catch (_) { backups = []; }
    function lastBackupFor(agent) {
        const hits = backups.filter(b => b.status === 'success' &&
            (String(b.sourceId || '').includes(`agent-${agent}-`) || String(b.sourceName || '').includes(`Agent ${agent}`)));
        if (!hits.length) return null;
        const latest = hits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
        return { id: latest.id, at: latest.timestamp, human: latest.createdAt, count: hits.length };
    }

    const cards = agents.map(agent => {
        const agentDir = path.join(workspaces, agent);
        const coreFiles = ['MEMORY.md', 'SOUL.md', 'PROFILE.md', 'AGENTS.md'].filter(f => exists(path.join(agentDir, f)));
        const coreBytes = coreFiles.reduce((s, f) => s + fileSize(path.join(agentDir, f)), 0);
        const memDirStats = dirSize(path.join(agentDir, 'memory'), 5000);
        const cnt = countMdFiles(agentDir, 5000);
        const memoryMtime = (() => {
            const mp = path.join(agentDir, 'MEMORY.md');
            const st = statSafe(mp);
            return st ? st.mtimeMs : null;
        })();
        return {
            agent,
            coreFiles: coreFiles.length,
            coreSize: coreBytes,
            coreSizeHuman: human(coreBytes),
            memDays: cnt.memDays,
            notes: cnt.notes,
            dialogs: cnt.dialogs,
            memDirSize: memDirStats.bytes,
            memDirSizeHuman: human(memDirStats.bytes),
            memoryMtime,
            lastBackup: lastBackupFor(agent),
        };
    });

    res.json({ ok: true, root, agents: agents.length, cards });
});

// v2.6.0：记忆时光对比 —— 比较两个快照里同一文件的内容差异
//   body: { oldId, newId, member, password? }
//   newId 可传 'CURRENT' 表示与当前实际文件对比
router.post('/diff', requireAuth, async (req, res) => {
    const { oldId, newId, member, oldPassword, newPassword } = req.body || {};
    if (!oldId || !newId || !member) return res.status(400).json({ error: '缺少 oldId/newId/member' });
    try {
        async function getContent(id, pw) {
            if (id === 'CURRENT') {
                // member 形如 work_xxx/workspaces/003/MEMORY.md 或相对快照根的路径
                // 当前文件需用绝对路径还原：取 member 中 workspaces/... 之后部分
                const idx = member.indexOf('workspaces/');
                if (idx < 0) throw new Error('CURRENT 对比需 member 含 workspaces/ 路径');
                const abs = path.join(DEFAULT_ROOT, member.slice(idx));
                if (!validators.isPathAllowed(abs) || !exists(abs)) throw new Error('当前文件不存在或不允许: ' + abs);
                return fs.readFileSync(abs, 'utf8');
            }
            const r = await backup.readArchiveMember(id, member, pw || '', 2 * 1024 * 1024);
            return r.content;
        }
        const oldText = await getContent(oldId, oldPassword);
        const newText = await getContent(newId, newPassword);
        const result = diffLib.diffLines(oldText, newText, { context: 3 });
        res.json({ ok: true, member, oldId, newId, diff: result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});


function listMarkdownFiles(root, limit) {
    const out = [];
    function walk(dir, rel) {
        if (out.length >= limit) return;
        for (const e of listDir(dir)) {
            if (out.length >= limit) return;
            const fp = path.join(dir, e.name);
            const rp = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) {
                if (!['node_modules', '.git', 'media', 'tool_results', 'sessions', 'backup', 'backups', '.trash', 'trash'].includes(e.name)) walk(fp, rp);
            } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ rel: rp, path: fp, size: fileSize(fp), mtime: statSafe(fp)?.mtimeMs || 0 });
        }
    }
    if (exists(root)) walk(root, '');
    return out;
}
function ageDays(ms) { return ms ? Math.floor((Date.now() - ms) / 86400000) : null; }
function addIssue(issues, severity, type, title, detail, file, files) { issues.push({ severity, type, title, detail, file: file || '', files: files || [] }); }
function healthLevel(score) { return score < 60 ? 'critical' : score < 82 ? 'warn' : 'ok'; }

// v2.13.0：记忆健康检查（只读扫描，不修改用户文件）
router.post('/health-check', requireAuth, (req, res) => {
    const root = path.resolve((req.body && req.body.root) || DEFAULT_ROOT);
    if (!validators.isPathAllowed(root)) return res.status(400).json({ error: 'root 不在允许路径白名单' });
    if (!exists(root)) return res.status(400).json({ error: 'root 不存在: ' + root });
    const workspaces = path.join(root, 'workspaces');
    const agents = listDir(workspaces).filter(e => e.isDirectory()).map(e => e.name).sort();
    let backups = [];
    try { backups = backup.listBackups({}); } catch (_) { backups = []; }
    function backupsFor(agent) {
        return backups.filter(b => b.status === 'success' && (String(b.sourceId || '').includes(`agent-${agent}-`) || String(b.sourceName || '').includes(`Agent ${agent}`))).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    const cards = agents.map(agent => {
        const dir = path.join(workspaces, agent);
        const issues = [];
        let score = 100;
        const required = ['MEMORY.md', 'SOUL.md', 'PROFILE.md', 'AGENTS.md'];
        const missing = required.filter(f => !exists(path.join(dir, f)));
        if (missing.length) { score -= missing.length * 8; addIssue(issues, missing.length >= 2 ? 'critical' : 'warn', 'missing-core', '核心记忆文件缺失', missing.join(', ')); }
        const mdFiles = listMarkdownFiles(dir, 800);
        const coreBytes = required.reduce((n, f) => n + fileSize(path.join(dir, f)), 0);
        const memStats = dirSize(path.join(dir, 'memory'), 8000);
        const lastBackup = backupsFor(agent)[0] || null;
        const backupAge = lastBackup ? ageDays(lastBackup.timestamp) : null;
        if (!lastBackup) { score -= 25; addIssue(issues, 'critical', 'no-backup', '尚无成功快照', '建议立即为该智能体创建快照'); }
        else if (backupAge > 7) { score -= 15; addIssue(issues, 'warn', 'old-backup', '最近快照超过 7 天', `${backupAge} 天前`); }
        else if (backupAge > 3) { score -= 8; addIssue(issues, 'warn', 'old-backup', '最近快照超过 3 天', `${backupAge} 天前`); }
        if (coreBytes > 1024 * 1024) { score -= 20; addIssue(issues, 'critical', 'large-core', '核心记忆过大', human(coreBytes)); }
        else if (coreBytes > 256 * 1024) { score -= 10; addIssue(issues, 'warn', 'large-core', '核心记忆偏大', human(coreBytes)); }
        if (memStats.bytes > 20 * 1024 * 1024) { score -= 18; addIssue(issues, 'critical', 'large-memory-dir', 'memory/ 目录过大', human(memStats.bytes)); }
        else if (memStats.bytes > 5 * 1024 * 1024) { score -= 9; addIssue(issues, 'warn', 'large-memory-dir', 'memory/ 目录偏大', human(memStats.bytes)); }
        const bigMd = mdFiles.filter(f => f.size > 128 * 1024).sort((a,b)=>b.size-a.size).slice(0,5);
        if (bigMd.length) { score -= Math.min(15, bigMd.length * 4); addIssue(issues, 'warn', 'large-md', '存在超大 Markdown 文件', bigMd.map(f => `${f.rel} ${human(f.size)}`).join('；'), '', bigMd.map(f => ({ rel: f.rel, size: f.size, sizeHuman: human(f.size), mtime: f.mtime }))); }
        const memDays = mdFiles.filter(f => f.rel.startsWith('memory/') && /\.md$/i.test(f.rel)).length;
        if (memDays > 365) { score -= 12; addIssue(issues, 'warn', 'many-daily', '日记忆文件超过 365 个', `${memDays} 个`); }
        else if (memDays > 120) { score -= 6; addIssue(issues, 'warn', 'many-daily', '日记忆文件较多', `${memDays} 个`); }
        const memorySt = statSafe(path.join(dir, 'MEMORY.md'));
        const memoryAge = memorySt ? ageDays(memorySt.mtimeMs) : null;
        if (memoryAge !== null && memoryAge > 30) { score -= 5; addIssue(issues, 'warn', 'stale-memory', 'MEMORY.md 超过 30 天未更新', `${memoryAge} 天`); }
        const seen = new Map();
        let repeated = 0;
        for (const f of mdFiles.slice(0, 300)) {
            if (f.size > 512 * 1024) continue;
            try {
                const lines = fs.readFileSync(f.path, 'utf8').split(/\r?\n/);
                for (const line of lines) {
                    const t = line.replace(/\s+/g, ' ').trim();
                    if (t.length < 60 || t.startsWith('|') || t.startsWith('```')) continue;
                    const k = t.toLowerCase();
                    const v = seen.get(k) || { count: 0, files: new Set() };
                    v.count++; v.files.add(f.rel); seen.set(k, v);
                }
            } catch (_) { /* ignore */ }
        }
        const repeatedFiles = new Set();
        for (const v of seen.values()) if (v.count >= 3 && v.files.size >= 2) { repeated++; for (const f of v.files) repeatedFiles.add(f); }
        if (repeated) { score -= Math.min(12, repeated * 3); addIssue(issues, 'warn', 'duplicates', '疑似重复长段落', `${repeated} 处（为保护隐私不展示原文）`, '', Array.from(repeatedFiles).slice(0, 8).map(rel => ({ rel }))); }
        score = Math.max(0, Math.min(100, Math.round(score)));
        const level = healthLevel(score);
        return { agent, score, level, issues, stats: { mdFiles: mdFiles.length, memDays, coreSize: coreBytes, coreSizeHuman: human(coreBytes), memSize: memStats.bytes, memSizeHuman: human(memStats.bytes), lastBackupAt: lastBackup ? lastBackup.timestamp : null, backupAge } };
    });
    const summary = { agents: cards.length, ok: cards.filter(c => c.level === 'ok').length, warn: cards.filter(c => c.level === 'warn').length, critical: cards.filter(c => c.level === 'critical').length, issues: cards.reduce((n, c) => n + c.issues.length, 0) };
    res.json({ ok: true, root, summary, cards });
});

module.exports = router;
