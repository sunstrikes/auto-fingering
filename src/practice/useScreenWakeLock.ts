import { useEffect, useRef } from "react";

interface WakeLockSentinelLike {
  readonly released?: boolean;
  release: () => Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

/**
 * Keeps the screen awake while `active` is true (e.g. during playback or waiting-mode practice)
 * using the Screen Wake Lock API (supported on iPadOS 16.4+ over HTTPS/localhost).
 * Automatically re-acquires the lock when returning to the tab.
 */
export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active) {
      void sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
      return;
    }

    if (typeof navigator === "undefined" || typeof document === "undefined") {
      return;
    }

    let cancelled = false;

    const requestWakeLock = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      const nav = navigator as unknown as NavigatorWithWakeLock;
      if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") return;
      if (sentinelRef.current && !sentinelRef.current.released) return;

      try {
        sentinelRef.current = await nav.wakeLock.request("screen");
      } catch {
        // Ignore errors (e.g. Low Power Mode or unsupported context)
      }
    };

    void requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
    };
  }, [active]);
}
