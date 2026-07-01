(function(){
'use strict';
const $=(s,r)=>(r||document).querySelector(s);
const $$=(s,r)=>Array.from((r||document).querySelectorAll(s));
const state={
  config:null,backups:[],restoreBackups:[],trash:[],history:[],audit:[],
  status:{},info:{},agents:null,setupMode:false,current:'home',
  lastBackupRun:null,polling:false
};
const REC_SOURCES=[
  {id:'qwenpaw-memory',name:'长期记忆 MEMORY.md',path:'/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces',enabled:true,include:['MEMORY.md','memory/*.md','*/MEMORY.md','*/memory/*.md'],exclude:['node_modules','.git','*.log','*.tmp']},
  {id:'qwenpaw-skills',name:'技能 skills/',path:'/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces',enabled:true,include:['skills/**'],exclude:['node_modules','.git','*.log','*.tmp']},
  {id:'qwenpaw-config',name:'智能体配置',path:'/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces',enabled:true,include:['agent.json','PROFILE.md','SOUL.md','AGENTS.md','*/agent.json','*/PROFILE.md','*/SOUL.md','*/AGENTS.md'],exclude:['node_modules','.git','*.log','*.tmp']}
];
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function fmtSize(n){n=Number(n||0);if(!n)return'0 B';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return(n>=10||i===0?Math.round(n):n.toFixed(1))+' '+u[i]}
function fmtTime(v){if(!v)return'-';let d;if(typeof v==='number')d=new Date(v<1e12?v*1000:v);else d=new Date(v);return isNaN(d)?esc(v):d.toLocaleString('zh-CN',{hour12:false})}
function clone(o){return JSON.parse(JSON.stringify(o||{}))}
function toast(msg,type){const t=$('#toast');if(!t)return;t.textContent=msg;t.className='toast '+(type||'info');t.classList.remove('hidden');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.add('hidden'),2800)}
function togglePwd(id){const el=$('#'+id);if(el)el.type=el.type==='password'?'text':'password'}
function backupId(b){return b&&String(b.id||b.name||b.filename||'')}
function allSources(){return (state.config&&state.config.sources)||[]}
function enabledSources(){return allSources().filter(s=>s.enabled)}
function healthLabel(b){const h=b.status||b.health;if(h==='deleted')return'已删除';if(h==='trashed')return'回收站';if(b.imported)return'导入';if(h==='missing')return'丢失';if(h==='error')return'失败';if(h==='ok'||h==='success')return'正常';return'未校验'}
function modal(title,bodyHtml,buttons){
  $('#modal-title').textContent=title||'';$('#modal-content').innerHTML=bodyHtml||'';
  const foot=$('#modal-footer');foot.innerHTML='';
  (buttons||[{label:'关闭',cls:'ghost'}]).forEach(cfg=>{
    const b=document.createElement('button');b.className='btn '+(cfg.cls||'ghost');b.textContent=cfg.label;
    b.onclick=async()=>{
      if(cfg.onClick){try{const r=await cfg.onClick();if(r===false)return;}catch(e){toast(e.message,'error');return;}}
      if(!cfg.keep)closeModal();
    };foot.appendChild(b);
  });
  $('#modal').classList.remove('hidden');
  const fc=$('#modal-content input,#modal-content select,#modal-content textarea');
  if(fc)setTimeout(()=>{try{fc.focus()}catch(_){}},60);
}
function closeModal(){$('#modal').classList.add('hidden');$('#modal-content').innerHTML=''}
function confirmDialog(title,msg,opt){
  opt=opt||{};return new Promise(res=>{
    modal(title,'<p class="modal-msg">'+esc(msg)+'</p>',[
      {label:opt.cancelLabel||'取消',cls:'ghost',onClick:()=>res(false)},
      {label:opt.okLabel||'确认',cls:opt.danger?'danger-soft':'primary',onClick:()=>res(true)}
    ]);
  });
}
function confirmWord(title,word,cb){
  modal(title,'<p class="modal-msg">此操作不可撤销。请输入 <b>'+esc(word)+'</b> 确认。</p><input id="cw-input" class="modal-input" placeholder="'+esc(word)+'">',[
    {label:'取消',cls:'ghost'},{label:'确认执行',cls:'danger-soft',keep:true,onClick:async()=>{
      if($('#cw-input').value!==word){toast('确认词不匹配','error');return false;}await cb();closeModal();
    }}
  ]);
}
function showLogin(msg){$('#main-page').classList.add('hidden');$('#login-page').classList.remove('hidden');if(msg)$('#login-hint').textContent=msg}
function showMain(){$('#login-page').classList.add('hidden');$('#main-page').classList.remove('hidden')}
async function initAuth(){
  try{
    const s=await Api.authStatus();state.setupMode=!!s.needsPasswordSetup;
    $('#login-password2').classList.toggle('hidden',!state.setupMode);
    $('#login-btn').textContent=state.setupMode?'设置密码并进入':'进入';
    $('#login-hint').textContent=state.setupMode?'首次使用，请设置管理员密码（至少8位）。':'请输入管理员密码。';
    if(Api.getToken()){try{await Api.check();showMain();await refreshAll();go('home');return;}catch(_){Api.clearToken();}}
    showLogin();
  }catch(e){showLogin('无法连接服务：'+e.message)}
}
async function doLogin(){
  const pw=$('#login-password').value;const err=$('#login-error');err.classList.add('hidden');
  if(!pw||pw.length<8){err.textContent='密码至少8位';err.classList.remove('hidden');return;}
  try{
    let r;
    if(state.setupMode){
      const pw2=$('#login-password2').value;
      if(pw!==pw2){err.textContent='两次密码不一致';err.classList.remove('hidden');return;}
      r=await Api.setup(pw);
    }else r=await Api.login(pw);
    if(r&&r.token)Api.setToken(r.token);
    showMain();await refreshAll();go('home');
  }catch(e){err.textContent=e.message;err.classList.remove('hidden')}
}
function pageInfo(id){return{
  home:['首页','备份、定时、恢复'],backup:['备份','选择内容，立即备份一次。'],
  schedule:['定时','自动备份时间和内容。'],restore:['恢复','恢复备份或管理回收站。'],
  agents:['智能体','查看并保护 QwenPaw 智能体。'],more:['更多','备份库、存储、通知、历史、日志。']
}[id]||['首页','']}
function go(id){
  state.current=id;
  $$('.page').forEach(p=>p.classList.toggle('active',p.id===id));
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===id));
  const info=pageInfo(id);$('#page-title').textContent=info[0];$('#page-subtitle').textContent=info[1];
  const side=$('.side');if(side)side.classList.remove('open');
  loadPage(id).catch(e=>toast(e.message,'error'));
}
async function loadPage(id){
  if(['home','restore','more'].includes(id))await loadBackups();
  if(id==='restore')await loadRestore();
  if(id==='agents')await loadAgents();
  renderAll();
}
async function loadConfig(){const r=await Api.config();state.config=r.config||r||{};if(!Array.isArray(state.config.sources))state.config.sources=[];}
async function loadStatus(){try{state.status=await Api.backupStatus()||{};}catch(_){}}
async function loadInfo(){try{state.info=await Api.info()||{};}catch(_){}}
async function loadBackups(){try{const r=await Api.backups();state.backups=r.backups||r.list||[];}catch(_){state.backups=[];}}
async function loadRestore(){try{const r=await Api.restoreList();state.restoreBackups=r.backups||r.list||[];}catch(_){state.restoreBackups=state.backups.filter(b=>(b.status||b.health)!=='trashed');}}
async function refreshAll(){await loadConfig();await Promise.all([loadStatus(),loadInfo(),loadBackups()]);renderAll();}
function renderAll(){renderHome();renderSources();renderSchedule();if(state.current==='restore')renderRestore();if(state.current==='more')renderBackups();}

