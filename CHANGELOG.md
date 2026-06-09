# 更新日志 (Changelog)


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
