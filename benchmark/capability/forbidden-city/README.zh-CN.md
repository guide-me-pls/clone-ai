# 故宫 3D 基准

[English](README.md) · **简体中文**

这是一个**能对着真实世界检查的 3D 建模**能力基准，而不只是对着自身检查。2026-11-17 的
能力评测表明 clone-ai 能产出可运行的 Three.js 场景，也表明原先的 3D 任务主要校验**内部
一致性**（种子时间轴、测试、渲染脚本），因此一个构图任意的城市也可能通过。故宫任务增加了
外部契约：具名宫殿、每座建筑历史上正确的屋顶形制、共用三台、可测量的中轴线与公开尺寸，
全部通过一个 JSON 模型暴露，由主管从运行中的页面读取。

它同时也是一个 **harness** 基准：任务经与桌面 App 相同的请求路径派发，因此运行记录能
回答：主 Agent 的规格是否真的到达了 Worker、证据是否被验证、失败的运行对所有者说了什么。

## 文件

| 路径 | 内容 |
| --- | --- |
| [`prompt.md`](prompt.md) | 交给 Main Agent 的任务（自然表述）。 |
| [`prompt.plan-steered.md`](prompt.plan-steered.md) | 同一任务，外加一段要求 Main Agent 用 `propose_work_plan` 提交一个自包含 step 的说明。这是**建模**变体；`prompt.md` 是**自然**变体。 |
| [`verify/expected.json`](verify/expected.json) | 有出处的期望值（屋顶形制、轴线容差、太和殿尺寸、对称组、软检查）。 |
| [`verify/check-forbidden-city.mjs`](verify/check-forbidden-city.mjs) | 主管检查器：静态检查、`node --test`、无头 Chrome、模型契约、时间轴截图、帧吞吐、可选 900 帧渲染。 |
| [`verify/render-frames.mjs`](verify/render-frames.mjs) | 用已安装 Chrome 的主管帧渲染器；当工作区自带的 `render.mjs` 需要本机无法完成的浏览器下载时使用。 |
| [`verify/serve.mjs`](verify/serve.mjs) | 检查器使用的静态文件服务器。 |

## 运行

Worker 只有文件工具——没有 shell、浏览器、网络——因此 Three.js 由运行脚本预置到工作区，
所有执行类检查在事后由主管完成。

```bash
eval-runs/2026-11-17-forbidden-city/run-task.sh <attempt> [prompt-variant]
```

运行脚本固定模型、effort、轮次与 token 上限，并为每次尝试隔离
`CLONE_AI_DATA_DIR` / `CLONE_AI_WORKSPACE` / `CLONE_AI_AUDIT_HOME`。

## 检查

```bash
CLONE_AI_VERIFY_DEPS=eval-runs/2026-11-17-capability/verify \
  node benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs \
  --workspace <workspace> --out <evidence-dir> [--render] [--frames 900]
```

检查器只在**硬性**失败时以非零退出。`expected.json` 列出软检查（帧吞吐、渲染脚本静态
合理性）：它们会被报告，但慢机器或偏严的静态启发式不应把正确的模型判成失败。每项检查打印
一行 `PASS`/`FAIL`，完整证据写入截图旁的 `report.json` / `report.txt`。

### 每项检查测量什么，为什么值得测

| 检查 | 硬性 | 抓什么 |
| --- | --- | --- |
| `files.required`、`src.modules` | 是 | 只交设计文档而非工程；一个巨型 HTML。 |
| `determinism.no-unseeded-random` | 是 | 无法复现渲染的时间轴。 |
| `html.three-import`、`html.external-assets` | 是 | 需要 Worker 没有的网络的页面。 |
| `render.script-static` | 否 | 语法错误；脚本完全没提 900 帧 / ffmpeg / H.264。静态文本不能证明渲染可用，只能排除明显空壳。 |
| `tests.run` | 是 | 测试不存在或不通过（由主管运行）。 |
| `browser.ready`、`browser.no-uncaught-error`、`browser.console` | 是 | 页面永不就绪或抛错。 |
| `api.model`、`api.checks` | 是 | 可检查契约：与几何同源构建的 JSON 模型。 |
| `model.roof-types` | 是 | 核心外部事实：每座具名宫殿的屋顶形制。 |
| `model.axis` | 是 | 建筑偏离中轴线。 |
| `model.three-platform` | 是 | 三大殿不共用三台。 |
| `model.taihe-dimensions` | 是 | 太和殿尺度超出公开的 64×37×35 m ±10%。 |
| `model.symmetry` | 是 | 体仁阁 / 弘义阁不镜像。 |
| `model.axis-length` | 是 | 宫城被压缩或拉伸超出 961 m ±10%。 |
| `model.features` | 是 | 模型缺少台基、相机关键帧或陈设。 |
| `browser.timeline-differs` | 是 | 静态画面或镜头不动。 |
| `browser.frame-throughput` | 否 | 每次寻帧重建几何（中位 > 100 ms/帧）。 |
| 可选 `render.900-frames`、`render.video-spec` | `--render` 时为是 | 交付视频及其 30 s / 1920×1080 规格。 |

期望值是通行的公开数据与历史上正确的屋顶形制；±10% 与 ±1 m 容差让检查针对「对着参考
建模」，而不是背诵精确数字。参考值本身是运行检查的模型的训练知识，`expected.json` 中已
如实注明——有可引用来源的读者应替换它们，检查器无需改代码。

## 如何读结果

基准把三个问题分开，单一数字会把它们混在一起：

1. **规格到达 Worker 了吗？** 由 Journal 佐证：`subagent.dispatched.workspacePath`、
   step instructions，以及是否发生 `write_file`。零工件而主 Agent 回复里满是指令文本，
   是 harness 失败而不是建模失败。
2. **模型符合外部契约吗？** `model.*` 与 `render.*` 检查。
3. **所有者拿到诚实的报告了吗？** 将主 Agent 回复与工作区 README 同检查器发现对照。

只有问题 1 通过时，一次运行才是关于建模（问题 2）的证据。

## 结果

2026-11-17 基线分析、每次尝试的逐项检查表，以及失败对 harness 说明了什么，见
[`ANALYSIS.md`](ANALYSIS.md)。