/* ---------- 首页 ---------- */
function renderHome(){
  const en=enabledSources().length,sched=state.config&&state.config.schedule;
  const bk=state.backups.filter(b=>(b.status||b.health)!=='trashed');
  const hs=$('#home-status');if(hs)hs.innerHTML='<b>'+bk.length+'</b> 份备份 · <b>'+en+'</b> 项内容 · 定时'+(sched&&sched.enabled?'已开':'未开');
  const bh=$('#home-backup-hint');if(bh)bh.textContent=en?'已选 '+en+' 项内容':'尚未选择内容';
  const sh=$('#home-schedule-hint');if(sh)sh.textContent=sched&&sched.enabled?describeCron(sched.cron):'未开启';
  const rh=$('#home-restore-hint');if(rh)rh.textContent=bk.length?bk.length+' 份可恢复':'暂无备份';
  const hsrc=$('#home-sources');if(hsrc)hsrc.innerHTML=en?enabledSources().map(s=>'<div class="src-row"><b>'+esc(s.name)+'</b><small>'+esc(s.path)+'</small></div>').join(''):'<p class="muted">尚未选择备份内容。</p>';
  const hb=$('#home-backups');if(hb)hb.innerHTML=bk.length?bk.slice(0,5).map(b=>'<div class="mini-item"><span>'+esc(b.name||b.id)+'</span><small>'+fmtTime(b.createdAt||b.timestamp)+'</small></div>').join(''):'<p class="muted">暂无备份。</p>';
}

/* ---------- 备份页 ---------- */
function renderSources(){
  const box=$('#backup-sources');if(!box)return;
  var list=allSources();
  var hint=$('#no-source-hint');if(hint)hint.classList.toggle('hidden',list.length>0);
  box.innerHTML=list.map(function(s,i){return'<div class="check-item"><label class="check-line"><input type="checkbox" class="src-cb" data-i="'+i+'"'+(s.enabled?' checked':'')+'><span class="src-info"><b>'+esc(s.name||s.id)+'</b><small>'+esc(s.path||'')+'</small></span></label><span class="src-ops"><button class="link" data-edit="'+i+'">编辑</button><button class="link danger" data-del="'+i+'">删除</button></span></div>';}).join('');
  $$('.src-cb',box).forEach(function(cb){cb.onchange=function(){var i=+cb.dataset.i;state.config.sources[i].enabled=cb.checked;Api.saveConfig(state.config).catch(ignore);renderHome();};});
  $$('[data-edit]',box).forEach(function(b){b.onclick=function(){editSource(+b.dataset.edit);};});
  $$('[data-del]',box).forEach(function(b){b.onclick=function(){delSource(+b.dataset.del);};});
}
function editSource(i){
  var s=i==null?{name:'',path:'',enabled:true,include:['*'],exclude:['node_modules','.git','*.log','*.tmp']}:clone(state.config.sources[i]);
  modal(i==null?'添加备份内容':'编辑备份内容','<label class="modal-field">名称<input id="s-name" value="'+esc(s.name||'')+'" placeholder="例如：我的文档"></label><label class="modal-field">路径<input id="s-path" value="'+esc(s.path||'')+'" placeholder="/vol3/1000/nas/..."></label><label class="modal-field">包含规则（每行一条）<textarea id="s-include" rows="3">'+esc((s.include||['*']).join('\n'))+'</textarea></label><label class="modal-field">排除规则（每行一条）<textarea id="s-exclude" rows="3">'+esc((s.exclude||[]).join('\n'))+'</textarea></label><label class="check-line"><input id="s-enabled" type="checkbox"'+(s.enabled!==false?' checked':'')+'><span>加入备份内容</span></label><p class="modal-err hidden" id="s-err"></p>',[
    {label:'取消',cls:'ghost'},{label:'保存',cls:'primary',keep:true,onClick:function(){
      var name=$('#s-name').value.trim(),path=$('#s-path').value.trim();
      var err=$('#s-err');
      if(!name||!path){err.textContent='名称和路径不能为空';err.classList.remove('hidden');return false;}
      var ns={id:s.id||('src-'+Date.now()),name:name,path:path,enabled:$('#s-enabled').checked,include:$('#s-include').value.split('\n').map(function(x){return x.trim();}).filter(Boolean),exclude:$('#s-exclude').value.split('\n').map(function(x){return x.trim();}).filter(Boolean)};
      if(!ns.include.length)ns.include=['*'];
      state.config.sources=state.config.sources||[];
      if(i==null)state.config.sources.push(ns);else state.config.sources[i]=Object.assign({},state.config.sources[i],ns);
      return Api.saveConfig(state.config).then(function(){toast('已保存','ok');closeModal();renderSources();renderHome();}).catch(function(e){err.textContent=e.message;err.classList.remove('hidden');return false;});
    }}
  ]);
}
function delSource(i){
  var s=state.config.sources[i];
  confirmDialog('删除备份内容','确认删除「'+s.name+('」？（不影响已生成的备份）'),{danger:true,okLabel:'删除'}).then(function(ok){if(!ok)return;state.config.sources.splice(i,1);Api.saveConfig(state.config).then(function(){toast('已删除','ok');renderSources();renderHome();}).catch(function(e){toast(e.message,'error');});});
}
function applyRecommended(){
  state.config.sources=state.config.sources||[];
  var existing={};state.config.sources.forEach(function(s){existing[s.id]=true;if(s.path)existing[s.path+'|'+s.name]=true;});
  var added=REC_SOURCES.filter(function(r){return !existing[r.id];});
  if(!added.length){toast('推荐内容已全部添加','info');return;}
  confirmDialog('应用推荐配置','将添加 '+added.length+' 项智能体推荐备份内容（长期记忆 / 技能 / 智能体配置），是否继续？',{okLabel:'添加'}).then(function(ok){
    if(!ok)return;
    added.forEach(function(r){state.config.sources.push(clone(r));});
    Api.saveConfig(state.config).then(function(){toast('已添加 '+added.length+' 项推荐内容','ok');renderSources();renderHome();}).catch(function(e){toast(e.message,'error');});
  });
}
async function scanLargeFiles(){
  const rb=$('#wizard-result');rb.innerHTML='<p class="muted">扫描中……</p>';
  const en=enabledSources();
  if(!en.length){rb.innerHTML='<p class="muted">请先选择备份内容。</p>';return;}
  try{const r=await Api.scanLarge(en[0].path,30);const files=r.files||r.large||[];
    rb.innerHTML=files.length?'<p class="muted">'+esc(en[0].path)+' 下较大文件（前'+files.length+'）：</p><div class="mini-list">'+files.map(f=>'<div class="mini-item"><span>'+esc(f.path||f.name||f)+'</span><small>'+fmtSize(f.size)+'</small></div>').join('')+'</div>':'<p class="muted">未发现大文件。</p>';
  }catch(e){rb.innerHTML='<p class="modal-err">扫描失败：'+esc(e.message)+'</p>';}
}
async function runBackup(){
  const en=enabledSources();if(!en.length){toast('请先选择备份内容','error');return;}
  const btn=$('#start-backup-btn');btn.disabled=true;
  const pwd=($('#backup-encrypt-pwd').value||'').trim();
  const before=new Set(state.backups.map(backupId));
  state.lastBackupRun={before:before,expect:en.length,pwd:pwd};
  $('#backup-result').classList.add('hidden');$('#backup-run-title').textContent='备份进行中……';$('#backup-status').textContent='正在打包，请稍候。';
  try{const opt={manual:true};if(pwd)opt.password=pwd;await Api.runBackup(opt);pollBackup();}
  catch(e){btn.disabled=false;$('#backup-run-title').textContent='备份失败';$('#backup-status').textContent=e.message;toast(e.message,'error');}
}
function pollBackup(){
  if(state.polling)return;state.polling=true;let n=0;
  var timer=setInterval(async()=>{n++;let s={};try{s=await Api.backupStatus();}catch(_){}
    var pct=s.percent!=null?s.percent:(s.progress!=null?s.progress:null);
    if(pct!=null)$('#backup-status').textContent='进度 '+Math.round(pct)+'%'+(s.currentSource?' · '+s.currentSource:'');
    var running=s.running===true||s.status==='running';
    await loadBackups();
    var added=state.backups.filter(function(b){return!state.lastBackupRun.before.has(backupId(b));});
    if((!running&&(added.length>0||n>3))||n>150){clearInterval(timer);state.polling=false;$('#start-backup-btn').disabled=false;renderBackupResult(added,s);renderHome();}
  },2000);
}
function renderBackupResult(added,s){
  var box=$('#backup-result');box.classList.remove('hidden');
  var ok=added.filter(function(b){return(b.status||b.health||'success')!=='error';}).length;
  var fail=added.length-ok;
  if(added.length===0&&s&&s.error){
    $('#backup-run-title').textContent='备份失败';$('#backup-status').textContent=s.error;
    box.innerHTML='<div class="result-fail"><b>备份失败</b><p>'+esc(s.error)+'</p><div class="btn-row"><button class="btn ghost small" data-go2="more">查看日志</button><button class="btn primary small" id="rb-retry">重新备份</button></div></div>';
  }else{
    $('#backup-run-title').textContent='备份完成';$('#backup-status').textContent='成功 '+ok+' 份'+(fail?'，失败 '+fail+' 份':'');
    box.innerHTML='<div class="result-ok"><b>备份完成：成功 '+ok+' 份'+(fail?'，失败 '+fail+' 份':'')+'</b>'+(added.length?'<div class="mini-list">'+added.map(function(b){return'<div class="mini-item"><span>'+esc(b.name||b.id)+'</span><small>'+fmtSize(b.size)+'</small></div>';}).join('')+'</div>':'')+'<div class="btn-row"><button class="btn ghost small" data-go2="more">查看备份库</button><button class="btn primary small" id="rb-again">继续备份</button></div></div>';
  }
  var again=$('#rb-again');if(again)again.onclick=function(){$('#backup-result').classList.add('hidden');$('#backup-run-title').textContent='准备就绪';$('#backup-status').textContent='选择内容后点击开始备份。';};
  var retry=$('#rb-retry');if(retry)retry.onclick=runBackup;
  $$('[data-go2]',box).forEach(function(b){b.onclick=function(){go(b.dataset.go2);};});
}

