"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { KanbanCard } from "@/lib/kanban-types";

/**
 * Dragging a kanban card between lanes (components/KanbanBoard.tsx). The
 * pointer-event state machine of hooks/useGroupDrag adapted to the board:
 * the lanes are a horizontal row of columns (not a virtualized list), so the
 * drop target is hit-tested against the lane columns' rects and the
 * auto-scroll goes sideways (and down a long lane's own card list). A mouse
 * picks the card up once it has moved DRAG_START_PX; touch and pen hold it
 * LONG_PRESS_MS first, so a swipe still scrolls and a tap still opens the
 * card. `mode: "menu"` (the phone's one-lane view, where a target lane is
 * never on screen) never drags: a held press opens the card menu instead.
 */

/** A mouse drag starts once the pointer has moved this far. */
const DRAG_START_PX = 4;
/** Touch and pen: a press held this long picks the card up (or opens the menu). */
const LONG_PRESS_MS = 350;
/** A finger that moves farther before that is scrolling: the press is let go. */
const LONG_PRESS_SLOP_PX = 8;
/** How near the row's left or right edge a drag scrolls it sideways. */
const AUTO_SCROLL_EDGE = 32;
/** In menu mode a held press that wanders this far is a scroll, not a menu: it is let go. */
const MENU_HOLD_SLOP_PX = 30;
/** Most pixels auto-scroll moves the row or a lane's card list in one frame. */
const AUTO_SCROLL_MAX_STEP = 14;
/** Room the ghost keeps from the pointer: a finger or pen hides more than a cursor. */
/** The click a release produces follows it at once; one later than this is the user's own. */
const CLICK_SUPPRESS_MS = 600;

type DragPhase = "pending" | "armed" | "menu" | "dragging" | "cancelled";

interface DragState {
  pointerId: number;
  pointerType: string;
  cardId: string;
  /** The card element: it holds the pointer capture and is where the press started. */
  element: HTMLElement;
  startX: number;
  startY: number;
  armX: number;
  armY: number;
  clientX: number;
  clientY: number;
  phase: DragPhase;
  timer: number | null;
  frame: number | null;
  /** The row's scrollLeft as the drag left it: any other value means the browser scrolled it. */
  expectedScrollLeft: number;
  laneId: string | null;
  /** The gap in that lane the drop lands in: the card it goes before, or null for the lane's end. */
  beforeCardId: string | null;
  ghost: boolean;
  /** The card's board-relative rect at pick-up: the clone stays there, offset by the pointer. */
  ghostOrig: { left: number; top: number; width: number } | null;
}

export interface KanbanCardDragView {
  cardId: string;
  /** "armed": a long-press picked the card up; "dragging": it follows the pointer. */
  phase: "armed" | "dragging";
  /** The lane under the pointer, or null (between lanes). The source lane counts: dropping back reorders. */
  laneId: string | null;
  /** The card the drop would land before in that lane; null = the lane's end. */
  beforeCardId: string | null;
}

/** Stable: a card calls these from its own listeners. */
export interface KanbanCardDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>, cardId: string): void;
  /** From the card's non-passive touchmove listener: holds the lane's card list still while the card is picked up. */
  onTouchMove(event: TouchEvent): void;
}

export interface KanbanCardDragOptions {
  /** "drag": all lanes are visible (desktop, wide touch); "menu": one lane at a time (a held press opens the card menu). */
  mode: "drag" | "menu";
  /** False while the board is not loaded; a drag under way is cancelled. */
  enabled: boolean;
  /** The board's cards: the dragged card is looked up here. */
  cards: KanbanCard[];
  /** The board's lanes, in order: changing the list re-runs a drag in flight. */
  laneIds: string[];
  rowRef: RefObject<HTMLDivElement | null>;
  /** The board container, the ghost's positioned parent. */
  boardRef: RefObject<HTMLElement | null>;
  ghostRef: RefObject<HTMLDivElement | null>;
  /** Drop the card at that gap: in any lane, the source included (a same-place drop is the reducer's no-op). */
  onMove(cardId: string, laneId: string, beforeCardId: string | null): void;
  /** Menu mode only: the held press opens the card menu anchored to the card. */
  onLongPress(cardId: string, anchor: DOMRect): void;
}

