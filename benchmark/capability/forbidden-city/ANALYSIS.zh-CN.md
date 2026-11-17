# 故宫 3D 基准 — 2026-11-17 基线分析

[English](ANALYSIS.md) · **简体中文**

本文是 [故宫 3D 基准](README.zh-CN.md) 第一次运行的分析。它回答两个问题：clone-ai 能否在
只有文件工具的条件下按考据建模一座可检查的紫禁城；以及这条链路是否能把这件事交付出去。
第二个问题的答案在第一次运行里就已经是「不能」，而失败原因不是建模能力——因此本文把两者
分开报告，并明确哪一部分是**已实测**、哪一部分是**尚未测得**。

本文的两个问题得到不同答案：harness 在 Worker 看到任务之前就失败了（§3），而 Worker 一旦
拿到规格就建成了合格模型（§4）；§5 说明为什么三次运行仍全部 `failed`。

## 1. 方法与可复现信息

| 项 | 值 |
| --- | --- |
| 被测链路 | `clone-ai new` → Main Agent（native）→ Kernel 规划/策略/验证 → native worker（仅 `read_file` / `list_directory` / `write_file` / `edit_file`） |
| 命令 | `eval-runs/2026-11-17-forbidden-city/run-task.sh <attempt> [prompt-variant]` |
| Provider / 模型 | native / `360/openai/gpt-6.1-terra`（本地 OpenAI 兼容网关 `http://127.0.0.1:3425`） |
| Effort | Main `high`；Worker `high` |
| Worker 限制 | `CLONE_AI_NATIVE_MAX_ROUNDS=40`、`CLONE_AI_NATIVE_MAX_TOKENS=24000`、超时 600 s |
| 工具集 | 只有四个文件工具；未启用 MCP；无 shell / 浏览器 / 网络 |
| 数据隔离 | 每次尝试独立 `CLONE_AI_DATA_DIR`、`CLONE_AI_WORKSPACE`、`CLONE_AI_AUDIT_HOME` |
| Three.js | `vendor/three.module.js` r170 由运行脚本预置（来自 2026-11-17 能力评测的 `node_modules`），Worker 无法联网安装 |
| 提示词 | 自然变体 `prompt.md`（sha256 `5a27f8c4…8b95`，尝试 A、B）；steered 变体 `prompt.plan-steered.md`（sha256 `3cdfc278…7d3c`，尝试 C） |
| 检查器 | `benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs` + `expected.json` |
| 机器 | macOS 27.0.0 arm64，Node v26.8.1，Google Chrome 157 |
| 结果 | `eval-runs/2026-11-17-forbidden-city/meta/<attempt>/`、`homes/<attempt>/journal.sqlite3`、`verify/<attempt>/report.json` |

**基准记录（AGENTS.md 第 5 条）**：这是一次基线测量，不是优化门禁，因此没有「变更前/后」
对比。命令、模型、参数、提示词哈希与结果路径均在上表与各 `meta/<attempt>/manifest.txt` 中。

## 2. 测量设计

同一任务跑两种变体，目的是把 **harness** 与 **建模** 两个问题分开：

- **自然变体（A、B）**：`prompt.md` 原样交给 Main Agent，不规定它用哪个工具。这测的是产品
  默认行为：一个普通用户把这段需求打进 `clone-ai new` 会发生什么。
- **steered 变体（C）**：同一任务，额外一段工作方式说明，要求用 `propose_work_plan`
  提交一个自包含 step。这测的是**建模能力**本身——当完整规格确实到达 Worker 时，它能不能
  按考据建模。2026-11-17 能力评测的 02-v2/03/04 也是靠同样的提示层修正才取得可用结果，
  这里沿用该做法以便对比。

两次自然变体并非重复采样：B 是 A 之后紧接着的独立尝试，用来确认 A 的失败不是一次性抖动。
两次结果完全一致（同一失败点），说明这是确定性的链路缺陷，不是模型波动。

## 3. 实测结果：自然变体（A、B）

### 3.1 结论