/* ---------- 定时 ---------- */
function describeCron(cron){
  var a=String(cron||'0 3 * * *').trim().split(/\s+/),m=a[0]||'0',h=a[1]||'3',dom=a[2]||'*',dow=a[4]||'*',t=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
  if(dom!=='*')return'每月 '+dom+' 日 '+t;
  if(dow!=='*')return'每周'+'日一二三四五六'[parseInt(dow)||0]+' '+t;
  return'每天 '+t;
}
function cronToUi(){
  var a=String(state.config&&state.config.schedule&&state.config.schedule.cron||'0 3 * * *').trim().split(/\s+/),m=a[0]||'0',h=a[1]||'3',dom=a[2]||'*',dow=a[4]||'*';
  $('#sched-time').value=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
  $('#sched-cron').value=state.config&&state.config.schedule&&state.config.schedule.cron||'0 3 * * *';
  if(dom!=='*'){$('#sched-freq').value='monthly';$('#sched-day').value=String(Math.max(1,Math.min(28,parseInt(dom)||1)));}
  else if(dow!=='*'){$('#sched-freq').value='weekly';$('#sched-weekday').value=String(parseInt(dow)||0);}
  else $('#sched-freq').value='daily';
  updateSchedPreview();
}
function uiToCron(){var v=$('#sched-time').value||'03:00',h=parseInt(v.split(':')[0],10)||0,m=parseInt(v.split(':')[1],10)||0,f=$('#sched-freq').value;if(f==='weekly')return m+' '+h+' * * '+$('#sched-weekday').value;if(f==='monthly')return m+' '+h+' '+Math.max(1,Math.min(28,parseInt($('#sched-day').value)||1))+' * *';return m+' '+h+' * * *';}
function updateSchedPreview(){var f=$('#sched-freq').value,en=$('#schedule-enabled').checked;var cron=uiToCron();$('#sched-cron').value=cron;$('#sched-preview').textContent=(en?'已开启：':'未开启：')+describeCron(cron);}
function renderSchedule(){
  var s=state.config&&state.config.schedule;
  if(!s){return;}
  $('#schedule-enabled').checked=s.enabled;
  cronToUi();
  renderPerSourceSchedule();
}
function renderPerSourceSchedule(){
  var box=$('#per-source-sched-list');if(!box)return;
  var sources=allSources().filter(function(s){return s.scheduleEnabled;});
  if(!sources.length&&state.config.schedule.enabled){box.innerHTML='<p class="muted">没有设置独立定时的备份源，全部跟随全局计划。</p>';return;}
  if(!sources.length&&!state.config.schedule.enabled){box.innerHTML='<p class="muted">定时未开启，可在上方开启全局定时或为各源设置独立定时。</p>';return;}
  box.innerHTML=sources.map(function(s){return'<div class="per-source-item"><div class="src-info"><b>'+esc(s.name)+'</b><small>'+describeCron(s.schedule)+'</small></div><button class="btn ghost small" data-edit-sched="'+esc(s.id)+'">编辑</button></div>';}).join('');
  $$('[data-edit-sched]',box).forEach(function(b){b.onclick=function(){editSourceSchedule(b.dataset.editSched);};});
}
function editSourceSchedule(id){
  var s=state.config.sources.find(function(x){return x.id===id;});
  if(!s){toast('源不存在','error');return;}
  var cron=s.schedule||state.config.schedule.cron||'0 3 * * *';
  modal('编辑「'+esc(s.name)+'」独立定时','<label>时间<input id="ess-time" type="time" value="'+String((cron||'0 3 * * *').split(/\s+/)[1]||'03').padStart(2,'0')+':'+String((cron||'0 3 * * *').split(/\s+/)[0]||'0').padStart(2,'0')+'"></label><label class="check-line"><input id="ess-enabled" type="checkbox"'+(s.scheduleEnabled?' checked':'')+'><span>启用独立定时（关闭则跟随全局）</span></label><details><summary>手写 Cron</summary><input id="ess-cron" value="'+esc(cron)+'" placeholder="分 时 日 月 周"></details>',[
    {label:'取消',cls:'ghost'},{label:'保存',cls:'primary',onClick:function(){
      var en=$('#ess-enabled').checked;
      s.scheduleEnabled=en;
      if(en){var v=$('#ess-time').value||'03:00',h=parseInt(v.split(':')[0],10)||0,m=parseInt(v.split(':')[1],10)||0;s.schedule=m+' '+h+' * * *';}else s.schedule='';
      return Api.saveConfig(state.config).then(function(){toast('已保存','ok');renderPerSourceSchedule();}).catch(function(e){toast(e.message,'error');});
    }}
  ]);
}

