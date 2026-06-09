// routes/auth.js：登录、登出、改密（v1.0.20 改：错误信息不暴露锁定状态 / change-password ≥8 字符 / 401 统一错误信息 / 加 logout 端点）
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const logger = require('../lib/logger');

// GET /api/auth/status（公开访问，UI 首次判断用）
router.get('/status', (req, res) => {
    try {
        const status = auth.getAuthStatus();
        res.json({ ok: true, ...status });
    } catch (e) {
        logger.warn(`auth status 异常: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/setup（首次设置密码，公开访问，受 server.js rateLimit 保护）
router.post('/setup', async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '缺少 password' });

    try {
        const token = await auth.setupPassword(password);
        res.json({ ok: true, token });
    } catch (e) {
        logger.warn(`auth setup 异常: ${e.message}`);
        res.status(400).json({ error: e.message });
    }
});

// POST /api/auth/login（受 server.js rateLimit 保护）
// v1.0.20 改：登录失败统一返 401，不暴露锁定信息（防计时攻击）
router.post('/login', async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '缺少 password' });

    try {
        const ok = await auth.verifyPassword(password);
        if (!ok) return res.status(401).json({ error: '密码错误' });
        // 成功：返回 token
        res.json({ ok: true, token: auth.getToken() });
    } catch (e) {
        logger.warn(`login 异常: ${e.message}`);
        res.status(401).json({ error: '密码错误' });
    }
});

// POST /api/auth/change-password（需 token）
router.post('/change-password', async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const token = req.headers['x-auth-token'];

    if (!token || !auth.verifyToken(token)) {
        return res.status(401).json({ error: '未授权' });
    }
    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: '缺少 oldPassword 或 newPassword' });
    }
    // v1.0.20 改：新密码统一 ≥8 字符
    if (newPassword.length < 8) {
        return res.status(400).json({ error: '新密码至少 8 位' });
    }

    try {
        const ok = await auth.verifyPassword(oldPassword);
        if (!ok) return res.status(401).json({ error: '原密码错误' });
        const newToken = await auth.setPassword(newPassword);
        res.json({ ok: true, token: newToken });
    } catch (e) {
        // v1.0.20 改：统一 401，不暴露锁定
        res.status(401).json({ error: '原密码错误' });
    }
});

// GET /api/auth/check（验证 token）
router.get('/check', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token || !auth.verifyToken(token)) {
        return res.status(401).json({ error: '未授权' });
    }
    res.json({ ok: true });
});

// v1.0.20 新增：POST /api/auth/logout（撤销当前 token，生成新 token）
// 简单实现：调用 setPassword 重新生成 token（要求传原密码）
// 注意：完整 logout 需 token 黑名单（持久化），这里先做密码二次确认版
router.post('/logout', async (req, res) => {
    const { password } = req.body || {};
    const token = req.headers['x-auth-token'];
    if (!token || !auth.verifyToken(token)) {
        return res.status(401).json({ error: '未授权' });
    }
    if (!password) return res.status(400).json({ error: '需要密码二次确认' });
    try {
        const ok = await auth.verifyPassword(password);
        if (!ok) return res.status(401).json({ error: '密码错误' });
        // 生成新 token（旧 token 立即失效）
        const newToken = await auth.setPassword(password);
        res.json({ ok: true, token: newToken, message: '已退出登录' });
    } catch (e) {
        res.status(401).json({ error: '密码错误' });
    }
});

module.exports = router;
