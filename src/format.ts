export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokPerSec(n: number): string {
  return n.toFixed(2);
}

// Figure space (U+2007): a whitespace character that, in the proportional fonts
// VS Code uses for the status bar, is exactly as wide as a digit (and, unlike an
// ASCII space, is never collapsed by the renderer). Padding with it aligns digit
// columns pixel-for-pixel.
const FIGURE_SPACE = "\u2007";

/**
 * Status-bar variant of {@link fmtTokPerSec}: one decimal place, with the integer
 * part reserved to two digits using figure spaces so the rendered width stays
 * constant for any value below 100 ("5.0" and "99.9" occupy the same space).
 * This keeps the status-bar item from jittering as the digit count changes; values
 * >= 100 tok/s widen the item by one character (and >= 1000 also gain a thousands
 * separator), which is uncommon in practice.
 * `undefined` (no interaction yet) renders as a right-aligned "-".
 */
export function fmtTokPerSecFixed(n: number | undefined): string {
  const s =
    n !== undefined && Number.isFinite(n)
      ? n.toLocaleString("en-US", {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : "-";
  return s.padStart(4, FIGURE_SPACE); // "99.9", the widest padded form, is 4 chars
}

/** ms as a duration: "812ms" below a second, otherwise "1h 2min 3sec" with the
 *  hour and minute parts dropped while they are zero (seconds are always shown).
 *  Seconds are whole numbers; sub-second values fall back to integer ms. */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}min`);
  parts.push(`${s}sec`);
  return parts.join(" ");
}

export function fmtCost(usd: number): string {
  if (!usd) return "$0.00";
  // Group thousands ("$1,083.28", "$1,234,567.89"). Sub-cent amounts keep four
  // decimals so tiny per-interaction costs don't collapse to "$0.00".
  const digits = usd < 0.01 ? 4 : 2;
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
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

/** Fixed-width local timestamp "YYYY-MM-DD HH:MM:SS" (24-hour). The uniform
 *  length keeps tabular rows aligned; unlike {@link fmtClock} it never
 *  abbreviates or switches format across days. */
export function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** {@link fmtTimestamp} without the year: "MM-DD HH:MM:SS". Retention is a
 *  handful of days, so the year is the one part of the stamp that never varies
 *  across the list, and dropping it buys a column's worth of width. Callers pair
 *  it with the full stamp on hover. */
export function fmtTimestampShort(ms: number): string {
  const full = fmtTimestamp(ms);
  return full === "-" ? full : full.slice(5);
}

/** Absolute time plus a relative hint: "2:34:05 PM (5s ago)". The absolute part
 *  is the source of truth; the relative part stays current only if the caller
 *  re-renders periodically (see the refresh timers in the status bar / panel). */
export function fmtWhen(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return `${fmtClock(ms, nowMs)} (${fmtAgo(Math.max(0, nowMs - ms))})`;
}
