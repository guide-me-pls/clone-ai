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
const window: { CloneToolFormat?: { toolInputMarkup: (name: string, summary: string) => string } } = {};
runInNewContext(source, { window });
const format = (name: string, summary: string): string => window.CloneToolFormat!.toolInputMarkup(name, summary);

test("a dispatched task reads as its objective, criteria and execution fields", () => {
  const html = format("dispatch_task", JSON.stringify({
    objective: "对 /Users/user/work/doc_translate 中未提交的 ToolBox 相关改动做一次纯只读审查。",
    acceptanceCriteria: ["列出实际文件清单", "说明与预期 9 个文件的差异", "给出能否整体提交的判断"],
    agentId: "context-researcher",
    risk: "read_only",
  }));
  assert.match(html, /派发任务：对 \/Users\/user\/work\/doc_translate 中未提交的 ToolBox/);
  assert.match(html, /验收标准/);
  assert.match(html, /列出实际文件清单/);
  assert.match(html, /执行者/);
  assert.match(html, /context-researcher/);
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
    agentId: "context-researcher",
  });
  const truncated = `${full.slice(0, full.length - 12)}…[truncated]`;
  const html = format("dispatch_task", truncated);
  assert.match(html, /派发任务：对 doc_translate/);
  assert.match(html, /列出实际清单/);
  assert.match(html, /参数过长/);
  assert.match(html, /原始参数（已截断）/);
});
