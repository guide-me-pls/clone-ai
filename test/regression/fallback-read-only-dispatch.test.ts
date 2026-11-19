import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackPlan } from "../../src/planning/fallback-planner.ts";

test("read-only dispatch objectives do not create write plans", () => {
  const objectives = [
    "在本机上定位 clone-ai 应用的源代码仓库，并找出设置页「工作目录」这一项的实现位置：渲染该输入框和「选择目录…」按钮的界面组件文件，以及读取/保存工作目录配置（默认 /Users/qihoo/Documents/Clone AI）的状态与后端代码。只读，不修改任何文件。线索：应用数据目录为 /Users/qihoo/.clone，项目运行目录为 /Users/qihoo/Documents/Clone AI/.clone。",
    "只读地在本机寻找 clone-ai 应用（一个本地个人 Agent 桌面应用）的源代码仓库，找到设置页「工作目录」设置项的实现代码。要给出：源码仓库根目录绝对路径；渲染该设置项（含「选择目录…」「在 Finder 中显示」按钮）的界面组件文件路径；读写工作目录配置的代码文件路径及持久化位置。不要修改任何文件。",
  ];

  const violations = objectives.flatMap((objective, index) =>
    buildFallbackPlan(objective).steps.flatMap((step) => [
      ...(step.risk === "reversible_write" ? [`${index}: step ${step.id}`] : []),
      ...(step.subagents ?? [])
        .filter((agent) => agent.risk === "reversible_write" || agent.agentId === "draft-maker")
        .map((agent) => `${index}: subagent ${agent.id}`),
    ]),
  );
  assert.deepEqual(violations, []);
});