**两次尝试都产出了 0 个工件。** 主 Agent 写了一份完整且自洽的计划，Worker 却从未看到这份
规格。这不是建模失败：Worker 没有写过任何文件。

| 尝试 | Run | 状态 | Worker 工件 | Worker 工具调用 | 失败点 |
| --- | --- | --- | ---: | --- | --- |
| A（第一次 dispatch） | `048740fd` | failed | 0 | 3 次 `list_directory` | `subagent.verified`: missing required artifact `local-draft` |
| A（第二次 `propose_work_plan`） | `9f9cee58` | failed | 0 | 3 次 `list_directory` + 1 次 `read_file` | `TestCommandVerifier`: “a test step needs test evidence with a locator” |
| B（两次 dispatch） | `7231b964`、`7fac3332` | failed | 0 | 各 3 次 `list_directory`（B 第二次 +1 次 `read_file`） | 同 A：missing required artifact `local-draft` |

### 3.2 失败链路（已从 Journal 逐步核实）

1. 主 Agent 调用 `dispatch_task`，`objective` 里写入了完整任务摘要，`acceptanceCriteria`
   写了 6–8 条可检查的验收项（`meta/a/turns.json` 中的 `inputSummary`）。
2. `dispatch_task` → `runQuery` → **fallback planner**（`src/planning/fallback-planner.ts`）
   生成了一个 `prepare` 步骤，其中只有一个通用 WorkOrder：
   `objective: "只在本地准备可修改、可回退的结果，不产生外部影响。"`，
   `expectedArtifacts: [{ id: "local-draft", locatorRequired: true }]`。
   **主 Agent 的 objective 与 acceptanceCriteria 没有进入这个 WorkOrder。**
3. worker 组装指令时优先使用 WorkOrder 的 `objective`
   （`src/workers/native-agent-worker.ts:460`：`input.workOrder?.objective ?? input.step.instructions`），
   于是 Worker 的系统/用户消息里只有那句通用目标，外加「若指令中点名的文件缺失就停下并报告」。
4. Worker 因此只做了 `list_directory`（还试图 `list_directory("..")` 被拒），随后回报
   「请提供具体的准备工作清单……」或「目前没有提供具体的准备任务」，不写文件。
5. 产物契约要求 `local-draft` 且 `locatorRequired`，没有 artifact 证据 → `subagent.verified`
   失败 → `execution.failed` → Run `failed`。
6. 尝试 A 的第二个 Run 走了 `propose_work_plan`，这一路径**保住了**主 Agent 的完整
   instructions（`plan.created` 中可见 2,000+ 字的规格），但 Worker 仍然只读不写：
   它没有拿到 task 的完整用户请求，只有 step instructions，且验收项在第一轮就要求
   `out/video.mp4` / 测试证据——这正是 2026-11-17 能力评测记录过的 P0 模式；本次任务提示里
   已明确要求不要承诺 MP4，说明**该约束只能约束写计划的模型，不能约束链路**。

### 3.3 这组失败说明了什么

| 现象 | 证据 | 判断 |
| --- | --- | --- |
| 规格在 `dispatch_task` 路径上丢失 | `plan.created` 的 WorkOrder objective 是通用模板；`turns.json` 中主 Agent 的完整 objective 只存在于工具入参 | **P0：规格路由**。产品默认路径（Main Agent 自选工具）会丢掉用户需求。 |
| 主 Agent 看不到失败原因 | 两次 CLI 回复都是「已排队 / 尚未执行」，`get_run_status` 返回的 status 不含 `failureReason`（`turns.json`） | **P0：反馈回路**。与 2026-11-17 能力评测的 CLIC 回合问题同源。 |
| 验收标准与执行器能力不匹配 | 第二个 Run 的失败原因是 `TestCommandVerifier`；提示词已明确禁止承诺 MP4，仍出现测试证据要求 | **P0：验证器/能力画像**（既有发现复现）。 |
| 计划看似完整、执行却为空 | 主 Agent 的计划文本质量很高（可读、覆盖交付物） | 计划质量不能替代**规格到达**的验证。 |

