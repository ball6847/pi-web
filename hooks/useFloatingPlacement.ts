"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { isSoftKeyboardResize } from "@/lib/soft-keyboard";

/**
 * A popup whose place must survive the soft keyboard (lib/soft-keyboard.ts
 * explains the two ways it moves the viewport).
 *
 * - `viewport()` is the box to clamp the popup to: the **visual** viewport, so
 *   an iOS keyboard (which shrinks only that one) covers nothing the popup put
 *   itself on, and a phone's keyboard band is not counted as room.
 * - `subscribePlacement` registers the popup's re-place pass. Every resize,
 *   scroll and step of the keyboard's animation runs it, once per frame, plus
 *   one settle pass after the last change: WebKit reports the shrunken visual
 *   viewport only once its animation finishes (bugs.webkit.org 265578), so a
 *   popup placed on the first event lands on the box the viewport has left by
 *   the time the keyboard has finished opening.
 * - `isRealResize(previous, next)` tells a phone turning (or a window drag)
 *   from the keyboard's own resizes. A popup whose anchor rectangle would then
 *   point at nothing closes on a real one — and must not close on the others,
 *   or it vanishes one frame after its own filter field raised the keyboard.
 */

/** How long after a viewport change the popup re-places once more. */
export const SOFT_KEYBOARD_SETTLE_MS = 260;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface FloatingPlacement {
  /** The box to clamp the popup to: the visual viewport (the keyboard's band excluded). */
  viewport(): ViewportSize;
  /** Re-place the popup: called for every keyboard resize, scroll and settle step. */
  subscribePlacement(replace: () => void): () => void;
}

/** Whether the viewport change from `previous` to `next` is a real resize, not the keyboard's. */
export function isRealResize(previous: ViewportSize, next: ViewportSize): boolean {
  return !isSoftKeyboardResize(previous, next);
}

/** The viewport as the page sees it now: the visual one when the browser has it. */
export function readViewport(): ViewportSize {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

/** One re-place per animation frame: a keyboard animation fires dozens of resizes. */
function frameScheduler(callback: () => void): () => void {
  let frame = 0;
  return () => {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      callback();
    });
  };
}

export function useFloatingPlacement(open: boolean): FloatingPlacement {
  const listeners = useRef(new Set<() => void>());
  const subscribePlacement = useCallback((replace: () => void) => {
    listeners.current.add(replace);
    // The popup is positioned already: a pass right away places it before the
    // first paint, and a body swapped under an open popup is measured at once.
    replace();
    return () => {
      listeners.current.delete(replace);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let timeout = 0;
    const run = () => listeners.current.forEach((replace) => replace());
    const schedule = frameScheduler(run);
    const onMeasured = () => {
      schedule();
      window.clearTimeout(timeout);
      timeout = window.setTimeout(run, SOFT_KEYBOARD_SETTLE_MS);
    };
    window.addEventListener("resize", onMeasured);
    window.visualViewport?.addEventListener("resize", onMeasured);
    // iOS scrolls the layout viewport (or pans the visual one) instead of
    // resizing it: the clamped box moves without a resize event.
    const onScroll = () => schedule();
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onMeasured);
      window.visualViewport?.removeEventListener("resize", onMeasured);
      window.removeEventListener("scroll", onScroll, true);
      window.clearTimeout(timeout);
    };
  }, [open]);

  return useMemo(() => ({ viewport: readViewport, subscribePlacement }), [subscribePlacement]);
}
