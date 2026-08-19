/**
 * Reliability benchmark tasks for the black-box execution path.
 * Each task is a fixed, reproducible WorkOrder that must pass against a real
 * provider. Results are recorded under benchmark/results/ so upgrades can be
 * compared run over run.
 *
 * 黑盒执行路径的可靠性基准任务。每个任务都是固定的、可复现的 WorkOrder，必须在
 * 真实 Provider 上通过。结果记录在 benchmark/results/ 下，供每次升级前后对比。
 *
 * Notes on scope:
 * - These measure the harness (orchestration, evidence, verification), not the
 *   model: a task passes when the workspace shows the contracted artifact and
 *   the Kernel verification passes.
 * - Keep the set small and cheap: five tasks, ~3-5 minutes against a real CLI.
 * - A flaky model must not break the benchmark; failing tasks are reported,
 *   and the summary shows pass rate instead of a single boolean.
 */
export interface BenchTask {
  id: string;
  title: string;
  summary: string;
  /** Seed files written into the workspace before the task runs. 任务前写入工作区的种子文件。 */
  seedFiles: Record<string, string>;
  /** One step with a subagent group (single WorkOrder) or a chain. 单步或链式子 WorkOrder。 */
  steps: BenchStep[];
}

export interface BenchStep {
  id: string;
  title: string;
  instructions: string;
  risk: "read_only" | "reversible_write";
  subagents: BenchWorkOrder[];
}

