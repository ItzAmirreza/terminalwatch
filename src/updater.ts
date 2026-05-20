// Self-update: check npm for a newer version of `terminalwatch`, and
// expose a one-call upgrade path.
//
// We don't want every twatch startup to hit npm — the result is cached
// to ~/.cache/twatch/update-check.json for 6 hours. If the cache is
// fresh we read it; otherwise we refetch in the background and update
// the cache.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "terminalwatch";

const CACHE_DIR = join(homedir(), ".cache", "twatch");
const CACHE_FILE = join(CACHE_DIR, "update-check.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type Cached = { fetchedAt: number; latest: string };

export type UpdateState = {
  installed: string;
  latest: string | null;
  hasUpdate: boolean;
};

let cachedInstalled: string | null = null;
export function getInstalledVersion(): string {
  if (cachedInstalled) return cachedInstalled;
  // package.json sits two levels above this file (src/updater.ts → root).
  // Resolve via import.meta.url so it works whether twatch was run from
  // source, a npm global install, or a copied-out tarball.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j?.name === PACKAGE_NAME && typeof j?.version === "string") {
        cachedInstalled = j.version;
        return j.version;
      }
    } catch {}
  }
  cachedInstalled = "0.0.0";
  return cachedInstalled;
}

export function readCached(): Cached | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (typeof j?.fetchedAt === "number" && typeof j?.latest === "string") return j;
  } catch {}
  return null;
}

function writeCached(c: Cached) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = CACHE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, CACHE_FILE);
}

export async function fetchLatest(): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (typeof j?.version === "string") return j.version;
  } catch {}
  return null;
}

// Returns the latest version, hitting cache if fresh; refetches lazily.
// The callback fires when a refresh completes with a newer value than
// what we initially returned synchronously.
export function checkForUpdate(
  onLater?: (state: UpdateState) => void,
): UpdateState {
  const installed = getInstalledVersion();
  const cached = readCached();
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  const initialLatest = fresh ? cached.latest : null;
  const initial: UpdateState = {
    installed,
    latest: initialLatest,
    hasUpdate: initialLatest ? isNewer(initialLatest, installed) : false,
  };
  if (!fresh) {
    void (async () => {
      const latest = await fetchLatest();
      if (!latest) return;
      writeCached({ fetchedAt: Date.now(), latest });
      const state: UpdateState = {
        installed,
        latest,
        hasUpdate: isNewer(latest, installed),
      };
      if (onLater && (state.latest !== initial.latest || state.hasUpdate !== initial.hasUpdate)) {
        onLater(state);
      }
    })();
  }
  return initial;
}

// Tiny semver-ish "is a strictly newer than b". Accepts plain X.Y.Z (no
// pre-release suffix) which is what we publish.
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

// Run `bun add -g <package>@latest` in the foreground, returning the
// exit code. Falls back to `npm i -g` if bun isn't on PATH.
export function runSelfUpdate(): { status: number; stdout: string; stderr: string } {
  const hasBun = !!spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim()
    || existsSync(join(homedir(), ".bun", "bin", "bun"));
  if (hasBun) {
    const r = spawnSync(
      spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim() || join(homedir(), ".bun/bin/bun"),
      ["add", "-g", `${PACKAGE_NAME}@latest`],
      { encoding: "utf8", stdio: "pipe" },
    );
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  const r = spawnSync("npm", ["i", "-g", `${PACKAGE_NAME}@latest`], { encoding: "utf8", stdio: "pipe" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
