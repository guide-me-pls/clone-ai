# 任务 05：程序化 3D 故宫（紫禁城中轴线）

在当前工作区根目录从零完成一个可复现、可检查、可渲染的 3D 故宫项目。不要访问网络，不执行任何外部动作，只在工作区内写文件。

## 作品要求

制作一段 **30 秒、1920×1080、30fps** 的程序化 3D 视频，主题是：

> 紫禁城中轴线：镜头从午门外的护城河上空出发，沿中轴线向北，穿过午门、太和门，最终停在太和殿前广场，回望三大殿。

所有视觉内容必须由代码程序化生成，不依赖外部图片、模型、贴图、字体或视频素材。Three.js r170 已放在 `vendor/three.module.js`，通过 import map 以 `three` 引入；只有核心模块，没有 `examples/jsm`。

## 考据要求（本任务的重点）

以米为单位建模（1 单位 = 1 米）。中轴线自南向北至少包含以下建筑，屋顶形制必须正确：

| 建筑 | 屋顶形制 |
| --- | --- |
| 午门（正楼） | 重檐庑殿 |
| 太和门 | 重檐歇山 |
| 太和殿 | 重檐庑殿 |
| 中和殿 | 四角攒尖（单檐） |
| 保和殿 | 重檐歇山 |
| 乾清门 | 单檐歇山 |
| 乾清宫 | 重檐庑殿 |
| 交泰殿 | 四角攒尖（单檐） |
| 坤宁宫 | 重檐庑殿 |
| 神武门 | 重檐庑殿 |

其他必须出现的元素：

- 三大殿共用「三台」：三层汉白玉须弥座台基，太和殿位于最上层；
- 城墙（约 10 m 高）、护城河（约 52 m 宽）、四座角楼（十字脊三重檐，可简化但必须能辨认）；
- 太和门广场与太和殿广场；体仁阁、弘义阁左右对称；
- 汉白玉栏杆（望柱 + 栏板）、御路石阶、铜龟铜鹤 / 日晷嘉量 / 华表 / 石狮（至少三种陈设）；
- 色彩制度：黄琉璃瓦、朱红宫墙、汉白玉台基栏杆、青绿彩画、鎏金宝顶。

尺度允许 ±10% 误差，但 README 必须给出所用尺寸与来源（凭训练知识，注明未联网核实）。参考：太和殿面阔约 64 m、进深约 37 m、通高约 35 m（含约 8 m 台基）；紫禁城南北约 961 m。

## 几何质量

- 屋顶必须是举折曲面（至少 3 段折线/曲线），不能是平面三角形；正脊、垂脊、戗脊、檐口起翘要有几何表达；
- 屋顶剖面必须是中国式屋面，不是穹顶或石棚：靠近正脊处坡度陡，越近檐口越平缓（举折），檐口外挑于墙身之外；庑殿的正脊必须有长度（约为面阔的 1/2–3/4），攒尖不收长长脊而是收成宝顶；
- 每座具名宫殿（含门楼）必须有台基，不能直接落地；
- 斗拱层、额枋彩画、窗棂、门钉、台阶、栏杆望柱可用简化几何，但必须实例化或合批；
- 建筑不是「盒子 + 三角顶」：台基、柱廊、墙体、屋顶要有层次；
- 确定性的种子 PRNG，禁止无种子 `Math.random()`；给定 `t` 场景状态唯一；
- 1080p 目标 30fps：限制 `pixelRatio`，复用几何/材质，重复构件用 `InstancedMesh` 或合批；
- 代码模块化：`index.html` + `src/` 多个模块，不能把所有逻辑塞进一个 HTML。

## 可检查接口（必须实现）

1. `window.videoReady` 与 `window.setVideoTime(t)`：与既有 3D 任务一致；`setVideoTime` 同步渲染并返回钳制后的时间（0–30）。
2. `window.getForbiddenCityModel()`：返回与场景实际几何**同源**的 JSON（由构建数据生成，不是手写常量）：