这四条都不是「模型不会建模」。把它们算进建模分数会低估 Worker；因此自然变体的分数记为
**未测得（not measured）**，而不是 0 分。

## 4. 实测结果：steered 变体（C）

### 4.1 结论

**Worker 按外部契约完成了故宫建模——21/21 项硬性检查全部通过——而 Kernel 仍把 Run 判为
`failed`。** 尝试 C 产出 20 个文件（`src/` 412 行，`index.html`、`render.mjs`、测试与
README 合计 190 行），所有“对着真实世界”的检查都通过，包括十座建筑屋顶形制、共用三台、
中轴线、太和殿尺寸与对称关系。失败在 harness，不在模型。

| 指标 | 值 |
| --- | --- |
| Run | `52b7886b-887c-463a-ab11-e05b190872ff`，状态 `failed` |
| Main Agent | 2 次模型调用，19,158 tokens，27.7 s；一次 `propose_work_plan` |
| Worker | 19 次模型调用，371,070 tokens（输出 25,573），294.4 s |
| 工件 | 20 个文件；`src/` 下 14 个模块 |
| 测试 | `node --test tests/`：**6/6 通过** |
| 检查器 | **21/21 硬性检查通过**，0 个硬性失败 |
| 渲染（主管） | 900 帧，`video.mp4` **30.00 s、1920×1080、30 fps、H.264 yuv420p**，5.5 MB |
| 帧耗时 | 中位 **33.3 ms/帧**，p95 34.5 ms（1080p，60 次寻帧） |
| 运行时统计 | t=30 时 414,626 三角形、71 draw calls |

视频由主管用 [`verify/render-frames.mjs`](verify/render-frames.mjs)（系统 Chrome、页面自身的
`window.setVideoTime` 契约）渲染，因为工作区的 `render.mjs` 需要下载 Playwright Chromium，
本机网络做不到——与 2026-11-17 那次相同的环境限制。工件 README 如实写明了这一依赖，也没有
声称视频已存在。

### 4.2 外部契约检查

| 检查 | 结果 |
| --- | --- |
| `model.roof-types` | **10/10 匹配**：午门 重檐庑殿、太和门 重檐歇山、太和殿 重檐庑殿、中和殿 四角攒尖、保和殿 重檐歇山、乾清门 单檐歇山、乾清宫 重檐庑殿、交泰殿 四角攒尖、坤宁宫 重檐庑殿、神武门 重檐庑殿 |
| `model.axis` | 10/10 中轴建筑 \|x\| ≤ 1 m |
| `model.three-platform` | 太和殿/中和殿/保和殿 共用 `platformId: three-halls` |
| `model.taihe-dimensions` | **64×37×35 m**，与参考值一致（容差 ±10%） |
| `model.symmetry` | 体仁阁 x=+94、弘义阁 x=−94 → 误差 0 m |
| `model.axis-length` | 961 m |
| `model.features` | 台基（5）、7 个相机关键帧、props（城墙、护城河、角楼、陈设、广场） |
| `browser.timeline-differs` | t=0/7.5/15/22.5/30 五帧互不相同 |

模型不是独立手写的清单：`src/model.js` 是唯一数据源，`buildings.js`、`platforms.js`、
`roof.js` 与 window 接口都从它读取，因此检查器评分的 JSON 就是几何构建所用的数据。

### 4.3 截图显示的画面与不足

检查通过的是事实；画面显示它仍是简化模型。这部分无法由 pass/fail 列表承载，故以文字记录：

- **t=0**（护城河上）：午门重檐读作庑殿，门洞是干净的开口，御路与望柱对齐中轴。构图正确，
  但屋顶轮廓鼓胀——举折曲线向外下垂而不是靠近正脊处陡降，使大殿读起来像石棚而不是中国屋顶。
- **t=15**（午门门洞内）：门洞确实贯通，镜头穿过两道门没有穿模，远处可见太和门。洞内是
  无纹理的红墙与硬边，没有斗拱或彩画细节。
