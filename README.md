# Agent 备份 (Agent Backup)

> **飞牛 fnOS 应用**：定时备份 / 手动备份 / 一键恢复 / 通知推送

## 项目简介

Agent 备份是一款运行在飞牛 fnOS 上的本地备份应用，专注于**关键目录的定时备份 + 快速恢复**。

### 核心功能

- **多源备份**：可同时配置多个备份源（笔记 / 配置 / 工作区等）
- **增量备份**：基于 `rsync --link-dest` 的硬链接增量，节省磁盘空间
- **定时调度**：`node-cron` 表达式（默认每天凌晨 3 点）
- **一键恢复**：UI 选择备份点 + 输入"YES"二次确认 → 原子恢复
- **三通道通知**：QQ webhook → 飞牛消息 → 邮件，自动降级
- **告警抑制**：5 分钟内同类通知合并
- **保留策略**：30 天固定保留 + 软回收 trash
- **空间预警**：1.5x 备份大小预警
- **安全认证**：`scrypt` 加盐哈希 + 5 次失败锁 5 分钟

### 技术栈

| 维度 | 选型 |
|:-----|:-----|
| 运行时 | Node.js v22（飞牛官方 `nodejs_v22`）|
| Web 框架 | Express 4.21+ |
| 定时任务 | node-cron |
| 备份引擎 | rsync + tar.zst + sha256 |
| 前端 | 单页 HTML（无框架，原生 JS）|

## 装机步骤

1. 下载 `com.dustinky.agentbackup.fpk` 文件
2. 飞牛桌面 → 应用中心 → 手动安装 → 选择 fpk
3. 等待安装完成（**首次安装会要求 root 权限**）
4. 桌面点击 "Agent 备份" 图标 → 浏览器打开 `http://<NAS_IP>:12083`
5. **首次访问**：使用默认密码 `admin` 登录（**装机后请立即修改**）
6. 配置备份源 + 定时规则 + 通知通道
7. 测试手动备份 → 验证恢复 → 正式启用

### 默认凭据

| 字段 | 值 |
|:-----|:---|
| 用户名 | `admin` |
| 初始密码 | `admin` |

**⚠️ 安全提示**：首次登录后**必须**在「设置 → 修改密码」修改默认密码。

## 配置

### 备份源

```json
{
  "sources": [
    {
      "id": "src-001",
      "name": "001 笔记（共享软链）",
      "path": "/vol3/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/001",
      "enabled": true,
      "include": ["*.md", "*.json"],
      "exclude": ["node_modules", ".git", "*.log"]
    }
  ]
}
```

### 定时规则

默认 `0 3 * * *`（每天凌晨 3 点）。可通过 crontab 表达式自定义：
- `0 */6 * * *`：每 6 小时
- `0 3 * * 0`：每周日凌晨 3 点
- `0 3 1 * *`：每月 1 号凌晨 3 点

### 通知通道

```json
{
  "notify": {
    "qq":      { "url": "https://qq-webhook-url" },
    "feiniu":  { "url": "https://feiniu-api-url" },
    "email":   { "smtp": "smtp.gmail.com:587", "user": "..." }
  }
}
```

## 开发

### 目录结构

```
agent-backup-source/
├── app/                  # Node.js 源码
│   ├── lib/              # 核心模块（auth / backup-engine / cron-engine / ...）
│   ├── routes/           # Express 路由
│   ├── ui/               # 前端（单页 HTML）
│   ├── server.js         # 入口
│   └── package.json
├── cmd/                  # 飞牛生命周期脚本（main / install_callback / ...）
├── config/               # privilege / resource
├── web/                  # fpk 打包资源（ICON）
├── manifest.json         # fpk 元数据
├── LICENSE
├── README.md
└── CHANGELOG.md
```

### 打包

```bash
cd /vol3/@appshare/com.dustinky.qwenpaw/agent-backup-source/com.dustinky.agentbackup
tar -czf app.tgz -C app server ui
fnpack build
md5sum com.dustinky.agentbackup.fpk  # 填入 manifest.json 的 checksum
fnpack build  # 第二遍生成最终 fpk
```

### 调试

```bash
# 手动启动（脱离 fnOS 生命周期）
/var/apps/com.dustinky.agentbackup/cmd/main start

# 查看日志
tail -f /vol3/@appdata/com.dustinky.agentbackup/logs/server.log

# 状态查询
/var/apps/com.dustinky.agentbackup/cmd/main status
```

## 故障排查

| 症状 | 原因 | 修法 |
|:-----|:-----|:-----|
| 应用中心显示"启用"但点不开 | 状态机死锁 | `sudo -u postgres psql -d appcenter -c "UPDATE app SET status='running' WHERE app_name='com.dustinky.agentbackup';"` |
| 端口 12083 占用冲突 | 旧进程残留 | `fuser -k 12083/tcp` + 重启应用 |
| 备份失败 `rsync: permission denied` | 备份源无读权限 | `chmod +r <source_path>` 或加入 `agent_backup` 用户组 |
| QQ 通知不发送 | webhook URL 错误 | 检查 config.json 的 `notify.qq.url` |

## 许可

本项目采用 [Apache License 2.0](LICENSE) 开源。

## 作者

- **黄元亮**（小米虾）—— 维护者
- 项目地址：`/vol3/@appshare/com.dustinky.qwenpaw/agent-backup-source/`
- 飞牛 fnOS 应用
