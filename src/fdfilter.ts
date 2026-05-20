// Resolves /proc/PID/fd/N → device path, so we can decide whether a given
// write() captured by strace actually lands on the user's terminal (the
// target pts) or on a pipe between cooperating child processes.
//
// Two cases to keep:
//   1. /proc/PID/fd/N → /dev/pts/X  AND /dev/pts/X == target pts
//   2. /proc/PID/fd/N → /dev/tty    AND the writing process's controlling
//      tty is the target pts. This case matters because Ubuntu's sudo
//      default `use_pty` makes sudo allocate a fresh pty for the child:
//      the child writes to that inner pty, and sudo's I/O monitor reads
//      it back and writes the bytes to /dev/tty (which for the monitor
//      resolves to the user's actual /dev/pts/X). Without this branch we
//      lose all output from any `sudo …` command.
//
// Everything else (pipes, /dev/null, files, sockets, /dev/pts/<other>) is
// dropped — those are intra-process IPC noise that the user can't see.

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export class FdResolver {
  private fdCache = new Map<string, boolean>();
  private cttyCache = new Map<number, string | null>();
  private readonly targetPath: string;
  private readonly useSudo: boolean;

  constructor(targetPts: string, useSudo: boolean) {
    this.targetPath = targetPts; // e.g. "/dev/pts/0"
    this.useSudo = useSudo;
  }

  isTargetTty(pid: number, fd: number): boolean {
    const key = `${pid}:${fd}`;
    const cached = this.fdCache.get(key);
    if (cached !== undefined) return cached;
    const link = this.readlink(pid, fd);
    let resolved = false;
    if (link === this.targetPath) {
      resolved = true;
    } else if (link === "/dev/tty") {
      // /dev/tty is the symbolic ctty — what it actually opens depends on
      // the writing process's controlling terminal. Look it up.
      resolved = this.controllingTty(pid) === this.targetPath;
    }
    this.fdCache.set(key, resolved);
    return resolved;
  }

  private readlink(pid: number, fd: number): string | null {
    const procPath = `/proc/${pid}/fd/${fd}`;
    try {
      return readlinkSync(procPath);
    } catch (e: any) {
      if (!this.useSudo) return null;
      if (e?.code === "ENOENT") return null;
    }
    const r = spawnSync("sudo", ["-n", "readlink", procPath], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out || null;
  }

  // Return the writing process's controlling terminal as a path like
  // "/dev/pts/0", or null if unknown.
  private controllingTty(pid: number): string | null {
    const cached = this.cttyCache.get(pid);
    if (cached !== undefined) return cached;
    const path = this.readProcStatCtty(pid);
    this.cttyCache.set(pid, path);
    return path;
  }

  private readProcStatCtty(pid: number): string | null {
    let stat: string | null = null;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (e: any) {
      if (!this.useSudo || e?.code === "ENOENT") return null;
      const r = spawnSync("sudo", ["-n", "cat", `/proc/${pid}/stat`], { encoding: "utf8" });
      if (r.status === 0) stat = r.stdout;
    }
    if (!stat) return null;
    // Field 7 (1-indexed) of /proc/PID/stat is tty_nr, encoded as a dev_t
    // (Linux: high 12 bits major, then 8 bits minor-low, then 12 bits
    // minor-high, then 8 bits minor-low). We decode and synthesize the
    // expected pts device path.
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return null;
    const tail = stat.slice(rp + 2).split(" ");
    // After the comm, tail[0]=state, tail[1]=ppid, tail[2]=pgrp,
    // tail[3]=session, tail[4]=tty_nr.
    const ttyNr = parseInt(tail[4] ?? "0", 10);
    if (!ttyNr) return null;
    const major = (ttyNr >> 8) & 0xfff;
    const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
    // UNIX98 pts slaves use major 136..143 (the kernel allocates more as
    // needed for additional pts masters). For now we treat any of those
    // as "/dev/pts/<minor>" since the userspace path is consistent.
    if (major >= 136 && major <= 143) {
      return `/dev/pts/${minor}`;
    }
    // Legacy ttyS / tty consoles — not relevant for SSH sessions but
    // returned for completeness.
    if (major === 4) return `/dev/tty${minor}`;
    return null;
  }
}
