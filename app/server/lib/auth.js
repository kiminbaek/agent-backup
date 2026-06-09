// auth.js：scrypt 131072 + 加盐 + 失败锁（v1.0.20 修：密码强度统一 ≥8，setPassword 长度校验，错误信息不暴露锁定，atomic write）
const crypto = require('crypto');
const fs = require('fs');

const AUTH_FILE = '/vol3/@appdata/com.dustinky.agentbackup/auth.json';
const MAX_FAILED = 5;
const LOCK_TIME = 5 * 60 * 1000; // 5 分钟
const MIN_PASSWORD_LEN = 8; // v1.0.20 改：统一密码强度 ≥8
const SCRYPT_OPTS = { N: 131072, r: 8, p: 1, maxmem: 1024 * 1024 * 1024 };

// v1.0.20 改：atomic write 防止极端崩溃导致 auth.json 损坏
function save(auth) {
    const tmp = AUTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* ignore */ }
    fs.renameSync(tmp, AUTH_FILE);
}

function load() {
    if (!fs.existsSync(AUTH_FILE)) {
        throw new Error(`auth.json 不存在: ${AUTH_FILE}`);
    }
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

// v1.0.16 新增：获取认证状态（UI 首次判断用）
function getAuthStatus() {
    const auth = load();
    return {
        needsPasswordSetup: !auth.passwordHash,
        hasPassword: !!auth.passwordHash,
        scryptOptsVersion: auth.scryptOptsVersion || 0,
    };
}

// v1.0.16 新增：首次设置密码（不需要旧密码验证，v1.0.20 改：最低 8 字符）
async function setupPassword(newPassword) {
    if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) {
        throw new Error(`密码长度至少 ${MIN_PASSWORD_LEN} 个字符`);
    }
    const auth = load();
    if (auth.passwordHash) {
        throw new Error('密码已设置，请使用修改密码功能');
    }
    const hash = await scryptHash(newPassword);
    auth.passwordHash = hash;
    auth.needsPasswordSetup = false;
    auth.failedAttempts = 0;
    auth.lockUntil = 0;
    auth.scryptOptsVersion = 4;
    save(auth);
    return auth.token;
}

function scryptHash(password, saltHex) {
    return new Promise((resolve, reject) => {
        const salt = saltHex || crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, SCRYPT_OPTS, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(salt + ':' + derivedKey.toString('hex'));
        });
    });
}

async function setPassword(newPassword) {
    // v1.0.20 修：统一密码强度校验
    if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) {
        throw new Error(`密码长度至少 ${MIN_PASSWORD_LEN} 个字符`);
    }
    const hash = await scryptHash(newPassword);
    const auth = {
        passwordHash: hash,
        token: crypto.randomBytes(32).toString('hex'),
        failedAttempts: 0,
        lockUntil: 0,
    };
    save(auth);
    return auth.token;
}

async function verifyPassword(password) {
    const auth = load();
    const now = Date.now();

    // v1.0.16 新增：未设置密码时拒绝登录（必须先调 /api/auth/setup）
    if (!auth.passwordHash) {
        throw new Error('请先设置密码');
    }

    // 检查是否锁定（v1.0.20 改：锁定时统一返 "密码错误"，不暴露剩余时间，防计时攻击）
    if (auth.lockUntil > now) {
        save({ ...auth }); // 维持锁定状态（不累加失败次数）
        return false;
    }

    // 验证密码
    // v1.0.17 修复 BUG：scryptHash 返回 "salt:hash"，但 passwordHash 也是 "salt:hash"
    //   旧逻辑 split 后 expected = hash 部分，但 actual 是完整 "salt:hash" → 永远不等
    //   正解：直接比较完整字符串
    const [salt] = auth.passwordHash.split(':');
    const actual = await scryptHash(password, salt);
    if (actual === auth.passwordHash) {
        // 成功：重置失败次数
        auth.failedAttempts = 0;
        save(auth);
        return true;
    }

    // 失败：累加
    auth.failedAttempts += 1;
    if (auth.failedAttempts >= MAX_FAILED) {
        auth.lockUntil = now + LOCK_TIME;
        auth.failedAttempts = 0;
    }
    save(auth);
    return false;
}

function verifyToken(token) {
    const auth = load();
    return token === auth.token;
}

// v1.0.17 新增：返回当前 token（routes/auth.js login 用，避免直接 readFile）
function getToken() {
    return load().token;
}

// v1.0.17 新增：Express 鉴权中间件
function requireToken(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || !verifyToken(token)) {
        return res.status(401).json({ error: '未授权' });
    }
    next();
}

module.exports = { setPassword, verifyPassword, verifyToken, scryptHash, getAuthStatus, setupPassword, requireToken, getToken };
