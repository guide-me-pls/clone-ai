# clone-ai 桌面客户端

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

原生壳的目标是 Tauri。仓库有意不在 daemon API 和原生审批协议定型前引入 Rust
工具链或桌面构建依赖，避免产生一个不能承载 Runtime 边界的空壳应用。
