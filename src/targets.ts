// Target discovery — what shows up in the picker screen.
//
// Two sources merged at runtime:
//   1. ~/.ssh/config  — Host entries we can parse out (concrete aliases
//      only; wildcards and glob patterns are skipped).
//   2. ~/.config/twatch/targets.json  — entries explicitly added through
//      twatch (or hand-edited). One per object: {name, user, host,
//      port?, identityFile?}.
//
// "Local" (the box twatch itself runs on) is always prepended as the
// first option in the picker UI.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Target = {
  kind: "local" | "ssh";
  // Stable id used by the UI state machine. For local: "local". For ssh:
  // the canonical "user@host[:port]" string, or the alias when sourced
  // from ssh config.
  id: string;
  // Display label.
  label: string;
  // Where it came from — drives the right-hand-side hint in the UI.
  source: "builtin" | "ssh-config" | "saved";

  // For kind=="ssh":
  user?: string;
  host?: string;
  port?: number;
  identityFile?: string;
  // The actual ssh destination as we'd pass it to `ssh`. For aliased
  // entries from ~/.ssh/config this is the alias itself (so ssh applies
  // the full stanza). For ad-hoc entries it's "user@host".
  sshTarget?: string;
};

export const LOCAL_TARGET: Target = {
  kind: "local",
  id: "local",
  label: "this box",
  source: "builtin",
};

const STORE_DIR = join(homedir(), ".config", "twatch");
const STORE_FILE = join(STORE_DIR, "targets.json");
const SSH_CONFIG = join(homedir(), ".ssh", "config");

export function listTargets(): Target[] {
  const out: Target[] = [];
  // "Local" only makes sense on Linux — elsewhere it's a guaranteed
  // dead-end (no /proc, no strace), so hide it instead of letting the
  // user pick it and bounce off a "Linux-only" error at the watch step.
  if (platform() === "linux") out.push(LOCAL_TARGET);
  out.push(...readSshConfig());
  out.push(...readStore());
  return out;
}

// Convert a Target into the (target, extraArgs) pair the SshTransport
// wants. Returns null for kind="local".
export function targetToSsh(t: Target): { target: string; extraArgs: string[] } | null {
  if (t.kind !== "ssh") return null;
  const extra: string[] = [];
  if (t.port) extra.push("-p", String(t.port));
  if (t.identityFile) extra.push("-i", expandHome(t.identityFile));
  return { target: t.sshTarget ?? `${t.user}@${t.host}`, extraArgs: extra };
}

// ─── ~/.ssh/config ─────────────────────────────────────────────────────

function readSshConfig(): Target[] {
  if (!existsSync(SSH_CONFIG)) return [];
  let body: string;
  try {
    body = readFileSync(SSH_CONFIG, "utf8");
  } catch {
    return [];
  }
  const stanzas: Array<{ aliases: string[]; opts: Record<string, string> }> = [];
  let cur: { aliases: string[]; opts: Record<string, string> } | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    // Allow `Key = Value` and `Key Value`. Strip an optional `=`.
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "host") {
      if (cur) stanzas.push(cur);
      cur = { aliases: value.split(/\s+/).filter(Boolean), opts: {} };
    } else if (cur) {
      cur.opts[key] = value;
    }
  }
  if (cur) stanzas.push(cur);

  const targets: Target[] = [];
  for (const s of stanzas) {
    for (const alias of s.aliases) {
      // Skip wildcards / negations / glob entries — they're defaults,
      // not pickable destinations.
      if (/[*?!]/.test(alias)) continue;
      const hostname = s.opts["hostname"];
      const port = s.opts["port"] ? parseInt(s.opts["port"], 10) : undefined;
      const user = s.opts["user"];
      const identityFile = s.opts["identityfile"];
      const labelParts: string[] = [alias];
      if (user) labelParts.push(`(${user}${hostname ? `@${hostname}` : ""})`);
      else if (hostname) labelParts.push(`(${hostname})`);
      targets.push({
        kind: "ssh",
        id: `ssh:${alias}`,
        label: labelParts.join(" "),
        source: "ssh-config",
        user,
        host: hostname ?? alias,
        port: Number.isFinite(port) ? port : undefined,
        identityFile,
        sshTarget: alias, // hand the alias to ssh so its config rules apply
      });
    }
  }
  return targets;
}

// ─── ~/.config/twatch/targets.json ─────────────────────────────────────

type StoreEntry = {
  name: string;
  user: string;
  host: string;
  port?: number;
  identityFile?: string;
};

function readStore(): Target[] {
  if (!existsSync(STORE_FILE)) return [];
  let entries: StoreEntry[] = [];
  try {
    const j = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    if (Array.isArray(j)) entries = j as StoreEntry[];
  } catch {
    return [];
  }
  return entries
    .filter((e) => e && e.user && e.host)
    .map((e): Target => ({
      kind: "ssh",
      id: `saved:${e.name || `${e.user}@${e.host}`}`,
      label: e.name
        ? `${e.name} (${e.user}@${e.host}${e.port ? `:${e.port}` : ""})`
        : `${e.user}@${e.host}${e.port ? `:${e.port}` : ""}`,
      source: "saved",
      user: e.user,
      host: e.host,
      port: e.port,
      identityFile: e.identityFile,
      sshTarget: `${e.user}@${e.host}`,
    }));
}

export function saveTarget(entry: StoreEntry): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  const existing: StoreEntry[] = existsSync(STORE_FILE)
    ? (() => {
        try {
          const j = JSON.parse(readFileSync(STORE_FILE, "utf8"));
          return Array.isArray(j) ? j : [];
        } catch {
          return [];
        }
      })()
    : [];
  // dedupe by name (or user@host if no name) — newest wins
  const key = (e: StoreEntry) => e.name || `${e.user}@${e.host}`;
  const next = existing.filter((e) => key(e) !== key(entry));
  next.push(entry);
  const tmp = STORE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, STORE_FILE);
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

export const STORE_PATH = STORE_FILE;
export const SSH_CONFIG_PATH = SSH_CONFIG;
