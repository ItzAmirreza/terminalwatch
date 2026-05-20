// Read the tail of a user's shell history so the operator has context
// for what the target was doing before the watch attached.
//
// Limitation worth knowing: bash only writes ~/.bash_history when the
// shell exits (unless histappend + PROMPT_COMMAND history -a is set), so
// what we surface here is "previously-finished sessions", not necessarily
// "what they typed in the current attached session". That's still useful
// signal — full in-memory history would require reading the bash process
// memory, which we'd rather avoid for v1.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export function fetchHistory(targetUser: string, lines: number, currentUser: string): {
  source: string;
  entries: string[];
} {
  // Prefer reading directly when running as the same UID; otherwise sudo.
  const histPath = `/home/${targetUser}/.bash_history`;
  let result: SpawnSyncReturns<string>;
  if (targetUser === currentUser) {
    result = spawnSync("tail", ["-n", String(lines), histPath], { encoding: "utf8" });
  } else {
    result = spawnSync("sudo", ["-n", "tail", "-n", String(lines), histPath], { encoding: "utf8" });
  }
  if (result.status !== 0) {
    return { source: histPath, entries: [] };
  }
  const entries = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
  return { source: histPath, entries };
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
    lines.push(`${dim}│${reset} ${dim}(no readable bash history)${reset}`);
  } else {
    lines.push(`${dim}│${reset} recent commands (from ~/.bash_history):`);
    for (const cmd of args.history.entries) {
      lines.push(`${dim}│${reset}   ${dim}$${reset} ${cmd}`);
    }
  }
  lines.push(`${bold}${cyan}└────────────────────────────────────────────${reset}`);
  return lines.map((l) => l + "\r\n").join("");
}
