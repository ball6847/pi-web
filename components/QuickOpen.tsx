"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { usePrimaryModifier } from "@/hooks/usePrimaryModifier";
import { formatRelativeTime, formatShortRelativeTime } from "@/lib/i18n/format";
import { quickOpenTitleWindow, type QuickOpenGroup, type QuickOpenHit, type QuickOpenScope } from "@/lib/quick-open";

/**
 * The Quick Open palette: one search field over every session, ranked by how
 * well it matched.
 *
 * The scope defaults to every project: the point of the palette is to find a
 * session without knowing which project it is in. "This project" narrows it
 * to the one on show.
 *
 * The rows show why a session is in the list: the title with the matched
 * characters marked, the project it belongs to, and — when the match was in
 * the opening message rather than the title — the message it landed in.
 */

interface QuickOpenProps {
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  scope: QuickOpenScope;
  onScopeChange: (scope: QuickOpenScope) => void;
  hits: QuickOpenHit[];
  groups: QuickOpenGroup[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onOpen: (hit: QuickOpenHit, options?: { newTab?: boolean }) => void;
  onClose: () => void;
  runningIds: ReadonlySet<string>;
  awaitingIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
}

/** The text with the matched characters marked. */
function Highlighted({ text, positions }: { text: string; positions: number[] }): ReactNode {
  if (!positions.length) return text;
  const marked = new Set(positions);
  const parts: ReactNode[] = [];
  let buffer = "";
  let isMarked = false;
  const flush = (): void => {
    if (!buffer) return;
    parts.push(isMarked ? <mark key={parts.length} className="quick-open-mark">{buffer}</mark> : buffer);
    buffer = "";
  };
  for (let index = 0; index < text.length; index++) {
    const hit = marked.has(index);
    if (hit !== isMarked) {
      flush();
      isMarked = hit;
    }
    buffer += text[index];
  }
  flush();
  return parts;
}

export function QuickOpen({
  open,
  query,
  onQueryChange,
  scope,
  onScopeChange,
  hits,
  groups,
  selectedIndex,
  onSelectedIndexChange,
  onOpen,
  onClose,
  runningIds,
  awaitingIds,
  unreadIds,
}: QuickOpenProps) {
  const { t, locale } = useI18n();
  const { label: modifierLabel, isMac } = usePrimaryModifier();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Focus the field when the palette opens, and give the focus back to
  // whatever had it (the composer, a row) when it closes.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = returnFocusRef.current;
      if (!opener || !opener.isConnected) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      opener.focus({ preventScroll: true });
    };
  }, [open]);

  // Keep the selected row in sight.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex, hits]);

  const rows = useMemo(() => {
    if (groups.length) return groups.flatMap((group) => group.hits);
    return hits;
  }, [groups, hits]);

  if (!open || typeof document === "undefined") return null;

  const move = (delta: number): void => {
    if (!rows.length) return;
    const next = Math.min(Math.max(selectedIndex + delta, 0), rows.length - 1);
    if (next !== selectedIndex) onSelectedIndexChange(next);
  };

  const openSelected = (newTab: boolean): void => {
    const hit = rows[selectedIndex];
    if (!hit) return;
    onOpen(hit, { newTab });
  };

  const renderRow = (hit: QuickOpenHit, index: number): ReactNode => {
    const { session } = hit.candidate;
    const isRunning = runningIds.has(session.id);
    const isAwaiting = awaitingIds.has(session.id);
    const isUnread = unreadIds.has(session.id);
    const selected = index === selectedIndex;
    // The title is cut like the sidebar's row cuts it, but a match beyond
    // that cut moves the window to the match, so it is never invisible.
    const title = quickOpenTitleWindow(hit.candidate.title, hit.titlePositions);
    return (
      <button
        key={session.id}
        type="button"
        role="option"
        aria-selected={selected}
        data-index={index}
        className={`quick-open-row${selected ? " is-selected" : ""}`}
        onClick={() => onOpen(hit)}
        onMouseMove={() => {
          if (selectedIndex !== index) onSelectedIndexChange(index);
        }}
      >
        <span className="quick-open-row-main">
          <span className="quick-open-row-title">
            <Highlighted text={title.text} positions={title.positions} />
          </span>
          <span className="quick-open-row-sub">
            <span className="quick-open-row-project">{hit.candidate.projectName}</span>
            {hit.messagePositions.length > 0 && (
              <>
                <span className="quick-open-row-dot">·</span>
                <span className="quick-open-row-snippet">
                  <Highlighted
                    text={quickOpenTitleWindow(hit.candidate.message, hit.messagePositions, 60).text}
                    positions={quickOpenTitleWindow(hit.candidate.message, hit.messagePositions, 60).positions}
                  />
                </span>
              </>
            )}
          </span>
        </span>
        <span className="quick-open-row-meta">
          {isAwaiting && <span className="quick-open-badge is-awaiting">{t("quickOpen.awaiting")}</span>}
          {isRunning && !isAwaiting && <span className="quick-open-badge is-running">{t("quickOpen.running")}</span>}
          {isUnread && !isRunning && <span className="quick-open-badge is-unread">{t("quickOpen.unread")}</span>}
          <span className="quick-open-row-time" title={formatRelativeTime(session.modified, locale)}>
            {formatShortRelativeTime(session.modified, locale)}
          </span>
          <span className="quick-open-row-count">{t("quickOpen.messageCount", { count: session.messageCount })}</span>
        </span>
      </button>
    );
  };

  const panel = (
    <div
      className="quick-open-layer"
      role="dialog"
      aria-modal="true"
      aria-label={t("quickOpen.label")}
      onMouseDown={(event) => {
        // A click on the backdrop closes the palette; a click inside does not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="quick-open-panel">
        <div className="quick-open-header">
          <span className="quick-open-heading">{t("quickOpen.heading")}</span>
          <button
            type="button"
            className="quick-open-scope"
            onClick={() => onScopeChange(scope === "all" ? "project" : "all")}
            title={t("quickOpen.scopeHint")}
          >
            {scope === "all" ? t("quickOpen.scopeAll") : t("quickOpen.scopeProject")}
          </button>
        </div>
        <div className="quick-open-input-row">
          <svg className="quick-open-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="quick-open-input"
            value={query}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("quickOpen.placeholder")}
            aria-label={t("quickOpen.placeholder")}
            aria-controls="quick-open-list"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                openSelected(isMac ? event.metaKey : event.ctrlKey);
                return;
              }
              if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
        </div>
        <div
          id="quick-open-list"
          ref={listRef}
          className="quick-open-list"
          role="listbox"
          aria-label={t("quickOpen.results")}
          aria-activedescendant={rows[selectedIndex] ? `quick-open-row-${rows[selectedIndex].candidate.session.id}` : undefined}
        >
          {groups.length > 0
            ? groups.map((group) => (
              <div key={group.key} className="quick-open-group">
                <div className="quick-open-group-label">{t(`quickOpen.group.${group.key}`)}</div>
                {group.hits.map((hit) => renderRow(hit, rows.indexOf(hit)))}
              </div>
            ))
            : rows.map((hit, index) => renderRow(hit, index))}
          {rows.length === 0 && (
            <div className="quick-open-empty">
              {query.trim() ? t("quickOpen.noResults") : t("quickOpen.noSessions")}
            </div>
          )}
        </div>
        <div className="quick-open-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t("quickOpen.hintNavigate")}</span>
          <span><kbd>↵</kbd>{t("quickOpen.hintOpen")}</span>
          <span><kbd>{modifierLabel}</kbd><kbd>↵</kbd>{t("quickOpen.hintNewTab")}</span>
          <span><kbd>esc</kbd>{t("quickOpen.hintClose")}</span>
          <span className="quick-open-count">{t("quickOpen.count", { count: hits.length })}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
