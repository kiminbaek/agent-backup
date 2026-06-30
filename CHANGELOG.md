# 更新日志 (Changelog)


## v2.14.0 - 2026-06-30

### 🛠️ 健康检查可操作化 + 排版验收

在 v2.13.0 记忆健康检查基础上，把「发现问题」升级为「能直接处理」。

- **问题级操作按钮**：
  - 无快照 / 快照过期：显示「立即快照」。
  - 超大 Markdown / 疑似重复段落：显示「查看文件」。
- **面板级操作**：新增「重新扫描」和「一键快照有风险智能体」。
- **后端增强 issue.files**：超大 Markdown 返回文件路径、体积、mtime；重复内容返回涉及文件路径；仍不返回原文，保护隐私。
- **前端文件查看弹窗**：点击「查看文件」展示文件列表和体积，便于用户定位。
- **移动端排版优化**：健康检查 header、操作按钮、文件列表在窄屏下自动换行。

### 验证

- `node --check app/ui/lib/app.js app/server/routes/qwenpaw.js app/server/server.js` 通过。
- 生产 UI 待本版同步后进行桌面/移动端截图检查。


## v2.13.0 - 2026-06-30

### 🩺 记忆健康检查

新增只读健康扫描，帮助用户发现智能体记忆长期运行后的风险点。

- **后端新增 `/api/qwenpaw/health-check`**：只读扫描 QwenPaw workspaces，不修改任何记忆文件。
- **智能体页新增「记忆健康检查」按钮**：在「智能体时光机」页一键扫描并展示结果。
- **检查维度**：
  - 是否有成功快照 / 最近快照是否超过 3/7 天。
  - 核心文件 `MEMORY.md` / `SOUL.md` / `PROFILE.md` / `AGENTS.md` 是否缺失。
  - 核心记忆、`memory/` 目录体积是否过大。
  - 是否存在超大 Markdown 文件。
  - 日记忆文件数量是否过多。
  - `MEMORY.md` 是否长期未更新。
  - 疑似重复长段落数量（为保护隐私不展示原文）。
- **健康评分**：每个智能体给出 0-100 分和 `健康/注意/风险` 状态。
- **UI 展示**：新增健康摘要、每智能体健康卡片、问题列表，保持 fnOS 白底软件化风格。

### 验证

- `node --check app/ui/lib/app.js app/server/routes/qwenpaw.js app/server/server.js` 通过。
- 生产 `/api/qwenpaw/health-check` 返回成功：5 个智能体，摘要 `健康 0 / 注意 4 / 风险 1 / 问题 11`。
- 生产 UI 实测：智能体页「记忆健康检查」按钮可用，健康摘要、5 张健康卡片、问题列表正常显示。
- 准确性修正：健康扫描排除 `backup/`、`backups/`、`.trash/` 目录，避免把 workspace 内旧备份目录算进 Markdown 体积和重复内容。


## v2.12.0 - 2026-06-30

### 🛡️ 恢复安全增强：最终 Diff 预览 + 双确认

在 v2.11.0「记忆单文件回滚」基础上，一次性补齐恢复前确认体验，降低误覆盖风险。

- **恢复前最终 Diff 预览**：点击「恢复旧版本」后，不再直接弹确认；先自动执行「旧快照 vs 当前实际文件」对比，并在同一弹窗展示最终 Diff。
- **恢复目标摘要**：预览区展示快照 ID、文件名、目标目录，以及增删行统计 `+X -Y`。
- **双确认执行**：必须先生成预览，再点击「确认恢复这个旧版本」，之后还会出现浏览器最终确认框；确认后才调用 `/api/restore/file`。
- **保护快照路径展示**：恢复成功后展示后端返回的 `snapshot.path`，用户可知道恢复前保护快照已生成。
- **恢复后立即快照**：恢复成功后提供「立即快照该智能体」按钮，用于记录恢复后的新状态。
- **UI 样式补齐**：新增 `.restore-preview` / `.restore-actions` / `.restore-done` 等轻量样式，保持 fnOS 白底软件化风格。

