import type { Tool, ToolCall, ToolInput, ToolOutput } from "./tool.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(): string[] {
  return Array.from(registry.keys());
}

export async function executeTool(
  name: string,
  input: ToolInput
): Promise<ToolCall> {
  const tool = registry.get(name);
  const start = Date.now();

  if (!tool) {
    const latencyMs = Date.now() - start;
    const output: ToolOutput = { success: false, error: `Tool "${name}" not found` };
    return { toolName: name, input, output, latencyMs, error: output.error };
  }

  try {
    const output = await tool.execute(input);
    const latencyMs = Date.now() - start;
    return { toolName: name, input, output, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    const output: ToolOutput = { success: false, error };
    return { toolName: name, input, output, latencyMs, error };
  }
}
