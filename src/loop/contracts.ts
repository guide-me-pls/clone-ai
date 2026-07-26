export type JsonObject = Record<string, unknown>;

export interface ToolSchema {
  type: "function";
  name: string;
  description: string;
  parameters: JsonObject;
  strict: true;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export type LoopMessage =
  | { role: "user"; content: string }
  | { role: "tool"; callId: string; toolName: string; result: ToolResult };

export type ModelTurn =
  | { kind: "tool_calls"; calls: ToolCall[] }
  | { kind: "final"; text: string };

export interface LoopModel {
  respond(input: { instructions: string; messages: LoopMessage[]; tools: ToolSchema[] }): Promise<ModelTurn>;
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute(arguments_: JsonObject): Promise<ToolResult>;
}

export type LoopEventType =
  | "run.started"
  | "context.built"
  | "model.started"
  | "model.completed"
  | "tool.requested"
  | "tool.completed"
  | "verification.completed"
  | "run.completed"
  | "run.failed";

export interface LoopEvent {
  id: string;
  sequence: number;
  runId: string;
  type: LoopEventType;
  occurredAt: string;
  payload: unknown;
}

export interface NewLoopEvent {
  runId: string;
  type: LoopEventType;
  payload: unknown;
}

export interface LoopJournal {
  append(event: NewLoopEvent): Promise<LoopEvent>;
  list(runId?: string): Promise<LoopEvent[]>;
}

/** The next recoverable action for a durable single-agent run. */
export type LoopRunStatus =
  | "created"
  | "waiting_model"
  | "running_model"
  | "waiting_tools"
  | "running_tool"
  | "verifying"
  | "completed"
  | "failed";

export interface LoopRunState {
  runId: string;
  status: LoopRunStatus;
  goal?: string;
  instructions?: string;
  turn: number;
  messages: LoopMessage[];
  pendingToolCalls: ToolCall[];
  activeToolCallId?: string;
  budget: {
    modelCalls: number;
    toolCalls: number;
  };
  verification?: { passed: boolean; summary: string };
  finalAnswer?: string;
  failureReason?: string;
  lastAppliedSequence: number;
  updatedAt?: string;
}

/** A materialized view used to start recovery without replaying an entire journal. */
export interface LoopCheckpointStore {
  save(state: LoopRunState): Promise<void>;
  load(runId: string): Promise<LoopRunState | undefined>;
}

export interface ResponseVerifier {
  verify(input: { goal: string; answer: string }): Promise<{ passed: boolean; summary: string }>;
}
