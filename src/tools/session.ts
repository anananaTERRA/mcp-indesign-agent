import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
} from "../bridge/index.js";
import { textResult, withToolError } from "./helpers.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "ping_indesign",
    "Check if Adobe InDesign is reachable via the local bridge (app open, version, active document).",
    {
      timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("Optional override; prefer INDESIGN_SCRIPT_TIMEOUT_SEC for the adapter"),
    },
    withToolError(async ({ timeoutSec }) => {
      try {
        const bridge =
          timeoutSec !== undefined
            ? new AppleScriptExtendScriptAdapter({ timeoutSec })
            : createBridge();
        const info = await bridge.ping();
        return textResult({ ok: true, ...info });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
            details: err.details ?? null,
            env: {
              INDESIGN_APP_NAME: process.env.INDESIGN_APP_NAME ?? null,
              INDESIGN_BRIDGE: process.env.INDESIGN_BRIDGE ?? "applescript",
            },
          });
        }
        throw err;
      }
    }),
  );
}
