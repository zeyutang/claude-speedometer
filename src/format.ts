export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokPerSec(n: number): string {
  return n.toFixed(2);
}

/** ms -> "812 ms" or "15.1 s". */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtCost(usd: number): string {
  if (!usd) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Claude Code's `speed` attribute: true only when fast mode is on. */
export function isFastModeOn(speed: string | undefined): boolean {
  return (speed ?? "").toLowerCase() === "fast";
}

/** Claude Code's `effort` attribute, presented for display ("-" if absent). */
export function fmtEffort(effort: string | undefined): string {
  if (!effort) return "-";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** ms-ago -> "just now" / "12s ago" / "3m ago" / "1h ago". */
export function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/** Absolute wall-clock time of an event: time-of-day (with seconds) for today,
 *  "Jun 12, 2:30 PM" for earlier days. Unlike a relative "x ago", this never
 *  goes stale between renders. */
export function fmtClock(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const d = new Date(ms);
  const now = new Date(nowMs);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}

/** Absolute time plus a relative hint: "2:34:05 PM (5s ago)". The absolute part
 *  is the source of truth; the relative part stays current only if the caller
 *  re-renders periodically (see the refresh timers in the status bar / panel). */
export function fmtWhen(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return `${fmtClock(ms, nowMs)} (${fmtAgo(Math.max(0, nowMs - ms))})`;
}