### 验证

- `node --check app/ui/lib/app.js app/server/lib/restore.js app/server/server.js` 通过。
- 生产 v2.12.0 UI 实测：点击「恢复旧版本」先生成「旧快照 vs 当前」最终 Diff 预览；预览区展示快照、文件、目标目录、`+0 -0` 统计；点击「确认恢复这个旧版本」后才出现浏览器最终确认框。
- 安全验证：浏览器测试中先拦截 `confirm=false`，确认不会调用真实恢复；随后 mock `Api.restoreFile()` 验证恢复成功状态区能展示保护快照路径和「立即快照该智能体」按钮，未覆盖真实记忆文件。


## v2.11.0 - 2026-06-30

### 🔁 记忆单文件回滚闭环

补齐「智能体时光机」最关键的闭环：看变化 → 选版本 → 恢复旧版本。

- **Diff 弹窗新增恢复入口**：在「记忆时光对比」弹窗底部新增「恢复旧版本」按钮，恢复的是左侧「旧快照」中的当前所选 Markdown 文件。
- **自动定位当前目标目录**：根据 QwenPaw 根目录、智能体 ID 和所选文件路径自动计算目标目录；核心文件恢复到 `workspaces/<agent>/`，日记忆文件恢复到 `workspaces/<agent>/memory/`。
- **二次确认防误操作**：确认框展示快照 ID、文件名、目标目录，并明确提示会覆盖当前文件。
- **后端 restoreFile 兼容时光机 member**：`/api/restore/file` 支持前端传 `workspaces/<agent>/<file>`，自动解析归档真实 `work_<id>/workspaces/...` 前缀。
- **单文件恢复前保护快照**：`restoreFile()` 执行覆盖前会先调用 `snapshotTarget(targetPath)`，返回并审计记录保护快照路径。

### 验证

- `node --check app/ui/lib/app.js app/server/lib/restore.js app/server/server.js` 通过。
- 后端安全测试：短 member `workspaces/003/MEMORY.md` 成功解析到归档真实路径，并恢复到临时目录 `ab-restore-test`，未覆盖真实记忆文件。
- 单文件恢复前保护快照已返回：`/vol3/@appdata/com.dustinky.agentbackup/restore-snapshots/...tar.zst`。
- 生产 v2.11.0 UI 实测：Diff 弹窗存在「恢复旧版本」按钮；确认框正确展示快照、文件、目标目录；`memory/2026-06-30.md` 的目标目录正确为 `.../workspaces/003/memory`；测试中拦截确认返回 false，未执行真实覆盖。


## v2.10.0 - 2026-06-30

### 🕰️ Memory Diff 时光机体验增强

继续强化「智能体时光机」的核心体验：

- **动态文件列表**：记忆对比文件下拉不再硬编码 4 个核心文件，改为读取快照真实归档文件列表，自动展示该智能体下所有 Markdown 文件，包括 `memory/*.md` 日记忆与归档笔记。
- **快捷对比**：新增「最近两次快照」「最新快照 vs 当前」两个快捷按钮，减少手动选择成本；只有 1 个快照时「最近两次快照」自动禁用。
- **快照后变化引导**：单个智能体快照完成后，自动对比最新两次 `MEMORY.md`，Toast 提示 `+X -Y 行`，让用户立即知道这次记忆发生了什么变化。
- **UI 小优化**：Diff 弹窗标题改为「记忆时光对比」，新增 `.quick-diff` 按钮组样式。

### 验证

- 生产升级 v2.10.0 实测：003 记忆对比弹窗文件列表已展示 `memory/2026-06-xx.md`；「最新快照 vs 当前」返回 `+0 -0 两个版本内容一致`；1 个快照时「最近两次快照」按钮禁用。


## v2.9.0 - 2026-06-30

### 🧹 精简冗余，聚焦「按智能体备份」

「智能体时光机」定位下，清理「通用目录备份」时代遗留的多余功能：

