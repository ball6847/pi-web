"use client";

/**
 * The caret request of the chat composer.
 *
 * The chat does not bring its field with it: it mounts, loads the transcript
 * and renders the composer a frame or two later, so a single frame's wait
 * finds nothing. A request therefore waits for the field — and gives up
 * rather than steal a focus the user has taken in the meantime.
 *
 * The rules live here, apart from the shell, so they can be tested without a
 * page: `components/AppShell.tsx` only owns the composer handle and the
 * phone check.
 */

/** The composer's imperative handle, as the focus request needs it. */
export interface ComposerFocusTarget {
  /** Puts the caret in the composer (at the end of what is typed). */
  focus: () => void;
  /** Whether the caret is in the composer right now. */
  hasFocus: () => boolean;
}

export interface ComposerFocusOptions {
  /** A phone is left alone: its keyboard would cover the chat that just opened. */
  isMobile: () => boolean;
  /** The mounted composer, or null while the chat still renders. */
  getTarget: () => ComposerFocusTarget | null;
  /** The active element, for the modal check. `document.activeElement` by default. */
  getActiveElement?: () => Element | null;
  /** How many frames the request waits for the field. */
  maxFrames?: number;
  /** The frame scheduler. `requestAnimationFrame` by default. */
  schedule?: (callback: () => void) => void;
}

/** How many frames a request waits for the composer (about two seconds). */
export const COMPOSER_FOCUS_MAX_FRAMES = 120;

export interface ComposerFocus {
  /**
   * Ask for the caret. A newer request wins over an older one.
   *
   * `force` is for an explicit request (the chord): it takes the caret even
   * from a field the user is typing in. An automatic one (a session pick)
   * gives that field its caret back.
   */
  request: (options?: { force?: boolean }) => void;
  /** Give up on the pending request. */
  cancel: () => void;
}

/**
 * Whether the focus lands on a dialog that covers the page.
 *
 * A modal (Settings, the trust dialog, the folder picker) owns the screen:
 * the panels behind it are not what the user is looking at, so the composer
 * must not take the caret away from it.
 */
function isInsideModal(element: Element | null): boolean {
  if (!element || typeof element.closest !== "function") return false;
  return element.closest("[aria-modal='true']") !== null;
}

/**
 * Whether the element is a field the user types into.
 *
 * Such a field keeps its caret: a request that would take it while the user
 * is typing there is a request that must give up.
 */
function isTextField(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * The composer's caret request.
 *
 * One counter, so a newer request wins over an older one: a session pick
 * that is followed by another one does not focus twice, and the second pick
 * is the one that has the caret.
 */
export function createComposerFocus(options: ComposerFocusOptions): ComposerFocus {
  const schedule = options.schedule ?? ((callback: () => void) => requestAnimationFrame(callback));
  const getActiveElement = options.getActiveElement
    ?? (() => (typeof document === "undefined" ? null : document.activeElement));
  const maxFrames = options.maxFrames ?? COMPOSER_FOCUS_MAX_FRAMES;
  let requestId = 0;

  const cancel = (): void => {
    requestId += 1;
  };

  const request = (requestOptions?: { force?: boolean }): void => {
    // A phone is left alone: its keyboard would cover the chat.
    if (options.isMobile()) return;
    const id = ++requestId;
    // Where the caret was when the request was made: a field the user moves
    // to while the request waits is theirs, and the request gives it up.
    const startElement = getActiveElement();
    let frames = 0;
    const tryFocus = (): void => {
      if (requestId !== id) return;
      const target = options.getTarget();
      if (target) {
        const active = getActiveElement();
        // A dialog still open over the page keeps the focus it has.
        if (isInsideModal(active)) {
          requestId = 0;
          return;
        }
        // The composer already has the caret: focusing it again would push
        // the caret to the end of what is being typed.
        if (target.hasFocus()) {
          requestId = 0;
          return;
        }
        // The user moved to another field while the request waited: that
        // caret is theirs. An explicit request (the chord) takes it anyway.
        if (!requestOptions?.force && active !== startElement && isTextField(active)) {
          requestId = 0;
          return;
        }
        target.focus();
        // The chat can still be hidden (the board covers it), and a focus on
        // a hidden field does nothing: try again on the next frame.
        if (target.hasFocus()) {
          requestId = 0;
          return;
        }
      }
      if (frames++ > maxFrames) {
        requestId = 0;
        return;
      }
      schedule(tryFocus);
    };
    schedule(tryFocus);
  };

  return { request, cancel };
}