```js
{
  schemaVersion: 1, units: "m", seed: 202405,
  axis: { start: {x,y,z}, end: {x,y,z}, lengthM: number },
  buildings: [{
    id, name, roofType,            // "重檐庑殿" | "单檐庑殿" | "重檐歇山" | "单檐歇山" | "四角攒尖" | "十字脊" | "卷棚" | "盝顶"
    footprint: { widthM, depthM }, heightM,   // 地面到正脊/宝顶
    position: { x, y, z }, rotationY,
    bays: { width, depth } | null, // 面阔/进深间数
    platformId: string | null,
    symmetryPair: string | null,
    bodyTopY?: number,               // 墙顶高度（m）
    roof?: { eaveY: number, ridgeY: number, eaveOverhangM: number, ridgeLengthM: number }  // 檐口/正脊高度、外挑、正脊长度
  }],
  platforms: [{ id, name, tiers, heightM, footprint: {widthM, depthM}, position }],
  props: { walls: {...}, moat: {...}, cornerTowers: [...], ornaments: [...] },
  camera: { fovDeg, keys: [{ t, position, target }] }
}
```

3. `window.getForbiddenCityChecks()`：从上述模型计算并返回：
   `{ axisLengthM, namedHallCount, maxSymmetryErrorM, roofTypesByName, triangleCount, drawCalls }`。

## 本轮额外验收（比上一轮更严格）

上一轮交付的模型屋顶剖面外鼓、门楼无台基、陈设漂在广场上。本轮这些项由所有者机器检查，不通过即算不合格：

- `model.platforms-for-halls`：午门、太和门、乾清门、神武门 必须有非空 `platformId`；
- `model.ornament-anchoring`：每件陈设必须位于某座建筑或台基附近（距离 ≤ 其半宽 + 15 m），且至少 3 件；
- `model.roof-form`：午门、太和殿、中和殿、保和殿、乾清宫 必须报告 `roof.eaveY < roof.ridgeY`、`eaveY ≥ bodyTopY`、`eaveOverhangM > 0`；攒尖 `ridgeLengthM ≤ 2`，重檐庑殿 `ridgeLengthM ≤ 0.75 × widthM`。

README 必须说明这些数值由构建数据导出，而不是事后手填。

## 交付物

- `index.html`：通过本地静态服务器打开；播放/暂停、时间滑块、当前时间显示；
- `src/`：模块化源码（场景、建筑生成、屋顶、台基、栏杆、陈设、天空、相机、时间轴、PRNG 等），使用 JSDoc；
- `render.mjs`：用 Playwright 或 Puppeteer 逐帧截图 900 帧（`t = 0, 1/30, ..., 899/30`），再调用 ffmpeg 合成 `out/video.mp4`（H.264，30fps，1920×1080）；依赖缺失时给出清晰、可操作的错误信息；
- `tests/`：`node:test` 测试，至少覆盖：同一 `t` 重复求值完全一致；相机与太阳随时间变化；PRNG 同种子同序列、不同种子不同序列；时间轴边界 `t=0` 与 `t=30` 不越界；
- `README.md`：尺寸与考据来源、运行方式、渲染方式、依赖、目录说明、已知限制与未验证项。

## 工作方式

- 用 `propose_work_plan` 提交**一个自包含的 step**：step 的 `instructions` 里放完整规格（执行 Worker 看不到这段对话，也看不到你发给 Kernel 的 acceptance criteria 之外的上下文）。
- 不要把完整规格只写进 `dispatch_task` 的 objective：Kernel 会用通用模板替换工作单元的目标，Worker 最终拿到的可能不是你的规格。
- 计划中的验收标准应只包含执行器能静态产出或检查的项；需要 shell/浏览器的验证请标为「由所有者执行」，不要写成执行器必须产出的证据。

## 执行能力与诚实要求

工作区执行器只有 `read_file`、`list_directory`、`write_file`、`edit_file` 四种工具，没有 shell、浏览器或网络。你无法运行测试、渲染或打开页面。你必须把测试、渲染脚本和检查接口写对，并在最终报告中明确哪些验证尚未执行。**不要声称运行过你无法运行的命令。**

计划中的验收标准应只包含执行器能静态产出或检查的项；需要 shell/浏览器的验证请标为「由所有者执行」，不要把它写成执行器必须产出的证据（例如不要承诺 `out/video.mp4` 必须存在）。

## 验收标准（由所有者执行）

- 交付物齐全且非空；`node --test tests/` 通过；浏览器加载无未处理错误；
- `getForbiddenCityModel()` 的 `roofType` 与上表一致；三大殿共享三台；
- 主要建筑在中轴线上（`|x|` 偏差 ≤ 1 m）且左右对称；
- 太和殿尺寸在 ±10% 内；屋顶至少有 3 段举折；
- `t=0/15/30` 画面明显不同，镜头沿中轴线推进；
- README 明确列出考据来源与未验证项。
