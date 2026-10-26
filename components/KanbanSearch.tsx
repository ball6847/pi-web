"use client";

import { Fragment, useRef, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { highlightKanbanText } from "@/lib/kanban-search";

export function KanbanSearchField({ query, onQueryChange, inputRef, disabled = false }: {
  query: string;
  onQueryChange(query: string): void;
  inputRef?: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const ownRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const clear = () => {
    onQueryChange("");
    ref.current?.focus({ preventScroll: true });
  };
  return (
    <div className="kanban-search-field">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
      </svg>
      <span className="kanban-search-input-slot">
      <input
        ref={ref}
        data-kanban-search
        disabled={disabled}
        type="search"
        value={query}
        aria-label={t("kanban.searchLabel")}
        placeholder={t("kanban.searchPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onQueryChange(event.target.value)}
        // Only this field owns the clear key. Dialog/menu capture listeners
        // run first; never install a board-global Escape handler for search.
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || !query) return;
          event.preventDefault();
          event.stopPropagation();
          clear();
        }}
      />
      </span>
      {query.length > 0 && (
        <button type="button" disabled={disabled} aria-label={t("kanban.searchClear")} title={t("kanban.searchClear")}
          onMouseDown={(event) => event.preventDefault()} onClick={clear}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      )}
    </div>
  );
}

export function KanbanSearchText({ text, query }: { text: string; query: string }) {
  return highlightKanbanText(text, query).map((part, index) => part.match
    ? <mark key={index} className="kanban-search-match">{part.text}</mark>
    : <Fragment key={index}>{part.text}</Fragment>);
}

/** Panel-width queries, not viewport-width: a desktop's side panels can narrow the board too. */
export function KanbanSearchStyles() {
  return <style>{`
    .kanban-board { container-type: inline-size; }
    .kanban-board-header {
      flex-shrink: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 220px) auto;
      align-items: center; gap: 8px; min-height: 40px; padding: 5px 12px;
      background: var(--bg-panel); border-bottom: 1px solid var(--border);
    }
    .kanban-board-heading { min-width: 0; display: flex; align-items: center; gap: 8px; }
    .kanban-board-heading > svg { flex-shrink: 0; }
    .kanban-board-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--text); }
    .kanban-board-count { flex-shrink: 0; color: var(--text-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
    .kanban-search-field { display: flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-dim); background: var(--bg); }
    .kanban-search-field:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
    .kanban-search-field > svg { flex-shrink: 0; }
    .kanban-search-input-slot { position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden; }
    .kanban-search-field input { position: absolute; top: 0; left: 0; min-width: 0; width: 100%; height: 100%; padding: 0; border: 0; outline: none; background: none; color: var(--text); font-size: 12px; }
    .kanban-search-field:has(input:disabled) { opacity: 0.6; }
    .kanban-search-field input::placeholder { color: var(--text-dim); }
    .kanban-search-field input::-webkit-search-cancel-button { -webkit-appearance: none; }
    .kanban-search-field button { flex-shrink: 0; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--text-muted); cursor: pointer; }
    .kanban-search-field button:hover { background: var(--bg-hover); }
    .kanban-search-match { background: color-mix(in srgb, var(--accent) 22%, var(--bg-panel)); color: inherit; border-radius: 2px; }
    .kanban-search-note { flex-shrink: 0; padding: 5px 12px; color: var(--text-dim); font-size: 11px; line-height: 1.5; }
    .kanban-search-empty { flex-shrink: 0; padding: 8px 12px; color: var(--text-muted); font-size: 12px; }
    .kanban-search-link { border: 0; padding: 4px; background: none; color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline; }
    @container (max-width: 620px) {
      .kanban-board-header { grid-template-columns: minmax(0, 1fr) auto; }
      .kanban-search-field { grid-column: 1 / -1; grid-row: 2; }
      .kanban-board-configure { grid-column: 2; grid-row: 1; }
    }
    @media (max-width: 640px), (pointer: coarse) {
      .kanban-search-field { height: 36px; }
      /* 16px keeps Safari from zooming on focus; scale only the text field to
         a visual 14px. Inverse dimensions preserve its full-width tap area. */
      .kanban-search-field input { font-size: 16px; width: calc(100% / 0.875); height: calc(100% / 0.875); transform: scale(0.875); transform-origin: top left; }
      .kanban-search-field button { width: 32px; height: 32px; }
    }
  `}</style>;
}
