/**
 * Browser MCP: a local-only, owner-enabled observation tool for web work.
 *
 * The server is Playwright MCP (Microsoft's `@playwright/mcp`), but this module
 * is the policy layer clone-ai needs: which of its tools are exposed, what risk
 * each carries, and which workspace the browser starts in. The default install
 * exposes only the observation subset — navigate, console, snapshot, evaluate,
 * screenshot, keyboard — and never `browser_run_code_unsafe` or file upload.
 *
 * 浏览器 MCP：面向 Web 工作的本地、由所有者开启的观察工具。
 *
 * 服务器是 Playwright MCP（微软的 `@playwright/mcp`），但本模块才是 clone-ai 需要的策略层：
 * 暴露哪些工具、各自的风险等级、浏览器从哪个工作区启动。默认安装只暴露观察子集——导航、
 * 控制台、快照、求值、截图、键盘——绝不暴露 `browser_run_code_unsafe` 或文件上传。
 */
import type { McpServerConfig, McpToolDeclaration } from "../workers/mcp-client.ts";
import type { AuthorityConfig, StandingPolicy } from "../authority/standing-policy-store.ts";

export const BROWSER_MCP_SERVER_ID = "playwright";
export const BROWSER_MCP_VERSION = "0.0.85";
export const BROWSER_MCP_DEFAULT_PORT = 8135;
export const BROWSER_MCP_POLICY_ID = "browser-mcp-local-observation";

/**
 * The browser server, rooted at the project workspace. `--allowed-origins`
 * keeps the intended destination local; file:// is deliberately not enabled,
 * so the page cannot read arbitrary files from the machine.
 *
 * 浏览器服务器，根目录为项目工作区。`--allowed-origins` 把预期目的地限制在本机；刻意不开启
 * file://，因此页面读不到机器上的任意文件。
 */
export function browserMcpServer(workspace: string, port = BROWSER_MCP_DEFAULT_PORT, options: { version?: string } = {}): McpServerConfig {
  const version = options.version ?? BROWSER_MCP_VERSION;
  return {
    id: BROWSER_MCP_SERVER_ID,
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: [
      "--yes",
      `@playwright/mcp@${version}`,
      "--headless",
      "--browser",
      "chrome",
      "--isolated",
      "--ignore-roots",
      "--console-level",
      "error",
      "--allowed-origins",
      `http://127.0.0.1:${port}`,
      "--output-dir",
      ".playwright",
    ],
    cwd: workspace,
    timeoutMs: 120_000,
    tools: browserMcpTools(port),
  };
}

/**
 * The declared surface. The descriptions carry the argument shape because
 * clone-ai's MCP client deliberately does not load a server's own schema; the
 * owner declaration is the authority, including for what the model is told.
 *
 * 声明面。描述里带参数形状，因为 clone-ai 的 MCP 客户端刻意不加载服务器自己的 Schema；
 * 所有者声明才是权威，包括告诉模型什么。
 */
export function browserMcpTools(port = BROWSER_MCP_DEFAULT_PORT): McpToolDeclaration[] {
  const url = `http://127.0.0.1:${port}/`;
  return [
    {
      name: "browser_navigate",
      risk: "read",
      description: `Open the local preview server in headless Chrome. Use ${url} in this workspace; navigation to other hosts is not part of this tool's purpose. Args: {"url": string}.`,
    },
    {
      name: "browser_console_messages",
      risk: "read",
      description: `Read the page console. Call after navigating and after each change. Args: {"level"?: "error"|"warning"|"info", "all"?: boolean}. Prefer level "error" to check for uncaught exceptions.`,
    },
    {
      name: "browser_snapshot",
      risk: "read",
      description: "Capture the page accessibility snapshot as text. Good for DOM/menu checks; a canvas-only game will look mostly empty.",
    },
    {
      name: "browser_evaluate",
      risk: "write",
      description: "Run one JavaScript expression in the page and return its JSON result. Use it to read game state, count scene objects, simulate a few frames, or assert that a control changed. Args: {\"function\": \"() => ({...})\"}. Keep the result small and JSON-serializable.",
    },
    {
      name: "browser_press_key",
      risk: "write",
      description: "Press one key in the page (for menus and simple controls). Args: {\"key\": string}. A held movement key needs browser_evaluate instead, because this tool releases the key after the press.",
    },
    {
      name: "browser_take_screenshot",
      risk: "write",
      pathField: "filename",
      description: "Take a screenshot and LOOK AT IT: the PNG comes back as an image you can see, so check roofs, detail, shadow and composition, then fix the code. Args: {\"filename\"?: string, \"fullPage\"?: boolean}. Call window.setVideoTime(t) with browser_evaluate first to land on an exact frame.",
    },
    {
      name: "browser_resize",
      risk: "write",
      description: "Resize the browser viewport. Args: {\"width\": number, \"height\": number}. Use 1280x720 and 1920x1080 for layout checks.",
    },
    {
      name: "browser_wait_for",
      risk: "read",
      description: "Wait for text to appear/disappear or for a number of seconds. Args: {\"text\"?: string, \"textGone\"?: string, \"time\"?: number}. Use a short time after navigating so the first frame exists.",
    },
    {
      name: "browser_navigate_back",
      risk: "read",
      description: "Go back in the page history. No arguments.",
    },
    {
      name: "browser_close",
      risk: "read",
      description: "Close the page. No arguments. The server also closes the browser when the step ends.",
    },
  ];
}

