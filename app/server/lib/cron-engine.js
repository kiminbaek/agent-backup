// cron-engine.js：node-cron 调度（默认 0 3 * * *）
const cron = require('node-cron');
const fs = require('fs');
const logger = require('./logger');
const backup = require('./backup-engine');
const notifier = require('./notifier');

const CONFIG_FILE = '/vol3/@appdata/com.dustinky.agentbackup/config/config.json';

let task = null;

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return { sources: [], schedule: '0 3 * * *' };
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

async function tick() {
    logger.info('[cron] 触发定时备份');
    const config = loadConfig();
    if (!config.sources || config.sources.length === 0) {
        logger.warn('[cron] 没有配置备份源');
        return;
    }
    await backup.runBackup(config.sources);
}

function start() {
    const config = loadConfig();
    const schedule = config.schedule || '0 3 * * *';
    if (!cron.validate(schedule)) {
        logger.error(`[cron] 无效的 cron 表达式: ${schedule}`);
        return false;
    }
    if (task) {
        logger.info('[cron] 任务已在运行，先停止');
        stop();
    }
    task = cron.schedule(schedule, () => {
        tick().catch(e => logger.error(`[cron] tick 异常: ${e.message}`));
    });
    logger.info(`[cron] 已启动: ${schedule}`);
    return true;
}

function stop() {
    if (task) {
        task.stop();
        task = null;
        logger.info('[cron] 已停止');
    }
}

function getStatus() {
    return {
        running: task !== null,
        schedule: loadConfig().schedule,
    };
}

function updateSchedule(newSchedule) {
    if (!cron.validate(newSchedule)) {
        throw new Error(`无效的 cron 表达式: ${newSchedule}`);
    }
    const config = loadConfig();
    config.schedule = newSchedule;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    if (task) {
        stop();
        start();
    }
    return true;
}

module.exports = { start, stop, tick, getStatus, updateSchedule };
