// v1.0.20 改：路径白名单 + 拒绝路径遍历 + 输入校验
const path = require('path');
const fs = require('fs');

// v2.21.2 改：去掉硬编码白名单（不再绑死 /vol3/），改为“系统关键路径黑名单”
// 目的：应用需通用适配任意 fnOS/Linux 设备，磁盘挂载点可能是 /vol1、/volume1、/mnt 等；
// 之前 startsWith('/vol3/1000/') 既拦了根目录本身（无尾斜杠），又绑死了用户设备路径。
// 现在允许任意用户数据路径，仅拒绝写入/读取会破坏系统的关键目录。
const DENY_ROOTS = [
    '/etc', '/bin', '/sbin', '/boot', '/sys', '/proc', '/dev',
    '/usr', '/lib', '/lib32', '/lib64', '/libx32', '/root', '/run',
];

// 判断 abs 是否命中某个禁止根（等于该根或在其之下）
function isDenied(abs) {
    return DENY_ROOTS.some(root => abs === root || abs.startsWith(root + '/'));
}

// v2.21.2：拒绝路径遍历（..）+ 拒绝系统关键目录；其余用户路径一律放行
function isPathAllowed(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    // 拒绝任何含 '..' 的路径
    if (targetPath.split('/').includes('..')) return false;
    // 必须是绝对路径
    if (!targetPath.startsWith('/')) return false;
    const abs = path.resolve(targetPath);
    // 拒绝根目录本身
    if (abs === '/') return false;
    // 解析符号链接后再判定，防止软链跳进系统目录
    let real = abs;
    try {
        real = fs.realpathSync(abs);
    } catch (_) {
        // 路径不存在时用 abs 本身判定
        real = abs;
    }
    return !isDenied(real) && !isDenied(abs);
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
            const includeKey = Array.isArray(s.include) ? s.include.join('|') : '';
            const pathKey = (s.mode === 'include' || includeKey) ? `${s.path}::${includeKey}` : s.path;
            if (pathSet.has(pathKey)) errors.push(`重复的 source path/rules: ${s.path}`);
            pathSet.add(pathKey);
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
    if (!isPathAllowed(source.path)) errors.push(`path 不允许（系统关键目录或非法路径）: ${source.path}`);
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
    DENY_ROOTS,
    isPathAllowed,
    pathExists,
    isDirectory,
    isReadable,
    validateSource,
    validateSourcesBatch, // v1.0.20 新增
    validateRestoreTarget,
};
