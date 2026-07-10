// Read the tail of a user's shell history so the operator has context
// for what the target was doing before the watch attached.
//
// We resolve the target's real home directory and login shell from
// `getent passwd` rather than assuming /home/<user>, so it works for root
// (/root), users with non-standard homes, and zsh users (.zsh_history,
// including EXTENDED_HISTORY `: <ts>:<elapsed>;cmd` lines). fish stores
// history in its own YAML-ish format elsewhere and is not parsed here.
//
// Limitation worth knowing: bash only writes ~/.bash_history when the
// shell exits (unless histappend + PROMPT_COMMAND history -a is set), so
// what we surface here is "previously-finished sessions", not necessarily
// "what they typed in the current attached session". That's still useful
// signal — full in-memory history would require reading the bash process
// memory, which we'd rather avoid for v1.

import type { Transport } from "./transport.ts";

export function fetchHistory(
  transport: Transport,
  targetUser: string,
  lines: number,
  currentUser: string,
): { source: string; entries: string[] } {
  const { home, shell } = resolveUserInfo(transport, targetUser);
  const needSudo = targetUser !== currentUser;
  const candidates = historyCandidates(home, shell);

  for (const path of candidates) {
    const argv = needSudo
      ? ["sudo", "-n", "tail", "-n", String(lines), path]
      : ["tail", "-n", String(lines), path];
    const r = transport.execCapture(argv);
    if (r.status !== 0) continue;
    const entries = parseHistory(r.stdout);
    if (entries.length) return { source: path, entries };
  }
  // Nothing readable — report the first path we tried as the source.
  return { source: candidates[0] ?? `${home}/.bash_history`, entries: [] };
}

// Look up the target user's home directory and login shell. `getent passwd`
// is world-readable, so no sudo is needed here (reading the history file
// itself still is, when the target is another user).
function resolveUserInfo(
  transport: Transport,
  user: string,
): { home: string; shell: string } {
  const r = transport.execCapture(["getent", "passwd", user]);
  if (r.status === 0) {
    const line = r.stdout.split("\n").find((l) => l.trim().length > 0);
    if (line) {
      // name:passwd:uid:gid:gecos:home:shell
      const f = line.split(":");
      if (f.length >= 7 && f[5]) return { home: f[5]!, shell: f[6] ?? "" };
    }
  }
  // getent missing or user unknown — fall back to the conventional layout.
  return { home: user === "root" ? "/root" : `/home/${user}`, shell: "" };
}

// History files to try, in priority order, based on the login shell.
function historyCandidates(home: string, shell: string): string[] {
  const bash = `${home}/.bash_history`;
  const zsh = `${home}/.zsh_history`;
  const s = shell.toLowerCase();
  if (s.endsWith("zsh")) return [zsh, bash];
  // bash, sh, dash, or unknown — bash history is the common case.
  return [bash, zsh];
}

function parseHistory(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    // zsh EXTENDED_HISTORY lines look like ": 1699999999:0;the command".
    const zm = line.match(/^: \d+:\d+;(.*)$/);
    if (zm) line = zm[1]!.trim();
    // bash HISTTIMEFORMAT writes "#<epoch>" comment lines between commands.
    if (!line || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

// Render history as a small preamble block.
export function renderPreamble(args: {
  user: string;
  tty: string;
  from: string;
  geoLabel: string;
  loginAt: string;
  idle: string;
  foregroundComm: string | null;
  history: { entries: string[] };
}): string {
  const dim = "\x1b[90m";
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const lines: string[] = [];
  lines.push(`${bold}${cyan}┌─ session ──────────────────────────────────${reset}`);
  lines.push(
    `${dim}│${reset} ${args.user}@${args.tty}  from ${args.from}${
      args.geoLabel && args.geoLabel !== "local" ? ` (${args.geoLabel})` : ""
    }`,
  );
  lines.push(
    `${dim}│${reset} login ${args.loginAt}  ·  idle ${args.idle}  ·  doing ${args.foregroundComm ?? "?"}`,
  );
  if (args.history.entries.length === 0) {
    lines.push(`${dim}│${reset} ${dim}(no readable shell history)${reset}`);
  } else {
    lines.push(`${dim}│${reset} recent commands:`);
    for (const cmd of args.history.entries) {
      lines.push(`${dim}│${reset}   ${dim}$${reset} ${cmd}`);
    }
  }
  lines.push(`${bold}${cyan}└────────────────────────────────────────────${reset}`);
  return lines.map((l) => l + "\r\n").join("");
}
