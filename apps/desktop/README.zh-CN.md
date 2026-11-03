# clone-ai 桌面客户端

[English](README.md) · **简体中文**

这个目录定义可安装的 `clone-ai` 客户端边界。它不是 SaaS 前端，也不拥有用户状态。

## 职责

- 呈现本地工作台、审批、活动追踪和已验证结果；
- 提供系统托盘、通知、全局快捷键和开机启动等原生存在；
- 以受监督子进程的方式启动和停止本地 daemon；
- 只通过本地 IPC 或 loopback 与 daemon 通信。

## 明确不负责的事

- 不决定权限或策略；
- 不接受 Agent 的完成声明；
- 不直接写入长期记忆；
- 不将本地 daemon 暴露给网络。

```text
桌面壳
  -> 本地 IPC / loopback
      -> Clone AI daemon
          -> journal、策略、supervisor、记忆、adapter
```

`ui/` 存放临时的 WebView 资源。仅在开发期，Node companion server 会通过
`npm run companion:debug` 服务这些资源，以便验证本地 API；它不是发布产品。

Windows 原生壳使用 Tauri。在 Apple Silicon Mac 上，
`npm run desktop:mac:build` 会生成自带 Node.js 运行时的 `dist/Clone AI.app` 和
`dist/Clone AI-macOS-arm64.zip`，同时生成 `dist/Clone AI-macOS-arm64.dmg`。macOS 原生壳
使用 Swift + WebKit，以受监督子进程启动本地运行时，并等待 loopback ready 事件后打开窗口。

macOS 版本默认以 `~/Documents/Clone AI` 作为工作目录，可在设置中修改。当前产物使用
ad-hoc 签名，不是经过 Apple notarization 的 App Store 或互联网分发版本。构建机需要
arm64 Node.js 24+；如果运行时不在默认本地缓存路径，可通过 `CLONE_AI_MAC_NODE` 指向
显式可执行文件。
