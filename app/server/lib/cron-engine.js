// cron-engine.js：v2.6.0 多任务调度
//   - 全局计划：config.schedule（兜底，备份所有未单独设定计划的源）
//   - 每源计划：source.schedule + source.scheduleEnabled（独立 cron）
const cron = require('node-cron');
const logger = require('./logger');
const backup = require('./backup-engine');
const storage = require('./storage');

let globalTask = null;
const sourceTasks = new Map(); // sourceId -> cron task

function loadConfig() {
    return storage.loadConfig();
}

async function tickSources(sources, label) {
    logger.info(`[cron] 触发定时备份 (${label}) 源数=${sources.length}`);
    await backup.runBackup(sources);
}

function stop() {
    if (globalTask) { globalTask.stop(); globalTask = null; }
    for (const [, t] of sourceTasks) { try { t.stop(); } catch (_) { /* ignore */ } }
    sourceTasks.clear();
    logger.info('[cron] 已停止全部任务');
}

function start() {
    stop();
    const config = loadConfig();
    const sources = Array.isArray(config.sources) ? config.sources : [];

    // 1) 每源独立计划
    const scheduledIds = new Set();
    for (const s of sources) {
        if (s.scheduleEnabled && s.schedule && cron.validate(s.schedule)) {
            const sid = s.id;
            const task = cron.schedule(s.schedule, () => {
                const fresh = loadConfig().sources.find(x => x.id === sid);
                if (!fresh || fresh.enabled === false) return;
                tickSources([fresh], `源 ${sid}`).catch(e => logger.error(`[cron] 源 ${sid} tick 异常: ${e.message}`));
            });
            sourceTasks.set(sid, task);
            scheduledIds.add(sid);
            logger.info(`[cron] 源 ${sid} 已注册独立计划: ${s.schedule}`);
        } else if (s.scheduleEnabled && s.schedule) {
            logger.error(`[cron] 源 ${s.id} 无效 cron 表达式: ${s.schedule}`);
        }
    }

    // 2) 全局计划：备份「未设独立计划」的源
    const sch = (config.schedule && typeof config.schedule === 'object') ? config.schedule : { enabled: true, cron: config.schedule || '0 3 * * *' };
    const globalSchedule = sch.cron || '0 3 * * *';
    if (sch.enabled === false) {
        logger.info('[cron] 全局计划已禁用（仅每源独立计划生效）');
        return true;
    }
    if (cron.validate(globalSchedule)) {
        globalTask = cron.schedule(globalSchedule, () => {
            const fresh = loadConfig();
            const rest = (fresh.sources || []).filter(s => s.enabled !== false && !(s.scheduleEnabled && s.schedule));
            if (rest.length === 0) return;
            tickSources(rest, '全局').catch(e => logger.error(`[cron] 全局 tick 异常: ${e.message}`));
        });
        logger.info(`[cron] 全局计划已启动: ${globalSchedule}`);
    } else {
        logger.error(`[cron] 无效的全局 cron 表达式: ${globalSchedule}`);
        return false;
    }
    return true;
}

function getStatus() {
    const config = loadConfig();
    const perSource = [];
    for (const s of (config.sources || [])) {
        if (s.scheduleEnabled && s.schedule) {
            perSource.push({ id: s.id, name: s.name, schedule: s.schedule, running: sourceTasks.has(s.id) });
        }
    }
    const sch = (config.schedule && typeof config.schedule === 'object') ? config.schedule : { enabled: true, cron: config.schedule || '0 3 * * *' };
    return {
        global: { running: globalTask !== null, enabled: sch.enabled !== false, schedule: sch.cron || '0 3 * * *' },
        perSource,
        totalTasks: (globalTask ? 1 : 0) + sourceTasks.size,
    };
}

function updateSchedule(newSchedule) {
    // 兼容旧接口：更新全局计划并重启全部任务
    const config = loadConfig();
    if (newSchedule && typeof newSchedule === 'object' && !Array.isArray(newSchedule)) {
        const cronStr = newSchedule.cron || (config.schedule && config.schedule.cron) || '0 3 * * *';
        if (cronStr && !cron.validate(cronStr)) throw new Error(`无效的 cron 表达式: ${cronStr}`);
        config.schedule = { enabled: newSchedule.enabled !== false, cron: cronStr };
    } else if (typeof newSchedule === 'string') {
        if (newSchedule && !cron.validate(newSchedule)) throw new Error(`无效的 cron 表达式: ${newSchedule}`);
        config.schedule = { enabled: true, cron: newSchedule };
    }
    storage.saveConfig(config);
    start();
    return true;
}

// 重新加载所有调度（配置变更后调用）
function reload() {
    return start();
}

module.exports = { start, stop, tickSources, getStatus, updateSchedule, reload };
