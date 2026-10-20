"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Dragging a kanban LANE to a new position — the board's lane columns
 * (axis "x") and the config dialog's lane rows (axis "y"). Pointer events,
 * not HTML5 drag and drop, for the same reasons as the sidebar's group
 * drag (hooks/useGroupDrag.ts). A mouse picks the lane up once it has moved
 * DRAG_START_PX; with allowTouch, touch and pen hold it LONG_PRESS_MS first,
 * so a swipe still scrolls. The drop position comes from the lane
 * elements' rects (elementOf), never from the DOM hit-test: the final index
 * 0 belongs to the fixed backlog, so the line can never land before it.
 * A release on the lane's own position posts nothing.
 */

/** A mouse drag starts once the pointer has moved this far. */
const DRAG_START_PX = 5;
/** A touch held this long picks the lane up. */
const LONG_PRESS_MS = 350;
/** A touch that moves farther before the long press is a swipe: it is let go. */
const LONG_PRESS_SLOP_PX = 8;
/** How near the scroll box's edge a drag scrolls it. */
const EDGE_PX = 32;
/** Most pixels auto-scroll moves the box in one pointermove. */
const MAX_STEP = 14;

interface LaneDragState {
  pointerId: number;
  pointerType: string;
  laneId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  phase: "pending" | "dragging";
  timer: number | null;
}

interface LaneDragOptions {
  /** The lanes in their current order: index 0 is the fixed one (backlog). */
  laneIds: string[];
  /** The lane's element (column or row) for the midpoint hit-test and the dim. */
  elementOf(laneId: string): HTMLElement | null;
  /** "x": columns side by side (the board); "y": rows stacked (the dialog). */
  axis: "x" | "y";
  /** The scroll box the lanes sit in: it scrolls out of the way near the edges. */
  scrollElement?(): HTMLElement | null;
  /** Touch/pen long-press support (the dialog, which also scrolls by touch). */
  allowTouch?: boolean;
  /** The dragged lane's final index (1..laneIds.length - 1) on a committed drop. */
  onReorder(laneId: string, toIndex: number): void;
}

export interface LaneDragView {
  /** The lane under the pointer, while it is being dragged. */
  draggingLaneId: string | null;
  /**
   * The dragged lane's final index (1..laneIds.length - 1); null while the
   * pointer sits where it already is. Render the line BEFORE original index
   * `dropIndex` when `dropIndex <= draggingIndex`, else before `dropIndex + 1`
   * (== laneIds.length: after the last one).
   */
  dropIndex: number | null;
  /** The drag ghost: it follows the pointer through its style, not state. */
  ghostRef: React.RefObject<HTMLDivElement | null>;
}

export interface LaneDragApi {
  view: LaneDragView;
  /** On the drag handle (a column header, a row's grip). */
  beginDrag(event: ReactPointerEvent<HTMLElement>, laneId: string): void;
}