/* ---------- 恢复页 ---------- */
function renderRestore(){
  var list=$('#restore-list');if(!list)return;
  var bk=state.restoreBackups;
  if(!bk.length){list.innerHTML='<p class="muted">暂无可用备份。请先在「备份」页创建备份。</p>';return;}
  list.innerHTML=bk.map(function(b){
    return'<div class="backup-card"><div class="card-main"><b>'+esc(b.name||b.id)+'</b><p>'+fmtTime(b.createdAt||b.timestamp)+' · '+fmtSize(b.size)+(b.encrypted?' · 加密':'')+(!b.encrypted?'':'')+' · '+healthLabel(b)+'</p></div><div class="card-ops"><button class="btn ghost small" data-preview="'+esc(b.id)+'">预览</button><button class="btn primary small" data-restore="'+esc(b.id)+'">恢复</button></div></div>';
  }).join('');
  $$('[data-preview]',list).forEach(function(b){b.onclick=function(){previewRestore(b.dataset.preview);};});
  $$('[data-restore]',list).forEach(function(b){b.onclick=function(){startRestore(b.dataset.restore);};});
}
async function previewRestore(id){
  try{var d=await Api.backupDetail(id);var files=d.backup||d;
    modal('备份详情','<div class="detail-section"><div><b>ID</b><span>'+esc(id)+'</span></div><div><b>大小</b><span>'+fmtSize(files.size)+'</span></div><div><b>时间</b><span>'+fmtTime(files.createdAt||files.timestamp)+'</span></div><div><b>状态</b><span>'+healthLabel(files)+'</span></div>'+(files.encrypted?'<div><b>加密</b><span>是</span></div>':'')+'</div>'+(files.description?'<p>'+esc(files.description)+'</p>':'')+'<div class="card-ops"><button class="btn primary small" data-restore="'+esc(id)+'">恢复此备份</button></div>',[{label:'关闭',cls:'ghost'}]);
    var restoreBtn=$('#modal-content [data-restore="'+esc(id)+'"]');
    if(restoreBtn)restoreBtn.onclick=function(){closeModal();startRestore(id);};
  }catch(e){toast(e.message,'error');}
}
function startRestore(id){
  modal('恢复备份','<p class="modal-msg">将恢复备份：<b>'+esc(id)+'</b></p><label class="modal-field">恢复到目录<input id="restore-target" value="/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces"></label><label class="modal-field">解密密码<input id="restore-password" type="password" placeholder="备份时设置的密码（可选）"></label><p class="modal-msg warn">恢复会覆盖目标目录中的同名文件。确认后执行。</p>',[
    {label:'取消',cls:'ghost'},{label:'确认恢复',cls:'primary',onClick:async function(){
      var target=$('#restore-target').value.trim(),password=$('#restore-password').value.trim();
      if(!target){toast('请输入恢复目录','error');return false;}
      try{await Api.executeRestore(id,target,password);toast('恢复已执行','ok');loadRestore();renderRestore();}catch(e){toast('恢复失败：'+e.message,'error');}
    }}
  ]);
}
async function loadTrash(){try{var r=await Api.trash();state.trash=r.items||r.trash||r.backups||[];var s=await Api.trashStats();renderTrash(s);}catch(_){state.trash=[];}}
function renderTrash(stats){
  var list=$('#trash-list');if(!list)return;
  var st=$('#trash-stats');if(st&&stats)st.textContent='共 '+stats.count+' 项，约 '+fmtSize(stats.size);
  if(!state.trash.length){list.innerHTML='<p class="muted">回收站为空。</p>';return;}
  list.innerHTML=state.trash.map(function(b){
    return'<div class="backup-card"><div class="card-main"><b>'+esc(b.name||b.id)+'</b><p>'+fmtTime(b.trashedAt||b.deletedAt||b.createdAt)+' · '+fmtSize(b.size)+'</p></div><div class="card-ops"><button class="btn ghost small" data-trash-restore="'+esc(b.id)+'">还原</button><button class="btn danger-soft small" data-trash-del="'+esc(b.id)+'">永久删除</button></div></div>';
  }).join('');
  $$('[data-trash-restore]',list).forEach(function(b){b.onclick=function(){Api.restoreTrash(b.dataset.trashRestore).then(function(){toast('已还原','ok');loadTrash();}).catch(function(e){toast(e.message,'error');});};});
  $$('[data-trash-del]',list).forEach(function(b){b.onclick=function(){confirmDialog('永久删除','确认永久删除此备份？',{danger:true,okLabel:'删除'}).then(function(ok){if(!ok)return;Api.deleteTrash(b.dataset.trashDel).then(function(){toast('已删除','ok');loadTrash();}).catch(function(e){toast(e.message,'error');});});};});
}
function cleanupTrash(){Api.cleanupTrash(30).then(function(){toast('已清理过期回收站','ok');loadTrash();}).catch(function(e){toast(e.message,'error');});}
function emptyTrashAll(){confirmWord('清空回收站','EMPTY',function(){return Api.emptyTrash().then(function(){toast('回收站已清空','ok');loadTrash();});});}

