// validators.js：路径白名单 + 输入校验
const path = require('path');
const fs = require('fs');

// 允许的备份/恢复根路径白名单
const ALLOWED_ROOTS = [
    '/vol3/@appshare/',
    '/vol3/@appdata/',
    '/vol3/1000/',
];

function isPathAllowed(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const abs = path.resolve(targetPath);
    return ALLOWED_ROOTS.some(root => abs.startsWith(root));
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
    validateRestoreTarget,
};
