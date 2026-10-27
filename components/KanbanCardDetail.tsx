"use client";

// One card, opened as a right-panel tab: lane, session, the title and the
// Markdown description (the card's only editor), and its journal — the notes a
// person and a session leave for each other across handoffs.
//
// It is also where a card is CREATED: the board's "+" opens this tab in draft
// mode (no card id yet), so a new card is written in the same editor it is read
// in, instead of a cramped inline form.
//
// The board cache owns every write (`lib/kanban.ts`); the page keeps the draft
// text. Nothing here talks to a route.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";
import { SpinnerIcon } from "./SidebarIcons";
import {
  kanbanAddCard,
  kanbanAddCardComment,
  kanbanDeleteCardComment,
  kanbanDeleteCard,
  kanbanLinkCard,
  kanbanMoveCard,
  kanbanUnlinkCard,
  kanbanUpdateCard,
  useKanbanBoard,
  useKanbanCardComments,
} from "@/lib/kanban";
import { canRestInLane } from "@/lib/kanban-shared";
import { kanbanSessionOptions } from "@/lib/kanban-sessions";
import type { KanbanCard } from "@/lib/kanban-types";
import type { SessionInfo } from "@/lib/types";
import type { KanbanComment } from "@/lib/kanban-types";

export interface KanbanCardDetailProps {
  /** The board's project (its resolved project root). */
  projectDir: string;
  projectName: string;
  /** The card to edit; `null` while the tab is a new-card draft. */
  cardId: string | null;
  /** The lane a draft starts in (the lane whose "+" opened the tab). */
  draftLaneId: string | null;
  /** The project's sessions and the board's activity sets, for the chips. */
  sessions: SessionInfo[];
  runningSessionIds: Set<string>;
  awaitingInputSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onOpenSession(sessionId: string, title: string): void;
  onStartSession(card: KanbanCard): void;
  /** A draft was saved: the shell retargets the tab to the real card. */
  onCardCreated(cardId: string, title: string): void;
  onCardDeleted(): void;
  /** The card's title changed: the tab's label follows it. */
  onTitleChange(title: string): void;
  onOpenFile?(filePath: string): void;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["minute", 60],
  ["hour", 60 * 60],
  ["day", 60 * 60 * 24],
  ["week", 60 * 60 * 24 * 7],
  ["month", 60 * 60 * 24 * 30],
  ["year", 60 * 60 * 24 * 365],
];

/** "3 minutes ago" in the reader's locale; no per-second ticking. */
function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 60) return RELATIVE.format(seconds, "second");
  for (const [unit, span] of UNITS) {
    if (Math.abs(seconds) < span * 60 || unit === "year") return RELATIVE.format(Math.round(seconds / span), unit);
  }
  return RELATIVE.format(Math.round(seconds / 31_536_000), "year");
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const FIELD: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  outline: "none",
};

const SEGMENT_BASE: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 10.5,
  borderRadius: 5,
  border: "none",
  cursor: "pointer",
  background: "transparent",
  color: "var(--text-dim)",
};

const CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  maxWidth: "100%",
  padding: "3px 8px",
  fontSize: 11,
  color: "var(--text-muted)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  cursor: "pointer",
};

function KanbanGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6 }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

