# Forbidden City 3D benchmark

**English** · [简体中文](README.zh-CN.md)

This is the capability benchmark for **3D modeling that can be checked against
the world**, not only against itself. The 2026-11-17 capability run showed that
clone-ai can produce a working Three.js scene; it also showed that the previous
3D task graded mostly *internal* consistency (a seeded timeline, tests, a
render script), so a scene could pass while the city it built was compositionally
arbitrary. The Forbidden City task adds an external contract: named halls, the
historically correct roof form for each, a shared three-tier platform, a
measured axis, and published dimensions — all exposed through a JSON model the
supervisor reads from the running page.

It is also a **harness** benchmark. The task is dispatched through the same
`clone-ai new` path the product uses, so the run records whether the Main
Agent's specification reaches the worker, whether evidence is verified, and
what a failed run tells the owner.

## Files

| Path | What it is |
| --- | --- |
| [`prompt.md`](prompt.md) | The task as given to the Main Agent (natural phrasing). |
| [`prompt.plan-steered.md`](prompt.plan-steered.md) | Same task, plus one paragraph telling the Main Agent to use `propose_work_plan` with a self-contained step. This is the **modeling** variant; `prompt.md` is the **natural** variant. |
| [`verify/expected.json`](verify/expected.json) | The sourced expectations (roof forms, axis tolerance, 太和殿 dimensions, symmetry pairs, soft checks). |
| [`verify/check-forbidden-city.mjs`](verify/check-forbidden-city.mjs) | The supervisor checker: static inspection, `node --test`, headless Chrome, model contract, timeline screenshots, frame throughput, optional 900-frame render. |
| [`verify/render-frames.mjs`](verify/render-frames.mjs) | Supervisor frame renderer on the installed Chrome; used when a workspace's own `render.mjs` needs a browser download the machine cannot perform. |
| [`verify/serve.mjs`](verify/serve.mjs) | Static file server used by the checker. |

## Run

The worker has file tools only — no shell, no browser, no network — so Three.js
is seeded into the workspace by the runner, and every execution check is done by
the supervisor afterwards.

```bash
eval-runs/2026-11-17-forbidden-city/run-task.sh <attempt> [prompt-variant]
```

The runner pins the model, effort, round and token limits, and an isolated
`CLONE_AI_DATA_DIR` / `CLONE_AI_WORKSPACE` / `CLONE_AI_AUDIT_HOME` per attempt.

## Check

```bash
CLONE_AI_VERIFY_DEPS=eval-runs/2026-11-17-capability/verify \
  node benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs \
  --workspace <workspace> --out <evidence-dir> [--render] [--frames 900]
```

The checker exits non-zero only on **hard** failures. `expected.json` lists the
soft checks (frame throughput, render-script static soundness): they are
reported but a slow machine or a strict static heuristic must not turn a correct
model into a failed one. Every check prints one `PASS`/`FAIL` line and the full
evidence lands in `report.json` / `report.txt` next to the screenshots.

### What each check measures, and why it is worth measuring

| Check | Hard? | What it catches |
| --- | --- | --- |
| `files.required`, `src.modules` | yes | A design document instead of a project; one giant HTML file. |
| `determinism.no-unseeded-random` | yes | A timeline that cannot be re-rendered. |
| `html.three-import`, `html.external-assets` | yes | A page that needs the network the worker does not have. |
| `render.script-static` | no | Syntax errors and a script that never mentions 900 frames / ffmpeg / H.264. Static text cannot prove the render works; it only rules out an obviously empty script. |
| `tests.run` | yes | Tests that do not exist or do not pass, run by the supervisor. |
| `browser.ready`, `browser.no-uncaught-error`, `browser.console` | yes | A page that never becomes ready or throws. |
| `api.model`, `api.checks` | yes | The checkable contract: a JSON model built from the same data as the geometry. |
| `model.roof-types` | yes | The core external fact: each named hall's roof form. |
| `model.axis` | yes | Halls placed off the central axis. |
| `model.three-platform` | yes | The three great halls not sharing the 三台. |
| `model.taihe-dimensions` | yes | Hall scale outside ±10% of the published 64×37×35 m. |
| `model.symmetry` | yes | 体仁阁 / 弘义阁 not mirrored. |
| `model.axis-length` | yes | The complex compressed or stretched beyond the 961 m ±10% band. |
| `model.features` | yes | Platforms, camera keys or props missing from the model. |
| `browser.timeline-differs` | yes | A static image or a camera that does not move. |
| `browser.frame-throughput` | no | An implementation that rebuilds geometry every seek (median > 100 ms/frame). |
| optional `render.900-frames`, `render.video-spec` | yes when `--render` | The deliverable video and its 30 s / 1920×1080 spec. |

The expectations are conventional published figures and the historically correct
roof forms; the ±10% tolerance and ±1 m axis tolerance keep the check about
*modeling against a reference*, not about recalling an exact number. The
reference values themselves are training knowledge of the model running the
check, and are stated as such in `expected.json` — a reader who has a citable
source should replace them and the checker needs no code change.

## Reading a result

The benchmark separates three questions, and a single number would blur them:

1. **Did the specification reach the worker?** Evidenced by the journal:
   `subagent.dispatched.workspacePath`, the step instructions, and whether any
   `write_file` occurred. Zero artifacts with a full page of instruction text in
   the Main Agent's reply is a harness failure, not a modeling failure.
2. **Did the model meet the external contract?** The `model.*` and `render.*`
   checks.
3. **Did the owner get an honest report?** The Main Agent's reply and the
   workspace README, compared with what the checker found.

A run is only evidence about modeling (question 2) when question 1 passed.

## Results

See [`ANALYSIS.md`](ANALYSIS.md) for the 2026-11-17 baseline analysis, the
per-check table for each attempt, and what the failures say about the harness.
