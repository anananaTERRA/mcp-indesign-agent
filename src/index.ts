#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerSessionTools } from "./tools/session.js";

const server = new McpServer({
  name: "mcp-indesign-agent",
  version: "0.0.1",
});

registerSessionTools(server);
registerBatchTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