- **t=22.5**（三台）：三层台基、望柱栏板、御路石阶、华表与小型铜龟/铜鹤都在，太和殿位于
  最上层。台基层次比例合理；台面是平的白色，没有须弥座线脚。
- **t=30**（鸟瞰）：三大殿可分辨，角楼位于城墙四角，护城河成环。但三大殿以北的内廷几乎
  是空的——内廷建筑在模型中存在，却稀疏地摆得很远，整体读作一条走廊而不是一座宫城。
- **系统性问题**：午门/太和门/神武门没有台基（门楼直接落地），曲面只出现在屋顶，光照只有
  一盏平行光的平涂——没有阴影、没有环境遮蔽。

即：**契约完整、视觉示意**。基准目前测量“模型能否守住有出处的契约”，还没有测量建筑质量；
§7 给出补充方法。

### 4.4 为什么 Run 仍判失败（已核实）

Kernel 的判定是：

```
Verification failed. Verification failed. 实现程序化故宫中轴线项目:
"out/video.mp4" was promised but does not exist on disk.;
Test verification failed. 实现程序化故宫中轴线项目:
a test step needs test evidence with a locator.
```

两条都是验证器缺陷，已用真实计划文本逐条复现：

1. **否定句被当成承诺。** `extractFileExpectations`（`src/core/verification.ts:43`）会匹配
   任何带目录段的反引号或裸路径，且不读否定。step 指令写的是 `不要声称 out/video.mp4 已生成`
   ——*不要声称它存在*——却被提取为必需文件。复现：
   `extractFileExpectations({ instructions: "…不要声称 out/video.mp4 已生成。" })` 返回
   `[{ path: "out/video.mp4" }]`。英文等价句（`do not claim out/video.mp4 exists`）同样失败。
2. **散文里的“tests”触发测试证据闸门。** `mentionsTests`（`src/core/verifier-plugins.ts:184`）
   只是对指令与验收标准做 `/\btests?\b|跑测试|运行测试|单元测试/` 匹配。指令把 `tests/` 列为
   交付物（*“交付 … tests/ …”*），于是匹配，验证器要求带 locator 的 `test` 证据——只有文件
   工具的 Worker 无法产出。复现：`mentionsTests({ instructions: "…交付 … tests/ …" })` 为
   `true`。连诚实句 *“README 列出未执行的测试与渲染”* 也会触发同一闸门。

两者合起来，把一次**主管逐项验证通过、21/21 全过**的交付变成 `failed`。产品用户只会看到
一个红色的 Run，没有任何解释。

### 4.5 评分

| 维度 | 分数 | 依据 |
| --- | ---: | --- |
| 完成度 | 5 | 所有交付物齐全且充实；外部契约完整。 |
| 功能正确性 | 5 | 6/6 测试、21/21 检查、900 帧 H.264 视频、无控制台错误。 |
| 工程质量 | 4 | 模型与几何单一数据源、重复件实例化、确定性 PRNG、README 诚实；屋顶剖面视觉不对、内廷偏空、光照单薄。 |
| 规划/自主性 | 4 | 单步自包含计划完整携带规格（提示词要求如此）；写完后没有自检回合。 |
| 诚实/自检 | 5 | README 写明未执行项、把来源标为训练知识、拒绝声称视频已生成。 |
| 效率 | 3 | 600 行代码用了 371k worker tokens——输入重复偏高，与 2026-11-17 同型。 |

按能力评分表加权（25/25/20/15/10/5）：**4.6 / 5**。而所有者看到的 Run 状态是 `failed`。

## 5. 与 2026-11-17 能力评测（01 程序化 3D 视频）的对照

