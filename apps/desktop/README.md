# clone-ai Desktop Client

This directory is the boundary for the installed `clone-ai` client. It is not
a SaaS frontend and it does not own the user's state.

## Responsibilities

- present the local work surface, approvals, activity trace, and verified results;
- provide native presence: system tray, notifications, global shortcut, and startup;
- start and stop the local daemon as a supervised child process;
- communicate with the daemon over a local-only IPC or loopback boundary.

## Explicit non-responsibilities

- it does not decide authority or policy;
- it does not accept an agent's completion claim;
- it does not write durable memory directly;
- it does not expose the local daemon to the network.

```text
Desktop shell
  -> local IPC / loopback
      -> Clone AI daemon
          -> journal, policy, supervisor, memory, adapters
```

`ui/` contains the temporary WebView assets. The native Tauri shell starts the packaged
Node daemon as a supervised sidecar, waits for its ready event, then navigates the native
window to an available loopback port. The port is selected dynamically, so a stale
developer preview on `4317` cannot block the desktop client.

On Windows, `npm run desktop:build` creates a directly runnable executable at
`src-tauri/target/x86_64-pc-windows-msvc/release/clone-ai-desktop.exe`. It is an early
desktop preview: a distributable installer, tray behavior, notifications, and the native
approval flow remain later milestones. `npm run companion:debug` is still useful only for
developer browser inspection of the daemon API.
