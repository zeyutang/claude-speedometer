export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokPerSec(n: number): string {
  return n.toFixed(2);
}

/** ms -> "812 ms" or "15.1 s". */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtCost(usd: number): string {
  if (!usd) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Claude Code's `speed` attribute -> fast-mode On/Off. */
export function fmtFastMode(speed: string | undefined): string {
  if (!speed) return "—";
  return speed.toLowerCase() === "fast" ? "On" : "Off";
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