- **删除「工具」页**：备份向导（扫大文件）、模板与推荐配置、QwenPaw 分析（已被「智能体」页仪表盘取代）、扫描工具——这些通用目录备份遗留功能在智能体定位下基本无用，整页移除。
- **删除「备份源」页的重复「定时调度」面板**：与「设置」页「计划任务」完全重复（v2.8.0 之前的历史遗留），保留更完整的设置页版本。
- **「备份源」降级为「高级 · 源管理」**：智能体快照已自动管理备份源，普通用户无需手动配目录源。该入口移至导航末尾并加说明，避免破坏「按智能体」的产品心智，但保留底层能力给高级用户。
- 导航从 13 项精简到 12 项。
- 同步清理对应的死代码 JS（tools handlers / cron-preset / scan handlers / 8 个孤儿函数），消除潜在 bind() 崩溃风险。


## v2.8.0 - 2026-06-30

### ⚙️ 埋藏功能可视化 + 调度 bug 修复

后端 v2.6.0 已实现 GFS 分级保留与多任务调度，但前端缺少入口，功能"半埋着"。本版把它们挖出来，并修复一个调度持久化 bug：

- **🐛 修复全局计划开关失效**：`storage.normalizeConfig` 旧逻辑把 `schedule` 对象拍平成纯字符串（`{enabled,cron}` → `cron`），导致「启用计划」开关永远存不住、自定义 cron 也会丢失，cron-engine 始终把全局计划当启用。改为规范化为 `{enabled, cron}` 对象并向后兼容旧字符串配置；cron-engine 读取 `schedule.enabled`，关闭时不再启动全局任务。
- **保留策略面板（全新）**：设置页新增「保留策略」——保留天数 / 至少保留最近 N 个 / 总容量上限 GB，以及 **GFS 分级保留**开关（每日/每周/每月保留数量）+「立即执行 GFS 清理」按钮。此前这些只能改原始 JSON 才能用。
- **计划任务面板升级**：iOS 风格开关「启用全局计划」+ 常用预设下拉联动 Cron + **每源独立计划**展示区（列出已设独立 cron 的源），打通 v2.6.0 多任务调度的可见性。
- **设置页 checkbox 统一**：剩余的老式 `<label>启用计划 checkbox` 改为 iOS 开关，与通知页风格一致。

### 验证

- 后端 `normalizeConfig` 单测：字符串/对象/enabled=false/缺失 四种输入归一化正确。
- 生产实时预览：保存 `schedule.enabled=false` + GFS 配置 → 重读持久化正确（修复前会丢失）。
- 浏览器实测：保留策略面板、GFS 开关联动（关闭字段变灰）、预设联动 Cron 全部通过。


## v2.7.0 - 2026-06-30

### 🎨 UI 全面优化（装机实测驱动）

v2.6.0 装机后逐页巡检发现一批不完善，本版系统性修复：

- **SVG 图标系统**：所有侧栏/移动端导航/卡片/状态图标从 emoji（fnOS 系统字体不渲染，显示为空方块 □）替换为内联 SVG（Lucide 风格，currentColor 自适应主题色）。彻底消除空方块。
- **品牌统一**：登录页、侧栏、文档标题、测试通知文案全部从「Agent 备份 / Backup Studio」更新为「智能体时光机 / QwenPaw Time Machine」，logo 改为时光机（时钟回溯）图标，完成 v2.6.0 重定位收尾。
- **通知页重构**：原 checkbox 因 `input{width:100%}` 被撑满右对齐、label 与控件分离换行——重写为 iOS 风格开关（switch-row）+ 字段分组（触发事件 / 飞牛 Webhook / QQ Webhook / 邮件 SMTP）。
- **总览页**：「应用信息」移除主机名/服务地址暴露（避免设备信息泄露），改为版本/端口/智能体数/快照数；并自动加载智能体统计。
- **备份库**：状态徽章、操作按钮去 emoji，加密标记改文字徽章。

> 纯前端优化，后端逻辑不变。


## v2.6.0 - 2026-06-29