export interface BenchWorkOrder {
  id: string;
  role: "researcher" | "maker" | "reviewer" | "custom";
  title: string;
  objective: string;
  requiredCapabilities: string[];
  expectedArtifacts: Array<{ id: string; kind: "artifact"; description: string; required: boolean }>;
  acceptanceCriteria: string[];
  risk: "read_only" | "reversible_write";
  maxDurationMs: number;
  dependsOn?: string[];
}

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "summarize",
    title: "Read-only summary",
    summary: "One read-only WorkOrder: read a seeded README and write a summary file.",
    seedFiles: {
      "README.md": [
        "# acme-project",
        "",
        "A demo project used by the clone-ai reliability benchmark.",
        "- Local-first, evidence over assertion.",
        "- Replaceable agent runtimes behind one black-box boundary.",
        "- Kernel owns policy, approval, verification, and completion.",
      ].join("\n"),
    },
    steps: [{
      id: "summarize",
      title: "Summarize the project",
      instructions: "One read-only research WorkOrder.",
      risk: "reversible_write",
      subagents: [{
        id: "summarize",
        role: "researcher",
        title: "Write a summary",
        objective: "Read README.md and write out/summary.md: the project purpose and its three key guarantees, under 120 words.",
        requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
        expectedArtifacts: [{ id: "summary", kind: "artifact", description: "out/summary.md", required: true }],
        acceptanceCriteria: ["out/summary.md exists"],
        risk: "reversible_write",
        maxDurationMs: 180_000,
      }],
    }],
  },
  {
    id: "two-step-chain",
    title: "Two-step dependency chain",
    summary: "Research notes feed a drafting WorkOrder through dependency evidence.",
    seedFiles: {
      "README.md": [
        "# acme-project",
        "",
        "A demo project used by the clone-ai reliability benchmark.",
        "- Local-first, evidence over assertion.",
        "- Replaceable agent runtimes behind one black-box boundary.",
        "- Kernel owns policy, approval, verification, and completion.",
      ].join("\n"),
    },
    steps: [{
      id: "chain",
      title: "Notes then brief",
      instructions: "Two dependent WorkOrders.",
      risk: "reversible_write",
      subagents: [
        {
          id: "research",
          role: "researcher",
          title: "Take notes",
          objective: "Read README.md and write out/notes.md: purpose and guarantees, under 150 words.",
          requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "notes", kind: "artifact", description: "out/notes.md", required: true }],
          acceptanceCriteria: ["out/notes.md exists"],
          risk: "reversible_write",
          maxDurationMs: 180_000,
        },
        {
          id: "draft",
          role: "maker",
          title: "Draft a brief",
          objective: "Read out/notes.md and write out/brief.md: a two-section brief (Purpose, Architecture) based only on the notes.",
          requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "brief", kind: "artifact", description: "out/brief.md", required: true }],
          acceptanceCriteria: ["out/brief.md has two sections"],
          risk: "reversible_write",
          maxDurationMs: 240_000,
          dependsOn: ["research"],
        },
      ],
    }],
  },
  {
    id: "three-step-pipeline",
    title: "Three-step research -> draft -> review pipeline",
    summary: "Full pipeline with two dependency edges; review must not modify the brief.",
    seedFiles: {
      "README.md": [
        "# acme-project",
        "",
        "A demo project used by the clone-ai reliability benchmark.",
        "- Local-first, evidence over assertion.",
        "- Replaceable agent runtimes behind one black-box boundary.",
        "- Kernel owns policy, approval, verification, and completion.",
      ].join("\n"),
    },
    steps: [{
      id: "pipeline",
      title: "Research, draft, review",
      instructions: "Three dependent WorkOrders.",
      risk: "reversible_write",
      subagents: [
        {
          id: "research",
          role: "researcher",
          title: "Take notes",
          objective: "Read README.md and write out/notes.md: purpose, guarantees, and architecture, under 200 words.",
          requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "notes", kind: "artifact", description: "out/notes.md", required: true }],
          acceptanceCriteria: ["out/notes.md exists"],
          risk: "reversible_write",
          maxDurationMs: 200_000,
        },
        {
          id: "draft",
          role: "maker",
          title: "Draft the brief",
          objective: "Read out/notes.md and write out/brief.md: a three-section product brief (Purpose, Architecture, Safety) based only on the notes.",
          requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "brief", kind: "artifact", description: "out/brief.md", required: true }],
          acceptanceCriteria: ["out/brief.md has three sections"],
          risk: "reversible_write",
          maxDurationMs: 240_000,
          dependsOn: ["research"],
        },
        {
          id: "review",
          role: "reviewer",
          title: "Review the brief",
          objective: "Read out/brief.md and write out/review.md: assess clarity, completeness, and accuracy against the notes; list three concrete improvements. Do not modify brief.md.",
          requiredCapabilities: ["review", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "review", kind: "artifact", description: "out/review.md", required: true }],
          acceptanceCriteria: ["out/review.md lists three improvements"],
          risk: "reversible_write",
          maxDurationMs: 240_000,
          dependsOn: ["research", "draft"],
        },
      ],
    }],
  },
  {
    id: "code-tool",
    title: "Code task with a real tool call",
    summary: "The agent writes a small JS module and a smoke test that actually runs.",
    seedFiles: {
      "package.json": JSON.stringify({ name: "bench-task", type: "module" }, null, 2),
    },
    steps: [{
      id: "code",
      title: "Write a module and test",
      instructions: "One maker WorkOrder with shell access.",
      risk: "reversible_write",
      subagents: [{
        id: "code",
        role: "maker",
        title: "Implement add.js and test.js",
        objective: "Write lib/add.js exporting a function add(a,b) that sums numbers, and test/add.test.mjs that imports it and asserts add(2,3)===5. Run the test with node and confirm it passes. Do not modify package.json.",
        requiredCapabilities: ["implementation", "filesystem_read", "filesystem_write", "external_action"],
        expectedArtifacts: [
          { id: "lib", kind: "artifact", description: "lib/add.js", required: true },
          { id: "test", kind: "artifact", description: "test/add.test.mjs", required: true },
        ],
        acceptanceCriteria: ["node test/add.test.mjs passes"],
        risk: "reversible_write",
        maxDurationMs: 300_000,
      }],
    }],
  },
  {
    id: "missing-input",
    title: "Missing input fails with the right category",
    summary: "A WorkOrder that references an absent file must fail cleanly (no_artifact), not hang.",
    seedFiles: {},
    steps: [{
      id: "missing",
      title: "Read an absent file",
      instructions: "One WorkOrder that cannot succeed.",
      risk: "reversible_write",
      subagents: [{
        id: "missing",
        role: "researcher",
        title: "Summarize an absent file",
        objective: "Read docs/absent.md (it does not exist) and write out/summary.md summarizing it.",
        requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
        expectedArtifacts: [{ id: "summary", kind: "artifact", description: "out/summary.md", required: true }],
        acceptanceCriteria: ["out/summary.md exists"],
        risk: "reversible_write",
        maxDurationMs: 120_000,
      }],
    }],
  },
];