/* ---------- 智能体页 ---------- */
async function loadAgents(){
  var list=$('#agents-list');if(list)list.innerHTML='<p class="muted">加载中……</p>';
  try{var r=await Api.qwenpawDashboard();state.agents=r;renderAgents();}catch(e){if(list)list.innerHTML='<p class="modal-err">加载失败：'+esc(e.message)+'</p>';}
}
function renderAgents(){
  var list=$('#agents-list');if(!list)return;
  var cards=state.agents&&state.agents.cards||state.agents&&state.agents.agents||[];
  if(!cards.length){list.innerHTML='<p class="muted">未发现智能体。确保 QwenPaw 正在运行。</p>';return;}
  list.innerHTML='<div class="agents-grid">'+cards.map(function(c){
    return'<div class="agent-card"><div class="agent-header"><b>Agent '+esc(c.agent||'')+'</b><span class="agent-badge">'+(c.filesCount||'0')+' 文件</span></div><div class="agent-info"><small>记忆：'+(c.memoryFile?esc(c.memoryFile.split('/').pop()):'-')+' · 大小：'+fmtSize(c.memorySize)+(c.lastBackup?'<br>最近备份：'+fmtTime(c.lastBackup):'')+'</small></div><div class="agent-ops"><button class="btn ghost small" data-agent-health="'+esc(c.agent)+'">健康</button><button class="btn ghost small" data-agent-diff="'+esc(c.agent)+'">Diff</button><button class="btn ghost small" data-agent-history="'+esc(c.agent)+'">历史</button><button class="btn soft small" data-agent-snap="'+esc(c.agent)+'">快照</button></div></div>';
  }).join('')+'</div>';
  $$('[data-agent-health]',list).forEach(function(b){b.onclick=function(){checkAgentHealth(b.dataset.agentHealth);};});
  $$('[data-agent-diff]',list).forEach(function(b){b.onclick=function(){showAgentDiff(b.dataset.agentDiff);};});
  $$('[data-agent-history]',list).forEach(function(b){b.onclick=function(){showAgentHistory(b.dataset.agentHistory);};});
  $$('[data-agent-snap]',list).forEach(function(b){b.onclick=function(){snapshotAgent(b.dataset.agentSnap);};});
}
async function checkAgentHealth(agent){
  try{var r=await Api.qwenpawHealthCheck('/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/'+agent);
    var res=r.results||r.files||r;
    var html;
    if(Array.isArray(res)){html='<div class="mini-list">'+res.map(function(f){return'<div class="mini-item"><span>'+esc(f.name||f.file||f.path||'')+'</span><small>'+esc(f.ok===false||f.status==='missing'?'缺失':'正常')+'</small></div>';}).join('')+'</div>';}
    else html='<pre>'+esc(JSON.stringify(res,null,2))+'</pre>';
    modal('Agent '+agent+' 健康检查',html,[{label:'关闭',cls:'ghost'}]);
  }catch(e){toast(e.message,'error');}
}
function agentBackups(agent){
  return state.backups.filter(function(b){return(b.status||b.health)==='success'||(b.status||b.health)==='ok';}).filter(function(b){return String(b.sourceId||'').indexOf('agent-'+agent+'-')>=0||String(b.sourceName||'').indexOf('Agent '+agent)>=0||String(b.name||'').indexOf(agent)>=0;}).sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0);});
}
async function showAgentHistory(agent){
  await loadBackups();
  var hits=agentBackups(agent);
  modal('Agent '+agent+' 备份历史',hits.length?'<div class="card-list">'+hits.map(function(b){return'<div class="backup-card"><div class="card-main"><b>'+esc(b.name||b.id)+'</b><p>'+fmtTime(b.createdAt||b.timestamp)+' · '+fmtSize(b.size)+(b.encrypted?' · 加密':'')+'</p></div></div>';}).join('')+'</div>':'<p class="muted">该智能体暂无备份。</p>',[{label:'关闭',cls:'ghost'}]);
}
async function showAgentDiff(agent){
  await loadBackups();
  var hits=agentBackups(agent);
  if(hits.length<2){toast('需要至少两份备份才能对比','error');return;}
  var opts=hits.map(function(b){return'<option value="'+esc(b.id)+'">'+esc(fmtTime(b.createdAt||b.timestamp))+' ('+fmtSize(b.size)+')</option>';}).join('');
  modal('Agent '+agent+' 记忆 Diff','<label class="modal-field">旧版本<select id="diff-old">'+opts+'</select></label><label class="modal-field">新版本<select id="diff-new">'+opts+'</select></label><label class="modal-field">对比文件<input id="diff-member" value="workspaces/'+esc(agent)+'/MEMORY.md"></label><div id="diff-result"></div>',[
    {label:'关闭',cls:'ghost'},{label:'对比',cls:'primary',keep:true,onClick:async function(){
      var oldId=$('#diff-old').value,newId=$('#diff-new').value,member=$('#diff-member').value.trim();
      if(oldId===newId){toast('请选择两个不同的版本','error');return false;}
      $('#diff-result').innerHTML='<p class="muted">对比中……</p>';
      try{var r=await Api.qwenpawDiff(oldId,newId,member);var d=r.diff||r;
        $('#diff-result').innerHTML='<div class="diff-summary">新增 <b class="ok">+'+(d.added||0)+'</b> 行 · 删除 <b class="danger">-'+(d.removed||0)+'</b> 行</div>'+(d.text||d.patch?'<pre class="diff-pre">'+esc(d.text||d.patch)+'</pre>':'');
      }catch(e){$('#diff-result').innerHTML='<p class="modal-err">对比失败：'+esc(e.message)+'</p>';}
      return false;
    }}
  ]);
  $('#diff-new').selectedIndex=0;$('#diff-old').selectedIndex=Math.min(1,hits.length-1);
}
function agentMemGroup(agent){
  var base='/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces';
  return{id:'agent-'+agent+'-mem',name:'Agent '+agent+' 记忆',path:base,enabled:true,include:[agent+'/MEMORY.md',agent+'/memory/*.md',agent+'/PROFILE.md',agent+'/SOUL.md',agent+'/AGENTS.md'],exclude:['node_modules','.git','*.log','*.tmp']};
}
async function snapshotAgent(agent){
  if(!await confirmDialog('快照 Agent '+agent,'将立即为 Agent '+agent+' 的记忆创建一次备份。继续？',{okLabel:'开始快照'}))return;
  var g=agentMemGroup(agent);
  state.config.sources=state.config.sources||[];
  var ex=state.config.sources.find(function(s){return s.id===g.id;});
  if(ex)Object.assign(ex,g);else state.config.sources.push(g);
  try{await Api.saveConfig(state.config);await Api.runBackup({manual:true,only:[g.id]});toast('已启动快照','ok');
    var n=0;var timer=setInterval(async function(){n++;var s={};try{s=await Api.backupStatus();}catch(_){}if((!s.running&&s.status!=='running')||n>150){clearInterval(timer);toast('快照完成','ok');await loadAgents();}},2000);
  }catch(e){toast(e.message,'error');}
}
async function snapshotAllAgents(){
  var cards=state.agents&&(state.agents.cards||state.agents.agents)||[];
  if(!cards.length){toast('没有可快照的智能体','error');return;}
  if(!await confirmDialog('全体快照','将为全部 '+cards.length+' 个智能体创建记忆备份。继续？',{okLabel:'开始'}))return;
  state.config.sources=state.config.sources||[];
  cards.forEach(function(c){var g=agentMemGroup(c.agent);var ex=state.config.sources.find(function(s){return s.id===g.id;});if(ex)Object.assign(ex,g);else state.config.sources.push(g);});
  try{await Api.saveConfig(state.config);await Api.runBackup({manual:true});toast('已启动全体快照','ok');
    var n=0;var timer=setInterval(async function(){n++;var s={};try{s=await Api.backupStatus();}catch(_){}if((!s.running&&s.status!=='running')||n>150){clearInterval(timer);toast('全体快照完成','ok');await loadAgents();}},2000);
  }catch(e){toast(e.message,'error');}
}

