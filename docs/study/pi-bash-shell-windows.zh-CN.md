# Pi 的 bash 工具与 Windows shell 修复（学习笔记）

> 记录时间：2026-08-18 · 适用版本：`@earendil-works/pi-coding-agent` 0.84.2（npm 全局安装，Node 运行）
>
> 背景：本机没有 Git Bash，pi 的 bash 工具全部报 `No bash shell found`。
> 本文记录**pi 如何寻找和执行 shell**（源码级）、**完整的诊断路径**、
> **为什么 PowerShell 不行**、**为什么 Python 可以**，以及**日常使用约定**。
> 目标：下次在任何 Windows 机器上遇到同类问题，能十分钟内定位并修好。

---

## 1. 先记住结论

| 问题 | 结论 |
|---|---|
| pi 的 bash 工具在 Windows 上依赖什么？ | 一个**接受 `-c <command>` 参数**的可执行文件（`bash -c` 只是默认约定，`shellPath` 可以指向任何兼容程序） |
| shell 在哪里配置？ | `~/.pi/agent/settings.json` 的顶层 `shellPath` 字段 |
| 改完配置为什么没生效？ | settings 在**会话启动时**加载进内存，工具定义创建时捕获；必须 `/reload` 或重启 pi |
| 本机最终方案 | `shellPath` 指向 **Python 3.13**（`python -c` 与 bash 工具调用方式完全兼容） |
| 最正统的修复 | 安装 Git for Windows（真 bash，无需任何约定） |

---

## 2. pi 是怎么找 shell 的（源码机制）

### 2.1 查找顺序：`dist/utils/shell.js` 的 `getShellConfig()`

```js
export function getShellConfig(customShellPath) {
    // 1. settings.json 的 shellPath（存在才用）
    if (customShellPath) {
        if (existsSync(customShellPath)) {
            return getBashShellConfig(customShellPath);
        }
        throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    if (process.platform === "win32") {
        // 2. Git Bash 固定位置
        //    %ProgramFiles%\Git\bin\bash.exe
        //    %ProgramFiles(x86)%\Git\bin\bash.exe
        // 3. PATH 上搜索 bash.exe（Cygwin / MSYS2 / WSL）
        //    spawnSync("where", ["bash.exe"]) → 第一个存在的结果
        // 4. 全部失败 → throw "No bash shell found. Options: ..."
    }
    // Unix: /bin/bash → PATH → sh
}
```

**注意**：我们平时看到的 `No bash shell found. Options: 1. Install Git for Windows ...` 就是第 4 步的报错。它**只说明系统里没有 bash**，不代表 pi 坏了。

### 2.2 执行方式：`dist/core/tools/bash.js` 的 `createLocalBashOperations()`

找到 shell 之后，每次执行命令都是这样启动的：

```js
const shellConfig = getShellConfig(options?.shellPath);   // 每次执行都重新 resolve
const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
    cwd,
    env: env ?? getShellEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});
```

即：`spawn(<shellPath>, ['-c', <command>])` —— **命令作为 argv 传入**，不做任何 bash 特有解析。

有一个特例：如果 `shellPath` 匹配旧版 WSL 的路径（`C:\Windows\System32\bash.exe` 或 `Sysnative\bash.exe`），pi 改用 `['-s']` 参数 + 把命令写进 **stdin**（`commandTransport: "stdin"`）。

### 2.3 超时与中止：进程树击杀

```js
// Windows: taskkill /F /T /PID <pid>  （/T = 杀整个进程树）
// Unix:    process.kill(-pid, "SIGKILL")
```

所以 bash 工具的超时、用户中止，都是**杀进程树**实现的——这意味着挂在 shell 下的子进程（比如测试进程）也会被一并杀掉，不会留下孤儿。

### 2.4 settings 的缓存语义（最容易踩的坑）

`dist/core/settings-manager.js`：settings 在**会话启动时**读文件进内存（全局 `~/.pi/agent/settings.json` 与项目 `.pi/settings.json` 深合并）。

`dist/core/agent-session.js` 的 `_buildRuntime()`：

```js
const shellPath = this.settingsManager.getShellPath();   // 内存缓存，不是读文件
const baseToolDefinitions = createAllToolDefinitions(this._cwd, {
    bash: { commandPrefix: shellCommandPrefix, shellPath },  // ← 工具创建时捕获
});
```

