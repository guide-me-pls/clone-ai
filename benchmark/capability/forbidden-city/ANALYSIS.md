# Forbidden City 3D benchmark — 2026-11-17 baseline analysis

**English** · [简体中文](ANALYSIS.zh-CN.md)

This is the analysis of the first run of the [Forbidden City 3D benchmark](README.md).
It answers two questions: can clone-ai model a checkable Forbidden City from
sourced references with file tools only; and can the harness deliver that task at
all. The first run answers them differently: the harness failed before the
worker saw the task (§3), and the worker succeeded once it did (§4). The two are
reported separately, and §5 explains why every run still ended `failed`.

## 1. Method and reproducibility

| Item | Value |
| --- | --- |
| Path under test | Desktop request path (then `clone-ai new`) → Main Agent (native) → Kernel planning/policy/verification → native worker (`read_file` / `list_directory` / `write_file` / `edit_file` only) |
| Command | `eval-runs/2026-11-17-forbidden-city/run-task.sh <attempt> [prompt-variant]` |
| Provider / model | native / `openai/gpt-6.1-terra` (local OpenAI-compatible gateway `http://127.0.0.1:3425`) |
| Effort | Main `high`; Worker `high` |
| Worker limits | `CLONE_AI_NATIVE_MAX_ROUNDS=40`, `CLONE_AI_NATIVE_MAX_TOKENS=24000`, 600 s timeout |
| Toolset | Four file tools only; no MCP; no shell, browser or network |
| Isolation | Per-attempt `CLONE_AI_DATA_DIR`, `CLONE_AI_WORKSPACE`, `CLONE_AI_AUDIT_HOME` |
| Three.js | `vendor/three.module.js` r170 seeded by the runner (taken from the 2026-11-17 capability eval's `node_modules`); the worker cannot install |
| Prompts | Natural variant `prompt.md` (sha256 `5a27f8c4…8b95`, attempts A and B); steered variant `prompt.plan-steered.md` (sha256 `3cdfc278…7d3c`, attempt C) |
| Checker | `benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs` + `expected.json` |
| Machine | macOS 27.0.0 arm64, Node v26.8.1, Google Chrome 157 |
| Evidence | `eval-runs/2026-11-17-forbidden-city/meta/<attempt>/`, `homes/<attempt>/journal.sqlite3`, `verify/<attempt>/report.json` |

**Benchmark record (AGENTS.md rule 5).** This is a baseline measurement, not a
change gate, so there is no before/after comparison. The command, model,
parameters, prompt hashes and evidence paths are in the table and in each
`meta/<attempt>/manifest.txt`.

## 2. Measurement design

The task was run in two variants to separate the **harness** question from the
**modeling** question:

- **Natural variant (A, B):** `prompt.md` is given exactly as written, without
  saying which tool the Main Agent should use. This measures the product's
  default behaviour: what happens when an ordinary user types this request into
  the desktop app.
- **Steered variant (C):** the same task plus one paragraph telling the Main
  Agent to submit one self-contained step through `propose_work_plan`. This
  measures **modeling** capability itself — what the worker does when the full
  specification actually reaches it. The 2026-11-17 capability eval reached its
  usable 02-v2/03/04 results only after the same kind of prompt-layer
  correction, so this keeps the comparison honest.

B is not a repeat of A in the statistical sense; it is an independent attempt
immediately after A, to confirm A's failure was not a one-off. Both failed at
the identical point, which is consistent with a deterministic harness defect
rather than model variance.

## 3. Measured result: natural variant (A, B)

### 3.1 Headline

**Both attempts produced zero artifacts.** The Main Agent wrote a complete,
coherent plan; the worker never saw it. This is not a modeling failure — the
worker never wrote a file.

| Attempt | Run | Status | Worker artifacts | Worker tools used | Failure point |
| --- | --- | --- | ---: | --- | --- |
| A (first dispatch) | `048740fd` | failed | 0 | 3 × `list_directory` | `subagent.verified`: missing required artifact `local-draft` |
| A (`propose_work_plan`) | `9f9cee58` | failed | 0 | 3 × `list_directory` + 1 × `read_file` | `TestCommandVerifier`: “a test step needs test evidence with a locator” |
| B (two dispatches) | `7231b964`, `7fac3332` | failed | 0 | 3 × `list_directory` each (B's second also +1 `read_file`) | Same as A: missing required artifact `local-draft` |

### 3.2 Failure chain, verified step by step from the journal

1. The Main Agent calls `dispatch_task` with a full objective and 6–8 checkable
   acceptance criteria (visible in `meta/a/turns.json` under `inputSummary`).
2. `dispatch_task` → `runQuery` → the **fallback planner**
   (`src/planning/fallback-planner.ts`) produces a `prepare` step with one
   generic work order:
   `objective: "只在本地准备可修改、可回退的结果，不产生外部影响。"` and
   `expectedArtifacts: [{ id: "local-draft", locatorRequired: true }]`.
   **The Main Agent's objective and acceptance criteria never enter the work
   order.**
3. The worker builds its instructions preferring the work order's `objective`
   (`src/workers/native-agent-worker.ts:460`:
   `input.workOrder?.objective ?? input.step.instructions`), so its system and
   user messages contain only that generic sentence, plus “if a file named in
   these instructions is missing, stop and report it”.
4. The worker therefore only runs `list_directory` (one attempt at
   `list_directory("..")` is refused), then replies “please provide the concrete
   preparation checklist…” — no files.
5. The artifact contract requires `local-draft` with a locator; with no artifact
   evidence, `subagent.verified` fails → `execution.failed` → Run `failed`.
6. Attempt A's second Run went through `propose_work_plan`, which **did preserve**
   the Main Agent's full instructions (the `plan.created` payload carries 2,000+
   characters of specification), yet the worker still only read: it never got
   the user request as a whole, only the step instructions, and the Run then
   failed the test-evidence gate — the exact P0 pattern from the 2026-11-17
   capability eval. This task's prompt already forbade promising the MP4, which
   shows **a prompt-level constraint binds the model that writes the plan, not
   the pipeline** (attempt C shows the same gate failing a complete delivery in
   §4.4).

### 3.3 What these failures show

| Observation | Evidence | Finding |
| --- | --- | --- |
| The specification is lost on the `dispatch_task` path | `plan.created` work-order objective is a generic template; the Main Agent's full objective exists only in the tool arguments | **P0: specification routing.** The default product path (Main Agent chooses its own tool) drops the user's request. |
| The Main Agent cannot see why it failed | Both CLI replies say “queued / not yet executed”; `get_run_status` carries no `failureReason` (`turns.json`) | **P0: feedback loop.** Same root as the 2026-11-17 capability eval's CLI turn problem. |
| Acceptance criteria do not match executor capability | Run 2 failed through `TestCommandVerifier`; the prompt forbade promising the MP4 and the criteria still required test evidence | **P0: verifier vs. capability profile** (existing finding, reproduced). |
| A coherent plan is not evidence of execution | The Main Agent's plan text is genuinely good and covers every deliverable | Plan quality cannot substitute for verifying the **specification arrived**. |

None of these is “the model cannot model.” Scoring them as a modeling result
would understate the worker, so the natural variant is recorded as **not
measured**, not zero.

## 4. Measured result: steered variant (C)

### 4.1 Headline

**The worker modeled the Forbidden City to the external contract — 21/21
hard checks — and the Kernel still marked the Run `failed`.** Attempt C
produced 20 files (412 lines of `src/`, 190 more across `index.html`,
`render.mjs`, the test file and the README), and every check that grades the
model against the world passed, including all ten roof forms, the shared 三台,
the axis, the 太和殿 dimensions and the symmetry pair. The failure is the
harness's, not the model's.

| Measure | Value |
| --- | --- |
| Run | `52b7886b-887c-463a-ab11-e05b190872ff`, status `failed` |
| Main Agent | 2 model calls, 19,158 tokens, 27.7 s; one `propose_work_plan` |
| Worker | 19 model calls, 371,070 tokens (25,573 out), 294.4 s |
| Artifacts | 20 files; 14 modules under `src/` |
| Tests | `node --test tests/`: **6/6 pass** |
| Checker | **21/21 hard checks pass**, 0 hard failures |
| Render (supervisor) | 900 frames, `video.mp4` **30.00 s, 1920×1080, 30 fps, H.264 yuv420p**, 5.5 MB |
| Frame timing | median **33.3 ms/frame**, p95 34.5 ms (60 seeks, 1080p) |
| Runtime stats | 414,626 triangles, 71 draw calls at t=30 |

The supervisor rendered the video with
[`verify/render-frames.mjs`](verify/render-frames.mjs) (system Chrome, the
page's own `window.setVideoTime` contract) because the workspace's `render.mjs`
requires a Playwright Chromium download the machine cannot perform — the same
environment limit as the 2026-11-17 run. The artifact's own README states this
dependence honestly and does not claim the video exists.

### 4.2 External-contract checks

| Check | Result |
| --- | --- |
| `model.roof-types` | **10/10 match**: 午门 重檐庑殿, 太和门 重檐歇山, 太和殿 重檐庑殿, 中和殿 四角攒尖, 保和殿 重檐歇山, 乾清门 单檐歇山, 乾清宫 重檐庑殿, 交泰殿 四角攒尖, 坤宁宫 重檐庑殿, 神武门 重檐庑殿 |
| `model.axis` | 10/10 axis buildings within ±1 m of x = 0 |
| `model.three-platform` | 太和殿/中和殿/保和殿 all share `platformId: three-halls` |
| `model.taihe-dimensions` | **64×37×35 m**, exactly the reference (tolerance ±10 %) |
| `model.symmetry` | 体仁阁 x=+94, 弘义阁 x=−94 → error 0 m |
| `model.axis-length` | 961 m |
| `model.features` | platforms (5), 7 camera keys, props (walls, moat, corner towers, ornaments, plazas) |
| `browser.timeline-differs` | 5/5 distinct screenshots at t = 0/7.5/15/22.5/30 |

The model is not a separate hand-written table: `src/model.js` is the single
source that `buildings.js`, `platforms.js`, `roof.js` and the window API all
read, so the JSON the checker grades is the data the geometry was built from.

### 4.3 What the screenshots show, and the gaps they reveal

The checker passes on facts; the images show where the model is still a
simplification. This is the part a pass/fail list cannot carry, so it is
recorded as prose:

- **t = 0**, from the moat: 午门's double roof reads as 庑殿, the gate opening is
  a clean portal, the 御路 and 望柱 line up on axis. Composition is correct but
  the roof silhouette is bulbous — the 举折 curve sags outward instead of
  falling steeply near the ridge, which makes the hall read as a dolmen rather
  than a Chinese roof.
- **t = 15**, inside 午门's tunnel: the portal is genuinely open, the camera
  passes through both gates without clipping, and 太和门 is visible beyond. The
  tunnel interior is untextured red with hard edges; no 斗拱 or 彩画 detail.
- **t = 22.5**, the 三台: three stepped platforms, 望柱/栏板, 御路 stairs,
  华表 and a small 铜龟/铜鹤 cluster are present, and 太和殿 sits on the top
  tier. The tier proportions are plausible; the platform decks are flat white
  with no 须弥座 profile.
- **t = 30**, aerial: 太和殿/中和殿/保和殿 are distinguishable, the corner
  towers sit at the wall corners and the moat reads as a ring. But upstream of
  the three halls the 内廷 is nearly empty — the inner-court buildings exist in
  the model but sit far north with little between them, and the complex reads
  as a corridor rather than a palace.
- **Systemic:** no 台基 for 午门/太和门/神武门 (gate buildings sit on the ground),
  roofs are the only curved geometry, and the whole scene has no lighting
  beyond a flat directional pass — no shadows, no ambient occlusion.

So: **contract-complete, visually schematic.** The bench measures whether the
model can hold a sourced contract; it does not yet measure architectural
quality, and §7 says how that could be added.

### 4.4 Why the Run still failed (verified)

The Kernel's verdict was:

```
Verification failed. Verification failed. 实现程序化故宫中轴线项目:
"out/video.mp4" was promised but does not exist on disk.;
Test verification failed. 实现程序化故宫中轴线项目:
a test step needs test evidence with a locator.
```

Both reasons are verifier defects, reproduced against the exact plan text:

1. **A negated mention becomes a promise.**
   `extractFileExpectations` (`src/core/verification.ts:43`) matches any quoted
   or bare path with a directory segment, without reading negation. The step
   instruction says `不要声称 out/video.mp4 已生成` — *do not claim it exists* —
   and the verifier extracted it as a required file. Reproduction:
   `extractFileExpectations({ instructions: "…不要声称 out/video.mp4 已生成。" })`
   returns `[{ path: "out/video.mp4" }]`. The English equivalent
   (`do not claim out/video.mp4 exists`) fails the same way.
2. **"Tests" in prose triggers the test-evidence gate.**
   `mentionsTests` (`src/core/verifier-plugins.ts:184`) is a bare
   `/\btests?\b|跑测试|运行测试|单元测试/` over instructions and criteria. The
   instruction names `tests/` as a deliverable (*"交付 … tests/ …"*), which
   matches, so the verifier demanded a `test` evidence item with a locator —
   something a file-only worker cannot produce. Reproduction:
   `mentionsTests({ instructions: "…交付 … tests/ …" })` is `true`. Even an
   honest sentence like *"README 列出未执行的测试与渲染"* trips the same gate.

Together these turn a **21/21, fully verified-by-the-supervisor delivery** into
`failed`. A user of the product would see a red Run and no explanation.

### 4.5 Score

| Dimension | Score | Basis |
| --- | ---: | --- |
| Task completion | 5 | Every deliverable present and substantive; external contract complete. |
| Functional correctness | 5 | 6/6 tests, 21/21 checks, 900-frame H.264 video, no console errors. |
| Engineering quality | 4 | Single data source for model+geometry, instanced repeats, deterministic PRNG, honest README; roof profile visually wrong, thin inner court, no lighting depth. |
| Planning & autonomy | 4 | One self-contained step that carried the whole spec (the prompt asked for it); no self-check pass after writing. |
| Honesty & self-verification | 5 | README states what was not run, names its sources as training knowledge, and refuses to claim the video. |
| Efficiency | 3 | 371 k worker tokens for 600 lines — high input repetition, same pattern as the 2026-11-17 runs. |

Weighted with the capability rubric (25/25/20/15/10/5): **4.6 / 5**. The Run
status shown to the owner was `failed`.

## 4A. Re-run after the verifier fix (2026-11-17, attempt E)

After the two verifier defects were fixed (§4.4) and the benchmark was made
stricter — three new hard checks and prompt requirements for gate platforms,
anchored ornaments and roof-form data — the same task and model
(`gpt-6.1-terra`, plan-steered prompt) were run again on the new product surface
(the companion HTTP API, since the `clone-ai` CLI was removed that day).

| Measure | Baseline C | Re-run E |
| --- | --- | --- |
| Checker (same stricter rules applied to both) | **21/24**, 3 hard failures | **24/24**, 0 hard failures |
| Roof-form data (`eaveY`/`ridgeY`/overhang/ridge length) | absent | present for every roof |
| Gate platforms (`platformId` on 午门/太和门/乾清门/神武门) | missing | all four present |
| Ornaments anchored to a hall or platform | 2 floating 华表 | 6 anchored |
| Visible roof profile | bulbous, dolmen-like | 举折: flat eaves, steep near the ridge |
| Tests | 6/6 | 9/9 |
| Video (supervisor-rendered) | 30.00 s 1920×1080 H.264 | 30.00 s 1920×1080 H.264 |
| Worker usage | 371 k tokens, 19 calls, 294 s | 493 k tokens, 20 calls, 432 s |
| Run status shown to the owner | `failed` | **`failed`** |

**What improved, verified in the screenshots:** every hall now sits on a modeled
platform, the three-tier 三台 with railings and the imperial stairway is clearly
visible at t = 22.5, the roofs read as Chinese roofs rather than tents, and the
ornaments (石狮/华表/铜龟/铜鹤/日晷) sit beside the halls instead of floating in
a plaza. The 24 checks all pass, including the three new ones.

**What is still wrong, and is not measured by any check yet:**

- The 30 s camera starts on the **north side of 午门** looking south — z runs
  +480 (南) to −481 (北) in this model, and the camera opens at z = 563 → 465,
  i.e. inside/behind the gate rather than on the moat outside it. The brief asked
  for a start outside the moat; no check can see camera orientation.
- **Lighting is flat.** No shadows, no ambient occlusion; every surface is lit
  the same, which is most of why the renders still look like a model rather than
  a place.
- The roofs, while correctly profiled, are **untextured flat yellow** with no
  tile rows, and 斗拱/彩画 are absent or a single band.

So the modeling improved substantially where the contract reaches, and the
remaining gap is mostly the part the contract does not describe: composition,
light and surface detail. That is the next thing to measure (§7).

**Why E still ended `failed`** — and this time it is a *different* cause, not a
verifier defect: E's plan writes that `render.mjs` produces `out/video.mp4`, and
the file verifier correctly reads that as a promised file. The prohibition fix
from §4.4 covers "do not claim X"; it does not cover "the script you deliver
will produce X", which is a true statement about a future step the owner runs.
The run is not honestly complete by its own plan's words. The remaining fix is
to let a plan mark a path as `producedLaterBy: "owner"` (or to put the MP4 only
in the README), not to weaken the verifier again. This is recorded as a P1 in
§7 rather than patched now, because it is a plan-schema change rather than a
judgment bug.

## 5. Comparison with the 2026-11-17 capability eval (01 procedural 3D video)

| Dimension | 01 city video (then) | Natural variant (A, B) | Steered variant (C) |
| --- | --- | --- | --- |
| Artifacts produced | 15 files | **0** | **20 files** |
| Run status | `failed` | `failed` | `failed` |
| Status vs. artifact quality | usable project marked failed | nothing to judge | **21/21 external checks pass, marked failed** |
| Failure cause | criteria promised an MP4 and test evidence the worker cannot produce | specification never reached the worker + the same evidence mismatch | the verifier read a *prohibition* of the MP4 as a promise, and `tests/` in prose as a test-evidence requirement |
| Feedback to the owner | Main Agent only saw “queued” | same | same |
| Weighted capability score | 3.6 / 5 | not measured | 4.6 / 5 |

Two conclusions follow. First, the same executor and model produced a
contract-complete model when the specification reached the worker, so the
worker's modeling capability is not the bottleneck at this scale. Second, **all
three runs ended `failed` for reasons unrelated to the artifacts** — and the
two verifier defects in §4.4 mean the newest failure mode is worse than the old
one: a run that is complete can now be failed for writing down what it did
*not* do. Honest disclosure is being punished, which is the opposite of the
behaviour the project wants to train.

The same executor, model and prompt-layer constraints produced a usable project
at 01 because the Main Agent there encoded the specification in
`propose_work_plan` step instructions (a three-step plan); the natural variant
here called `dispatch_task` first. **The two tools differ in whether the
specification reaches the worker, and the product lets the model choose.**

## 6. Evidence that the checker itself discriminates

The checker was first run against the 2026-11-17 eval's 01 city artifact, as a
“partially sound project” calibration:

```
11/14 checks passed; hard failures: 3
PASS  tests.run — 4 pass, 0 fail (1 file(s))
PASS  browser.ready / browser.timeline-differs — 5/5 distinct screenshots
PASS  browser.frame-throughput — median 33.3 ms/frame
FAIL  api.model / api.checks — getForbiddenCityModel() missing (not required by that task)
FAIL  html.three-import — import map points at node_modules, not the seeded vendor/
```

It correctly separates “the page runs and its tests pass” from “there is no
external model contract”, and it does not turn the favicon 404 or a strict
static heuristic into a hard failure (soft checks are reported separately). That
calibration also shows what the 01 score of 3.6 actually measured: **internal
consistency, not external facts**.

## 7. Gaps and next steps, by priority

> Per AGENTS.md rule 4, if these are implemented as bug fixes they go through
> clone-ai's own repair lane; the working agent checks functional correctness
> only and does not hand-write patches.

1. **P0 — `dispatch_task` must inject the task's objective and criteria into the
   work order.** Today the fallback planner replaces them with a generic
   template, and the worker receives “prepare a local deliverable”. Fixing this
   is the precondition for the natural variant to measure modeling at all. The
   regression test should assert the work order's objective in `plan.created`
   contains the task's subject.
2. **P0 — the Main Agent needs the Run's terminal state and `failureReason`.**
   Both replies said “queued”, so neither the model nor the user could see why
   it failed.
3. **P0 — verifiers must know the executor's capabilities** (existing finding,
   reproduced): a step without a shell must not be failed by
   `TestCommandVerifier`; it should be owner-review, or the plan should be
   refused if it writes execution criteria. The specific defects are now
   reproduced with one-line cases: a negated path mention
   (`不要声称 out/video.mp4 已生成`) becomes a required file, and `tests/` named as
   a deliverable triggers `mentionsTests`. Regression cases belong in
   `benchmark/gate/verdict-cases.json`, where a false fail is already a gate
   failure. **Fixed 2026-11-17** (hand fix, protected-path exception): negation
   is now read, and `mentionsTests` requires a run request.
4. **P1 — a plan must be able to say "produced later by the owner".**
   Attempt E failed because its plan truthfully says `render.mjs` produces
   `out/video.mp4`; that is a future owner step, not a worker deliverable. Add a
   `producedLaterBy` marker to the plan artifact contract (or keep render outputs
   in the README only) instead of weakening the verifier again.
4. **P1 — “do not promise the MP4” must be enforced by the Kernel, not by the
   model's self-discipline.** The prompt said it; the plan still did it.
5. **P1 — more repetitions.** One or two runs per variant cannot estimate
   variance; the next revision should pin three repeats and report the median and
   pass rate, reusing the `--repeat` statistics from `bench:main`.
6. **P2 — the sourced expectations should be replaced with citable sources.**
   Today they are the checking model's training knowledge, marked as such in
   `expected.json`; that is not external authority.
