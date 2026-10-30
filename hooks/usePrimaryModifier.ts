"use client";

import { useEffect, useState } from "react";
import { isMacPlatform, primaryModifierLabel } from "@/lib/keyboard-platform";

/**
 * The platform's primary modifier: `⌘` on macOS, `Ctrl` on Windows and Linux.
 *
 * The label is read after the first paint: the server renders the Control
 * spelling and the client corrects it once the user agent is known, so the
 * server and the first client render agree and hydration stays quiet.
 */
export function usePrimaryModifier(): { isMac: boolean; label: string } {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(isMacPlatform(navigator.userAgent));
  }, []);

  return { isMac, label: primaryModifierLabel(isMac) };
}
