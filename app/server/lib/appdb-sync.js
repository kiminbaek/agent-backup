// appdb-sync.js：fnOS 状态机同步（M99/M100）
const { execFileSync } = require('child_process');
const logger = require('./logger');

const DB_NAME = 'appcenter';
const DB_USER = 'postgres';
const APP_NAME = 'com.dustinky.agentbackup';

function syncStatus(targetStatus) {
    // fnOS appcenter 状态机：is_stop/is_uninstall 表示“允许停止/允许卸载”，不是当前状态。
    // running => status=running, is_stop=true, is_uninstall=true
    // stopped => status=stopped, is_stop=true, is_uninstall=true
    const status = (targetStatus === 'running') ? 'running' : ((targetStatus === 'stop' || targetStatus === 'stopped') ? 'stopped' : 'start');
    const isStop = 'true';
    const isUninstall = 'true';
    const isNonManualStop = 'false';

    // 值用单引号包裹并转义（APP_NAME/DB_NAME/DB_USER 都是常量，但写死也加防护）
    const esc = (s) => String(s).replace(/'/g, "''");
    try {
        const sql = `UPDATE app SET status='${esc(status)}', is_stop=${isStop}, is_uninstall=${isUninstall}, is_non_manual_stop=${isNonManualStop} WHERE app_name='${esc(APP_NAME)}';`;
        execFileSync('sudo', ['-u', DB_USER, 'psql', '-d', DB_NAME, '-c', sql], { stdio: 'pipe' });
        logger.info(`[appdb-sync] status=${status} is_stop=${isStop} is_uninstall=${isUninstall}`);
        return true;
    } catch (e) {
        logger.warn(`[appdb-sync] 失败: ${e.message}`);
        return false;
    }
}

module.exports = { syncStatus };
