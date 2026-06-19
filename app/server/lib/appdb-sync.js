// appdb-sync.js：fnOS 状态机同步（M99/M100）
const { execSync } = require('child_process');
const logger = require('./logger');

const DB_NAME = 'appcenter';
const DB_USER = 'postgres';
const APP_NAME = 'com.dustinky.agentbackup';

function syncStatus(targetStatus) {
    // fnOS appcenter 状态机（2026-06-18 装机复验）：
    // running + is_stop=true  => 桌面图标/打开入口正常
    // running + is_stop=false => 服务 200 但桌面无图标/打开无反应
    // stopped + is_stop=true  => 停止状态
    const status = (targetStatus === 'running') ? 'running' : ((targetStatus === 'stop' || targetStatus === 'stopped') ? 'stopped' : 'start');
    const isStop = 'true';

    // v1.0.20 修：值用单引号包裹并转义（APP_NAME/DB_NAME/DB_USER 都是常量，但写死也加防护）
    const esc = (s) => String(s).replace(/'/g, "''");
    try {
        const sql = `UPDATE app SET status='${esc(status)}', is_stop=${isStop} WHERE app_name='${esc(APP_NAME)}';`;
        execSync(`sudo -u ${DB_USER} psql -d ${DB_NAME} -c "${sql.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });
        logger.info(`[appdb-sync] status=${status} is_stop=${isStop}`);
        return true;
    } catch (e) {
        logger.warn(`[appdb-sync] 失败: ${e.message}`);
        return false;
    }
}

module.exports = { syncStatus };