`_buildRuntime()` 只在**构造**和 **`reload()`** 时调用。因此：

- 会话启动后修改 settings.json，**当前会话不生效**；
- 必须 `/reload`（内部走 `session.reload()` → `settingsManager.reload()` 重读文件 → `_buildRuntime()` 重建工具定义）或重启 pi；
- **例外**：`AgentSession.executeBash()`（交互模式 `!command` / `!!command` 路径）每次调用都动态读 `settingsManager.getShellPath()`，不走工具定义。

---

## 3. 这次的实际诊断路径

### 3.1 现象

```
$ ls
No bash shell found. Options:
  1. Install Git for Windows: https://git-scm.com/download/win
  2. Add your bash to PATH (Cygwin, MSYS2, etc.)
  3. Set shellPath in settings.json
Searched Git Bash in:
  C:\Program Files\Git\bin\bash.exe
  C:\Program Files (x86)\Git\bin\bash.exe
```

### 3.2 确认系统里确实没有任何 bash

逐个验证（read 工具直接读文件头，`MZ`/`PE` 签名 = 存在）：

- `C:\Program Files\Git\bin\bash.exe`、`C:\Program Files (x86)\Git\bin\bash.exe` ❌
- Cygwin `C:\cygwin64\bin\bash.exe`、MSYS2 `C:\msys64\usr\bin\bash.exe` ❌
- scoop / choco / 用户级安装 / cmder 便携版 ❌
- WSL：`C:\Windows\System32\wsl.exe` 存在（系统自带启动器），但**没有任何发行版**（WindowsApps 下无 ubuntu.exe 等 alias，`%LOCALAPPDATA%\Packages` 下无 ext4.vhdx）→ 无 bash 可用

结论：这台机器上 bash 是**真没有**，只能换一个兼容 shell 或安装 Git。

### 3.3 第一次尝试：PowerShell → `spawn UNKNOWN`

Windows 自带 PowerShell 5.1（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`），且 `-c` 恰好是 `-Command` 的合法缩写——理论上兼容。

配置 `shellPath` 后 reload，结果：

```
$ Write-Output hi
spawn UNKNOWN
```

**`spawn UNKNOWN` 的含义**：`child_process.spawn` 的 `error` 事件，errno 为 `UNKNOWN`（`UV_UNKNOWN = -1`）。即 **Windows 的 `CreateProcess` 调用失败了，但返回的错误码不在 libuv 的 `uv_translate_sys_error` 映射表里**。常见的未映射错误码：

| 错误 | 值 | 典型原因 |
|---|---|---|
| `ERROR_ELEVATION_REQUIRED` | 740 | exe 的 manifest 要求管理员权限 |
| `ERROR_DLL_NOT_FOUND` | 1157 | exe 依赖的 DLL 缺失 |
| `ERROR_NOT_FOUND` | 1168 | 系统组件缺失 |
| `ERROR_SXS_*` | 59 等 | Side-by-Side 激活上下文失败（.NET 组件问题） |

PowerShell 5.1 依赖 .NET Framework 4.x——本机最可能是 **.NET 组件被精简/损坏，或安全软件拦截了 PowerShell 启动**（这正是系统层把 PowerShell 当作攻击面的常见场景）。

**即使 PowerShell 能启动，它还有两个坑**（笔记，避免将来踩）：

1. **输出编码**：PS 5.1 重定向 stdout 时用 UTF-16LE，中文必然乱码（ASCII 可经 sanitize 恢复）；
2. **退出码不透明**：`powershell -c "node --test"` 中 node 失败，powershell.exe 进程退出码可能仍是 0——bash 工具会把失败误判为成功。

### 3.4 第二次尝试：Python → 成功

检查到用户级安装的 **Python 3.13**（`C:\Users\<user>\AppData\Local\Programs\Python\Python313\python.exe`）：

- `python -c <code>` 与 `spawn(shell, ['-c', command])` **完美兼容**；
- 用户级安装、自带运行时，**无 .NET 依赖**，spawn 一次通过；
- 退出码：`sys.exit(n)` 直接可控；
- 编码：`sys.stdout.reconfigure(encoding="utf-8")` 可控。

```json
// ~/.pi/agent/settings.json
{
    "shellPath": "C:\\Users\\jiaoxiangyu\\AppData\\Local\\Programs\\Python\\Python313\\python.exe"
}
```

验证：

```
$ import sys; sys.stdout.reconfigure(encoding="utf-8", errors="replace"); print("PY-SHELL-OK")
PY-SHELL-OK
3.13.14 (tags/v3.13.14:fd17997, Jun 10 2026, 13:03:48) [MSC v.1944 64 bit (AMD64)]
```

### 3.5 三种方案对比

| 方案 | 兼容性 | 依赖 | 代价 |
|---|---|---|---|
| **Git for Windows**（正统） | 完美（真 bash） | 安装 ~50MB | 需要安装一次，之后零约定 |
| **PowerShell 5.1** | `-c` 兼容 | .NET Framework | 本机 spawn UNKNOWN；UTF-16LE 输出；退出码不透明 |
| **Python 3.13**（本机采用） | `-c` 兼容 | 无（用户级安装） | 命令必须写成 Python 代码 |

---

## 4. Python shell 的日常使用手册

bash 工具的每次调用等价于：`python.exe -c "<command>"`。以下模板覆盖日常操作。

### 4.1 跑命令并正确传递退出码（最重要）

```python
import subprocess, sys; sys.exit(subprocess.run("npm test", shell=True).returncode)
```

- `shell=True` → 通过 cmd.exe 执行，能跑 `.cmd`（npm 就是 npm.cmd）和管道；
- 不捕获输出 → 子进程 stdout/stderr 直接透传到 pi 的管道（UTF-8 字节原样，无重编码问题）；
- `sys.exit(returncode)` → 测试失败时 bash 工具正确报 `Command exited with code N`，而不是误判成功。

### 4.2 目录与文件操作

```python
# 列目录（UTF-8 输出，中文文件名正常）
import os, sys; sys.stdout.reconfigure(encoding="utf-8", errors="replace"); [print(x) for x in sorted(os.listdir("."))]