export interface KanbanCardDragApi {
  view: KanbanCardDragView | null;
  handlers: KanbanCardDragHandlers;
  /** On the board root: eats the click a drag's (or a long-press's) release produces. */
  onClickCapture(event: ReactMouseEvent): void;
  /** On the board root: a new press means the next click is the user's. */
  onPointerDownCapture(): void;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Laid out: not display: none itself or inside something that is. */
function isRendered(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

export function useKanbanCardDrag(options: KanbanCardDragOptions): KanbanCardDragApi {
  const { cards, laneIds, enabled } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dragRef = useRef<DragState | null>(null);
  // Event time (timeStamp) until which a click is the release's own; 0 = none.
  const suppressClickUntilRef = useRef(0);
  // Set only when the phase or the target lane changes, never per pointermove.
  const [state, setState] = useState<KanbanCardDragView | null>(null);

  const machine = useMemo(() => {
    const laneOf = (element: HTMLElement): string | null =>
      element instanceof Element && element.dataset ? element.dataset.kanbanLane ?? null : null;

    /**
     * The card a drop at `clientY` lands before: the first card of the lane
     * whose vertical midpoint is below the pointer. Null = the lane's end
     * (also for an empty lane). The lane's own card list scrolls, so this
     * reads rects, not offsets.
     */
    const insertionBefore = (laneEl: HTMLElement, clientY: number): string | null => {
      for (const el of Array.from(laneEl.querySelectorAll<HTMLElement>("[data-kanban-card]"))) {
        const r = el.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return el.dataset.kanbanCard ?? null;
      }
      return null;
    };

    /** The lane whose column holds the pointer, and the gap the drop lands in; null between lanes. */
    const dropFor = (drag: DragState): { laneId: string; beforeCardId: string | null } | null => {
      const row = optionsRef.current.rowRef.current;
      if (!row || !isRendered(row)) return null;
      for (const el of Array.from(row.querySelectorAll<HTMLElement>("[data-kanban-lane]"))) {
        const r = el.getBoundingClientRect();
        if (drag.clientX >= r.left && drag.clientX <= r.right && drag.clientY >= r.top && drag.clientY <= r.bottom) {
          const laneId = laneOf(el);
          return laneId ? { laneId, beforeCardId: insertionBefore(el, drag.clientY) } : null;
        }
      }
      return null;
    };

    const placeGhost = () => {
      const drag = dragRef.current;
      const ghost = optionsRef.current.ghostRef.current;
      if (!drag?.ghost || !ghost || !drag.ghostOrig) return;
      // The clone sits where the card sat and moves by the pointer's travel
      // since the pick-up: the card looks picked up as-is.
      const dx = drag.clientX - drag.startX;
      const dy = drag.clientY - drag.startY;
      ghost.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const stopMotion = (drag: DragState) => {
      if (drag.timer !== null) window.clearTimeout(drag.timer);
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      drag.timer = null;
      drag.frame = null;
      const ghost = optionsRef.current.ghostRef.current;
      if (ghost) {
        ghost.innerHTML = "";
        ghost.style.transform = "none";
      }
      document.body.style.userSelect = "";
      drag.ghostOrig = null;
      try {
        if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released with the pointer.
      }
    };

    /** Ends the gesture: timers, frames, capture, listeners and the view. */
    const teardown = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      stopMotion(drag);
      removeListeners();
      setState(null);
    };

    /**
     * A picked-up card goes back without moving, but the gesture waits for
     * its release, whose click must not open the card's session. A press not
     * picked up yet (or a menu hold) just ends.
     */
    const cancel = () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.phase === "pending" || drag.phase === "menu") {
        teardown();
        return;
      }
      drag.phase = "cancelled";
      drag.laneId = null;
      drag.beforeCardId = null;
      stopMotion(drag);
      setState(null);
    };

    const updateDrag = (force = false) => {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "dragging") return;
      const hit = dropFor(drag);
      const laneId = hit?.laneId ?? null;
      const beforeCardId = hit?.beforeCardId ?? null;
      const changed = force || laneId !== drag.laneId || beforeCardId !== drag.beforeCardId;
      drag.laneId = laneId;
      drag.beforeCardId = beforeCardId;
      placeGhost();
      if (changed) publish(drag);
    };

    const publish = (drag: DragState) => {
      setState(drag.phase === "armed" || drag.phase === "dragging"
        ? { cardId: drag.cardId, phase: drag.phase, laneId: drag.laneId, beforeCardId: drag.beforeCardId }
        : null);
    };

    // Each frame of a drag near an edge scrolls: the row sideways, and the
    // lane under the pointer down its own card list (a long lane).
    const autoScroll = () => {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "dragging") return;
      drag.frame = null;
      const row = optionsRef.current.rowRef.current;
      if (!row || !isRendered(row)) {
        cancel();
        return;
      }
      const box = row.getBoundingClientRect();
      let delta = 0;
      if (drag.clientX > box.right - AUTO_SCROLL_EDGE) delta = AUTO_SCROLL_MAX_STEP;
      else if (drag.clientX < box.left + AUTO_SCROLL_EDGE) delta = -AUTO_SCROLL_MAX_STEP;
      if (delta !== 0) {
        const maxLeft = row.scrollWidth - row.clientWidth;
        const next = Math.min(Math.max(0, maxLeft), Math.max(0, row.scrollLeft + delta));
        if (next !== row.scrollLeft) {
          row.scrollLeft = next;
          drag.expectedScrollLeft = row.scrollLeft;
        }
      }
      if (drag.laneId) {
        const laneEl = Array.from(row.querySelectorAll<HTMLElement>("[data-kanban-lane]")).find((el) => el.dataset.kanbanLane === drag.laneId);
        const list = laneEl?.querySelector<HTMLElement>("[data-kanban-lane-cards]");
        if (list) {
          const lbox = list.getBoundingClientRect();
          let vDelta = 0;
          if (drag.clientY > lbox.bottom - AUTO_SCROLL_EDGE) vDelta = AUTO_SCROLL_MAX_STEP;
          else if (drag.clientY < lbox.top + AUTO_SCROLL_EDGE) vDelta = -AUTO_SCROLL_MAX_STEP;
          if (vDelta !== 0) {
            const maxTop = list.scrollHeight - list.clientHeight;
            list.scrollTop = Math.min(Math.max(0, maxTop), Math.max(0, list.scrollTop + vDelta));
          }
        }
      }
      if (dragRef.current === drag && drag.phase === "dragging") {
        updateDrag();
        drag.frame = requestAnimationFrame(autoScroll);
      }
    };