export function useKanbanLaneDrag(options: LaneDragOptions): LaneDragApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dragRef = useRef<LaneDragState | null>(null);
  const listenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: () => void;
    key: (e: KeyboardEvent) => void;
  } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [draggingLaneId, setDraggingLaneId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  dropIndexRef.current = dropIndex;

  const reset = useCallback(() => {
    const drag = dragRef.current;
    if (drag && drag.timer !== null) window.clearTimeout(drag.timer);
    dragRef.current = null;
    const listeners = listenersRef.current;
    if (listeners) {
      window.removeEventListener("pointermove", listeners.move);
      window.removeEventListener("pointerup", listeners.up);
      window.removeEventListener("pointercancel", listeners.cancel);
      window.removeEventListener("keydown", listeners.key);
      listenersRef.current = null;
    }
    setDraggingLaneId(null);
    setDropIndex(null);
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      const wasDragging = drag.phase === "dragging";
      const to = dropIndexRef.current;
      const laneId = drag.laneId;
      reset();
      if (!commit || !wasDragging || to === null) return;
      const from = optionsRef.current.laneIds.findIndex((id) => id === laneId);
      if (from >= 0 && to !== from) optionsRef.current.onReorder(laneId, to);
    },
    [reset],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, laneId: string) => {
      const opts = optionsRef.current;
      if (dragRef.current) return;
      if (event.button !== 0) return;
      // The fixed first lane never moves.
      if (laneId === opts.laneIds[0]) return;
      if (event.pointerType === "touch" && !opts.allowTouch) return;
      const drag: LaneDragState = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        laneId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        phase: "pending",
        timer: null,
      };
      dragRef.current = drag;

      const arm = () => {
        const d = dragRef.current;
        if (!d || d.phase !== "pending") return;
        d.phase = "dragging";
        setDraggingLaneId(d.laneId);
      };

      const move = (e: PointerEvent) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pointerId) return;
        const o = optionsRef.current;
        if (d.phase === "pending") {
          const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
          if (d.pointerType === "mouse") {
            if (dist >= DRAG_START_PX) arm();
          } else if (dist >= LONG_PRESS_SLOP_PX) {
            // A swipe, not a hold: let go.
            finish(false);
            return;
          }
          if (dragRef.current?.phase !== "dragging") return;
        }
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        // The ghost follows the pointer through its style, not state.
        const ghost = ghostRef.current;
        if (ghost) {
          const gapX = d.pointerType === "mouse" ? 12 : 24;
          const gapY = d.pointerType === "mouse" ? 14 : 28;
          const left = Math.max(8, Math.min(e.clientX + gapX, window.innerWidth - ghost.offsetWidth - 8));
          const top = Math.max(8, Math.min(e.clientY + gapY, window.innerHeight - ghost.offsetHeight - 8));
          ghost.style.transform = `translate(${left}px, ${top}px)`;
        }
        // The scroll box moves out of the way near its edges, so a lane
        // beyond the visible ones still takes the drop.
        const scroll = o.scrollElement?.();
        if (scroll) {
          const box = scroll.getBoundingClientRect();
          if (o.axis === "x") {
            if (e.clientX > box.left && e.clientX < box.left + EDGE_PX) {
              scroll.scrollLeft = Math.max(0, scroll.scrollLeft - MAX_STEP);
            } else if (e.clientX < box.right && e.clientX > box.right - EDGE_PX) {
              scroll.scrollLeft = Math.min(scroll.scrollWidth - scroll.clientWidth, scroll.scrollLeft + MAX_STEP);
            }
          } else {
            if (e.clientY > box.top && e.clientY < box.top + EDGE_PX) {
              scroll.scrollTop = Math.max(0, scroll.scrollTop - MAX_STEP);
            } else if (e.clientY < box.bottom && e.clientY > box.bottom - EDGE_PX) {
              scroll.scrollTop = Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + MAX_STEP);
            }
          }
        }
        // The final index: the gap above (or left of) the first lane whose
        // midpoint the pointer has not passed, converted for the row the
        // drag removed. Index 0 is the fixed lane's, so it is never offered.
        const from = o.laneIds.findIndex((id) => id === d.laneId);
        if (from < 0) return;
        let before = o.laneIds.length; // past the last one: the final position
        for (let j = 1; j < o.laneIds.length; j++) {
          const el = o.elementOf(o.laneIds[j]);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const mid = o.axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
          const p = o.axis === "y" ? e.clientY : e.clientX;
          if (p < mid) {
            before = j;
            break;
          }
        }
        const to = before > from ? before - 1 : before;
        setDropIndex(to === from ? null : to);
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== drag.pointerId) return;
        finish(true);
      };
      const cancel = () => finish(false);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") finish(false);
      };
      listenersRef.current = { move, up, cancel, key };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key);
      if (drag.pointerType !== "mouse") drag.timer = window.setTimeout(arm, LONG_PRESS_MS);
    },
    [finish],
  );

  useEffect(() => reset, [reset]);

  // The ghost mounts on the move that arms the drag: place it where the
  // pointer already is (that move could not position it yet).
  useLayoutEffect(() => {
    if (!draggingLaneId) return;
    const ghost = ghostRef.current;
    const drag = dragRef.current;
    if (!ghost || !drag) return;
    const left = Math.max(8, Math.min(drag.lastX + 12, window.innerWidth - ghost.offsetWidth - 8));
    const top = Math.max(8, Math.min(drag.lastY + 14, window.innerHeight - ghost.offsetHeight - 8));
    ghost.style.transform = `translate(${left}px, ${top}px)`;
  }, [draggingLaneId]);

  return {
    view: { draggingLaneId, dropIndex, ghostRef },
    beginDrag,
  };
}
