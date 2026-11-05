/**
 * Safety-critical paths the repair model may never change.
 *
 * These are the rules that decide whether a patch is safe. A repair loop that
 * can edit its own verifier, policy, journal, or review gate can turn a failed
 * test into a green lie.
 *
 * 修复模型永远不能改动的安全关键路径。
 *
 * 这些规则决定补丁是否安全。若修复回路能修改自己的验证器、策略、Journal 或评审闸门，
 * 它就能把失败测试变成一条绿色的谎言。
 */
export const PROTECTED = [
  ".rsi/",
  "src/authority/",
  "src/core/policy.ts",
  "src/core/tool-authority.ts",
  "src/core/contracts.ts",
  "src/core/verification.ts",
  "src/core/verifier-plugins.ts",
  "src/core/invariants.ts",
  "src/core/run-state.ts",
  "src/core/journal.ts",
  "src/core/sqlite-journal.ts",
  "src/core/runtime.ts",
  "src/application/run-queue.ts",
  "src/application/run-query.ts",
  "src/audit/apply-review.ts",
  "src/audit/self-review.ts",
  "src/companion-auth.ts",
  "src/companion-server.ts",
  "src/main-agent/session.ts",
  "src/main-agent/tools/",
  ".github/",
  "scripts/",
  // The repair model may add a regression test in test/regression, but it
  // must never weaken an existing test or test configuration to make the
  // suite green.
  // 修复模型可以在 test/regression 中新增回归测试，但绝不能削弱现有测试或
  // 测试配置来把测试套件变绿。
  "test/",
  "tsconfig.json",
  "tsconfig.",
  ".claude/",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".npmrc",
  ".gitmodules",
  "deploy/",
  "Dockerfile",
  "compose.server.yml",
];

/** Parse path lines from `git diff --name-only` or `git status --porcelain`. 解析 git 差异或状态中的路径行。 */
export function stagedPaths(stdout) {
  if (stdout.includes("\0")) {
    return stdout.split("\0").filter(Boolean).map((path) => path.replace(/^\.\//, ""));
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rename = line.match(/^(.+?)\s+->\s+(.+)$/);
      if (rename?.[2] !== undefined) return rename[2];
      const parts = line.split(/\s+/);
      return parts.at(-1) ?? "";
    })
    .filter(Boolean);
}

/** Return every protected path in a repair diff; test/regression is the one allowed test area. 返回补丁中的保护路径；test/regression 是唯一允许的测试区域。 */
export function protectedPathViolations(paths) {
  return paths.filter((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    return PROTECTED.some((prefix) => normalized.startsWith(prefix))
      && !normalized.startsWith("test/regression/");
  });
}