    const startDragging = (drag: DragState) => {
      const row = optionsRef.current.rowRef.current;
      if (!row || !isRendered(row) || !drag.element.isConnected) {
        cancel();
        return;
      }
      drag.phase = "dragging";
      // A release outside the window still reaches the card. Touch has an implicit capture.
      if (drag.pointerType !== "touch") {
        try {
          drag.element.setPointerCapture(drag.pointerId);
        } catch {
          // The window listeners still see the pointer.
        }
      }
      drag.ghost = true;
      const ghost = optionsRef.current.ghostRef.current;
      const board = optionsRef.current.boardRef.current;
      if (ghost && board) {
        const boardRect = board.getBoundingClientRect();
        const r = drag.element.getBoundingClientRect();
        drag.ghostOrig = { left: r.left - boardRect.left, top: r.top - boardRect.top, width: r.width };
        ghost.style.left = `${drag.ghostOrig.left}px`;
        ghost.style.top = `${drag.ghostOrig.top}px`;
        ghost.style.width = `${r.width}px`;
        ghost.innerHTML = "";
        const clone = drag.element.cloneNode(true) as HTMLElement;
        clone.removeAttribute("data-kanban-card");
        ghost.appendChild(clone);
      }
      // A picked-up card must not drag a text selection along with it.
      document.body.style.userSelect = "none";
      drag.expectedScrollLeft = row.scrollLeft;
      drag.frame = requestAnimationFrame(autoScroll);
      updateDrag(true);
    };

