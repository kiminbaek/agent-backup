# 智能体时光机 (QwenPaw Time Machine)

面向 **QwenPaw** 的本地智能体记忆备份、快照对比、健康检查与安全恢复工具，运行在飞牛 fnOS 上。

它不是普通目录备份工具，而是专门保护 QwenPaw 智能体资产：`MEMORY.md`、每日笔记、工作区配置、技能池、全局设置、对话/会话记录，以及完整 QwenPaw 数据目录。

## 核心能力

- **智能体仪表盘**：查看每个智能体的核心记忆、专项笔记、每日笔记、对话数量和最近快照。
- **一键快照**：对单个智能体或全部智能体执行记忆快照。
- **Memory Diff**：对比两次快照，或对比最新快照与当前文件。
- **单文件恢复**：从快照中恢复单个记忆文件，恢复前提供最终 Diff 预览和双确认。
- **恢复安全增强**：恢复前保护快照、恢复预检、归档校验、目标路径白名单、缺失目录提示。
- **记忆健康检查**：发现无快照、旧快照、超大 Markdown、重复长段落、核心文件缺失等风险。
- **备份策略中心**：选择智能体记忆、完整 QwenPaw、全局设置、技能池、插件/MCP、对话会话、日志缓存、密钥分组。
- **敏感配置保护**：密钥/敏感配置默认不备份；选择 `secrets` 时必须启用加密要求。
- **定时任务与保留策略**：支持全局计划、每源计划、保留天数、容量上限与 GFS 分级保留。
- **本地通知与审计**：记录操作审计，支持通知开关和多类日志查看。

## 适用场景

- 升级 QwenPaw 前，先给全部智能体做快照。
- 调整记忆、技能或全局配置后，回看变更差异。
- 某个智能体记忆被误改时，恢复单个文件。
- 新设备/重装系统后，预检并恢复 QwenPaw 数据。
- 定期检查智能体记忆体积、重复内容和快照新鲜度。

## 安装

1. 从 GitHub Releases 下载 `com.dustinky.agentbackup-v*.fpk`。
2. 在飞牛 fnOS 应用中心手动安装 fpk。
3. 安装向导中阅读并同意使用条款。
4. 桌面点击 **智能体时光机** 图标打开应用。
5. 首次进入后建议先打开 **备份策略**，确认备份范围，再执行一次手动快照。

## 安全建议

- 恢复真实 QwenPaw 数据前，先执行 **恢复预检** 和 **预览**。
- 不要对真实记忆目录做无保护的破坏性恢复。
- 选择密钥/敏感配置备份时必须启用加密，并妥善保存密码。
- 完整 QwenPaw 备份默认排除 `node_modules`、`.git`、缓存、日志、媒体、密钥类文件等膨胀或敏感内容。

## 开发与打包

```bash
# 语法检查
/var/apps/nodejs_v22/target/bin/node --check app/ui/lib/app.js
/var/apps/nodejs_v22/target/bin/node --check app/server/server.js

# fnOS 打包，注意不要使用 /tmp
TMPDIR=/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/003/ab-build-tmp fnpack build -d .
```

## 运行路径

- 应用 ID：`com.dustinky.agentbackup`
- 默认端口：`12083`
- 应用数据：`/vol3/@appdata/com.dustinky.agentbackup`
- 备份目录：默认 `/vol3/@appdata/com.dustinky.agentbackup/backup`

## 许可证

本项目为本地自托管工具，按“现状”提供。请在执行恢复操作前自行确认备份完整性、恢复目标和风险。