# 读文件
print(open("package.json", encoding="utf-8").read())

# 递归找文件
import os
for root, dirs, files in os.walk("src"):
    for f in files:
        if f.endswith(".ts"): print(os.path.join(root, f))
```

### 4.3 约定与坑

| 坑 | 说明 |
|---|---|
| 编码 | 每次 Python 自己输出前先 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`；子进程输出不用管（直接透传） |
| 通配符 | `subprocess.run(..., shell=True)` 走 cmd.exe，**cmd 不展开 `*`**；但 `node --test test/*.test.ts` 里 Node 自己展开 glob，不受影响 |
| `.cmd` 文件 | `subprocess.run(["npm", ...])` 直接传列表会 `FileNotFoundError`（.cmd 不是可执行文件），**必须 `shell=True` 字符串形式** |
| 启动开销 | Python 冷启动约 50-100ms，可接受；比 PowerShell 快 |
| 环境变量 | 子进程继承 pi 进程的 env（含 `PI_SESSION_ID` 等，但 bash 工具会剔除后再注入自己的） |

### 4.4 如果哪天装了 Git for Windows

把 `shellPath` 改回 `C:\Program Files\Git\bin\bash.exe`，reload 即可——**所有命令模板恢复成正常 bash 语法**，本文的 Python 约定不再需要。

---

## 5. 附：源码位置清单（pi 0.84.2）

```
C:\Users\<user>\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\
├── utils\shell.js              getShellConfig / getShellEnv / killProcessTree
├── core\tools\bash.js          createLocalBashOperations（spawn 执行）与工具定义
├── core\agent-session.js       _buildRuntime（工具创建时捕获 shellPath）/ executeBash / reload
├── core\settings-manager.js    SettingsManager（启动加载 + reload 重读 + 全局/项目深合并）
└── config.js                   getAgentDir() = ~/.pi/agent，getSettingsPath() = settings.json
```

学习要点回顾：

1. **pi 的 bash 工具 ≠ 只认 bash**——它只要求一个 `-c <command>` 兼容的可执行文件（legacy WSL 路径例外，走 stdin）；
2. **settings 是内存缓存**，改文件必须 `/reload` 或重启（工具定义创建时捕获，`executeBash` 例外）；
3. **`spawn UNKNOWN` = CreateProcess 失败且错误码未映射**——优先怀疑系统组件（.NET）、安全软件拦截，而不是自己的代码；
4. **换 shell 的三个兼容性维度**：参数形态（`-c`）、输出编码、退出码语义——PowerShell 前两个都踩雷，Python 全通过。
