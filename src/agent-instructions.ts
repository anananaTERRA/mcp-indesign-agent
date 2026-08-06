/**
 * MCP server instructions — shown to the client/agent on connect.
 * Keep short; push scan → analyze → batch → summarize.
 */
export const AGENT_INSTRUCTIONS = `You are editing Adobe InDesign via this MCP.

Preferred flow (minimize round-trips):
1. ping_indesign — confirm app + active document
2. scan_document — build Document Model cache + snapshot before (once per session)
3. analyze_page — assign roles (Header, Body, Image…) when the user talks about titles/headers
4. preview_batch (optional) or layout_assistant mode=preview
5. execute_batch — preferred mutation path (one dispatcher round-trip)
6. summarize_changes — diff before/after snapshots

Rules:
- Prefer execute_batch over execute_operation / layout_operation for multi-step edits.
- Targets: uuid string | {uuid} | {role, pageIndex?} | {selection:true}. Never use pageIndex:itemIndex as identity.
- Geometry is in points (pt), not EMU/px.
- After manual edits in InDesign, call refresh_document.
- For overlaps/tight gaps: layout_assistant diagnose → preview → fix.
- Styles/assets: list_* from cache; mutations via tools or batch ops (applyStyle, relinkAsset, …).
- Do not invent new MCP tools. New capabilities belong as dispatcher ops + batch commands (ceiling ~25 registered tools).`;
