// cron-engine.js：node-cron 调度（默认 0 3 * * *），v1.1.0 走统一 storage 配置
const cron = require('node-cron');
const logger = require('./logger');
const backup = require('./backup-engine');
const storage = require('./storage');

let task = null;

function loadConfig() {
    return storage.loadConfig();
}

async function tick() {
    logger.info('[cron] 触发定时备份');
    const config = loadConfig();
    await backup.runBackup(config.sources || []);
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
    return { running: task !== null, schedule: loadConfig().schedule };
}

function updateSchedule(newSchedule) {
    if (!cron.validate(newSchedule)) throw new Error(`无效的 cron 表达式: ${newSchedule}`);
    const config = loadConfig();
    config.schedule = newSchedule;
    storage.saveConfig(config);
    if (task) { stop(); start(); }
    return true;
}

module.exports = { start, stop, tick, getStatus, updateSchedule };
