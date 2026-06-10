// ─────────────────────────────────────────────────────────────────────────────
// Tool Types
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolInput = Record<string, any>;

export interface ToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface Tool<TInput = ToolInput, TData = unknown> {
  name: string;
  description: string;
  execute(input: TInput): Promise<ToolOutput & { data?: TData }>;
}

export interface ToolCall {
  toolName: string;
  input: ToolInput;
  output: ToolOutput;
  latencyMs: number;
  error?: string;
}
