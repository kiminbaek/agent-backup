// appdb-sync.js：fnOS 状态机同步（M99/M100）
const { execSync } = require('child_process');
const logger = require('./logger');

const DB_NAME = 'appcenter';
const DB_USER = 'postgres';
const APP_NAME = 'com.dustinky.agentbackup';

function syncStatus(targetStatus) {
    // status: 'start' / 'running' / 'stop'
    // is_stop: true / false
    const isStop = (targetStatus === 'stop' || targetStatus === 'stopped') ? 'true' : 'false';
    const status = (targetStatus === 'running') ? 'running' : 'start';

    try {
        const sql = `UPDATE app SET status='${status}', is_stop=${isStop} WHERE app_name='${APP_NAME}';`;
        execSync(`sudo -u ${DB_USER} psql -d ${DB_NAME} -c "${sql}"`, { stdio: 'pipe' });
        logger.info(`[appdb-sync] status=${status} is_stop=${isStop}`);
        return true;
    } catch (e) {
        logger.warn(`[appdb-sync] 失败: ${e.message}`);
        return false;
    }
}

module.exports = { syncStatus };
