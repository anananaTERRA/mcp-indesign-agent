import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlannerError } from "../commands/index.js";
import {
  analyzePage,
  applyRolesToModel,
  SEMANTIC_ROLES,
} from "../session/semantic.js";
import { sessionStore } from "../session/index.js";
import { textResult, withToolError } from "./helpers.js";

export function registerSemanticTools(server: McpServer): void {
  server.tool(
    "analyze_page",
    "Classify page items into semantic roles (Header, Subtitle, Body, Caption, Image, Background, Logo, Decorative, Unknown) and store roles on the Document Model. Prefer this after scan_document so targets like {role:\"Header\"} work in execute_batch.",
    {
      pageIndex: z
        .number()
        .int()
        .min(0)
        .describe("0-based page index to analyze"),
      persist: z
        .boolean()
        .optional()
        .describe("Write roles into session cache (default true)"),
    },
    withToolError(async ({ pageIndex, persist }) => {
      const model = sessionStore.get();
      if (!model) {
        throw new PlannerError(
          "No Document Model in cache. Call scan_document before analyze_page.",
        );
      }
      if (pageIndex >= model.meta.pageCount) {
        throw new PlannerError(
          `pageIndex ${pageIndex} out of range (document has ${model.meta.pageCount} page(s))`,
        );
      }

      const result = analyzePage(model, pageIndex);
      if (persist !== false) {
        sessionStore.set(applyRolesToModel(model, result.assignments));
      }

      return textResult({
        ok: true,
        roles: SEMANTIC_ROLES,
        ...result,
        persisted: persist !== false,
        hint: "Targets may now use { role: \"Header\", pageIndex }. Typical flow: analyze_page → preview_batch/execute_batch → summarize_changes.",
      });
    }),
  );
}
