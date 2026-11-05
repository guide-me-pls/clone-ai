# 服务器部署

[English](server-deployment.md) · **简体中文**

Mac App 是本地优先的桌面入口。没有公网 IP 的 Mac 可以把同一个 Runtime 和 UI 部署到
一台小型 Linux 服务器。服务器只负责编排：模型使用远程 Provider。1 核 2G 适合运行
Main Agent、记忆、定时任务、审计和 WhatsApp 桥，不适合在服务器上跑本地大模型。

## 包含什么

- `src/server-main.ts`：带稳定 Bearer Token 的无界面服务器入口。
- `Dockerfile`：Node 24 运行镜像，不在镜像里构建模型或前端。
- `compose.server.yml`：Clone AI + Caddy + 持久化数据卷 + workspace。
- `deploy/Caddyfile`：HTTPS、所有者认证，以及公开的 WhatsApp Webhook 路由。
- `deploy/server.env.example`：服务器专用环境变量模板。

容器监听 `4317`（UI/API）和 `4318`（WhatsApp Webhook）。两个端口都不直接发布到宿主机，
Caddy 是唯一公网入口并终止 TLS。

## 前置条件

- Linux 服务器，至少 1 核 / 2G。
- 在 2G 主机上首次构建镜像时，建议配置 1-2G swap。
- Docker Engine 和 Docker Compose v2。
- 一个 A/AAAA 记录指向服务器的域名。
- 开放 80 和 443。
- Main Agent 使用的远程模型凭据。

## 配置

1. 复制服务器环境模板：

```bash
cp deploy/server.env.example deploy/server.env
```

2. 生成稳定的 Companion Token：

```bash
openssl rand -hex 32
```

3. 生成 Caddy 所有者密码哈希：

```bash
docker run --rm caddy:2.8 caddy hash-password --plaintext 'change-me'
```

4. 填写 `deploy/server.env`：

```dotenv
CLONE_AI_DOMAIN=agent.example.com
CLONE_AI_PUBLIC_URL=https://agent.example.com
CLONE_AI_COMPANION_TOKEN=<64 位十六进制>
CLONE_AI_PROXY_SECRET=<另一个 64 位十六进制>
CLONE_AI_BASIC_AUTH_USER=owner
CLONE_AI_BASIC_AUTH_HASH='<bcrypt 哈希>'
CLONE_AI_MAIN_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=<模型密钥>
```

不要提交 `deploy/server.env`。

## 启动

```bash
docker compose -f compose.server.yml up -d --build
docker compose -f compose.server.yml ps
docker compose -f compose.server.yml logs -f clone-ai
```

访问 `https://agent.example.com`。Caddy 会要求输入环境文件里的用户名和密码，认证后
浏览器才拿到 Clone AI UI。

反向代理刻意让 `/webhook` 对 Meta 公开，而 UI 与 API 保持在所有者认证后面。Webhook
本身还有 HMAC-SHA256 验签和手机号白名单。

## WhatsApp

打开 **连接手机**，填写 Cloud API 配置。服务器部署会使用固定公网地址：

```text
https://agent.example.com/webhook
```

这种模式不需要 Cloudflare Tunnel，也不要把 `4317` 或 `4318` 直接暴露到宿主机防火墙。
Mac 不再需要公网 IP，因为 Agent 已经运行在 Linux 服务器上。

## 数据与更新

Compose 使用命名卷 `clone_data`、`clone_workspace`，以及 Caddy 的证书/配置卷。更新代码
不会删除它们：

```bash
git pull
docker compose -f compose.server.yml up -d --build
```

升级前备份数据卷：

```bash
docker run --rm -v clone-ai_clone_data:/data -v "$PWD":/backup \
  alpine tar czf /backup/clone-data.tar.gz -C /data .
```

## 限制

- 1 核 2G 必须使用远程模型，不要在服务器跑本地大模型。
- 无界面镜像没有安装 Claude Code、Codex CLI、Pi 等 Coding Agent CLI。Main Agent 和
  远程模型路径可用；黑盒子 Agent 需要另行安装对应 Provider，后续可拆成独立 Worker 服务。
- 服务器是单所有者模式。不要共享 Caddy 登录信息或 Companion Token。
- 服务器仍然需要 HTTPS 域名，示例故意不填具体地址；启动前请你配置域名。
