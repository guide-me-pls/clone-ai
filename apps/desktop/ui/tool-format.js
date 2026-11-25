/*
 * Human-readable tool inputs for the audit view.
 *
 * The audit is read to answer "what did the agent actually do", so a tool call
 * opens with a sentence and labeled fields, not a JSON blob. Raw arguments stay
 * one click away for debugging. This module is deliberately pure: it takes the
 * recorded summary string and returns markup.
 *
 * 审计视图的人类可读工具输入。
 *
 * 审计是为了回答"分身到底做了什么"，因此工具调用先给人话与带标签的字段，而不是 JSON。
 * 原始参数留在一键之后，供排查。本模块刻意保持纯粹：输入是记录下来的摘要字符串，输出是
 * 标记。
 */
(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
  const LABELS = {
    objective: "目标",
    acceptanceCriteria: "验收标准",
    responsibility: "职责",
    date: "日期",
    path: "路径",
    paths: "路径",
    files: "文件",
    includeDiffs: "包含内容差异",
    limit: "条数上限",
    since: "起始时间",
    query: "查询",
    pattern: "匹配模式",
    glob: "匹配模式",
    agentId: "执行者",
    risk: "风险",
    writeScopes: "写入范围",
    command: "命令",
    cwd: "工作目录",
    content: "内容",
    summary: "摘要",
    id: "标识",
    url: "地址",
    offset: "起始位置",
    maxResults: "结果上限",
  };
  /** The field each headline already says, so it is not repeated below. 标题已经说过的字段，下方不再重复。 */
  const HEADLINE_KEYS = {
    dispatch_task: "objective",
    daily_workspace_digest: "path",
    recent_file_changes: "path",
    read_file: "path",
    write_file: "path",
    list_files: "path",
    search_files: "query",
    run_command: "command",
    search_memory: "query",
    read_memory: "id",
    remember: "summary",
  };
  const MAX_TEXT = 240;
  const MAX_HEADLINE = 300;
  const MAX_ITEMS = 8;

  const label = (key) => LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  function scalar(value) {
    if (value === true) return "是";
    if (value === false) return "否";
    if (value === null || value === undefined) return "—";
    const text = String(value);
    if (text === "today") return "今天";
    if (text === "yesterday") return "昨天";
    if (text === "read") return "只读";
    if (text === "write") return "写入";
    return clip(text.replace(/\s+/g, " ").trim(), MAX_TEXT);
  }
  function headline(name, input) {
    const text = (key) => (typeof input[key] === "string" ? clip(input[key].replace(/\s+/g, " ").trim(), MAX_HEADLINE) : "");
    if (name === "dispatch_task") return text("objective") ? `派发任务：${text("objective")}` : "派发任务";
    if (name === "daily_workspace_digest") return text("path") ? `工作区摘要：${text("path")}` : "工作区摘要";
    if (name === "recent_file_changes") return text("path") ? `最近变更：${text("path")}` : "最近变更";
    if (name === "read_file") return text("path") ? `读取文件：${text("path")}` : "读取文件";
    if (name === "write_file") return text("path") ? `写入文件：${text("path")}` : "写入文件";
    if (name === "list_files") return text("path") ? `列出目录：${text("path")}` : "列出目录";
    if (name === "search_files") return text("query") || text("pattern") ? `搜索文件：${text("query") || text("pattern")}` : "搜索文件";
    if (name === "run_command") return text("command") ? `运行命令：${text("command")}` : "运行命令";
    if (name === "search_memory") return text("query") ? `检索记忆：${text("query")}` : "检索记忆";
    if (name === "read_memory") return text("id") ? `读取记忆：${text("id")}` : "读取记忆";
    if (name === "remember") return text("summary") ? `写入记忆：${text("summary")}` : "写入记忆";
    return `调用 ${name}`;
  }
  function valueMarkup(value) {
    if (Array.isArray(value)) {
      const shown = value.slice(0, MAX_ITEMS);
      const items = shown.map((item) => `<li>${esc(typeof item === "object" && item !== null ? JSON.stringify(item) : scalar(item))}</li>`).join("");
      const more = value.length > shown.length ? `<li>还有 ${value.length - shown.length} 项，见原始参数</li>` : "";
      return `<ul class="au-tool-list">${items}${more}</ul>`;
    }
    if (typeof value === "object" && value !== null) return `<code>${esc(JSON.stringify(value))}</code>`;
    return esc(scalar(value));
  }

  /**
   * Recovers a JSON object whose recorded text was cut at the server's input
   * limit. The scanner closes an open string and the open objects/arrays, then
   * parses; anything that still does not parse falls back to the recorded text.
   * 恢复被服务器输入上限截断的 JSON 对象。扫描器补上未闭合的字符串与对象/数组后再解析；
   * 仍无法解析的退回记录文本。
   */
  function repairJson(text) {
    const source = text.replace(/…\[truncated\]$/, "").trim();
    if (source.length === 0) return undefined;
    let inString = false;
    let escaped = false;
    const stack = [];
    for (const char of source) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") stack.pop();
    }
    let repaired = inString ? `${source}"` : source;
    repaired = repaired.replace(/[,:]\s*$/, "");
    for (let index = stack.length - 1; index >= 0; index -= 1) repaired += stack[index] === "{" ? "}" : "]";
    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
  }

  /**
   * Renders one recorded tool input. Malformed or truncated JSON falls back to
   * the recorded text: a readable failure is better than a broken summary.
   * 渲染一条记录下来的工具输入。格式损坏或截断的 JSON 退回记录文本：可读的失败优于坏掉的
   * 摘要。
   */
  function toolInputMarkup(name, summary) {
    if (typeof summary !== "string" || summary.trim().length === 0) return "";
    let input;
    let repaired = false;
    try {
      input = JSON.parse(summary);
    } catch {
      input = repairJson(summary);
      repaired = input !== undefined;
    }
    if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) {
      return `<div class="au-tool-input"><pre class="au-tool-text">${esc(summary)}</pre></div>`;
    }
    const listKey = name === "dispatch_task" && Array.isArray(input.acceptanceCriteria) ? "acceptanceCriteria" : undefined;
    const headlineKey = HEADLINE_KEYS[name];
    const rows = Object.entries(input)
      .filter(([key, value]) => value !== undefined && key !== headlineKey && key !== listKey)
      .map(([key, value]) => `<dt>${esc(label(key))}</dt><dd>${valueMarkup(value)}</dd>`)
      .join("");
    const criteria = listKey === undefined
      ? ""
      : `<p class="au-tool-subhead">${esc(label(listKey))}</p>${valueMarkup(input[listKey])}`;
    const note = repaired ? `<p class="au-tool-note">参数过长，记录已被截断；以下是可恢复的部分。</p>` : "";
    const rawLabel = repaired ? "原始参数（已截断）" : "原始参数";
    const raw = `<details class="au-tool-raw"><summary>${rawLabel}</summary><pre>${esc(repaired ? summary : JSON.stringify(input, null, 2))}</pre></details>`;
    return `<div class="au-tool-input"><p class="au-tool-headline">${esc(headline(name, input))}</p>${note}${criteria}${rows ? `<dl class="au-tool-fields">${rows}</dl>` : ""}${raw}</div>`;
  }

  window.CloneToolFormat = Object.freeze({ toolInputMarkup });
})();
