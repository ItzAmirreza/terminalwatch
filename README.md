# twatch — terminal watch

A sysadmin TUI for Linux: list every logged-in PTY session on the host
and live-mirror what any user is seeing on their terminal — keystrokes,
output, full-screen apps like `vim` or `top`, all of it.

```
┌─ twatch ─ azureuser@vps ─ 3 watchable sessions ─────────────────────────────┐
│ USER        TTY    FROM             LOCATION         LOGIN           DOING  │
│ azureuser   pts/0  77.119.164.236   Tehran, IR       20:35           bash   │
│ alice       pts/2  10.0.0.7         local            20:40           vim    │
│ deploy      pts/3  3.121.4.18       Frankfurt, DE    20:42           apt    │
└─────────────────────────────────────────────────────────────────────────────┘
  ↑/↓ move · Enter watch · r refresh · q quit
```

## Install

If you already have [Bun](https://bun.sh) and `strace`:

```bash
bun i -g terminalwatch
```

On a fresh Ubuntu / Debian box (installs Bun + strace for you):

```bash
curl -fsSL https://raw.githubusercontent.com/ItzAmirreza/terminalwatch/main/install.sh | bash
```

That script installs the system prereqs and Bun if missing, then
either does `bun i -g terminalwatch` for you or falls back to a git
clone, so `twatch` ends up on `$PATH`.

Forking? Override the source repo at install time:
`TWATCH_REPO=https://github.com/you/yourfork.git bash install.sh`.

## Use

```bash
twatch
```

- **↑ / ↓** — move the cursor
- **Enter** — attach to the highlighted session
- **r** — re-scan for new logins
- **q** / **Esc** — quit
- **← / Esc** (while attached) — detach back to the list
- **Ctrl+C** (while attached) — same as detach

Before the live stream starts you get a one-screen preamble: login
time, IP geolocation, and the tail of the target's `~/.bash_history` so
you have context for what they were doing before you joined.

You don't need to start `twatch` with `sudo` — it self-elevates via
`sudo strace` when you attach. Passwordless sudo makes it transparent;
otherwise sudo will prompt the first time per session.

## How it works

```
your terminal                       target user's terminal
   │                                       ▲
   │ replays ANSI bytes                    │ apps write here
   ▼                                       │
twatch ◀── decode ── strace -f -p <shell> ─┘
            ▲
            └─ filters writes whose fd actually points at the target's pts
```

1. `who` lists every active PTY; `ps -e -o pid,tty,stat,comm` finds the
   session leader (login shell) and current foreground process for each
   one. Works for any user on default Ubuntu (`/proc` is world-listable).
2. On Enter we `sudo strace -f -p <shellPid> -e trace=write -s 65535`,
   then for every `write(fd, "…", n)` line we resolve `/proc/PID/fd/N`
   and only forward writes whose destination is the target's `/dev/pts/X`.
   This is essential because `strace -f` follows children, and programs
   like `apt update` spawn helpers that write to pipes — without the
   filter you get pages of gpgv / apt-helper internal IPC noise.
3. Ubuntu's default `sudo use_pty` adds a wrinkle: `sudo` allocates an
   inner pty for its child and relays output through a monitor process
   that writes to `/dev/tty` (its real ctty being `/dev/pts/0`). We
   decode each writing process's controlling terminal from
   `/proc/PID/stat` field 7 so those relayed bytes still pass the filter.
4. We never forward your keystrokes back to the target. Watching is
   strictly passive.

## Limitations / notes

- **Linux only.** Relies on `/proc`, `strace`, and the Linux pts model.
  On macOS / BSD the binary will refuse to start the watch path; the
  UI still runs in `--mock` mode for demos.
- **Needs root to attach** (`ptrace_scope=1` on default Ubuntu blocks
  cross-UID ptrace). The launcher invokes `sudo strace`, so the user
  running `twatch` needs sudo rights.
- **`~/.bash_history` is only flushed on shell exit** by default. The
  preamble shows commands from previous bash sessions, not necessarily
  what the target typed during the *current* session.
- **Terminal size mismatch**: full-screen apps render to the target's
  reported terminal size. If your terminal is smaller, lines may wrap.
  Make your window at least as wide/tall as theirs.
- **No keystroke injection.** Detach (← / Esc) returns to the list.

## Dev

```bash
bun install
bun run dev:mock     # UI on macOS / non-Linux, mock data
bun run dev          # real listing (Linux only)
bun run typecheck
```

`src/test-capture.ts` and `src/test-diag.ts` are non-interactive
harnesses used to validate the filter against real workloads
(`sudo apt-get update`, etc.).

## Roadmap

Legend: ✅ shipped · 🚧 in progress · ⏳ planned · 💭 idea

### Shipped (v0.1)

- ✅ List logged-in PTY sessions (`who` + `ps -e`)
- ✅ Live mirror via `sudo strace -f`, ANSI replayed verbatim
- ✅ Noise filter: drop pipe writes, only forward writes whose fd points
  at the target pts
- ✅ Handle Ubuntu's default `sudo use_pty`: keep monitor relay writes
  via `/dev/tty` when the writer's controlling tty matches the target
- ✅ Cross-user listing (works for any user on the box, not just yours)
- ✅ Left Arrow / Esc to detach
- ✅ IP geolocation column (ip-api.com)
- ✅ Pre-attach context: login, idle, foreground proc, `~/.bash_history`
  tail
- ✅ One-line installer (`curl … | bash`)
- ✅ Published on npm — `bun i -g terminalwatch`

### Tier 1 — natural next steps

- 🚧 **Remote mode** — `twatch --remote user@host`: operator on laptop,
  target on a remote VPS. Transport layer abstracts local vs. SSH.
- ⏳ **Session recording** — `--record file.cast` writes asciicast v2;
  replays with `asciinema play` or `twatch --replay`.
- ⏳ **Audit log** — append every attach (operator, target, duration,
  detach reason) to `~/.local/share/twatch/audit.log`.

### Tier 2 — UX wins

- ⏳ **In-TUI watch view** — render the byte stream into an OpenTUI
  cell grid via a headless vt emulator instead of taking over the
  terminal. Enables session-switching without redraws.
- ⏳ **Multi-watch split** — tile 2/3/4 sessions side-by-side (depends
  on in-TUI renderer).
- ⏳ **Pause / scrollback / search** — `Space` pauses, `↑/↓` scrolls,
  `/foo` highlights (depends on in-TUI renderer).

### Tier 3 — sysadmin power

- 💭 **Show keystrokes separately** — trace `read(0, …)` on the
  foreground process to surface what they're typing before render.
- 💭 **Danger-command alerts** — flash on `rm -rf`, `chmod 777`,
  `curl … | sudo bash`, etc.
- 💭 **New-login notifications** — watch `/var/run/utmp`, POST to a
  configurable webhook on each new PTY.
- 💭 **In-memory bash history** — inject opt-in `PROMPT_COMMAND` so
  history is flushed per command (current preview shows only the file
  on disk, which flushes on shell exit).

### Tier 4 — speculative / heavy

- 💭 **eBPF backend** — replace strace with `tty_write` kprobes for
  zero-overhead, multi-watcher scaling.
- 💭 **Container awareness** — detect `docker exec` / `kubectl exec`
  sessions, enter the right pid namespace before attaching.
- 💭 **Web UI** — stream the same byte channel into a browser tab via
  xterm.js. Pairs with session recording for sharable links.
