import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getScriptTimeoutSec,
  getTempDir,
  isIndesignRunning,
  resolveIndesignAppName,
} from "./detect.js";
import {
  BridgeError,
  type BridgeAdapter,
  type DispatcherPayload,
  type DispatcherResult,
  type PingInfo,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DISPATCHER = join(
  __dirname,
  "../../extendscript/dispatcher.jsx",
);

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildAppleScript(opts: {
  appName: string;
  timeoutSec: number;
  dispatcherPath: string;
  requestPath: string;
  responsePath: string;
}): string {
  const app = escapeAppleScriptString(opts.appName);
  const dispatcher = escapeAppleScriptString(opts.dispatcherPath);
  const request = escapeAppleScriptString(opts.requestPath);
  const response = escapeAppleScriptString(opts.responsePath);

  return `with timeout of ${opts.timeoutSec} seconds
  tell application "${app}"
    do script (POSIX file "${dispatcher}") language javascript with arguments {"${request}", "${response}"}
  end tell
end timeout
`;
}

function runOsascript(
  scriptPath: string,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new BridgeError(
          "TIMEOUT",
          `InDesign script timed out after ${timeoutSec}s. Increase INDESIGN_SCRIPT_TIMEOUT_SEC or check for modal dialogs.`,
        ),
      );
    }, timeoutSec * 1000 + 5000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new BridgeError("BRIDGE", `Failed to spawn osascript: ${err.message}`),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout || `osascript exited with code ${code}`).trim();
      reject(mapOsascriptError(detail));
    });
  });
}

function mapOsascriptError(detail: string): BridgeError {
  const lower = detail.toLowerCase();
  if (
    lower.includes("application isn't running") ||
    lower.includes("not running") ||
    lower.includes("connection is invalid") ||
    lower.includes("(-600)")
  ) {
    return new BridgeError(
      "APP_CLOSED",
      `InDesign does not appear to be running. Open the app (and a document if needed), then retry. Details: ${detail}`,
      detail,
    );
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new BridgeError("TIMEOUT", detail);
  }
  return new BridgeError("BRIDGE", `AppleScript/osascript failed: ${detail}`, detail);
}

export interface AppleScriptAdapterOptions {
  appName?: string;
  timeoutSec?: number;
  tempDir?: string;
  dispatcherPath?: string;
}

export class AppleScriptExtendScriptAdapter implements BridgeAdapter {
  readonly kind = "applescript" as const;
  readonly appName: string;
  readonly candidates: string[];
  private readonly timeoutSec: number;
  private readonly tempDir: string;
  private readonly dispatcherPath: string;

  constructor(options: AppleScriptAdapterOptions = {}) {
    const resolved = resolveIndesignAppName(options.appName);
    this.appName = resolved.appName;
    this.candidates = resolved.candidates;
    this.timeoutSec = options.timeoutSec ?? getScriptTimeoutSec();
    this.tempDir = options.tempDir ?? getTempDir();
    this.dispatcherPath = options.dispatcherPath ?? DEFAULT_DISPATCHER;
  }

  async ping(): Promise<PingInfo> {
    const result = await this.run({
      requestId: randomUUID(),
      commands: [{ op: "ping" }],
    });
    const first = result.results[0] as
      | {
          appName?: string;
          version?: string;
          locale?: string;
          document?: PingInfo["document"];
        }
      | undefined;

    if (!first?.version) {
      throw new BridgeError(
        "JSX_EXCEPTION",
        "ping succeeded but response was missing version info",
        result,
      );
    }

    return {
      appName: first.appName ?? this.appName,
      version: first.version,
      locale: first.locale,
      document: first.document ?? null,
      bridge: this.kind,
      indesignAppName: this.appName,
    };
  }

  async run(payload: DispatcherPayload): Promise<DispatcherResult> {
    await this.assertReady();

    const id = payload.requestId || randomUUID();
    const requestPath = join(this.tempDir, `${id}.request.json`);
    const responsePath = join(this.tempDir, `${id}.response.json`);
    const scriptPath = join(this.tempDir, `${id}.run.applescript`);

    await mkdir(this.tempDir, { recursive: true });

    try {
      await writeFile(
        requestPath,
        JSON.stringify({ ...payload, requestId: id }, null, 2),
        "utf8",
      );

      const appleScript = buildAppleScript({
        appName: this.appName,
        timeoutSec: this.timeoutSec,
        dispatcherPath: this.dispatcherPath,
        requestPath,
        responsePath,
      });
      await writeFile(scriptPath, appleScript, "utf8");

      await runOsascript(scriptPath, this.timeoutSec);

      let raw: string;
      try {
        raw = await readFile(responsePath, "utf8");
      } catch {
        throw new BridgeError(
          "JSX_EXCEPTION",
          "InDesign script finished but no response JSON was written. The dispatcher may have crashed before completing.",
        );
      }

      let parsed: DispatcherResult;
      try {
        parsed = JSON.parse(raw) as DispatcherResult;
      } catch (err) {
        throw new BridgeError(
          "JSX_EXCEPTION",
          `Invalid JSON from dispatcher: ${err instanceof Error ? err.message : String(err)}`,
          raw.slice(0, 500),
        );
      }

      if (!parsed.ok) {
        const message = parsed.error?.message ?? "Unknown ExtendScript error";
        if (message.startsWith("NO_DOCUMENT:")) {
          throw new BridgeError("NO_DOCUMENT", message, parsed);
        }
        throw new BridgeError("JSX_EXCEPTION", message, parsed);
      }

      return parsed;
    } finally {
      await Promise.allSettled([
        rm(requestPath, { force: true }),
        rm(responsePath, { force: true }),
        rm(scriptPath, { force: true }),
      ]);
    }
  }

  private async assertReady(): Promise<void> {
    const running = await isIndesignRunning(this.appName);
    if (!running) {
      throw new BridgeError(
        "APP_CLOSED",
        `Adobe InDesign is not running (expected process matching "${this.appName}"). Open InDesign first, then retry.`,
        { appName: this.appName, candidates: this.candidates },
      );
    }
  }
}
