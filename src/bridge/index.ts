import { AppleScriptExtendScriptAdapter } from "./applescript-adapter.js";
import { BridgeError, type BridgeAdapter } from "./types.js";

export type {
  BridgeAdapter,
  BridgeErrorCode,
  DispatcherCommand,
  DispatcherPayload,
  DispatcherResult,
  ModelPatch,
  PingInfo,
} from "./types.js";
export { BridgeError } from "./types.js";
export { AppleScriptExtendScriptAdapter } from "./applescript-adapter.js";
export {
  listInstalledIndesignApps,
  resolveIndesignAppName,
  isIndesignRunning,
} from "./detect.js";

export function createBridge(): BridgeAdapter {
  const kind = (process.env.INDESIGN_BRIDGE ?? "applescript").trim().toLowerCase();

  switch (kind) {
    case "applescript":
      return new AppleScriptExtendScriptAdapter();
    case "uxp":
      throw new BridgeError(
        "CONFIG",
        "INDESIGN_BRIDGE=uxp is not implemented yet (planned for v0.2+).",
      );
    default:
      throw new BridgeError(
        "CONFIG",
        `Unknown INDESIGN_BRIDGE="${kind}". Supported: applescript`,
      );
  }
}
