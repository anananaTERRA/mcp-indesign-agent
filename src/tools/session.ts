import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, withToolError } from "./helpers.js";

/**
 * Phase 0 stub — real ping via BridgeAdapter lands in Phase 1.
 */
export function registerSessionTools(server: McpServer): void {
  server.tool(
    "ping_indesign",
    "Check if Adobe InDesign is reachable (app open, version, active document). Phase 0 returns a stub until the bridge is wired.",
    {
      timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Optional timeout in seconds (ignored by stub)"),
    },
    withToolError(async () => {
      return textResult({
        ok: false,
        stub: true,
        phase: 0,
        message:
          "Bridge not implemented yet. Phase 1 wires AppleScriptExtendScriptAdapter + dispatcher.jsx.",
        hint: "Run `npm run doctor` after Phase 1 for a real round-trip.",
        env: {
          INDESIGN_APP_NAME: process.env.INDESIGN_APP_NAME ?? null,
          INDESIGN_BRIDGE: process.env.INDESIGN_BRIDGE ?? "applescript",
        },
      });
    }),
  );
}
