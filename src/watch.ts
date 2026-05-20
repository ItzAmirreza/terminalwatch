// Live PTY mirror for a target session.
//
// Strategy: spawn `sudo strace -f -p <shellPid> -e trace=write
// -e signal=none -s 65535 -qq`, parse each emitted line, and for any
// `write(1, "...", N)` or `write(2, "...", N)` decode the C-escaped bytes
// and pipe them straight to our stdout.
//
// Critical: strace -f traces children too, so commands like `apt update`
// surface write()s from helper procs (gpgv, apt-helper) that go to pipes
// between cooperating processes — NOT to the user's terminal. We resolve
// /proc/PID/fd/N for each (pid, fd) we see and only forward writes whose
// fd actually points at the target session's pts.
//
// We deliberately do NOT forward keystrokes back to the target — passive
// observation only. Left Arrow or Esc detaches.

import { type ChildProcess } from "node:child_process";
import { decodeCEscaped, findCloseQuote } from "./cescape.ts";
import { FdResolver } from "./fdfilter.ts";
import type { Transport } from "./transport.ts";

export type WatchHandle = {
  detach: () => void;
  done: Promise<{ reason: "user" | "exit" | "error"; code?: number; err?: string }>;
};

export type WatchOptions = {
  // Where the target lives (local or SSH).
  transport: Transport;
  shellPid: number;
  // Path like "/dev/pts/0" — used to filter strace writes to actual tty
  // output (vs. pipe writes from helper procs).
  targetPts: string;
  // When true, run strace under sudo. On hosts where the watcher already
  // runs as root, set false to skip the sudo invocation.
  useSudo?: boolean;
  // Optional preamble to print before the live stream starts (e.g. history).
  preamble?: string;
  // For local mock/dev: instead of strace, replay a canned stream.
  mockStream?: AsyncIterable<Uint8Array>;
};

export function startWatch(opts: WatchOptions): WatchHandle {
  const out = process.stdout;
  let detached = false;
  let resolve!: (v: { reason: "user" | "exit" | "error"; code?: number; err?: string }) => void;
  const done = new Promise<{ reason: "user" | "exit" | "error"; code?: number; err?: string }>(
    (r) => (resolve = r),
  );

  out.write("\x1b[2J\x1b[H");
  if (opts.preamble) out.write(opts.preamble);
  out.write(
    `\x1b[7m  twatch ▸ attached to pid ${opts.shellPid} on ${opts.targetPts}  ·  ← or Esc to detach  \x1b[0m\r\n`,
  );

  let child: ChildProcess | null = null;
  let mockAbort: AbortController | null = null;
  const resolver = opts.mockStream
    ? null
    : new FdResolver(opts.targetPts, opts.transport, opts.useSudo !== false);

  if (opts.mockStream) {
    mockAbort = new AbortController();
    void (async () => {
      try {
        for await (const chunk of opts.mockStream!) {
          if (mockAbort!.signal.aborted) break;
          out.write(chunk);
        }
        if (!detached) finish({ reason: "exit", code: 0 });
      } catch (e: any) {
        if (!detached) finish({ reason: "error", err: String(e?.message ?? e) });
      }
    })();
  } else {
    const straceArgs = [
      "-f",
      "-p", String(opts.shellPid),
      "-e", "trace=write",
      "-e", "signal=none",
      "-s", "65535",
      "-qq",
    ];
    const argv = opts.useSudo === false
      ? ["strace", ...straceArgs]
      : ["sudo", "-n", "strace", ...straceArgs];
    child = opts.transport.spawnPipe(argv, { stdio: ["ignore", "ignore", "pipe"] });

    const parser = new StraceLineParser(
      opts.shellPid,
      resolver!,
      (bytes) => out.write(bytes),
      (errLine) => out.write(`\x1b[31m${errLine}\x1b[0m\r\n`),
    );
    child.stderr!.on("data", (buf: Buffer) => parser.feed(buf));
    child.on("exit", (code) => {
      if (!detached) finish({ reason: "exit", code: code ?? 0 });
    });
    child.on("error", (err) => {
      if (!detached) finish({ reason: "error", err: err.message });
    });
  }

  // Watch our stdin for the detach keys.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const detachDetector = new DetachDetector();
  const onData = (buf: Buffer) => {
    if (detachDetector.shouldDetach(buf)) finish({ reason: "user" });
  };
  stdin.on("data", onData);

  function finish(r: { reason: "user" | "exit" | "error"; code?: number; err?: string }) {
    if (detached) return;
    detached = true;
    stdin.removeListener("data", onData);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    if (child && !child.killed) {
      try { child.kill("SIGTERM"); } catch {}
    }
    if (mockAbort) mockAbort.abort();
    resolve(r);
  }

  return {
    detach: () => finish({ reason: "user" }),
    done,
  };
}

