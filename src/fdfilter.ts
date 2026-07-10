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

// Cap the caches so a long watch over a busy shell (many short-lived PIDs)
// can't grow them without bound. When full we drop the whole map — these are
// pure lookups, so re-resolving is always correct, just momentarily slower.
const CACHE_CAP = 4096;

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

  // Decide whether a write() strace attributed to (pid, fd) actually lands on
  // the target pts.
  //
  // `knownLink` is the fd→path strace prints inline with `-y` (e.g.
  // `write(1</dev/pts/0>, …)`). When present it's authoritative for THIS
  // write, so we classify from it directly and do NOT consult the pid:fd
  // cache: that cache goes stale under PID reuse or an fd being reopened to a
  // different target mid-watch, which would misroute another process's pipe
  // writes onto the operator's terminal. The link is cheap (a string compare,
  // plus an occasional cached ctty read), so there's nothing to cache anyway.
  //
  // Only the fallback path (no `-y`, e.g. the older test harness) caches the
  // readlink result, since that readlink is the expensive part.
  isTargetTty(pid: number, fd: number, knownLink?: string): boolean {
    if (knownLink !== undefined) return this.classify(pid, knownLink);

    const key = `${pid}:${fd}`;
    const cached = this.fdCache.get(key);
    if (cached !== undefined) return cached;
    const link = this.readlink(pid, fd);
    const resolved = link === null ? false : this.classify(pid, link);
    if (this.fdCache.size >= CACHE_CAP) this.fdCache.clear();
    this.fdCache.set(key, resolved);
    return resolved;
  }

  private classify(pid: number, link: string): boolean {
    if (link === this.targetPath) return true;
    if (link === "/dev/tty") return this.controllingTty(pid) === this.targetPath;
    return false;
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
    if (this.cttyCache.size >= CACHE_CAP) this.cttyCache.clear();
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
