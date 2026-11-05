# WhatsApp 手机通道

[English](mobile-whatsapp.md) · **简体中文**

Clone AI 可以从手机 WhatsApp 接收文本，并交给 Mac App 使用的同一个 Main Agent
执行。手机不会直接连接 Mac Runtime。

## 为什么选 WhatsApp，而不是 iMessage

Apple 没有提供受支持的 iMessage/Messages 机器人 API。用 AppleScript 驱动
Messages.app，或读取本地 `chat.db`，都是依赖系统版本的私有做法，不适合要求长期稳定
工作的产品。WhatsApp Cloud API 提供受支持的 Webhook 和回复接口，因此手机通道先实现
WhatsApp。

WhatsApp 走互联网，不依赖短信，但**不能保证完全免费**。Meta 可能按账号、地区、会话
类型和当期规则收取商业消息费用。启用前应查看 Meta 最新定价；Clone AI 不假设也不承诺
一定存在免费额度。

## 数据路径

```text
iPhone WhatsApp
  -> Meta Cloud API Webhook
  -> HTTPS 隧道
  -> clone-ai WhatsApp 桥（127.0.0.1:4318）
  -> Companion API（127.0.0.1，Bearer 鉴权）
  -> Main Agent / Run Queue
  -> 通过 Meta Graph API 回复
  -> iPhone WhatsApp
```

桥与桌面窗口分离，拥有自己的 SQLite 收件箱，验证每个原始 Webhook 请求体，并且只接受
白名单号码。App 内向导会把它作为独立的本地进程启动，因此关闭桌面窗口不会停止它；
需要断开时，在同一个向导里点击“停止手机桥”。

## 在 App 内一键绑定

最短路径是使用 App 内的向导：

1. 点击左侧的 **连接手机**，或打开 **设置 → 手机通道**。
2. 填写白名单 WhatsApp 号码、Phone Number ID、Access Token、App Secret；
   生成 Verify Token，然后点击 **保存并启动手机桥**。
3. 如果缺少 `cloudflared`，点击 **安装 cloudflared**。它会使用 Homebrew，
   并且必须先在 App 内明确确认。
4. 点击 **启动免费隧道**，复制生成的 HTTPS Webhook 地址，再复制 Verify Token。
5. 到 Meta 的 WhatsApp 配置中粘贴以 `/webhook` 结尾的回调地址和 Verify Token，
   订阅 `messages` 字段，然后用白名单手机号发一条 WhatsApp。

App 内的清单会依次显示：凭据已保存、手机桥已运行、公网地址已生成、
Meta 已完成 GET 验证、已经收到手机消息。Access Token 和 App Secret 在这套 UI 中是
只写字段：保存到权限为 `0600` 的 `~/.clone/whatsapp.env`，状态接口永不回显。

## 手动配置 Meta

1. 创建带 WhatsApp 产品的 Meta App，并使用测试或正式电话号码。
2. 记录 Phone number ID、App Secret 和 Cloud API Access Token。
3. 生成一个随机 Webhook Verify Token，不要复用 Access Token。
4. 只把值放进 Shell 或 LaunchAgent 环境：

```bash
export WHATSAPP_ACCESS_TOKEN='...'
export WHATSAPP_PHONE_NUMBER_ID='...'
export WHATSAPP_VERIFY_TOKEN='...'
export WHATSAPP_APP_SECRET='...'
export WHATSAPP_ALLOWED_NUMBERS='+8613800000000'
```

多个所有者用逗号分隔。白名单必须配置；空白名单会拒绝所有发送者。

旧的命令行 LaunchAgent 安装器仍可用于恢复和无 GUI 的场景。App 内向导是新的主路径；
两者只能选一个，不能让两个桥同时争用同一端口和收件箱。

```bash
npm run mobile:install
```

这会创建权限为 `0600` 的 `~/.clone/whatsapp.env` 和 LaunchAgent plist。把密钥填进
环境文件（不要填进 plist），然后执行安装器打印的 `launchctl` 命令。该文件只会被桥进程
读取。

## 本机运行

```bash
npm run mobile:whatsapp
```

桥监听 `127.0.0.1:4318`，启动日志只输出非敏感状态。可用
`CLONE_AI_WHATSAPP_PORT` 改端口。

只暴露这个桥的临时 HTTPS 隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:4318
```

在 Meta Webhook 设置中填写生成的 HTTPS 地址加 `/webhook`，订阅 `messages` 字段。
`GET /webhook` 处理 Meta 校验，`POST /webhook` 接收消息。

不要把 Companion 端口（默认 `4317`）暴露到公网。桥是唯一公网面，它不代理配置修改、
审批、Connector 安装或任意 API。

## 安全与行为

- 使用原始请求体与 App Secret 计算 HMAC-SHA256，常量时间比较
  `X-Hub-Signature-256`。
- 未知号码、群消息、媒体、表情回应和状态回调会被忽略。
- WhatsApp message id 是收件箱主键，Meta 重试不会把同一条消息执行两次。
- 同一 id 会作为 `whatsapp:<message id>` 传给 Companion。已完成回合重试时直接返回已存
  回复，不再调用模型。
- 先持久化消息，再返回 `200`。崩溃留下的 `processing` 行会在重启后恢复执行。
- 独立桥仍在运行、但桌面 Runtime 已关闭或正忙时，消息会留在本机队列并退避重试。
  所有者会先收到一次「已排队、尚未执行」提示；恢复后重试会发送真正的回复。
- 长回复会按 Cloud API 的 4096 字符上限切分并编号。
- 失败会明确报告为失败。Main Agent 离线或回合失败时，桥不会声称任务已完成。
- 只发送可见回复。不会转发模型私有推理、工具轨迹、令牌或本地文件内容。

## 当前限制

桥运行在 Mac 上。Mac 休眠、隧道断开或桥未运行时，Meta 无法送来新 Webhook。Meta 可能
重试失败投递，但本桥不承诺远程离线队列。本机队列覆盖的是「桌面窗口已关闭」或
「Main Agent 正忙」，不等同于 Mac 已关机。若要手机端永远在线，下一步是增加一个小型
中继，让 Mac 主动建立鉴权长连接；不要把 Companion 端口直接开到公网来解决。

## 测试

```bash
node --experimental-strip-types --test test/whatsapp-bridge.test.ts
```
