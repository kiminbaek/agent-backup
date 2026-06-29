// diff.js：v2.6.0 纯文本行级 diff（LCS / 动态规划），零依赖
// 用于「记忆时光对比」：比较两个快照里同一文件的内容差异
// 仅对文本文件做行 diff，二进制只比 size/sha256（由调用方判断）

// 计算两段文本的行级 diff，返回 {added, removed, changes, hunks}
function diffLines(oldText, newText, opts) {
    opts = opts || {};
    const maxLines = opts.maxLines || 20000;
    let a = String(oldText == null ? '' : oldText).split(/\r\n|\r|\n/);
    let b = String(newText == null ? '' : newText).split(/\r\n|\r|\n/);
    let truncated = false;
    if (a.length > maxLines) { a = a.slice(0, maxLines); truncated = true; }
    if (b.length > maxLines) { b = b.slice(0, maxLines); truncated = true; }

    const n = a.length, m = b.length;
    // LCS 动态规划表（数值型 Int32Array 省内存）
    // 注意：n*m 过大时退化，maxLines 已限制上界
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i], next = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            if (a[i] === b[j]) row[j] = next[j + 1] + 1;
            else row[j] = Math.max(next[j], row[j + 1]);
        }
    }
    // 回溯生成操作序列
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ t: 'same', line: a[i], ai: i + 1, bi: j + 1 }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', line: a[i], ai: i + 1 }); i++; }
        else { ops.push({ t: 'add', line: b[j], bi: j + 1 }); j++; }
    }
    while (i < n) { ops.push({ t: 'del', line: a[i], ai: i + 1 }); i++; }
    while (j < m) { ops.push({ t: 'add', line: b[j], bi: j + 1 }); j++; }

    let added = 0, removed = 0;
    for (const o of ops) { if (o.t === 'add') added++; else if (o.t === 'del') removed++; }

    // 折叠成 hunks：连续 same 超过 contextLines*2 的中间部分省略
    const ctx = opts.context == null ? 3 : opts.context;
    const hunks = buildHunks(ops, ctx);

    return { added, removed, total: ops.length, hunks, truncated, oldLines: n, newLines: m };
}

function buildHunks(ops, ctx) {
    // 标记哪些 same 行需要保留（变更行前后 ctx 行）
    const keep = new Array(ops.length).fill(false);
    for (let k = 0; k < ops.length; k++) {
        if (ops[k].t !== 'same') {
            for (let d = -ctx; d <= ctx; d++) {
                const idx = k + d;
                if (idx >= 0 && idx < ops.length) keep[idx] = true;
            }
        }
    }
    const hunks = [];
    let cur = null;
    for (let k = 0; k < ops.length; k++) {
        if (keep[k]) {
            if (!cur) { cur = { lines: [] }; }
            cur.lines.push(ops[k]);
        } else {
            if (cur) { hunks.push(cur); cur = null; }
        }
    }
    if (cur) hunks.push(cur);
    return hunks;
}

module.exports = { diffLines };
