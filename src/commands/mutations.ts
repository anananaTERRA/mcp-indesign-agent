/**
 * Which dispatcher ops write to the document.
 *
 * Single source of truth for the two things that must agree: what needs an
 * undo transaction, and what needs a checkpoint before it runs.
 */

export const MUTATING_DISPATCHER_OPS: ReadonlySet<string> = new Set([
  "moveItem",
  "resizeItem",
  "deleteItem",
  "duplicateItem",
  "createTextFrame",
  "setText",
  "replaceText",
  "setFont",
  "setFill",
  "alignItems",
  "distributeItems",
  "centerItems",
  "stackItems",
  "applyMargins",
  "applyStyle",
  "createStyle",
  "updateStyle",
  "relinkAsset",
  "replaceAsset",
  "embedAsset",
]);

export function isMutatingOp(op: string): boolean {
  return MUTATING_DISPATCHER_OPS.has(op);
}

export function mutatingOpsIn(commands: Array<{ op: string }>): string[] {
  const seen: string[] = [];
  for (const cmd of commands) {
    if (isMutatingOp(cmd.op) && !seen.includes(cmd.op)) seen.push(cmd.op);
  }
  return seen;
}
