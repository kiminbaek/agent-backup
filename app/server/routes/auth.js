// routes/auth.js：登录、登出、改密
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

// POST /api/auth/setup（首次设置密码，公开访问）
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

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '缺少 password' });

    try {
        const ok = await auth.verifyPassword(password);
        if (!ok) return res.status(401).json({ error: '密码错误' });
        // 成功：返回 token（v1.0.17：用封装的 getToken 而非直接 readFile）
        res.json({ ok: true, token: auth.getToken() });
    } catch (e) {
        logger.warn(`login 异常: ${e.message}`);
        res.status(423).json({ error: e.message }); // 423 Locked
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
    if (newPassword.length < 6) {
        return res.status(400).json({ error: '新密码至少 6 位' });
    }

    try {
        const ok = await auth.verifyPassword(oldPassword);
        if (!ok) return res.status(401).json({ error: '原密码错误' });
        const newToken = await auth.setPassword(newPassword);
        res.json({ ok: true, token: newToken });
    } catch (e) {
        res.status(423).json({ error: e.message });
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

module.exports = router;
