/**
 * Which modifier is the platform's "primary" one: Command on macOS, Control
 * everywhere else.
 *
 * A chord written once then reads as `Cmd+B` on a Mac and `Ctrl+B` on Windows
 * or Linux — the way the DeepSeek Harness models it (its shortcut catalog
 * spells the modifier `primary` and resolves it per platform profile).
 */

/**
 * Whether the user agent names macOS.
 *
 * An iPad asking for desktop sites reports `Macintosh` too, so this answers
 * "macOS" for an iPad as well; an iPad has no Command key, so the modifier
 * never arrives and nothing depends on the difference.
 */
export function isMacPlatform(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return /\bMacintosh\b|\bMac OS X\b/.test(userAgent);
}

/**
 * The label for that modifier: `⌘` on macOS, `ctrl` everywhere else.
 *
 * Shortcut text is written all lowercase (`ctrl`, `alt`, `shift`, `esc`), so a
 * key label reads the same in a tooltip, a hint row and a footer.
 */
export function primaryModifierLabel(isMac: boolean): string {
  return isMac ? "⌘" : "ctrl";
}

/**
 * The label for the secondary modifier: `⌥` (Option) on macOS, `alt`
 * everywhere else.
 */
export function altModifierLabel(isMac: boolean): string {
  return isMac ? "⌥" : "alt";
}

/** The user agent of this browser, read once and kept (null on the server). */
let cachedUserAgent: string | null | undefined;

/**
 * Whether this browser runs on macOS, read from the user agent once.
 *
 * For a key handler that must answer at event time — xterm's custom key
 * handler, which is installed once and never reinstalled — so the platform
 * is settled before the first keystroke rather than after a re-render.
 */
export function currentIsMacPlatform(): boolean {
  if (cachedUserAgent === undefined) {
    cachedUserAgent = typeof navigator === "undefined" ? null : navigator.userAgent;
  }
  return isMacPlatform(cachedUserAgent);
}
