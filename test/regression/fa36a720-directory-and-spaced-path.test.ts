import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvidenceVerifier, extractFileExpectations } from "../../src/core/verification.ts";

test("directory context is not a file promise and spaced absolute file paths stay whole", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "verification-regression-"));
  try {
    const dataDir = join(workspace, ".clone");
    const projectDir = join(workspace, "Clone AI", ".clone");
    const file = join(workspace, "Clone AI", "out.md");
    await mkdir(dataDir);
    await mkdir(projectDir, { recursive: true });
    await writeFile(file, "completed\n");

    const directories = {
      id: "directories", title: "Inspect directories", risk: "read_only" as const,
      instructions: `数据目录 ${dataDir}；项目运行目录 ${projectDir}`,
      acceptanceCriteria: [],
    };
    const promise = {
      id: "file", title: "Write file", risk: "read_only" as const,
      instructions: `Write ${file}`,
      acceptanceCriteria: [],
    };
    const result = await new EvidenceVerifier({ workspacePath: workspace }).verify({
      run: { id: "run" } as any,
      plan: { steps: [directories, promise] } as any,
      evidence: [
        { id: "directory-evidence", stepId: directories.id, kind: "observation", summary: "inspected" },
        { id: "file-evidence", stepId: promise.id, kind: "observation", summary: "file exists" },
      ] as any,
    });

    assert.deepEqual({
      directories: extractFileExpectations(directories),
      file: extractFileExpectations(promise),
      passed: result.passed,
    }, {
      directories: [],
      file: [{ path: file, mustContain: [] }],
      passed: true,
    }, result.summary);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
