// routes/audit.js：v1.1.3 操作审计查询
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const audit = require('../lib/audit');

router.get('/list', auth.requireToken, (req, res) => {
    try { res.json({ ok: true, logs: audit.list(req.query.limit) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