// Detect detach intent from raw stdin bytes:
//   - Left Arrow: ESC [ D  (normal mode)  or  ESC O D  (application mode)
//   - Esc (bare): ESC followed by no more bytes in this read
//   - Ctrl+C:    0x03
//   - Ctrl+]:    0x1d  (legacy from v1)
class DetachDetector {
  shouldDetach(buf: Buffer): boolean {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]!;
      if (b === 0x03 || b === 0x1d) return true;
      if (b === 0x1b) {
        const next = buf[i + 1];
        const after = buf[i + 2];
        // Left arrow: ESC [ D  or  ESC O D
        if ((next === 0x5b || next === 0x4f) && after === 0x44) return true;
        // Bare Esc — no continuation in this buffer.
        if (next === undefined) return true;
        // Some other escape sequence (cursor up/down, F-keys) — ignore.
        // Skip until we run out of likely-CSI bytes.
        i += 1;
        while (i < buf.length - 1) {
          const c = buf[i + 1]!;
          if (c >= 0x40 && c <= 0x7e) { i++; break; } // final byte of CSI
          i++;
        }
      }
    }
    return false;
  }
}

// Incremental parser for strace stderr. strace writes line-buffered output;
// we split on \n and pick out `write(1|2, "...", N)`.
class StraceLineParser {
  private buf = "";
  constructor(
    private readonly attachedPid: number,
    private readonly resolver: FdResolver,
    private readonly onBytes: (bytes: Uint8Array) => void,
    private readonly onError?: (line: string) => void,
  ) {}
  feed(chunk: Buffer) {
    this.buf += chunk.toString("binary");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }
  private handleLine(line: string) {
    let i = 0;
    let pid = this.attachedPid;
    if (line.startsWith("[pid")) {
      const close = line.indexOf("]", 4);
      if (close < 0) return;
      pid = parseInt(line.slice(4, close).trim(), 10);
      i = close + 1;
      while (i < line.length && line.charCodeAt(i) === 0x20) i++;
    }
    if (!line.startsWith("write(", i)) {
      if (line.startsWith("strace:") && this.onError) this.onError(line);
      return;
    }
    i += "write(".length;
    const comma = line.indexOf(",", i);
    if (comma < 0) return;
    const fd = parseInt(line.slice(i, comma).trim(), 10);
    // Don't filter on fd number — sudo's I/O monitor relays via fd 8
    // (its dup of /dev/tty), not fd 1/2. The link-based check is what
    // decides whether this write is actually user-visible.
    if (!this.resolver.isTargetTty(pid, fd)) return;
    let j = comma + 1;
    while (j < line.length && line.charCodeAt(j) === 0x20) j++;
    if (line.charCodeAt(j) !== 0x22 /* " */) return;
    const close = findCloseQuote(line, j + 1);
    if (close < 0) return;
    const escaped = line.slice(j + 1, close);
    const bytes = decodeCEscaped(escaped);
    this.onBytes(bytes);
  }
}

// Demo / mock stream useful when developing the UI on a Mac.
export async function* demoMockStream(): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  yield enc.encode("\x1b[2J\x1b[H");
  yield enc.encode("user@vps:~$ ");
  for (const ch of "ls -la /var/log\n") {
    await sleep(60);
    yield enc.encode(ch);
  }
  await sleep(150);
  yield enc.encode("total 1248\n");
  yield enc.encode("drwxr-xr-x  9 root root  4096 May 20 20:30 .\n");
  yield enc.encode("drwxr-xr-x 14 root root  4096 May 20 19:11 ..\n");
  yield enc.encode("-rw-r-----  1 syslog adm  62k May 20 20:35 syslog\n");
  yield enc.encode("user@vps:~$ ");
  for (const ch of "vim deploy.yml\n") {
    await sleep(70);
    yield enc.encode(ch);
  }
  await sleep(200);
  yield enc.encode("\x1b[?1049h\x1b[2J\x1b[H");
  yield enc.encode("\x1b[1;1H~\n~\n~\n~\n~ deploy.yml [New File]");
  await sleep(1200);
  yield enc.encode("\x1b[?1049l");
  yield enc.encode("\nuser@vps:~$ ");
  while (true) {
    await sleep(800);
    yield enc.encode(`echo "still here at ${new Date().toLocaleTimeString()}"\n`);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
