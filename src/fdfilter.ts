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
//      resolves to the user's actual /dev/pts/X).
//
// All filesystem access goes through the Transport, so the same logic
// works whether we're tailing a local strace or one running over SSH.

import { readFileSync, readlinkSync } from "node:fs";
import type { Transport } from "./transport.ts";

export class FdResolver {
  private fdCache = new Map<string, boolean>();
  private cttyCache = new Map<number, string | null>();
  private readonly targetPath: string;
  private readonly transport: Transport;
  private readonly useSudoFallback: boolean;

  constructor(targetPts: string, transport: Transport, useSudoFallback: boolean) {
    this.targetPath = targetPts;
    this.transport = transport;
    this.useSudoFallback = useSudoFallback;
  }

  // `knownLink` lets the caller skip the /proc/PID/fd/N readlink. The
  // strace-y output gives us the fd→path resolution inline in every
  // write() line, which is much faster than a separate readlink (esp.
  // over SSH) AND survives the trace target exiting before our lookup
  // would have run.
  isTargetTty(pid: number, fd: number, knownLink?: string): boolean {
    const key = `${pid}:${fd}`;
    const cached = this.fdCache.get(key);
    if (cached !== undefined) return cached;
    const link = knownLink ?? this.readlink(pid, fd);
    let resolved = false;
    if (link === this.targetPath) {
      resolved = true;
    } else if (link === "/dev/tty") {
      resolved = this.controllingTty(pid) === this.targetPath;
    }
    this.fdCache.set(key, resolved);
    return resolved;
  }

  private readlink(pid: number, fd: number): string | null {
    const procPath = `/proc/${pid}/fd/${fd}`;
    // Fast path: when transport is local, the in-process syscall is
    // ~100× cheaper than spawning `readlink`.
    if (this.transport.isLocal()) {
      try {
        return readlinkSync(procPath);
      } catch (e: any) {
        if (!this.useSudoFallback || e?.code === "ENOENT") return null;
      }
    }
    const r = this.useSudoFallback
      ? this.transport.execCapture(["sudo", "-n", "readlink", procPath])
      : this.transport.execCapture(["readlink", procPath]);
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  }

  private controllingTty(pid: number): string | null {
    const cached = this.cttyCache.get(pid);
    if (cached !== undefined) return cached;
    const path = this.readStatCtty(pid);
    this.cttyCache.set(pid, path);
    return path;
  }

  private readStatCtty(pid: number): string | null {
    let stat: string | null = null;
    if (this.transport.isLocal()) {
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (e: any) {
        if (e?.code === "ENOENT") return null;
        // fall through to sudo fallback below
      }
    }
    if (!stat) {
      const r = this.useSudoFallback
        ? this.transport.execCapture(["sudo", "-n", "cat", `/proc/${pid}/stat`])
        : this.transport.execCapture(["cat", `/proc/${pid}/stat`]);
      if (r.status === 0) stat = r.stdout;
    }
    if (!stat) return null;
    // Field 7 of /proc/PID/stat is tty_nr — a dev_t. Decode major/minor
    // (Linux: minor low 8 bits, major 12 bits, minor high 12 bits).
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return null;
    const tail = stat.slice(rp + 2).split(" ");
    const ttyNr = parseInt(tail[4] ?? "0", 10);
    if (!ttyNr) return null;
    const major = (ttyNr >> 8) & 0xfff;
    const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
    if (major >= 136 && major <= 143) return `/dev/pts/${minor}`;
    if (major === 4) return `/dev/tty${minor}`;
    return null;
  }
}