| 维度 | 01 城市视频（当时） | 自然变体（A、B） | steered 变体（C） |
| --- | --- | --- | --- |
| 工件数 | 15 个文件 | **0** | **20 个文件** |
| Run 状态 | `failed` | `failed` | `failed` |
| 状态 vs 工件质量 | 可用项目被判失败 | 无工件可判 | **21/21 外部检查通过，仍判失败** |
| 失败原因 | 验收标准承诺了 Worker 做不到的 MP4/测试证据 | 规格未到达 Worker + 同样的证据不匹配 | 验证器把*禁止* MP4 读成承诺，把散文里的 `tests/` 读成测试证据要求 |
| 所有者得到的反馈 | Main Agent 只看到「排队中」 | 同左 | 同左 |
| 加权能力分 | 3.6 / 5 | 未测得 | 4.6 / 5 |

两个结论。第一，同一执行器、同一模型在规格到达 Worker 时产出了契约完整的模型，说明在这个
规模上 Worker 的建模能力不是瓶颈。第二，**三次运行全部 `failed`，原因都与工件无关**——而
§4.4 的两个验证器缺陷让最新的失败模式比旧的更糟：一次完整的运行现在会因为写下自己*没有*
做什么而被判失败。诚实披露正在被惩罚，这与项目想训练的行为正好相反。

01 当时能产出可用项目，是因为那次的主 Agent 把规格放进了 `propose_work_plan` 的 step
instructions（三步计划）；本次自然变体先调了 `dispatch_task`。**两个工具在“规格是否到达
Worker”上可靠性不同，而产品让模型自己选。**

## 6. 检查器自身的证据（工具可信度）

检查器先对 2026-11-17 能力评测的 01 城市工件跑了一遍，作为“已知部分合格的工件”的校准：

```
11/14 checks passed; hard failures: 3
PASS  tests.run — 4 pass, 0 fail (1 file(s))
PASS  browser.ready / browser.timeline-differs — 5/5 distinct screenshots
PASS  browser.frame-throughput — median 33.3 ms/frame
FAIL  api.model / api.checks — getForbiddenCityModel() missing（该任务未要求）
FAIL  html.three-import — importmap 指向 node_modules，而非基准预置的 vendor/
```

它正确地区分了「页面能跑、测试能过」与「没有外部模型契约」，并且没有把 favicon 404 或
静态启发式误判成硬失败（软检查单列）。这组校准结果本身也说明：**01 当时拿到的 3.6 分是
内部一致性分数，不是外部事实分数**。

## 7. 不足与后续（按优先级）

> 按 AGENTS.md 第 4 条，若作为 bug 修复实施，应走 clone-ai 自己的修复通道；工作的 Agent
> 只做功能正确性检查，不手写补丁。

1. **P0 — `dispatch_task` 必须把 task 的 objective/criteria 注入 WorkOrder。**
   当前 fallback planner 用通用模板替换，Worker 拿到的是「准备本地交付物」。修复后即可让
   自然变体测到建模能力；回归用例应断言 `plan.created` 的 WorkOrder objective 包含任务主体。
2. **P0 — Main Agent 需要看到 Run 的终态与 failureReason。** 本次两次回复都是「已排队」，
   用户与模型都无法在回合内知道失败原因。
3. **P0 — 验证器感知执行器能力**（既有发现复现）：无 shell 的 step 不应被 `TestCommandVerifier`
   判失败，应转 owner-review 或要求 plan 不写执行类标准。两个具体缺陷现在已有单行复现用例：
   否定路径（`不要声称 out/video.mp4 已生成`）被当成必需文件，`tests/` 作为交付物触发
   `mentionsTests`。回归用例应进 `benchmark/gate/verdict-cases.json`——那里“假失败”本身就是
   门禁失败。
4. **P1 — 任务提示的「不要承诺 MP4」类约束应由 Kernel 强制，而不是靠模型自觉。**
   本次提示词已写明，仍出现该模式。
5. **P1 — 基准扩充**：目前每个变体 1–2 次运行，没有方差估计；后续应固定 3 次重复并报告
   中位数与通过率（README 中 `--repeat` 语义可直接复用 `bench:main` 的统计方式）。
6. **P2 — 考据期望值可替换为可引用来源**；当前期望值来自检查模型自身的训练知识，已如实
   标注，不构成外部权威。
