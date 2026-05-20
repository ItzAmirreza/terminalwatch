import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Session } from "../sessions.ts";
import { formatGeo, lookup, lookupCached, type GeoInfo } from "../geoip.ts";

type Props = {
  sessions: Session[];
  hostLabel: string;
  onSelect: (s: Session) => void;
  onQuit: () => void;
  onRefresh: () => void;
  // When provided, Esc / Left Arrow navigates back to the targets picker
  // instead of quitting the app entirely.
  onBack?: () => void;
};

export function SessionList({ sessions, hostLabel, onSelect, onQuit, onRefresh, onBack }: Props) {
  const watchable = sessions.filter((s) => !s.isSelf);
  const [cursor, setCursor] = useState(0);
  const [geo, setGeo] = useState<Record<string, GeoInfo>>({});

  // Kick off geoip lookups for any IPs we haven't resolved yet.
  useEffect(() => {
    const seen = new Set<string>();
    for (const s of watchable) {
      if (!s.from || seen.has(s.from)) continue;
      seen.add(s.from);
      if (geo[s.from]) continue;
      const cached = lookupCached(s.from);
      if (cached) {
        setGeo((m) => ({ ...m, [s.from]: cached }));
        continue;
      }
      void lookup(s.from).then((info) => setGeo((m) => ({ ...m, [s.from]: info })));
    }
  }, [watchable.map((s) => s.from).join("|")]);

  useEffect(() => {
    if (cursor >= watchable.length) setCursor(Math.max(0, watchable.length - 1));
  }, [watchable.length, cursor]);

  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "left") {
      if (onBack) return onBack();
      return onQuit();
    }
    if (k.name === "q") return onQuit();
    if (k.name === "r") return onRefresh();
    if (k.name === "up" || k.name === "k") setCursor((c) => Math.max(0, c - 1));
    if (k.name === "down" || k.name === "j") setCursor((c) => Math.min(watchable.length - 1, c + 1));
    if (k.name === "return") {
      const target = watchable[cursor];
      if (target) onSelect(target);
    }
  });

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ height: 1, backgroundColor: "#1e3a5f", paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#7dd3fc">
          <strong>twatch</strong>
          <span fg="#888"> — {hostLabel} — {watchable.length} watchable session{watchable.length === 1 ? "" : "s"}</span>
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        <box style={{ flexDirection: "row", height: 1, marginBottom: 1 }}>
          <text fg="#94a3b8"><strong>
            {padRight("USER", 12)}{padRight("TTY", 8)}{padRight("FROM", 18)}{padRight("LOCATION", 22)}{padRight("LOGIN", 18)}{padRight("IDLE", 6)}{padRight("PID", 7)}DOING
          </strong></text>
        </box>
        {watchable.length === 0 ? (
          <text fg="#888">No other PTY sessions found. (You are filtered out of this list.) Press 'r' to refresh.</text>
        ) : (
          watchable.map((s, i) => {
            const selected = i === cursor;
            const fg = selected ? "#0b0f19" : "#e2e8f0";
            const bg = selected ? "#7dd3fc" : undefined;
            const loc = formatGeo(geo[s.from] ?? null);
            return (
              <box key={`${s.tty}-${s.shellPid}`} style={{ height: 1, backgroundColor: bg, flexDirection: "row" }}>
                <text fg={fg}>
                  {padRight(s.user, 12)}
                  {padRight(s.tty, 8)}
                  {padRight(s.from, 18)}
                  {padRight(loc, 22)}
                  {padRight(s.loginAt, 18)}
                  {padRight(s.idle, 6)}
                  {padRight(s.shellPid ? String(s.shellPid) : "?", 7)}
                  {s.foregroundComm ?? "?"}
                </text>
              </box>
            );
          })
        )}
      </box>

      <box style={{ height: 1, backgroundColor: "#0b1220", paddingLeft: 1 }}>
        <text fg="#64748b">
          ↑/↓ move · Enter watch · r refresh{onBack ? " · ← / Esc back" : ""} · q quit
        </text>
      </box>
    </box>
  );
}

function padRight(s: string, n: number) {
  if (s.length >= n) return s.slice(0, n - 1) + " ";
  return s + " ".repeat(n - s.length);
}
