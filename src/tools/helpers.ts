import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CheckpointRequiredError } from "../commands/checkpoint.js";
import { checkpointStore } from "../session/checkpoints.js";

/** Refusal body for a mutation with no way back — see commands/checkpoint.ts. */
export function checkpointRefusalPayload(err: CheckpointRequiredError) {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    generation: err.generation,
    remedy: err.remedy,
    recentCheckpoints: checkpointStore.list(5),
  };
}

export function textResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function withToolError<T extends unknown[]>(
  fn: (...args: T) => Promise<CallToolResult>,
): (...args: T) => Promise<CallToolResult> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
