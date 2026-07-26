import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { JsonObject, ToolCall, ToolDefinition, ToolResult, ToolSchema } from "./contracts.ts";

const MAX_LISTED_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "target", ".clone-ai"]);

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.schema.name)) {
        throw new Error(`Duplicate tool name: ${tool.schema.name}`);
      }
      this.#tools.set(tool.schema.name, tool);
    }
  }

  schemas(): ToolSchema[] {
    return [...this.#tools.values()].map((tool) => tool.schema);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return { ok: false, content: `Unknown tool: ${call.name}` };
    }

    try {
      return await tool.execute(call.arguments);
    } catch (error: unknown) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function createWorkspaceTools(workspaceRoot: string): ToolDefinition[] {
  const resolveWorkspacePath = (input: unknown): string => {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new Error("path must be a non-empty string");
    }
    const candidate = resolve(workspaceRoot, input);
    const pathFromRoot = relative(workspaceRoot, candidate);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error("path must stay inside the configured workspace");
    }
    return candidate;
  };

  return [
    {
      schema: {
        type: "function",
        name: "list_files",
        description: "List files under a path in the local workspace. Use this to discover relevant files before reading them.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory. Defaults to the workspace root." },
            recursive: { type: "boolean", description: "Whether to include nested files. Defaults to false." },
          },
          additionalProperties: false,
        },
        strict: true,
      },
      async execute(arguments_: JsonObject): Promise<ToolResult> {
        const inputPath = arguments_.path ?? ".";
        const recursive = arguments_.recursive ?? false;
        if (typeof recursive !== "boolean") {
          throw new Error("recursive must be a boolean when provided");
        }
        const directory = resolveWorkspacePath(inputPath);
        const entries: string[] = [];

        const visit = async (current: string): Promise<void> => {
          const children = await readdir(current, { withFileTypes: true });
          for (const child of children) {
            if (entries.length >= MAX_LISTED_FILES) {
              return;
            }
            if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) {
              continue;
            }
            const childPath = resolve(current, child.name);
            const displayPath = relative(workspaceRoot, childPath).replaceAll("\\", "/");
            if (child.isDirectory()) {
              entries.push(`${displayPath}/`);
              if (recursive) {
                await visit(childPath);
              }
            } else {
              entries.push(displayPath);
            }
          }
        };

        await visit(directory);
        const suffix = entries.length === MAX_LISTED_FILES ? `\n(truncated at ${MAX_LISTED_FILES} entries)` : "";
        return {
          ok: true,
          content: entries.length === 0 ? "No files found." : `${entries.join("\n")}${suffix}`,
          data: { entries, truncated: entries.length === MAX_LISTED_FILES },
        };
      },
    },
    {
      schema: {
        type: "function",
        name: "read_file",
        description: "Read a UTF-8 text file inside the local workspace. Use list_files first when the path is unknown.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative file path." } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: true,
      },
      async execute(arguments_: JsonObject): Promise<ToolResult> {
        const path = resolveWorkspacePath(arguments_.path);
        const bytes = await readFile(path);
        const truncated = bytes.byteLength > MAX_FILE_BYTES;
        const content = bytes.subarray(0, MAX_FILE_BYTES).toString("utf8");
        return {
          ok: true,
          content: truncated ? `${content}\n\n[File truncated at ${MAX_FILE_BYTES} bytes]` : content,
          data: { path: relative(workspaceRoot, path).replaceAll("\\", "/"), truncated },
        };
      },
    },
    {
      schema: {
        type: "function",
        name: "write_file",
        description: "Propose writing a text file. This learning-loop version is intentionally mocked and never changes the filesystem.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative destination path." },
            content: { type: "string", description: "Proposed UTF-8 content." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        strict: true,
      },
      async execute(arguments_: JsonObject): Promise<ToolResult> {
        const path = resolveWorkspacePath(arguments_.path);
        if (typeof arguments_.content !== "string") {
          throw new Error("content must be a string");
        }
        return {
          ok: true,
          content: `Mock write accepted for ${relative(workspaceRoot, path).replaceAll("\\", "/")}; no file was changed.`,
          data: { mocked: true, path: relative(workspaceRoot, path).replaceAll("\\", "/") },
        };
      },
    },
  ];
}