/**
 * A standing policy for the local preview server. It is deliberately narrow:
 * one host, read access, and only while the owner keeps this policy. The
 * browser is still a local observation tool; it cannot reach a remote host
 * through the declared URL surface.
 *
 * 本地预览服务器的常设策略。刻意很窄：一个主机、只读，且只在所有者保留此策略时有效。
 * 浏览器仍是本地观察工具；通过声明的 URL 面够不到远程主机。
 */
export function browserMcpPolicy(now = new Date()): StandingPolicy {
  return {
    id: BROWSER_MCP_POLICY_ID,
    label: "Browser MCP: local preview observation",
    scopes: [{ domain: "network", resource: "127.0.0.1", access: "read" }],
    maxAutonomy: "act_auto",
    createdAt: now.toISOString(),
  };
}

/** Merge a server into an mcp.json document without dropping other servers. 合并服务器，不丢其他服务器。 */
export function mergeMcpConfig(existing: unknown, server: McpServerConfig): { servers: McpServerConfig[] } {
  const source = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as { servers?: unknown })
    : {};
  const list = Array.isArray(source.servers)
    ? source.servers.filter((entry): entry is McpServerConfig => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")
    : [];
  const next = list.filter((entry) => entry.id !== server.id);
  next.push(server);
  return { servers: next };
}

/** Merge the local policy into an authority document; idempotent by policy id. 合并策略；按 id 幂等。 */
export function mergeAuthority(existing: unknown, policy: StandingPolicy): AuthorityConfig {
  const source = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Partial<AuthorityConfig>)
    : {};
  const policies = Array.isArray(source.policies)
    ? source.policies.filter((entry): entry is StandingPolicy => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")
    : [];
  const kept = policies.filter((entry) => entry.id !== policy.id);
  kept.push(policy);
  return {
    version: 1,
    domains: { ...(source.domains ?? {}) },
    policies: kept,
  };
}

/** The one paragraph a workspace can carry so a user prompt stays short. 工作区里的一段说明，让用户提示词保持简短。 */
export function browserMcpInstructions(port = BROWSER_MCP_DEFAULT_PORT): string {
  return [
    "## Local browser verification",
    "",
    `A read-only static server serves this workspace at http://127.0.0.1:${port}/.`,
    "The `playwright.*` tools are available to workers: `browser_navigate` opens that URL,",
    "`browser_console_messages` returns errors, `browser_evaluate` reads game/DOM state, and",
    "`browser_take_screenshot` returns the PNG **as an image you can see**. After writing or editing",
    "a page, navigate once, check console errors, then take a screenshot and look at it — check",
    "composition, detail, shadow and colour, fix what looks wrong, and repeat until it looks good.",
    "Do not navigate to other hosts.",
  ].join("\n");
}

/** Only the runs that are allowed to use the preview: the local host and port. 仅允许本地预览的 URL。 */
export function isLocalPreviewUrl(url: string, port = BROWSER_MCP_DEFAULT_PORT): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === String(port);
  } catch {
    return false;
  }
}
