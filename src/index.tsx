import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { userInfo } from "node:os";
import { useCallback, useEffect, useState } from "react";
import { SessionList } from "./ui/SessionList.tsx";
import { hostLabel, listSessions, type Session, isLinux } from "./sessions.ts";
import { startWatch, demoMockStream } from "./watch.ts";
import { fetchHistory, renderPreamble } from "./history.ts";
import { formatGeo, lookup, lookupCached } from "./geoip.ts";

const MOCK = process.env.TWATCH_MOCK === "1" || process.argv.includes("--mock");

function App() {
  const renderer = useRenderer();
  const [sessions, setSessions] = useState<Session[]>(() => listSessions());
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setSessions(listSessions());
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const quit = useCallback(() => {
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  const onSelect = useCallback(
    async (target: Session) => {
      if (!MOCK && !isLinux()) {
        setErr("Live watch only works on Linux. Run with TWATCH_MOCK=1 for a demo.");
        return;
      }
      if (!target.shellPid && !MOCK) {
        setErr(`No shell PID for ${target.tty}; can't attach.`);
        return;
      }

      // Best-effort geo + history before suspending the TUI.
      const geoInfo = lookupCached(target.from) ?? (await lookup(target.from).catch(() => null));
      const history = MOCK
        ? { source: "(mock)", entries: ["ls -la", "vim deploy.yml", "sudo systemctl restart api"] }
        : fetchHistory(target.user, 10, userInfo().username);
      const preamble = renderPreamble({
        user: target.user,
        tty: target.tty,
        from: target.from,
        geoLabel: formatGeo(geoInfo),
        loginAt: target.loginAt,
        idle: target.idle,
        foregroundComm: target.foregroundComm,
        history,
      });

      renderer.suspend();
      const handle = startWatch({
        shellPid: target.shellPid ?? 0,
        targetPts: target.ttyDev,
        useSudo: !MOCK,
        preamble,
        mockStream: MOCK ? demoMockStream() : undefined,
      });
      const result = await handle.done;
      renderer.resume();
      if (result.reason === "error") setErr(`watch failed: ${result.err}`);
      refresh();
    },
    [renderer, refresh],
  );

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <SessionList
        sessions={sessions}
        hostLabel={hostLabel()}
        onSelect={onSelect}
        onQuit={quit}
        onRefresh={refresh}
      />
      {err ? (
        <box style={{ height: 1, backgroundColor: "#7f1d1d", paddingLeft: 1 }}>
          <text fg="#fecaca">{err}</text>
        </box>
      ) : null}
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
});
createRoot(renderer).render(<App />);
