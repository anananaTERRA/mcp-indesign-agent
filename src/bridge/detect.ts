import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "./types.js";

const execFileAsync = promisify(execFile);

const APPLICATIONS_DIR = "/Applications";

/**
 * Discover installed Adobe InDesign apps under /Applications.
 * Bundles live at: /Applications/Adobe InDesign YYYY/Adobe InDesign YYYY.app
 */
export function listInstalledIndesignApps(): string[] {
  if (!existsSync(APPLICATIONS_DIR)) {
    return [];
  }

  const entries = readdirSync(APPLICATIONS_DIR, { withFileTypes: true });
  const names: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^Adobe InDesign \d{4}/i.test(entry.name)) continue;

    const appBundle = join(
      APPLICATIONS_DIR,
      entry.name,
      `${entry.name}.app`,
    );
    if (existsSync(appBundle)) {
      names.push(entry.name);
    }
  }

  return names.sort((a, b) => {
    const yearA = Number(a.match(/(\d{4})/)?.[1] ?? 0);
    const yearB = Number(b.match(/(\d{4})/)?.[1] ?? 0);
    return yearB - yearA;
  });
}

export function resolveIndesignAppName(
  explicit?: string | null,
): { appName: string; candidates: string[] } {
  const candidates = listInstalledIndesignApps();
  const fromEnv = (explicit ?? process.env.INDESIGN_APP_NAME)?.trim();

  if (fromEnv) {
    if (candidates.length > 0 && !candidates.includes(fromEnv)) {
      // Still allow override (renamed installs / future versions).
      return { appName: fromEnv, candidates };
    }
    return { appName: fromEnv, candidates };
  }

  if (candidates.length === 0) {
    throw new BridgeError(
      "APP_NOT_FOUND",
      "No Adobe InDesign installation found under /Applications. Set INDESIGN_APP_NAME manually.",
    );
  }

  return { appName: candidates[0]!, candidates };
}

export async function isIndesignRunning(appName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-fl", appName], {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch (err: unknown) {
    // pgrep exits 1 when no matches.
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: number | string }).code
        : undefined;
    if (code === 1) return false;
    // Fallback: try shorter pattern
    try {
      const { stdout } = await execFileAsync("pgrep", ["-fl", "InDesign"], {
        timeout: 5000,
      });
      return stdout.toLowerCase().includes("indesign");
    } catch {
      return false;
    }
  }
}

export function getScriptTimeoutSec(): number {
  const raw = process.env.INDESIGN_SCRIPT_TIMEOUT_SEC;
  if (!raw) return 300;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

export function getTempDir(): string {
  return (
    process.env.INDESIGN_TEMP_DIR?.trim() ||
    join(process.env.TMPDIR || "/tmp", "mcp-indesign-agent")
  );
}