function CommentEntry({
  comment,
  onDelete,
}: {
  comment: KanbanComment;
  onDelete(commentId: string): void;
}) {
  const { t } = useI18n();
  const agent = comment.author === "agent";
  const who = agent ? comment.sessionTitle || t("kanban.detailCommentAgent") : t("kanban.detailCommentYou");
  return (
    <li
      data-kanban-comment={comment.id}
      style={{
        listStyle: "none",
        position: "relative",
        padding: "9px 10px",
        background: agent ? "var(--bg-panel)" : "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            flexShrink: 0,
            background: agent ? "var(--accent)" : "var(--text-dim)",
          }}
        />
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {who}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>
          {relativeTime(comment.createdAt)}
        </span>
        <span style={{ flex: 1 }} />
        {!agent && (
          <button
            type="button"
            onClick={() => onDelete(comment.id)}
            title={t("kanban.detailCommentDelete")}
            aria-label={t("kanban.detailCommentDelete")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              padding: 0,
              background: "none",
              border: "none",
              borderRadius: 4,
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <TrashIcon />
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
        <MarkdownBody>
          {comment.body}
        </MarkdownBody>
      </div>
    </li>
  );
}

export function KanbanCardDetail(props: KanbanCardDetailProps) {
  const {
    projectDir,
    projectName,
    cardId,
    draftLaneId,
    sessions,
    runningSessionIds,
    awaitingInputSessionIds,
    unreadSessionIds,
    onOpenSession,
    onStartSession,
    onCardCreated,
    onCardDeleted,
    onTitleChange,
    onOpenFile,
  } = props;
  const { t } = useI18n();
  const board = useKanbanBoard(projectDir);
  const draft = cardId === null;
  const card = cardId ? board?.cards.find((entry) => entry.id === cardId) ?? null : null;
  const lane = card ? board?.lanes.find((entry) => entry.id === card.laneId) ?? null : null;
  const laneOptions = board?.lanes ?? [];

  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [draftLane, setDraftLane] = useState<string | null>(draftLaneId);
  const [draftSession, setDraftSession] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const lastSynced = useRef("");
  const titleRef = useRef<HTMLInputElement | null>(null);

  // A card changed elsewhere (another tab, the agent's own `update`): adopt it,
  // unless this editor holds unsaved text for the same card.
  useEffect(() => {
    if (!card) return;
    const key = `${card.id}:${card.updatedAt}`;
    if (lastSynced.current === key) return;
    const sameCard = lastSynced.current.startsWith(`${card.id}:`);
    lastSynced.current = key;
    if (sameCard && dirty) return;
    setTitle(card.title);
    setDescription(card.description);
    setDirty(false);
    // A card opens as it reads; an empty one opens in the editor that fills it.
    setMode(card.description ? "preview" : "write");
  }, [card, dirty]);

  // The tab's label follows the card's real title.
  const cardTitle = card?.title;
  useEffect(() => {
    if (cardTitle) onTitleChange(cardTitle);
  }, [cardTitle, onTitleChange]);

  // The card's thread: its own read, refetched when the board revision moves —
  // so a note the agent writes appears without a reload.
  const comments = useKanbanCardComments(projectDir, cardId);

  const sessionOptions = useMemo(
    () => kanbanSessionOptions(sessions, runningSessionIds, card),
    [sessions, runningSessionIds, card],
  );
  const draftLaneEntry = laneOptions.find((entry) => entry.id === draftLane) ?? laneOptions.find((entry) => !entry.fixed) ?? laneOptions[0] ?? null;
  // The backlog never takes a session: there the session control is a hint, not a picker.
  const backlogOnly = draft ? Boolean(draftLaneEntry?.fixed) : Boolean(lane?.fixed);
  const showWriteMode = useCallback(() => {
    setMode("write");
    titleRef.current?.focus();
  }, []);

  if (!board) {
    return (
      <div role="status" style={{ height: "100%", display: "grid", placeItems: "center", fontSize: 12, color: "var(--text-dim)", background: "var(--bg)" }}>
        {t("kanban.loadingBoard")}
      </div>
    );
  }

  if (!draft && !card) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, background: "var(--bg)", textAlign: "center" }}>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{t("kanban.detailGone")}</span>
        <button type="button" onClick={onCardDeleted} style={{ ...CHIP, cursor: "pointer" }}>
          {t("kanban.detailClose")}
        </button>
      </div>
    );
  }

  const awaiting = card?.sessionId ? awaitingInputSessionIds.has(card.sessionId) : false;
  const running = card?.sessionId ? runningSessionIds.has(card.sessionId) : false;
  const unread = card?.sessionId ? unreadSessionIds.has(card.sessionId) : false;
  const activityLabel = awaiting
    ? t("sidebar.agentAwaitingInput")
    : running
      ? t("sidebar.agentRunning")
      : unread
        ? t("sidebar.newActivity")
        : undefined;

  const save = () => {
    if (!card) return;
    const nextTitle = title.trim() || card.title;
    kanbanUpdateCard(projectDir, card.id, { title: nextTitle, description });
    setDirty(false);
  };

  const addNote = () => {
    if (!card || !commentText.trim()) return;
    kanbanAddCardComment(projectDir, card.id, commentText);
    setCommentText("");
  };

  const createCard = () => {
    const trimmed = title.trim();
    if (!trimmed || !draftLaneEntry) return;
    const session = backlogOnly ? null : draftSession ? sessionOptions.find((option) => option.id === draftSession) ?? null : null;
    const created = kanbanAddCard(projectDir, draftLaneEntry.id, {
      title: trimmed,
      description,
      sessionId: session?.id ?? null,
      sessionTitle: session?.title ?? null,
    });
    if (created) onCardCreated(created.id, created.title);
  };

  const canCreate = title.trim().length > 0;

  return (
    <div
      data-kanban-card-detail={card?.id ?? "draft"}
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", minHeight: 0 }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px 18px" }}>
        {/* Header: the lane it rests in, and the way out. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, ...CHIP, paddingRight: 7 }}>
            <KanbanGlyph size={12} />
            <select
              value={card ? card.laneId : draftLaneEntry?.id ?? ""}
              onChange={(event) => {
                const laneId = event.target.value;
                if (draft) setDraftLane(laneId);
                else if (card) kanbanMoveCard(projectDir, card.id, laneId);
              }}
              aria-label={t("kanban.detailLane")}
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                padding: "0 2px",
                outline: "none",
                maxWidth: 170,
              }}
            >
              {laneOptions.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={card ? entry.id !== card.laneId && !canRestInLane(card, entry) : false}
                >
                  {entry.name}
                </option>
              ))}
            </select>
            <CaretIcon />
          </label>
          <span style={{ flex: 1 }} />
          {!draft && card && (
            <button
              type="button"
              onClick={() => {
                kanbanDeleteCard(projectDir, card.id);
                onCardDeleted();
              }}
              title={t("kanban.detailDelete")}
              aria-label={t("kanban.detailDelete")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                padding: 0,
                background: "none",
                border: "1px solid transparent",
                borderRadius: 6,
                color: "var(--text-dim)",
                cursor: "pointer",
                flexShrink: 0,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.color = "#e5484d";
                event.currentTarget.style.borderColor = "color-mix(in srgb, #e5484d 40%, transparent)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = "var(--text-dim)";
                event.currentTarget.style.borderColor = "transparent";
              }}
            >
              <TrashIcon />
            </button>
          )}
        </div>

        {/* The title: borderless, the way a document reads. */}
        <input
          ref={titleRef}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setDirty(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (draft) {
              if (canCreate) createCard();
            } else {
              save();
            }
          }}
          placeholder={t("kanban.detailTitlePlaceholder")}
          aria-label={t("kanban.cardFormTitle")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            margin: "8px 0 0",
            padding: "2px 0",
            fontSize: 17,
            fontWeight: 600,
            lineHeight: 1.35,
            color: "var(--text)",
            background: "transparent",
            border: "none",
            outline: "none",
          }}
        />

        {/* Session and the card's timestamps. */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {card?.sessionId ? (
            <button
              type="button"
              onClick={() => card.sessionId && onOpenSession(card.sessionId, card.sessionTitle ?? card.title)}
              title={t("kanban.detailOpenSession")}
              style={{ ...CHIP, maxWidth: "min(100%, 330px)" }}
            >
              {awaiting ? (
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "#e5a233", flexShrink: 0 }} />
              ) : running ? (
                <SpinnerIcon size={11} />
              ) : unread ? (
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />
              ) : (
                <KanbanGlyph size={11} />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {card.sessionTitle ?? card.title}
              </span>
              {activityLabel && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>· {activityLabel}</span>}
            </button>
          ) : backlogOnly ? (
            <span style={{ ...CHIP, cursor: "default" }} title={t("kanban.backlogNoSessions")}>
              {t("kanban.detailBacklogHint")}
            </span>
          ) : (
            <label style={{ ...CHIP, paddingRight: 6, gap: 6 }}>
              <select
                value={draft ? draftSession ?? "" : card?.sessionId ?? ""}
                onChange={(event) => {
                  const sessionId = event.target.value;
                  if (draft) {
                    setDraftSession(sessionId || null);
                    return;
                  }
                  if (!card) return;
                  if (!sessionId) {
                    kanbanUnlinkCard(projectDir, card.id);
                    return;
                  }
                  const option = sessionOptions.find((entry) => entry.id === sessionId);
                  if (option) kanbanLinkCard(projectDir, card.id, option.id, option.title);
                }}
                aria-label={t("kanban.detailSession")}
                style={{
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                  padding: 0,
                  outline: "none",
                  maxWidth: 190,
                }}
              >
                <option value="">{t("kanban.detailNoSession")}</option>
                {sessionOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.running ? "● " : ""}{option.title}
                  </option>
                ))}
              </select>
              <CaretIcon />
            </label>
          )}
          {card?.sessionId && (
            <button
              type="button"
              onClick={() => kanbanUnlinkCard(projectDir, card.id)}
              style={{ ...SEGMENT_BASE, color: "var(--text-dim)" }}
              title={t("kanban.menuUnlink")}
            >
              {t("kanban.detailUnlink")}
            </button>
          )}
          {card && !card.sessionId && !backlogOnly && (
            <button
              type="button"
              onClick={() => onStartSession(card)}
              style={{ ...SEGMENT_BASE, color: "var(--accent)" }}
            >
              {t("kanban.detailStartSession")}
            </button>
          )}
          {card && (
            <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
              {t("kanban.detailUpdated", { time: relativeTime(card.updatedAt) })}
            </span>
          )}
        </div>

        {/* Description: the card's editor, ChatInput-shaped (Markdown, Ctrl+Enter). */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={SECTION_LABEL}>{t("kanban.detailDescription")}</span>
            <span style={{ flex: 1 }} />
            <div data-kanban-detail-modes style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 7 }}>
              <button
                type="button"
                onClick={showWriteMode}
                data-kanban-detail-mode="write"
                aria-pressed={mode === "write"}
                style={{
                  ...SEGMENT_BASE,
                  background: mode === "write" ? "var(--bg-selected)" : "transparent",
                  color: mode === "write" ? "var(--text)" : "var(--text-dim)",
                }}
              >
                {t("kanban.detailWrite")}
              </button>
              <button
                type="button"
                onClick={() => setMode("preview")}
                data-kanban-detail-mode="preview"
                aria-pressed={mode === "preview"}
                style={{
                  ...SEGMENT_BASE,
                  background: mode === "preview" ? "var(--bg-selected)" : "transparent",
                  color: mode === "preview" ? "var(--text)" : "var(--text-dim)",
                }}
              >
                {t("kanban.detailPreview")}
              </button>
            </div>
          </div>

          {mode === "write" ? (
            <div style={{ marginTop: 8, ...FIELD, padding: 0, overflow: "hidden" }}>
              <textarea
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setDirty(true);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
                  event.preventDefault();
                  if (draft) {
                    if (canCreate) createCard();
                  } else {
                    save();
                  }
                }}
                placeholder={t("kanban.detailDescriptionPlaceholder")}
                aria-label={t("kanban.detailDescription")}
                rows={draft ? 8 : 10}
                style={{
                  display: "block",
                  width: "100%",
                  boxSizing: "border-box",
                  resize: "vertical",
                  padding: "9px 10px",
                  minHeight: 96,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--text)",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("kanban.detailEditorHint")}</span>
                <span style={{ flex: 1 }} />
                {dirty && !draft && <span style={{ fontSize: 10.5, color: "var(--accent)" }}>{t("kanban.detailUnsaved")}</span>}
                {draft ? (
                  <>
                    <button type="button" onClick={() => { setTitle(""); setDescription(""); onCardDeleted(); }} style={{ ...SEGMENT_BASE, padding: "4px 10px", border: "1px solid var(--border)" }}>
                      {t("kanban.detailDraftCancel")}
                    </button>
                    <button
                      type="button"
                      disabled={!canCreate}
                      onClick={createCard}
                      style={{
                        padding: "4px 12px",
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: "none",
                        cursor: canCreate ? "pointer" : "default",
                        background: canCreate ? "var(--accent)" : "var(--bg-hover)",
                        color: canCreate ? "var(--accent-contrast)" : "var(--text-dim)",
                      }}
                    >
                      {t("kanban.detailDraftAdd")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={!dirty}
                    onClick={save}
                    style={{
                      padding: "4px 12px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      borderRadius: 6,
                      border: "none",
                      cursor: dirty ? "pointer" : "default",
                      background: dirty ? "var(--accent)" : "var(--bg-hover)",
                      color: dirty ? "var(--accent-contrast)" : "var(--text-dim)",
                    }}
                  >
                    {t("kanban.detailSave")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                marginTop: 8,
                padding: "2px 0",
                fontSize: 12.5,
                lineHeight: 1.6,
                color: description ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {description ? (
                <MarkdownBody cwd={projectDir} onOpenFile={onOpenFile}>
                  {description}
                </MarkdownBody>
              ) : (
                <button type="button" onClick={showWriteMode} style={{ ...SEGMENT_BASE, color: "var(--text-dim)", padding: 0 }}>
                  {t("kanban.detailNoDescription")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Journal: what the next session needs, written down. */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={SECTION_LABEL}>{t("kanban.detailComments")}</span>
            {comments.total > 0 && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{comments.total}</span>
            )}
          </div>
          {draft ? (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-dim)" }}>{t("kanban.detailCommentsDraft")}</p>
          ) : (
            <>
              {comments.status === "error" && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "#e5484d" }}>{comments.error}</p>
              )}
              {comments.comments.length === 0 ? (
                comments.status === "loading" ? null : (
                  <p style={{ margin: "8px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-dim)" }}>{t("kanban.detailCommentsEmpty")}</p>
                )
              ) : (
                <ul style={{ margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {comments.comments.map((comment) => (
                    <CommentEntry
                      key={comment.id}
                      comment={comment}
                      onDelete={(commentId) => card && kanbanDeleteCardComment(projectDir, card.id, commentId)}
                    />
                  ))}
                </ul>
              )}
              <div style={{ marginTop: 8, ...FIELD, padding: 0, overflow: "hidden" }}>
                <textarea
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
                    event.preventDefault();
                    addNote();
                  }}
                  placeholder={t("kanban.detailCommentPlaceholder")}
                  aria-label={t("kanban.detailCommentPlaceholder")}
                  rows={2}
                  style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    resize: "vertical",
                    minHeight: 46,
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--text)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: "inherit",
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px 5px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {projectName}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    disabled={!commentText.trim()}
                    onClick={addNote}
                    style={{
                      padding: "4px 12px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      borderRadius: 6,
                      border: "none",
                      cursor: commentText.trim() ? "pointer" : "default",
                      background: commentText.trim() ? "var(--accent)" : "var(--bg-hover)",
                      color: commentText.trim() ? "var(--accent-contrast)" : "var(--text-dim)",
                    }}
                  >
                    {t("kanban.detailCommentAdd")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