/* ---------- 更多页：备份库 ---------- */
function renderBackups(){
  var box=$('#backups-list');if(!box)return;
  var q=($('#backup-search')?$('#backup-search').value:'').trim().toLowerCase();
  var f=$('#backup-status-filter')?$('#backup-status-filter').value:'';
  var list=state.backups.filter(function(b){return(b.status||b.health)!=='trashed';});
  if(q)list=list.filter(function(b){return String(b.name||b.id||'').toLowerCase().indexOf(q)>=0;});
  if(f)list=list.filter(function(b){return(b.status||b.health)===f;});
  if(!list.length){box.innerHTML='<p class="muted">没有匹配的备份。</p>';updateBatchBar();return;}
  box.innerHTML=list.map(function(b){
    return'<div class="backup-card"><label class="card-check"><input type="checkbox" class="batch-cb" value="'+esc(b.id)+'"></label><div class="card-main"><b>'+esc(b.name||b.id)+(b.protected?' <span class="lock-badge">保护</span>':'')+'</b><p>'+fmtTime(b.createdAt||b.timestamp)+' · '+fmtSize(b.size)+' · '+healthLabel(b)+'</p></div><div class="card-ops"><button class="btn ghost small" data-detail="'+esc(b.id)+'">详情</button><button class="btn ghost small" data-verify="'+esc(b.id)+'">校验</button><button class="btn ghost small" data-download="'+esc(b.id)+'">下载</button><button class="btn ghost small" data-protect="'+esc(b.id)+'" data-on="'+(b.protected?'1':'0')+'">'+(b.protected?'取消保护':'保护')+'</button><button class="btn danger-soft small" data-archive="'+esc(b.id)+'">归档</button></div></div>';
  }).join('');
  $$('.batch-cb',box).forEach(function(c){c.onchange=updateBatchBar;});
  $$('[data-detail]',box).forEach(function(b){b.onclick=function(){showBackupDetail(b.dataset.detail);};});
  $$('[data-verify]',box).forEach(function(b){b.onclick=function(){Api.verifyRestore(b.dataset.verify).then(function(r){toast('校验：'+(r.ok||r.valid?'完整':'异常'),(r.ok||r.valid)?'ok':'error');}).catch(function(e){toast(e.message,'error');});};});
  $$('[data-download]',box).forEach(function(b){b.onclick=function(){Api.download(b.dataset.download).catch(function(e){toast(e.message,'error');});};});
  $$('[data-protect]',box).forEach(function(b){b.onclick=function(){var on=b.dataset.on!=='1';Api.protect(b.dataset.protect,on).then(function(){toast(on?'已保护':'已取消保护','ok');loadBackups().then(renderBackups);}).catch(function(e){toast(e.message,'error');});};});
  $$('[data-archive]',box).forEach(function(b){b.onclick=function(){confirmDialog('归档到回收站','将此备份移入回收站？可在恢复页的回收站还原。',{okLabel:'归档'}).then(function(ok){if(!ok)return;Api.moveTrash(b.dataset.archive).then(function(){toast('已归档','ok');loadBackups().then(renderBackups);}).catch(function(e){toast(e.message,'error');});});};});
  updateBatchBar();
}
function updateBatchBar(){
  var n=$$('.batch-cb:checked').length;
  ['#batch-delete-btn','#batch-trash-btn','#batch-protect-btn'].forEach(function(s){var e=$(s);if(e)e.hidden=(n===0);});
}
function batchIds(){return $$('.batch-cb:checked').map(function(c){return c.value;});}
async function batchAction(action){
  var ids=batchIds();if(!ids.length)return;
  var label=action==='protect'?'保护':'归档到回收站';
  if(action!=='protect'&&!await confirmDialog('批量操作','确认对 '+ids.length+' 个备份执行「'+label+'」？',{danger:true,okLabel:'执行'}))return;
  try{
    for(var i=0;i<ids.length;i++){
      if(action==='protect')await Api.protect(ids[i],true);
      else await Api.moveTrash(ids[i]);
    }
    toast('已完成','ok');await loadBackups();renderBackups();
  }catch(e){toast(e.message,'error');}
}
async function showBackupDetail(id){
  try{var d=await Api.backupDetail(id);var b=d.backup||d;
    modal('备份详情','<div class="detail-section"><div><b>名称</b><span>'+esc(b.name||id)+'</span></div><div><b>大小</b><span>'+fmtSize(b.size)+'</span></div><div><b>时间</b><span>'+fmtTime(b.createdAt||b.timestamp)+'</span></div><div><b>状态</b><span>'+healthLabel(b)+'</span></div><div><b>加密</b><span>'+(b.encrypted?'是':'否')+'</span></div>'+(b.sourceName?'<div><b>来源</b><span>'+esc(b.sourceName)+'</span></div>':'')+'</div><label class="modal-field">备注<input id="meta-note" value="'+esc(b.description||b.note||'')+'"></label>',[
      {label:'关闭',cls:'ghost'},{label:'保存备注',cls:'primary',onClick:function(){return Api.updateMeta(id,{description:$('#meta-note').value.trim()}).then(function(){toast('已保存','ok');loadBackups().then(renderBackups);}).catch(function(e){toast(e.message,'error');});}}
    ]);
  }catch(e){toast(e.message,'error');}
}

/* ---------- 更多页：存储 ---------- */
function renderStorageForm(){
  var st=state.config&&state.config.storage||{},ret=state.config&&state.config.retention||{};
  if($('#storage-root'))$('#storage-root').value=st.root||'';
  if($('#storage-layout'))$('#storage-layout').value=st.layout||'year-month-source';
  if($('#storage-trash-days'))$('#storage-trash-days').value=st.trashDays||7;
  if($('#storage-max-upload'))$('#storage-max-upload').value=st.maxUploadGB||20;
  if($('#ret-days'))$('#ret-days').value=ret.days||30;
  if($('#ret-keeplast'))$('#ret-keeplast').value=ret.keepLast||10;
  if($('#ret-maxgb'))$('#ret-maxgb').value=ret.maxTotalSizeGB||100;
  var gfs=ret.gfs||{};
  if($('#gfs-enabled'))$('#gfs-enabled').checked=!!gfs.enabled;
  if($('#gfs-daily'))$('#gfs-daily').value=gfs.daily||7;
  if($('#gfs-weekly'))$('#gfs-weekly').value=gfs.weekly||4;
  if($('#gfs-monthly'))$('#gfs-monthly').value=gfs.monthly||12;
  var gf=$('#gfs-fields');if(gf)gf.classList.toggle('hidden',!(gfs.enabled));
}
async function saveStorage(){
  state.config.storage=Object.assign({},state.config.storage,{root:$('#storage-root').value.trim(),layout:$('#storage-layout').value,trashDays:+$('#storage-trash-days').value||7,maxUploadGB:+$('#storage-max-upload').value||20});
  try{await Api.saveConfig(state.config);toast('存储设置已保存','ok');}catch(e){toast(e.message,'error');}
}
async function saveRetention(){
  state.config.retention=Object.assign({},state.config.retention,{days:+$('#ret-days').value||30,keepLast:+$('#ret-keeplast').value||10,maxTotalSizeGB:+$('#ret-maxgb').value||100,gfs:{enabled:$('#gfs-enabled').checked,daily:+$('#gfs-daily').value||7,weekly:+$('#gfs-weekly').value||4,monthly:+$('#gfs-monthly').value||12}});
  try{await Api.saveConfig(state.config);toast('保留策略已保存','ok');}catch(e){toast(e.message,'error');}
}