### 🤖 重新定位：QwenPaw 智能体时光机

将「通用目录备份工具」收窄为「QwenPaw 智能体记忆的时光机」，备份单位从「目录」升级为「智能体」。

- **智能体仪表盘**（新 Tab）：扫描 QwenPaw workspaces，按智能体卡片展示核心记忆大小、日记忆/专项笔记/对话数量、MEMORY.md 最后修改、最近备份状态。
- **一键快照**：单个智能体「立即快照」/ 全部智能体「一键快照」，自动生成 `Agent <id> 记忆` 备份源（含 MEMORY/SOUL/PROFILE/AGENTS + memory/）。
- **记忆时光对比（Memory Diff）**：纯 JS LCS 行级 diff，红绿高亮，支持「快照 vs 快照」与「快照 vs 当前实际文件（CURRENT）」对比；仅对文本（.md/.json），二进制只比 size/sha256。
- **真实 SMTP 邮件通知**：零依赖自写 SMTP 客户端（net+tls，SSL/STARTTLS + AUTH LOGIN + UTF-8 主题 base64），通知 Tab 新增完整 SMTP 配置表单。
- **GFS 分级保留**：祖父-父-子保留策略（daily/weekly/monthly），与原有按天数+keepLast 保留并存。
- **多任务调度**：全局计划（兜底）+ 每源独立 cron 计划；保存配置即热重载调度。

### 🔧 其他

- 备份运行支持 `sourceIds` 过滤，按需备份指定源。
- `readArchiveMember` 修复归档 `work_<id>/` 顶层前缀解析。
- notify 配置深合并修复，保留 email 默认字段。


## v1.1.3 - 2026-06-09

一次性补齐 v1.1.1-v1.1.3 功能：

- v1.1.1：回收站闭环：列表、恢复、永久删除、清空、过期清理、空间统计、状态筛选。
- v1.1.2：恢复/删除安全增强：恢复目标风险等级、恢复前快照、永久删除保护检查、操作审计日志。
- v1.1.3：易用性增强：备份备注、标签、备份源模板、一键推荐配置、大文件 Top 20 扫描、推荐排除规则、大小异常检测接口。
- UI 新增：回收站、审计、工具 Tab；备份文件支持状态筛选、备注/标签编辑。

