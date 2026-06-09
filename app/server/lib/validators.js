// v1.0.20 改：路径白名单 + 拒绝路径遍历 + 输入校验
const path = require('path');
const fs = require('fs');

// 允许的备份/恢复根路径白名单
const ALLOWED_ROOTS = [
    '/vol3/@appshare/',
    '/vol3/@appdata/',
    '/vol3/1000/',
];

// v1.0.20 加：拒绝路径遍历（.. 或符号链接跳出白名单）
function isPathAllowed(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    // 拒绝任何含 '..' 的路径
    if (targetPath.split('/').includes('..')) return false;
    const abs = path.resolve(targetPath);
    // 拒绝符号链接跳出白名单
    try {
        const real = fs.realpathSync(abs);
        return ALLOWED_ROOTS.some(root => real.startsWith(root));
    } catch (_) {
        // 路径不存在时，先看 abs 自身是否在白名单
        return ALLOWED_ROOTS.some(root => abs.startsWith(root));
    }
}

// v1.0.20 加：批量校验 sources（id 唯一性 + 路径不重复）
function validateSourcesBatch(sources) {
    const errors = [];
    if (!Array.isArray(sources)) return { valid: true, errors }; // 数组不存在不算错
    const idSet = new Set();
    const pathSet = new Set();
    for (const s of sources) {
        if (!s.id) { errors.push('source 缺少 id'); continue; }
        if (idSet.has(s.id)) errors.push(`重复的 source id: ${s.id}`);
        idSet.add(s.id);
        if (s.path) {
            if (pathSet.has(s.path)) errors.push(`重复的 source path: ${s.path}`);
            pathSet.add(s.path);
        }
        const v = validateSource(s);
        if (!v.valid) errors.push(`源 ${s.id}: ${v.errors.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
}

function pathExists(targetPath) {
    try {
        return fs.existsSync(targetPath);
    } catch (e) {
        return false;
    }
}

function isDirectory(targetPath) {
    try {
        return fs.statSync(targetPath).isDirectory();
    } catch (e) {
        return false;
    }
}

function isReadable(targetPath) {
    try {
        fs.accessSync(targetPath, fs.constants.R_OK);
        return true;
    } catch (e) {
        return false;
    }
}

// 校验备份源
function validateSource(source) {
    const errors = [];
    if (!source || typeof source !== 'object') {
        return { valid: false, errors: ['source 必须是对象'] };
    }
    if (!source.id) errors.push('缺少 id');
    if (!source.name) errors.push('缺少 name');
    if (!source.path) errors.push('缺少 path');
    if (!isPathAllowed(source.path)) errors.push(`path 不在白名单: ${source.path}`);
    if (source.path && !pathExists(source.path)) errors.push(`path 不存在: ${source.path}`);
    return { valid: errors.length === 0, errors };
}

// 校验恢复目标
function validateRestoreTarget(targetPath) {
    if (!isPathAllowed(targetPath)) {
        return { valid: false, error: '目标路径不在白名单' };
    }
    if (!pathExists(targetPath)) {
        return { valid: false, error: '目标路径不存在' };
    }
    if (!isDirectory(targetPath)) {
        return { valid: false, error: '目标路径不是目录' };
    }
    return { valid: true };
}

module.exports = {
    ALLOWED_ROOTS,
    isPathAllowed,
    pathExists,
    isDirectory,
    isReadable,
    validateSource,
    validateSourcesBatch, // v1.0.20 新增
    validateRestoreTarget,
};
