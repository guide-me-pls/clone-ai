/**
 * The audit must answer "what did the agent do" in words. These checks render
 * recorded tool inputs through the shared formatter: a sentence headline,
 * labeled fields and lists, with the raw JSON behind a toggle.
 *
 * 审计必须用文字回答"分身做了什么"。这些检查通过共享格式化器渲染记录下来的工具输入：
 * 一句话标题、带标签的字段与列表，原始 JSON 留在一键之后。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(join(process.cwd(), "apps", "desktop", "ui", "tool-format.js"), "utf8");
type ToolParam = { name: string; type: string; required: boolean; default: string; note: string };
type ToolDescription = { summary: string; params: ToolParam[] };
const window: {
  CloneToolFormat?: {
    toolInputMarkup: (name: string, summary: string) => string;
    describeTool: (description: string) => ToolDescription;
    paramsFromSchema: (schema: unknown) => ToolParam[];
  };
} = {};
runInNewContext(source, { window });
const format = (name: string, summary: string): string => window.CloneToolFormat!.toolInputMarkup(name, summary);
const describe = (description: string): ToolDescription => window.CloneToolFormat!.describeTool(description);
// Values built inside the VM realm have that realm's prototypes, so
// deepStrictEqual would reject them even with equal contents.
// VM 领域内构造的值带有该领域的原型，即使内容相同 deepStrictEqual 也会拒绝。
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("a dispatched task reads as its objective, responsibility and criteria", () => {
  const html = format("dispatch_task", JSON.stringify({
    objective: "对 /Users/user/work/doc_translate 中未提交的 ToolBox 相关改动做一次纯只读审查。",
    acceptanceCriteria: ["列出实际文件清单", "说明与预期 9 个文件的差异", "给出能否整体提交的判断"],
    responsibility: "read",
  }));
  assert.match(html, /派发任务：对 \/Users\/user\/work\/doc_translate 中未提交的 ToolBox/);
  assert.match(html, /验收标准/);
  assert.match(html, /列出实际文件清单/);
  assert.match(html, /职责/);
  assert.match(html, /只读/);
  assert.match(html, /原始参数/);
  // The visible part comes first; the JSON is inside the raw details. 可见部分在前，JSON 在原始详情里。
  assert.ok(html.indexOf("列出实际文件清单") < html.indexOf("原始参数"));
});

test("a workspace digest states its path, date, diff switch and limit in words", () => {
  const html = format("daily_workspace_digest", JSON.stringify({
    date: "today",
    path: "/Users/user/work",
    includeDiffs: true,
    limit: 60,
  }));
  assert.match(html, /工作区摘要：\/Users\/user\/work/);
  assert.match(html, /日期/);
  assert.match(html, /今天/);
  assert.match(html, /包含内容差异/);
  assert.match(html, /是/);
  assert.match(html, /条数上限/);
  assert.match(html, /60/);
});

test("unknown tools keep a readable label and escape their values", () => {
  const html = format("some_tool", JSON.stringify({ alpha: "<script>x</script>", beta: 3 }));
  assert.match(html, /调用 some_tool/);
  assert.match(html, /alpha/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /beta/);
  assert.match(html, /原始参数/);
});

test("malformed JSON falls back to the recorded text", () => {
  const html = format("dispatch_task", '{"objective":');
  assert.match(html, /au-tool-text/);
  assert.match(html, /objective/);
  assert.equal(format("dispatch_task", ""), "");
});

test("an open string at the cut is closed and still reads", () => {
  const html = format("dispatch_task", '{"objective":"half a JSON');
  assert.match(html, /派发任务：half a JSON/);
  assert.match(html, /参数过长/);
});

test("a truncated dispatch_task recovers its readable objective and criteria", () => {
  const full = JSON.stringify({
    objective: "对 doc_translate 中未提交的 ToolBox 改动做只读审查",
    acceptanceCriteria: ["列出实际清单", "说明差异", "给出结论"],
    responsibility: "read",
  });
  // Cut after the criteria, before the responsibility key: the recovered text
  // still names the task and its criteria, and the repair closes the object.
  // 在标准之后、职责字段之前截断：恢复出的文本仍有点名的任务与验收标准，修复器补上对象结尾。
  const truncated = `${full.slice(0, full.indexOf(',"responsibility"'))}…[truncated]`;
  const html = format("dispatch_task", truncated);
  assert.match(html, /派发任务：对 doc_translate/);
  assert.match(html, /列出实际清单/);
  assert.match(html, /参数过长/);
  assert.match(html, /原始参数（已截断）/);
});

test("a tool description becomes a summary and a typed parameter list", () => {
  const description = "Search files under a directory and return matching lines as `path:line: text`. "
    + "Args: {\"query\": string, \"path\"?: string (default \".\"), \"glob\"?: string (e.g. \"*.ts\"), "
    + "\"regex\"?: boolean, \"caseSensitive\"?: boolean, \"maxResults\"?: number (default 50, max 500)}. "
    + "Skips .git, node_modules, build output, binary files and protected locations.";
  const meta = describe(description);
  assert.equal(meta.summary, "Search files under a directory and return matching lines as `path:line: text`. Skips .git, node_modules, build output, binary files and protected locations.");
  assert.equal(meta.summary.includes("Args:"), false);
  const byName = new Map(meta.params.map((param) => [param.name, param]));
  assert.deepEqual(plain(byName.get("query")), { name: "query", type: "string", required: true, default: "", note: "" });
  assert.equal(byName.get("path")?.required, false);
  assert.equal(byName.get("path")?.default, '"."');
  assert.equal(byName.get("glob")?.note, "e.g. \"*.ts\"");
  assert.equal(byName.get("maxResults")?.type, "number");
  assert.equal(byName.get("maxResults")?.default, "50");
  assert.equal(byName.get("maxResults")?.note, "max 500");
});

test("a dash after the Args block stays a dash in the summary", () => {
  const meta = describe("Show a repository's branch and working-tree status. Args: {\"path\"?: string} — the repository or a directory inside it; defaults to the workspace. Read-only.");
  assert.match(meta.summary, /status — the repository or a directory inside it/);
  assert.equal(meta.params.length, 1);
});

test("a quoted sample value stays one string parameter and does not invent a note", () => {
  const meta = describe("Run one JavaScript expression. Args: {\"function\": \"() => ({...})\"}. Keep the result small.");
  assert.deepEqual(plain(meta.params), [{ name: "function", type: "string", required: true, default: "", note: "" }]);
});

test("a literal union reads as its alternatives", () => {
  const meta = describe("Read the console. Args: {\"level\"?: \"error\"|\"warning\"|\"info\", \"all\"?: boolean}.");
  assert.equal(meta.params[0]?.type, "error | warning | info");
  assert.equal(meta.params[0]?.required, false);
});

test("a description without an Args block is kept whole", () => {
  const meta = describe("Return the current instant. No arguments.");
  assert.equal(meta.summary, "Return the current instant. No arguments.");
  assert.deepEqual(plain(meta.params), []);
  assert.deepEqual(plain(describe("")), { summary: "", params: [] });
});

test("a probe schema produces the same parameter shape, including enum and default", () => {
  const params = window.CloneToolFormat!.paramsFromSchema({
    type: "object",
    properties: {
      query: { type: "string", description: "Literal text or a regular expression." },
      mode: { enum: ["fast", "thorough"] },
      limit: { type: "number", default: 50 },
      extra: { type: ["string", "null"] },
    },
    required: ["query"],
  });
  assert.deepEqual(plain(params.map((param) => [param.name, param.type, param.required])), [
    ["query", "string", true],
    ["mode", "fast | thorough", false],
    ["limit", "number", false],
    ["extra", "string | null", false],
  ]);
  assert.equal(params[1]?.default, "");
  assert.equal(params[2]?.default, "50");
  assert.equal(params[0]?.note, "Literal text or a regular expression.");
  assert.deepEqual(plain(window.CloneToolFormat!.paramsFromSchema({ type: "object" })), []);
});
