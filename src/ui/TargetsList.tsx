import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { Target } from "../targets.ts";
import { SSH_CONFIG_PATH, STORE_PATH } from "../targets.ts";

type Props = {
  targets: Target[];
  onSelect: (t: Target) => void;
  onQuit: () => void;
  onRefresh: () => void;
  // Status flag for the bottom hint area — e.g. an error from a prior
  // SSH attempt that we want to surface.
  banner?: string | null;
};

export function TargetsList({ targets, onSelect, onQuit, onRefresh, banner }: Props) {
  const [cursor, setCursor] = useState(0);

  useKeyboard((k) => {
    if (k.name === "q") return onQuit();
    if (k.name === "r") return onRefresh();
    if (k.name === "up" || k.name === "k") setCursor((c) => Math.max(0, c - 1));
    if (k.name === "down" || k.name === "j") setCursor((c) => Math.min(targets.length - 1, c + 1));
    if (k.name === "return") {
      const t = targets[cursor];
      if (t) onSelect(t);
    }
  });

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ height: 1, backgroundColor: "#1e3a5f", paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#7dd3fc">
          <strong>twatch</strong>
          <span fg="#888"> — pick a target ({targets.length})</span>
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        <box style={{ flexDirection: "row", height: 1, marginBottom: 1 }}>
          <text fg="#94a3b8">
            <strong>
              {padRight("KIND", 8)}{padRight("TARGET", 38)}SOURCE
            </strong>
          </text>
        </box>
        {targets.map((t, i) => {
          const selected = i === cursor;
          const fg = selected ? "#0b0f19" : "#e2e8f0";
          const bg = selected ? "#7dd3fc" : undefined;
          const kind = t.kind === "local" ? "local" : "ssh";
          const src = t.source === "builtin"
            ? ""
            : t.source === "ssh-config"
              ? "~/.ssh/config"
              : "~/.config/twatch/targets.json";
          return (
            <box key={t.id} style={{ height: 1, backgroundColor: bg, flexDirection: "row" }}>
              <text fg={fg}>
                {padRight(kind, 8)}
                {padRight(t.label, 38)}
                {src}
              </text>
            </box>
          );
        })}
      </box>

      <box style={{ height: 1, backgroundColor: "#0b1220", paddingLeft: 1, paddingRight: 1 }}>
        <text fg={banner ? "#fecaca" : "#64748b"}>
          {banner ?? `↑/↓ move · Enter open · r refresh · q quit  ·  add server: edit ${STORE_PATH}  ·  ssh aliases: ${SSH_CONFIG_PATH}`}
        </text>
      </box>
    </box>
  );
}

function padRight(s: string, n: number) {
  if (s.length >= n) return s.slice(0, n - 1) + " ";
  return s + " ".repeat(n - s.length);
}