/* ---------- 更多页：通知 ---------- */
function renderNotifyForm(){
  var n=state.config&&state.config.notify||{};var ch=n.channels||{};var qq=ch.qq||{},fn=ch.feiniu||{},em=ch.email||{};
  if($('#notify-enabled'))$('#notify-enabled').checked=!!n.enabled;
  if($('#notify-success'))$('#notify-success').checked=n.onSuccess!==false;
  if($('#notify-failure'))$('#notify-failure').checked=n.onFailure!==false;
  if($('#notify-nosource'))$('#notify-nosource').checked=n.onNoSource!==false;
  if($('#notify-qq-enabled'))$('#notify-qq-enabled').checked=!!qq.enabled;
  if($('#notify-qq-url'))$('#notify-qq-url').value=qq.url||'';
  if($('#notify-feiniu-enabled'))$('#notify-feiniu-enabled').checked=!!fn.enabled;
  if($('#notify-feiniu-url'))$('#notify-feiniu-url').value=fn.url||'';
  if($('#notify-email-enabled'))$('#notify-email-enabled').checked=!!em.enabled;
  if($('#notify-email-host'))$('#notify-email-host').value=em.host||'';
  if($('#notify-email-port'))$('#notify-email-port').value=em.port||465;
  if($('#notify-email-secure'))$('#notify-email-secure').checked=em.secure!==false;
  if($('#notify-email-user'))$('#notify-email-user').value=em.user||'';
  if($('#notify-email-pass'))$('#notify-email-pass').value=em.pass||'';
  if($('#notify-email-to'))$('#notify-email-to').value=em.to||'';
}
function collectNotify(){
  var old=state.config&&state.config.notify||{};var oldEmail=(old.channels&&old.channels.email)||{};
  return{
    enabled:$('#notify-enabled').checked,
    onSuccess:$('#notify-success').checked,onFailure:$('#notify-failure').checked,onNoSource:$('#notify-nosource').checked,
    channels:{
      qq:{enabled:$('#notify-qq-enabled').checked,url:$('#notify-qq-url').value.trim()},
      feiniu:{enabled:$('#notify-feiniu-enabled').checked,url:$('#notify-feiniu-url').value.trim()},
      email:Object.assign({},oldEmail,{enabled:$('#notify-email-enabled').checked,host:$('#notify-email-host').value.trim(),port:+$('#notify-email-port').value||465,secure:$('#notify-email-secure').checked,user:$('#notify-email-user').value.trim(),pass:$('#notify-email-pass').value,to:$('#notify-email-to').value.trim()})
    }
  };
}
async function saveNotify(){
  state.config.notify=collectNotify();
  try{await Api.saveConfig(state.config);toast('通知设置已保存','ok');}catch(e){toast(e.message,'error');}
}
async function testNotify(){
  var box=$('#notify-test-result');if(box)box.innerHTML='<p class="muted">发送中……</p>';
  try{state.config.notify=collectNotify();await Api.saveConfig(state.config);await Api.testNotify('这是一条来自智能体时光机的测试通知');if(box)box.innerHTML='<p class="ok-text">测试通知已发送，请检查各渠道。</p>';}
  catch(e){if(box)box.innerHTML='<p class="modal-err">发送失败：'+esc(e.message)+'</p>';}
}

/* ---------- 更多页：历史 / 审计 / 日志 ---------- */
async function loadHistory(){var box=$('#history-list');if(box)box.innerHTML='<p class="muted">加载中……</p>';try{var r=await Api.history();var items=r.history||r.items||r.list||[];if(box)box.innerHTML=items.length?items.map(function(h){return'<div class="log-row"><b>'+esc(h.action||h.type||'操作')+'</b><small>'+fmtTime(h.timestamp||h.createdAt)+' · '+esc(h.detail||h.message||h.target||'')+'</small></div>';}).join(''):'<p class="muted">暂无历史。</p>';}catch(e){if(box)box.innerHTML='<p class="modal-err">'+esc(e.message)+'</p>';}}
async function loadAudit(){var box=$('#audit-list');if(box)box.innerHTML='<p class="muted">加载中……</p>';try{var r=await Api.audit();var items=r.audit||r.items||r.list||r.logs||[];if(box)box.innerHTML=items.length?items.map(function(a){return'<div class="log-row"><b>'+esc(a.action||a.event||'事件')+'</b><small>'+fmtTime(a.timestamp||a.createdAt)+' · '+esc(a.detail||a.message||a.ip||'')+'</small></div>';}).join(''):'<p class="muted">暂无审计记录。</p>';}catch(e){if(box)box.innerHTML='<p class="modal-err">'+esc(e.message)+'</p>';}}
async function loadLogs(){var box=$('#logs-content');if(box)box.innerHTML='<p class="muted">加载中……</p>';try{var r=await Api.logs('server',200);var txt=r.content||r.log||r.text||(Array.isArray(r.lines)?r.lines.join('\n'):'');if(box)box.innerHTML=txt?'<pre>'+esc(txt)+'</pre>':'<p class="muted">暂无日志。</p>';}catch(e){if(box)box.innerHTML='<p class="modal-err">'+esc(e.message)+'</p>';}}

/* ---------- 改密 ---------- */
async function changePassword(){
  var o=$('#old-password').value,n=$('#new-password').value,c=$('#confirm-password').value;
  if(!n||n.length<8){toast('新密码至少8位','error');return;}
  if(n!==c){toast('两次新密码不一致','error');return;}
  try{await Api.changePassword(o,n);toast('密码已修改','ok');$('#old-password').value='';$('#new-password').value='';$('#confirm-password').value='';}catch(e){toast(e.message,'error');}
}

/* ---------- 子标签 ---------- */
function initSubTabs(){
  $$('.sub-tab').forEach(function(b){b.onclick=function(){
    var pane=b.closest('.page')||document;
    $$('.sub-tab',pane).forEach(function(x){x.classList.remove('active');});
    b.classList.add('active');
    $$('.sub-pane',pane).forEach(function(p){var on=p.dataset.sub===b.dataset.sub;p.classList.toggle('active',on);p.classList.toggle('hidden',!on);});
    var sub=b.dataset.sub;
    if(sub==='backups'){loadBackups().then(renderBackups);}
    if(sub==='storage'){renderStorageForm();}
    if(sub==='notify'){renderNotifyForm();}
    if(sub==='trash'){loadTrash();}
    if(sub==='history'){loadHistory();}
    if(sub==='audit'){loadAudit();}
    if(sub==='logs'){loadLogs();}
  };});
}