本项目遵循 [Semantic Versioning](https://semver.org/) 规范。

## [1.1.0] - 2026-06-09

### ✨ 一次性功能完整升级

- 新增备份文件下载、导入、详情、归档内部文件列表查看。
- 新增自定义备份存放路径、路径校验、按年/月/来源自动分类整理。
- 新增备份前预检查、备份健康状态、trash 软删除、保护备份。
- 新增通知配置界面后端能力：通知总开关、成功/失败/无源场景、QQ/飞牛 webhook。
- 新增恢复前预览（rsync -ani）与配置导出/导入。
- UI 将补齐备份文件管理、导入、存储设置、通知配置等操作入口。

---

## [1.0.19] - 2026-06-09

### 🐛 修复

- **备份失败** `fs.flockSync is not a function`：Node.js v22 **没有** `fs.flockSync`（**v24+** 才新加）。改用 `O_EXCL` 原子文件锁 + PID 校验（POSIX 标准，所有 Node.js 版本都支持）
  - **陈旧锁自愈**：启动时检查锁文件里的 PID 是否还活着（`process.kill(pid, 0)`），死了就自动清理（防应用崩溃后留下死锁）
  - 沙箱单测通过：lock → lock 失败 (EEXIST) → unlock → lock 成功

### ✅ 验证

- v1.0.19 装机 v1.0.19 登录成功 + 备份功能正常

---

## [1.0.18] - 2026-06-09

### 🐛 修复（致命 BUG）

- **登录永远密码错误**：`verifyPassword` 比较时 `expected = "hash"` 但 `actual = "salt:hash"`（因为 `scryptHash` 返回的就是 `"salt:hash"` 完整字符串），**永远不可能相等**
- 修法：直接 `actual === auth.passwordHash` 比较完整字符串
- v1.0.0~v1.0.17 一直有这个 BUG，从未真正登录过
  - v1.0.16 setup → 设密码后直接拿到 token，没走 verifyPassword
  - 一旦清浏览器/换浏览器/卸载重装 → 走 login 流程 → 永远密码错

### ✅ 验证

- v1.0.18 装机登录成功

---

## [1.0.17] - 2026-06-09

### ✨ 新增（8 项功能完善）

- **版本号 + IP 真实显示**：`GET /api/info`（version / IP / hostname / port / url）+ UI 初始化时调 `loadInfo()`
- **默认备份源路径**改 `/vol3/1000/nas`（不再指向用户目录）
- **手动备份进度条** UI 展示（假进度 0→90%→100%）
- **保留策略手动执行**按钮 + `POST /api/backup/retention/run`
- **日志查看**：`GET /api/log?lines=N` + UI 新增「日志」Tab + `loadLog()`

### 🔧 重构（5 处代码质量优化）

- 5 个 routes 共用 `auth.requireToken` 中间件（删 32 行重复代码）
- `auth.getToken()` 替代 login 中的直接 `readFileSync`
- `fs.rmSync` 替代 `execSync('rm -rf')`（防 shell 注入）
- IP 探测改 `.find() + flat()`（简洁 + 无 sentinel 风险）
- UI 进度条 CSS 补齐（之前完全没显示！）

---

## [1.0.16] - 2026-06-08

### ✨ 新增

- **首次登录注册密码流程**：setup 不再写默认 admin
  - `cmd/main setup` 写 `passwordHash: null, needsPasswordSetup: true`
  - `lib/auth.js` 加 `getAuthStatus()` + `setupPassword()` + `verifyPassword` 检测 `needsPasswordSetup`
  - `routes/auth.js` 加 `GET /api/auth/status` + `POST /api/auth/setup`
  - UI 新增「设置密码」模态框 + 初始化先调 `/api/auth/status`

### 🐛 修复

- **scrypt 登录** `Invalid scrypt params: memory limit exceeded`：OpenSSL 3.x 默认 maxmem 32MB 太小，加 `maxmem: 1024*1024*1024`（1GB）

### 📚 装机关键发现

- **UI_DIR 路径必须 `path.join(__dirname, '..', 'ui')`**（ui 与 server 平级，不是 server 子目录）
- **删 `config/resource` 的 `systemd-unit: {}` 段**：让 fnOS UI 不显「卸载」
- **`cmd/main` 的 `sync_appcenter_status` 写 `is_stop=true`**：让 UI 可点击

---

## [1.0.2] - 2026-06-08

### 🐛 修复（fnOS 装机 nil pointer 真根因）

- **删 `manifest` 3 个非标字段**（v1.0.0-rc1 + v1.0.1 一直没发现）：
  - `run_as = root` ← 不在 fnOS manifest 字段清单（应放 `config/privilege`）
  - `support_arch = x86_64` ← 旧版 `arch` 字段已废弃，新版用 `platform`
  - `language = zh-cn` ← 不在 fnOS manifest 字段清单

### 📚 依据

- fnOS 文档 3.3 完整字段清单：`appname / version / display_name / desc / platform / source / maintainer[/url] / distributor[/url] / os_min_version[/max] / ctl_stop / install_type / install_dep_apps / service_port / checkport / disable_authorization_path / changelog / desktop_uidir / desktop_applaunchname`
- 装上版对比：proc-guardian v1.0.8（14 字段）/ xray-proxy v1.17.1（14 字段）/ fnos-apps-store（16 字段）**都**没这 3 字段
- 错误堆栈：`AppService.GetCloudDetail`（`/app/core/service/app.go:157`）拼装 WizardData 遇非标字段 → nil pointer → 10111 → 弹"无效fpk包"

### 🔬 v1.0.1 失败回顾

- v1.0.1 改了 5 个**表层**问题（icon 字段 / icon_*.png / wizard/upgrade / privilege username / resource 格式）
- **全错方向**——**全**没触及 manifest 字段，**仍**在 GetCloudDetail 阶段崩

---

## [1.0.1] - 2026-06-08

### 🐛 修复（fnOS 装机校验 10111 nil pointer 错误）

- **`app/ui/config` 的 `icon` 字段**：从 `images/256.png` 改为 `images/icon_{0}.png`（fnOS 文档 3.8 占位符规范）
- **补 `app/ui/images/icon_64.png` + `icon_256.png`**：从根目录 `ICON.PNG` / `ICON_256.PNG` 复制（fnOS 文档 3.8 必备）
- **补 `wizard/upgrade` 文件**：空数组 `[]`（fnOS 文档 3.7 四种类型必备）
- **`config/privilege` 的 `username` / `groupname`**：从 `agent_backup` 改为 `com.dustinky.agentbackup`（与 appname 一致，参考 WxBackup / trim.openclaw）
- **`config/resource` 格式**：从旧版 `cpu/memory/disk` 改为 `data-share` + `systemd-unit`（参考 fnos-apps-store）

### 📚 参考

- 完整排查见 `/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/003/agent_backup_dev_notes.md`
- fnOS 文档：https://developer.fnnas.com/docs/guide/

---

## [1.0.0] - 2026-06-XX

### ✨ 新增

- **首版发布**：基础备份 + 恢复 + 定时调度 + 通知推送
- **多源备份**：UI 配置多个备份源（路径 / include / exclude）
- **rsync 增量**：基于 `--link-dest` 的硬链接增量备份
- **tar.zst 压缩**：归档使用 zstd 压缩，节省 30-50% 空间
- **sha256 校验**：每个备份生成 SHA-256 摘要
- **scrypt 认证**：密码加盐哈希（131072 round）+ 5 次失败锁 5 分钟
- **三通道通知**：QQ webhook / 飞牛消息 / 邮件，自动降级
- **告警抑制**：5 分钟内同类通知合并
- **保留策略**：30 天固定保留 + trash 软回收
- **空间预警**：1.5x 备份大小预警
- **cron 调度**：`node-cron` 表达式（默认 `0 3 * * *`）
- **pkill 全覆盖**：5 处 pkill 函数，清理孤儿进程
- **状态机同步**：start() 末尾自动 sync appcenter DB
- **路径白名单**：备份/恢复时路径校验，防止越权
- **二次确认**：恢复 / 删除 / 修改敏感操作需输入 "YES"

### 🔧 技术细节

- Node.js v22 + Express 4.21+
- 端口：`12083`（不与 xray 2087 冲突）
- run-as：`root`（需访问 `/vol3/@appshare/` 软链池）
- 数据目录：`/vol3/@appdata/com.dustinky.agentbackup/`
- 单页 HTML：原生 JS（无框架）
- 启动方式：fnOS 生命周期（`TRIM_APP_STATUS` 环境变量）

### 🔒 安全

- 默认密码 `admin` 必须首次登录后修改
- 备份文件存储在 `/vol3/@appdata/.../backups/`（root:root 700）
- 通知 webhook 存储在 `config.json`（root:root 600）
- 卸载保护：`uninstall_callback` **不**删除 backups/ 目录

---

## 版本说明

- **v1.0.0**：骨架版本，**不**装机（仅本地 shell 验证）
- **v1.0.1-v1.0.2**：manifest 字段修复（fnOS 装机 nil pointer）
- **v1.0.16-v1.0.19**：装机成功 + 登录成功 + 备份成功
- **v1.0.20**：findLatestBackup link-dest 失效修复（磁盘爆炸 BUG）+ 23 项安全/稳定优化 + 8 项 UI 完善 + /api/backup/status 真进度
- **v1.0.21**：install_deps 加 npm install 兜底（v1.0.20 fpk 漏打包 node_modules 启动失败）
- **v1.0.22**：Token Modal（显示/复制）+ AbortController 真进度轮询 + 装 v1.0.21 后升级
