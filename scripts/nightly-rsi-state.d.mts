export interface ConsumedTrace {
  runId: string;
  sha256: string;
  consumedAt: string;
  branch: string;
  prUrl?: string;
}
export interface ConsumedState {
  version: number;
  traces: Record<string, ConsumedTrace>;
}
export interface TraceFingerprint { runId: string; sha256: string }
export interface RepairOutcome { status: string; branch: string; prUrl?: string }
export function stateFilePath(reportDir: string): string;
export function fingerprint(content: string | Buffer): string;
export function loadState(reportDir: string): Promise<ConsumedState>;
export function isConsumed(state: ConsumedState, runId: string, sha256: string): boolean;
export function markConsumed(state: ConsumedState, entry: TraceFingerprint & { branch: string; prUrl?: string }, now?: Date): ConsumedState;
export function recordOutcome(state: ConsumedState, traces: TraceFingerprint[], report: RepairOutcome, now?: Date): ConsumedState;
export function saveState(reportDir: string, state: ConsumedState): Promise<void>;
