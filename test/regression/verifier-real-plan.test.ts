import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { extractFileExpectations } from "../../src/core/verification.ts";

test("read-only investigation paths are not file deliverables", () => {
  const step = {
    id: "locate-repo-and-setting",
    title: "定位 clone-ai 源码仓库与「工作目录」设置实现",
    risk: "read_only" as const,
    agentId: "context-researcher",
    acceptanceCriteria: [
      "结果中给出源码仓库根目录绝对路径及依据",
      "给出设置页「工作目录」项所在组件文件的绝对路径（或明确写未找到）",
      "给出该配置默认值与持久化位置的绝对路径（或明确写未找到）",
      "列出 Kernel/策略层把工作目录作为默认写 scope 的相关文件与行号",
      "未修改任何文件",
    ],
    instructions: `只读调查，不要写入任何文件。

目标：这台 Mac 上跑着 clone-ai 桌面应用（本地个人 Agent）。已知数据目录 /Users/user/.clone，日志里出现项目运行目录 /Users/user/Documents/Clone AI/.clone。

请做：
1) 找到 clone-ai 的源代码仓库根目录（判断依据：package.json / pnpm-workspace.yaml / .git / src 目录结构 / electron 或 tauri 配置）。候选位置包括 /Users/user/Documents、/Users/user/work、/Users/user/Projects、~/dev、~/code 等，以及 /Users/user/.clone 里的线索（如 app 路径、安装来源）。
2) 在该仓库里定位设置页「工作目录」（Workspace / workspaceRoot / workingDirectory）这一项的界面组件文件，包含「选择目录…」「在 Finder 中显示」按钮的那段 JSX/TSX。
3) 定位读取与保存该配置的代码：默认值 /Users/user/Documents/Clone AI 在哪里定义、持久化到哪个文件（如 ~/.clone/config.json）。
4) 顺带说明：当前 Kernel/策略层是怎么把「工作目录」当作默认写 scope 的（哪些文件里出现 workspace 作为默认 scope 的逻辑），只列文件与行号，不改。

输出：一份简短的清单，每项给绝对路径 + 关键行号 + 一句话说明。找不到的项要明确写「未找到」，并列出实际搜索过的顶层目录。`,
  };

  deepStrictEqual(extractFileExpectations(step), []);
});
