"use client";

// A card's key (`PIW-42`) as a button: one click puts the reference on the
// clipboard, so it can be quoted in a commit message, a branch name, a prompt
// or another card without a trip through the card menu. Two sizes, one
// control — the dim label above a board card's title and the tab header's
// bordered chip — so both confirm the same way: the chip turns accent and a
// check appears after the key while a live region says "Copied".

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { KanbanSearchText } from "./KanbanSearch";

/** How long the confirmation (accent + check) stays before the chip goes quiet. */
export const KANBAN_CARD_KEY_COPIED_MS = 1200;

export interface KanbanCardKeyChipProps {
  /** The card's handle, from `kanbanCardKey`. */
  cardKey: string;
  /**
   * `card` = the small mono label above a board card's title;
   * `detail` = the card detail tab's borderless-in-a-chip header control.
   */
  variant?: "card" | "detail";
  /** The board's filter query, so a typed reference highlights its own chip. */
  query?: string;
}

/** The visually hidden live region: the click's outcome, for a screen reader. */
const ANNOUNCE: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

function CheckIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function KanbanCardKeyChip({ cardKey, variant = "card", query = "" }: KanbanCardKeyChipProps) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // A card swap inside a reused tab, or the tab closing, must not leave a
  // pending flash behind.
  useEffect(() => () => stop(), []);
  useEffect(() => {
    stop();
    setOutcome("idle");
  }, [cardKey]);

  const copy = () => {
    stop();
    const settle = (next: "copied" | "failed") => {
      setOutcome(next);
      timer.current = setTimeout(() => setOutcome("idle"), KANBAN_CARD_KEY_COPIED_MS);
    };
    // A refused clipboard write (an unfocused document, a denied permission)
    // says so instead of flashing a confirmation that never happened.
    copyText(cardKey).then(() => settle("copied"), () => settle("failed"));
  };

  const copied = outcome === "copied";
  const style: React.CSSProperties = variant === "detail"
    ? {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "3px 8px",
      fontFamily: "var(--font-mono)",
      fontSize: 10.5,
      letterSpacing: 0.3,
      color: copied ? "var(--accent)" : "var(--text-muted)",
      background: "var(--bg-panel)",
      border: `1px solid ${copied ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
      borderRadius: 999,
      cursor: "pointer",
      whiteSpace: "nowrap",
    }
    : {
      // A negative margin keeps the key where it stood while the padding
      // widens its click target.
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      margin: "-1px -3px",
      padding: "1px 3px",
      fontFamily: "var(--font-mono)",
      fontSize: 9.5,
      fontWeight: 500,
      letterSpacing: 0.2,
      lineHeight: 1.3,
      color: copied ? "var(--accent)" : "var(--text-dim)",
      background: "none",
      border: "1px solid transparent",
      borderRadius: 4,
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

  return (
    <button
      type="button"
      data-kanban-card-key={cardKey}
      data-kanban-detail-key={variant === "detail" ? cardKey : undefined}
      data-copied={copied ? "true" : undefined}
      onClick={(event) => {
        // Inside a board card: copying must not open the card.
        event.stopPropagation();
        copy();
      }}
      // The board card starts a drag on pointerdown; a copy click is not one.
      onPointerDown={(event) => event.stopPropagation()}
      title={t("kanban.cardKeyTitle", { key: cardKey })}
      aria-label={t("kanban.menuCopyKey", { key: cardKey })}
      onMouseEnter={(event) => {
        if (!copied) event.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = copied ? "var(--accent)" : variant === "detail" ? "var(--text-muted)" : "var(--text-dim)";
      }}
      style={style}
    >
      <KanbanSearchText text={cardKey} query={query} />
      {copied && <CheckIcon />}
      <span role="status" aria-live="polite" style={ANNOUNCE}>
        {outcome === "copied" ? t("kanban.cardKeyCopied") : outcome === "failed" ? t("kanban.cardKeyCopyFailed") : ""}
      </span>
    </button>
  );
}
