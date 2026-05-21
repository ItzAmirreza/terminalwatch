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
twatch                                  # opens the targets picker
twatch --remote azureuser@vps           # skip the picker, open this remote
twatch --remote azureuser@vps -i ~/.ssh/key.pem -p 2222
```

Plain `twatch` shows three flavors of targets:

- **local** — this box.
- **ssh-config** — every concrete `Host` entry in `~/.ssh/config`
  (wildcards / globs skipped). Use these to inherit your existing ssh
  config — keys, ports, jump hosts, etc.
- **saved** — entries in `~/.config/twatch/targets.json`, an array of
  `{name, user, host, port?, identityFile?}`. Hand-edit for now; an
  in-UI add form is coming in 0.3.x.

Keys:

- **Targets**:  `↑/↓` move · `Enter` open · `r` refresh · `q` quit
- **Sessions**: `↑/↓` move · `Enter` watch · `r` refresh · `← / Esc`
  back to targets · `q` quit
- **Attached**: `← / Esc` detach · `Ctrl+C` also detaches

In `--remote` (or any ssh target) mode the TUI runs on your laptop, but
every command (`who`, `ps`, `sudo strace`, `readlink /proc/PID/fd/N`,
etc.) executes on the target box. SSH connections are multiplexed
through one OpenSSH ControlMaster socket so per-call latency stays in
the tens of ms after the initial handshake. The remote user must have
sudo (passwordless or interactive) for the attach step.

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

Tagged `(wip)` = in progress, `(idea)` = speculative. Anything else
unchecked is planned next-up.

### Shipped (v0.4)

- [x] **Add-server form** in the targets picker — `a` (or scroll to
      "+ add server…" and Enter) opens a form: name, user, host,
      port?, identity file? Saves to `~/.config/twatch/targets.json`.
- [x] **Auto-updater** — startup fetches the latest version from npm
      (cached 6h in `~/.cache/twatch/update-check.json`). If newer, a
      yellow badge in the header reads `update vX.Y.Z available · press u`;
      pressing `u` runs `bun add -g terminalwatch@latest` and exits so
      you re-launch with the new version.
### Shipped (v0.2 / v0.3)

- [x] **Remote mode** — `twatch --remote user@host`. See "Use" above.
- [x] Transport abstraction (`LocalTransport` / `SshTransport`) so the
      same code paths drive both local and SSH execution.
- [x] **Targets picker** — plain `twatch` opens a first-screen picker
      backed by `~/.ssh/config` Host entries plus
      `~/.config/twatch/targets.json`. `Esc` / `←` from the session
      list pops back to targets so you can switch hosts without quitting.

### Shipped (v0.1)

- [x] List logged-in PTY sessions (`who` + `ps -e`)
- [x] Live mirror via `sudo strace -f`, ANSI replayed verbatim
- [x] Noise filter: drop pipe writes, only forward writes whose fd
      points at the target pts
- [x] Handle Ubuntu's default `sudo use_pty`: keep monitor relay writes
      via `/dev/tty` when the writer's controlling tty matches the target
- [x] Cross-user listing (works for any user on the box, not just yours)
- [x] Left Arrow / Esc to detach
- [x] IP geolocation column (ip-api.com)
- [x] Pre-attach context: login, idle, foreground proc, `~/.bash_history`
      tail
- [x] One-line installer (`curl … | bash`)
- [x] Published on npm — `bun i -g terminalwatch`

### Tier 1 — natural next steps

- [x] **Remote mode** — `twatch --remote user@host`: operator on
      laptop, target on a remote VPS. Transport layer abstracts local
      vs. SSH; SSH calls multiplexed through one ControlMaster socket.
- [x] **Targets picker** — first screen lists local + ssh-config +
      saved entries; Enter opens one, Esc returns.
- [x] **Add-server form** — writes to `~/.config/twatch/targets.json`.
- [ ] **Session recording** — `--record file.cast` writes asciicast v2;
      replays with `asciinema play` or `twatch --replay`.
- [ ] **Audit log** — append every attach (operator, target, duration,
      detach reason) to `~/.local/share/twatch/audit.log`.

### Tier 2 — UX wins

- [ ] **In-TUI watch view** — render the byte stream into an OpenTUI
      cell grid via a headless vt emulator instead of taking over the
      terminal. Enables session-switching without redraws.
- [ ] **Multi-watch split** — tile 2/3/4 sessions side-by-side (depends
      on in-TUI renderer).
- [ ] **Pause / scrollback / search** — `Space` pauses, `↑/↓` scrolls,
      `/foo` highlights (depends on in-TUI renderer).

### Tier 3 — sysadmin power

- [ ] (idea) **Show keystrokes separately** — trace `read(0, …)` on the
      foreground process to surface what they're typing before render.
- [ ] (idea) **Danger-command alerts** — flash on `rm -rf`, `chmod 777`,
      `curl … | sudo bash`, etc.
- [ ] (idea) **New-login notifications** — watch `/var/run/utmp`, POST
      to a configurable webhook on each new PTY.
- [ ] (idea) **In-memory bash history** — inject opt-in
      `PROMPT_COMMAND` so history is flushed per command (current
      preview shows only the file on disk, which flushes on shell exit).

### Tier 4 — speculative / heavy

- [ ] (idea) **eBPF backend** — replace strace with `tty_write` kprobes
      for zero-overhead, multi-watcher scaling.
- [ ] (idea) **Container awareness** — detect `docker exec` /
      `kubectl exec` sessions, enter the right pid namespace before
      attaching.
- [ ] (idea) **Web UI** — stream the same byte channel into a browser
      tab via xterm.js. Pairs with session recording for sharable links.