/* ---------- 事件绑定 ---------- */
function bind(){
  $$('.nav-item').forEach(function(b){b.onclick=function(){go(b.dataset.page);};});
  $$('[data-go]').forEach(function(b){b.onclick=function(){go(b.dataset.go);};});
  var mm=$('#mobile-menu');if(mm)mm.onclick=function(){$('.side').classList.toggle('open');};
  var rf=$('#refresh-btn');if(rf)rf.onclick=function(){refreshAll().then(function(){toast('已刷新','ok');});};
  var lb=$('#login-btn');if(lb)lb.onclick=doLogin;
  var lp=$('#login-password');if(lp)lp.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
  // modal 关闭：按钮 / 点遮罩 / Esc
  var mc=$('#modal-close');if(mc)mc.onclick=closeModal;
  var mo=$('#modal');if(mo)mo.addEventListener('click',function(e){if(e.target.id==='modal')closeModal();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('#modal').classList.contains('hidden'))closeModal();});
  // 备份页
  var rb=$('#recommend-btn');if(rb)rb.onclick=applyRecommended;
  var asb=$('#add-source-btn');if(asb)asb.onclick=function(){editSource(null);};
  var slb=$('#scan-large-btn');if(slb)slb.onclick=scanLargeFiles;
  var sbb=$('#start-backup-btn');if(sbb)sbb.onclick=runBackup;
  // 定时页
  var se=$('#schedule-enabled');if(se)se.onchange=function(){updateSchedPreview();saveSchedule();};
  ['#sched-freq','#sched-weekday','#sched-day','#sched-time'].forEach(function(s){var e=$(s);if(e)e.addEventListener('change',function(){toggleSchedDay();updateSchedPreview();saveSchedule();});});
  var sc=$('#sched-cron');if(sc)sc.addEventListener('change',function(){$('#sched-preview').textContent=($('#schedule-enabled').checked?'已开启：':'未开启：')+describeCron(sc.value);saveSchedule(true);});
  var spb=$('#sched-preview-btn');if(spb)spb.onclick=updateSchedPreview;
  // 恢复/回收站页
  var lrb=$('#load-restore-btn');if(lrb)lrb.onclick=function(){loadRestore().then(renderRestore);};
  var ltb=$('#load-trash-btn');if(ltb)ltb.onclick=loadTrash;
  var ctb=$('#cleanup-trash-btn');if(ctb)ctb.onclick=cleanupTrash;
  var etb=$('#empty-trash-btn');if(etb)etb.onclick=emptyTrashAll;
  // 智能体页
  var arb=$('#agents-refresh-btn');if(arb)arb.onclick=loadAgents;
  var ahb=$('#agents-health-btn');if(ahb)ahb.onclick=function(){if(state.agents&&(state.agents.cards||state.agents.agents)){checkAllAgentsHealth();}else loadAgents();};
  var asnap=$('#agents-snapshot-btn');if(asnap)asnap.onclick=snapshotAllAgents;
  // 更多页：备份库
  var lbb=$('#load-backups-btn');if(lbb)lbb.onclick=function(){loadBackups().then(renderBackups);};
  var bs=$('#backup-search');if(bs)bs.addEventListener('input',renderBackups);
  var bsf=$('#backup-status-filter');if(bsf)bsf.onchange=renderBackups;
  var bpb=$('#batch-protect-btn');if(bpb)bpb.onclick=function(){batchAction('protect');};
  var btb=$('#batch-trash-btn');if(btb)btb.onclick=function(){batchAction('trash');};
  var bdb=$('#batch-delete-btn');if(bdb)bdb.onclick=function(){batchAction('trash');};
  // 更多页：存储
  var ssb=$('#save-storage-btn');if(ssb)ssb.onclick=saveStorage;
  var vsb=$('#validate-storage-btn');if(vsb)vsb.onclick=function(){var root=$('#storage-root').value.trim();Api.validateStorage(root,true).then(function(r){toast(r.ok?'路径可用':(r.error||'路径不可用'),r.ok?'ok':'error');}).catch(function(e){toast(e.message,'error');});};
  var osb=$('#organize-storage-btn');if(osb)osb.onclick=function(){Api.organizeStorage().then(function(){toast('已整理','ok');}).catch(function(e){toast(e.message,'error');});};
  var srb=$('#save-retention-btn');if(srb)srb.onclick=saveRetention;
  var rgb=$('#run-gfs-btn');if(rgb)rgb.onclick=function(){Api.retentionRun().then(function(){toast('已执行保留清理','ok');loadBackups();}).catch(function(e){toast(e.message,'error');});};
  var ge=$('#gfs-enabled');if(ge)ge.onchange=function(){$('#gfs-fields').classList.toggle('hidden',!ge.checked);};
  // 更多页：通知
  var snb=$('#save-notify-btn');if(snb)snb.onclick=saveNotify;
  var tnb=$('#test-notify-btn');if(tnb)tnb.onclick=testNotify;
  // 更多页：配置/安全
  var ecb=$('#export-config-btn');if(ecb)ecb.onclick=function(){Api.exportConfig().catch(function(e){toast(e.message,'error');});};
  var imf=$('#import-file');if(imf)imf.onchange=async function(e){var f=e.target.files[0];if(!f)return;try{var txt=await f.text();await Api.importConfig(JSON.parse(txt));toast('配置已导入','ok');await refreshAll();}catch(err){toast('导入失败：'+err.message,'error');}};
  var cpb=$('#change-password-btn');if(cpb)cpb.onclick=changePassword;
  // 历史/审计/日志
  var lhb=$('#load-history-btn');if(lhb)lhb.onclick=loadHistory;
  var lab=$('#load-audit-btn');if(lab)lab.onclick=loadAudit;
  var llb=$('#load-logs-btn');if(llb)llb.onclick=loadLogs;
  initSubTabs();
}
function toggleSchedDay(){
  var f=$('#sched-freq').value;
  var dl=$('#sched-day-label'),wl=$('#sched-weekday-label');
  if(dl)dl.classList.toggle('hidden',f!=='monthly');
  if(wl)wl.classList.toggle('hidden',f!=='weekly');
}
async function saveSchedule(fromCron){
  state.config.schedule=state.config.schedule||{};
  state.config.schedule.enabled=$('#schedule-enabled').checked;
  state.config.schedule.cron=fromCron?($('#sched-cron').value.trim()||'0 3 * * *'):uiToCron();
  try{await Api.saveConfig(state.config);renderHome();}catch(e){toast(e.message,'error');}
}
async function checkAllAgentsHealth(){
  try{var r=await Api.qwenpawHealthCheck();var res=r.results||r.agents||r;
    modal('全体智能体健康检查','<pre>'+esc(JSON.stringify(res,null,2))+'</pre>',[{label:'关闭',cls:'ghost'}]);
  }catch(e){toast(e.message,'error');}
}

/* ---------- 初始化 ---------- */
window.App={togglePwd:togglePwd,showLogin:showLogin,go:go,refreshAll:refreshAll};
function boot(){bind();toggleSchedDay();initSubTabs();initAuth();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
else boot();
})();
