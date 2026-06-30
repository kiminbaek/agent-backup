// cron-engine.js：v2.6.0 多任务调度
//   - 全局计划：config.schedule（兜底，备份所有未单独设定计划的源）
//   - 每源计划：source.schedule + source.scheduleEnabled（独立 cron）
const cron = require('node-cron');
const logger = require('./logger');
const backup = require('./backup-engine');
const storage = require('./storage');
const fs = require('fs');
const path = require('path');

let globalTask = null;
const sourceTasks = new Map(); // sourceId -> cron task
const CRON_STATE_FILE = path.join(storage.TMP_DIR, 'cron_state.json');
function loadCronState(){try{return JSON.parse(fs.readFileSync(CRON_STATE_FILE,'utf8'))}catch(_){return {runs:{}}}}
function saveCronState(st){try{storage.ensureDir(path.dirname(CRON_STATE_FILE),0o700);fs.writeFileSync(CRON_STATE_FILE,JSON.stringify(st,null,2))}catch(_){}}
function markRun(id,status,error){const st=loadCronState();st.runs=st.runs||{};st.runs[id]={lastRun:Date.now(),lastStatus:status,lastError:error||''};saveCronState(st)}
function cronHuman(c){const m={'0 3 * * *':'每天 03:00','0 */6 * * *':'每 6 小时','0 * * * *':'每小时','0 3 * * 0':'每周日 03:00','0 3 1 * *':'每月 1 日 03:00'};return m[c]||c}
function nextRunApprox(c){const now=new Date(), n=new Date(now); if(c==='0 * * * *'){n.setHours(now.getHours()+1,0,0,0)}else if(c==='0 */6 * * *'){const h=Math.floor(now.getHours()/6)*6+6;n.setHours(h,0,0,0)}else if(c==='0 3 * * *'){n.setHours(3,0,0,0);if(n<=now)n.setDate(n.getDate()+1)}else if(c==='0 3 * * 0'){n.setHours(3,0,0,0);while(n<=now||n.getDay()!==0)n.setDate(n.getDate()+1)}else if(c==='0 3 1 * *'){n.setDate(1);n.setHours(3,0,0,0);if(n<=now)n.setMonth(n.getMonth()+1)}else return null; return n.getTime()}

function loadConfig() {
    return storage.loadConfig();
}

async function tickSources(sources, label) {
    logger.info(`[cron] 触发定时备份 (${label}) 源数=${sources.length}`);
    const id = label || 'global';
    try { await backup.runBackup(sources); markRun(id, 'success'); }
    catch (e) { markRun(id, 'failure', e.message); throw e; }
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
            { const r=(loadCronState().runs||{})['源 '+s.id]||(loadCronState().runs||{})[s.id]||{}; perSource.push({ id: s.id, name: s.name, schedule: s.schedule, scheduleText: cronHuman(s.schedule), nextRun: nextRunApprox(s.schedule), running: sourceTasks.has(s.id), lastRun:r.lastRun||0, lastStatus:r.lastStatus||'', lastError:r.lastError||'' }); }
        }
    }
    const sch = (config.schedule && typeof config.schedule === 'object') ? config.schedule : { enabled: true, cron: config.schedule || '0 3 * * *' };
    const state=loadCronState(); const gr=(state.runs||{})['全局']||{};
    return {
        global: { running: globalTask !== null, enabled: sch.enabled !== false, schedule: sch.cron || '0 3 * * *', scheduleText: cronHuman(sch.cron || '0 3 * * *'), nextRun: nextRunApprox(sch.cron || '0 3 * * *'), lastRun: gr.lastRun||0, lastStatus: gr.lastStatus||'', lastError: gr.lastError||'' },
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