    const arm = () => {
      const drag = dragRef.current;
      if (!drag || drag.phase !== "pending") return;
      drag.timer = null;
      if (optionsRef.current.mode === "menu") {
        // A held press with no lanes to drop onto: the card menu opens when
        // the press is released (a fired menu would be closed again by the
        // synthetic mousedown of the same gesture).
        drag.phase = "menu";
        return;
      }
      drag.phase = "armed";
      drag.armX = drag.clientX;
      drag.armY = drag.clientY;
      drag.expectedScrollLeft = optionsRef.current.rowRef.current?.scrollLeft ?? 0;
      publish(drag);
    };

    /** Drop the picked-up card at the gap under the pointer: the one evaluation shared by a release, a cancel, and a release lost outside the window. */
    const dropAt = (drag: DragState) => {
      const drop = dropFor(drag);
      // The source lane takes the card back too: that is a reorder, and a drop
      // where it already was is the reducer's no-op (nothing is written).
      if (drop) optionsRef.current.onMove(drag.cardId, drop.laneId, drop.beforeCardId);
    };

    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      // A release outside the window: no pointerup came, this move is all we
      // get. A picked-up card drops at its last position; a press not picked
      // up yet just ends.
      if (drag.pointerType === "mouse" && event.buttons === 0) {
        if (drag.phase === "dragging") dropAt(drag);
        teardown();
        return;
      }
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
      const moved = distance(drag.startX, drag.startY, event.clientX, event.clientY);
      switch (drag.phase) {
        case "pending":
          if (drag.pointerType === "mouse" && optionsRef.current.mode === "drag") {
            if (moved >= DRAG_START_PX) startDragging(drag);
          } else if (moved > LONG_PRESS_SLOP_PX) {
            // A swipe: the board scrolls as usual.
            teardown();
          }
          break;
        case "armed":
          if (distance(drag.armX, drag.armY, event.clientX, event.clientY) >= DRAG_START_PX) startDragging(drag);
          break;
        case "menu":
          // The held press waits for its release, but a wander this far is a
          // scroll the browser takes over: the menu never opens for it.
          if (distance(drag.startX, drag.startY, event.clientX, event.clientY) > MENU_HOLD_SLOP_PX) teardown();
          break;
        case "dragging":
          updateDrag();
          break;
      }
    }

    function onPointerUp(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.phase === "menu") {
        // The hold is over: the card menu opens, and the release's own click
        // must not go on to open the card's session.
        suppressClickUntilRef.current = event.timeStamp + CLICK_SUPPRESS_MS;
        optionsRef.current.onLongPress(drag.cardId, drag.element.getBoundingClientRect());
        teardown();
        return;
      }
      if (drag.phase === "dragging") dropAt(drag);
      // A plain click (still pending) opens the card's session; after a pick-up it must not.
      if (drag.phase !== "pending") suppressClickUntilRef.current = event.timeStamp + CLICK_SUPPRESS_MS;
      teardown();
    }

    function onPointerCancel(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      // A trackpad can end the gesture with a cancel at the moment of release:
      // for a mouse pointer that is the user's release, so a picked-up card
      // drops where the pointer was.
      if (drag.pointerType === "mouse" && drag.phase === "dragging") {
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        dropAt(drag);
      }
      teardown();
    }

    // A second finger (or pointer) is not a drag.
    function onOtherPointerDown(event: PointerEvent) {
      if (dragRef.current && event.pointerId !== dragRef.current.pointerId) cancel();
    }

    // Escape puts a picked-up card back. In the capture phase, marked handled,
    // so the window-level Escape that stops a running agent leaves it alone.
    function onKeyDown(event: KeyboardEvent) {
      const drag = dragRef.current;
      if (!drag || event.key !== "Escape" || (drag.phase !== "armed" && drag.phase !== "dragging")) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }

    // Android's long-press menu, or a Ctrl+click: a press not picked up yet
    // ends; once picked up the menu is held back.
    function onContextMenu(event: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.phase === "pending") {
        teardown();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }

    function onBlur() {
      teardown();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") teardown();
    }

    function addListeners() {
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerCancel, true);
      window.addEventListener("pointerdown", onOtherPointerDown, true);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("contextmenu", onContextMenu, true);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function removeListeners() {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("pointerdown", onOtherPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    const handlers: KanbanCardDragHandlers = {
      // Never preventDefault here: a plain click or tap must still open the card.
      onPointerDown(event, cardId) {
        if (!optionsRef.current.enabled || dragRef.current) return;
        if (!event.isPrimary || event.button !== 0 || event.ctrlKey) return;
        // The card's buttons (the ⋯ menu, the session chip) keep their own clicks.
        if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, [contenteditable]")) return;
        if (!optionsRef.current.cards.some((c) => c.id === cardId)) return;
        const element = event.currentTarget;
        const drag: DragState = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          cardId,
          element,
          startX: event.clientX,
          startY: event.clientY,
          ghostOrig: null,
          armX: event.clientX,
          armY: event.clientY,
          clientX: event.clientX,
          clientY: event.clientY,
          phase: "pending",
          timer: null,
          frame: null,
          expectedScrollLeft: 0,
          laneId: null,
          beforeCardId: null,
          ghost: false,
        };
        dragRef.current = drag;
        addListeners();
        // Touch and pen scroll the board natively: they pick the card up with a held press (or open the menu).
        if (event.pointerType !== "mouse") drag.timer = window.setTimeout(arm, LONG_PRESS_MS);
      },
      onTouchMove(event) {
        const drag = dragRef.current;
        // Before the pick-up the board scrolls as usual (pointercancel ends the press).
        if (!drag || (drag.phase !== "armed" && drag.phase !== "dragging")) return;
        if (event.cancelable) {
          event.preventDefault();
          return;
        }
        // Not cancelable: Chrome sends such moves inside its touch slop too.
        // Only a row the browser really scrolled ends the drag.
        const row = optionsRef.current.rowRef.current;
        if (row && row.scrollLeft !== drag.expectedScrollLeft) teardown();
      },
    };

    return { handlers, cancel, teardown, updateDrag, placeGhost, arm, startDragging };
  }, []);

  // The board re-renders on every change: the dragged card may be gone (edited
  // away or deleted in another window), else the lanes under it moved.
  // optionsRef is read (the stable holder of the latest values) while
  // cards/laneIds stay in the deps so a board change re-runs this.
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (!drag || (drag.phase !== "armed" && drag.phase !== "dragging")) return;
    if (!optionsRef.current.cards.some((c) => c.id === drag.cardId)) machine.cancel();
    else machine.updateDrag();
  }, [cards, laneIds, machine]);

  useEffect(() => {
    if (!enabled) machine.cancel();
  }, [enabled, machine]);

  const dragging = state?.phase === "dragging";
  // The ghost mounts with the drag; it gets its place before it is painted.
  useLayoutEffect(() => {
    if (dragging) machine.placeGhost();
  }, [dragging, machine]);

  useEffect(() => () => machine.teardown(), [machine]);

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    const until = suppressClickUntilRef.current;
    if (until === 0) return;
    suppressClickUntilRef.current = 0;
    if (event.timeStamp > until) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const onPointerDownCapture = useCallback(() => {
    suppressClickUntilRef.current = 0;
  }, []);

  const view = useMemo<KanbanCardDragView | null>(
    () => (state && (state.phase === "armed" || state.phase === "dragging") ? state : null),
    [state],
  );

  return { view, handlers: machine.handlers, onClickCapture, onPointerDownCapture };
}
