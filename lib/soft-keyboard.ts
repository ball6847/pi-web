// CLIENT-SAFE (no hooks, no DOM at import): the soft keyboard as the page can
// observe it. A phone's keyboard arrives two ways, and a popup has to survive
// both:
//
// - `interactive-widget: resizes-content` (app/layout.tsx) shrinks the *layout*
//   viewport, so the browser fires `resize` on `window` for every frame of the
//   keyboard's animation. A popup that closes on `resize` (to drop a stale
//   anchor) shuts itself the moment its own filter field raised the keyboard.
// - iOS shrinks only the *visual* viewport: `window` never resizes, but the
//   layout viewport keeps reaching under the keyboard, so a popup clamped to
//   `innerHeight` sits behind it.

/** A viewport's box, in CSS pixels: `visualViewport` when there is one. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Smallest visual-viewport shrink that can only come from the on-screen
 * keyboard. Safari's toolbar and safe-area changes stay well below it.
 * (`hooks/useViewportHeight.ts` keys its composer height off the same number.)
 */
export const SOFT_KEYBOARD_MIN_HEIGHT_PX = 60;

/**
 * The keyboard's empty band: how much shorter the visual viewport is than the
 * layout viewport at the current zoom. A pinch zoom shrinks both together
 * (`height === innerHeight / scale`), so zoom reads as no keyboard at all.
 */
export function softKeyboardBand({ innerHeight, viewportHeight, viewportScale }: {
  innerHeight: number;
  viewportHeight: number;
  viewportScale: number;
}): number {
  const scale = viewportScale > 0 ? viewportScale : 1;
  return innerHeight / scale - viewportHeight;
}

/** Whether that band is wide enough to be the keyboard rather than browser chrome. */
export function isSoftKeyboardOpen(state: {
  innerHeight: number;
  viewportHeight: number;
  viewportScale: number;
}): boolean {
  return softKeyboardBand(state) > SOFT_KEYBOARD_MIN_HEIGHT_PX;
}

/**
 * A change in size that is the soft keyboard's, not a real resize: the width
 * stayed put and only the height moved (its animation, or the band it leaves).
 * Turning the device changes the width, so it still counts as a real resize.
 */
export function isSoftKeyboardResize(previous: ViewportSize, next: ViewportSize): boolean {
  return Math.round(previous.width) === Math.round(next.width)
    && Math.round(previous.height) !== Math.round(next.height);
}
