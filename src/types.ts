// Shared types and OTLP value helpers.

import {
  CostBasis,
  PriceTable,
  PricedCost,
  emptyPriceTable,
  priceTurn,
} from "./pricing";

/** A flat attribute bag, merged from a log record's attributes and its
 *  resource attributes. Values are coerced to primitives. */
export type Attrs = Record<string, string | number | boolean>;

/** One Claude Code "interaction" = the api_request events that share a prompt.id
 *  *and* a model configuration (see {@link turnKey}). */
export interface Turn {
  promptId: string;

  // timing of the turn as a whole
  startMs: number; // wall-clock ms of first event (Date-derived, for "x ago")
  lastMs: number; // wall-clock ms of most recent event

  requests: number;

  // tokens (summed across the turn's API calls)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  // timing (ms)
  totalDurationMs: number; // sum of per-request duration_ms (wall-clock, incl. retries)

  // Claude Code's own reported cost, summed, and accumulated only while
  // costBasis is "upstream". Anywhere else the reported figure is Claude Code's
  // guess at Anthropic's rate for a model it does not recognize, so it is
  // dropped at ingest rather than stored where something might later read it.
  costUsd: number;
  /** Where this row's requests went (normalized base URL), when it could be
   *  resolved. Stamped at ingest, because every input to it is current
   *  configuration: deriving it later would re-attribute old turns the moment
   *  the user switched providers. */
  endpoint?: string;
  /** Whether {@link costUsd} is authoritative or the row has to be priced from
   *  its token counts. Absent on snapshots written before cost attribution
   *  existed, which {@link priceTurn} reads as "upstream". */
  costBasis?: CostBasis;

  // identity (part of the key; fixed when the turn is created)
  model?: string;
  effort?: string;

  // context (last-write-wins; stable within a turn anyway)
  speed?: string;
  sessionId?: string;
  terminalType?: string;
  workspace?: string; // resolved from session.id -> transcript cwd
}

/**
 * Identity of one interaction: a prompt's API calls to a single model
 * configuration (model plus reasoning effort).
 *
 * Claude Code stamps every request it issues while a prompt is in flight with
 * that prompt's id, including calls it routes to a different model: at the start
 * of a session it asks Haiku to name the session, and that request carries the
 * first prompt's id. Keying on prompt.id alone would fold such a call into the
 * user's turn, adding its tokens to the turn's counts and relabelling the row
 * with whichever model happened to report last. Making the model configuration
 * part of the key gives each one its own row: the tokens land on the model that
 * produced them, and a row's Model | Effort label can never change once the row
 * exists.
 *
 * NUL separates the parts, a byte none of them can contain, so no two distinct
 * triples ever collide on one key.
 */
export function turnKey(t: Pick<Turn, "promptId" | "model" | "effort">): string {
  return `${t.promptId}\u0000${t.model ?? ""}\u0000${t.effort ?? ""}`;
}

/** Read a single OTLP AnyValue into a JS primitive. */
export function readAnyValue(v: unknown): string | number | boolean | undefined {
  if (v == null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return String(o.stringValue);
  if ("intValue" in o) return Number(o.intValue); // OTLP encodes int64 as string
  if ("doubleValue" in o) return Number(o.doubleValue);
  if ("boolValue" in o) return Boolean(o.boolValue);
  return undefined;
}

/** Turn an OTLP `attributes` array ([{key, value}]) into a flat bag. */
export function readAttributes(
  arr: unknown,
  into: Attrs = {}
): Attrs {
  if (!Array.isArray(arr)) return into;
  for (const kv of arr) {
    if (!kv || typeof kv !== "object") continue;
    const key = (kv as { key?: unknown }).key;
    if (typeof key !== "string") continue;
    const val = readAnyValue((kv as { value?: unknown }).value);
    if (val !== undefined) into[key] = val;
  }
  return into;
}

export function num(attrs: Attrs, key: string): number | undefined {
  const v = attrs[key];
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

export function str(attrs: Attrs, key: string): string | undefined {
  const v = attrs[key];
  return v === undefined ? undefined : String(v);
}

/** Serializable shared state written by the leader, read by all windows. */
export interface Snapshot {
  // 2 adds the per-turn cost basis and the unpriced-day markers below. Both are
  // additions, so an older build still reads a newer snapshot and a newer build
  // an older one. Nothing gates on this number, which is kept as a record.
  version: number;
  updatedMs: number;
  displayId?: string;
  turns: Turn[];
  // Running cost (USD) per UTC calendar day, keyed "YYYY-MM-DD". Banked as
  // events arrive and kept beyond the per-turn retention, so Today/Week/Month
  // totals stay accurate even after old turns are pruned.
  dailyCost?: Record<string, number>;
  // UTC days ("YYYY-MM-DD") holding at least one turn that had no rate to price
  // it. Nothing retained can say the day's figure covers that turn, so the day,
  // and any window containing it, reads as a lower bound rather than a total.
  unpricedDays?: string[];
}

/** UTC calendar-day key ("YYYY-MM-DD") for an epoch-ms instant. */
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** One window's spend. `lowerBound` marks a total that is not known to cover
 *  every turn in the window, at least one of them having no rate to price it, so
 *  it may understate by an unknown amount rather than being merely approximate. */
export interface CostWindow {
  usd: number;
  lowerBound: boolean;
}

/** Cost (USD) summed over the day, the week (from Monday), the month, and the
 *  whole of the preceding calendar month. */
export interface CostWindows {
  today: CostWindow;
  week: CostWindow;
  month: CostWindow;
  lastMonth: CostWindow;
}

/** Sum a daily-cost ledger into Today / This Week (Monday-start) / This Month /
 *  Last Month, all in UTC. "YYYY-MM-DD" keys order lexically, so range checks
 *  are plain string comparisons. Last Month is the only closed window: bounded
 *  above by the first of this month, it stops growing once the month turns. */
export function costWindows(
  daily: Record<string, number> | undefined,
  unpricedDays: readonly string[] | undefined,
  nowMs: number
): CostWindows {
  const out: CostWindows = {
    today: { usd: 0, lowerBound: false },
    week: { usd: 0, lowerBound: false },
    month: { usd: 0, lowerBound: false },
    lastMonth: { usd: 0, lowerBound: false },
  };
  const unpriced = new Set(unpricedDays ?? []);
  // A day every one of whose turns went unpriced banks no dollars at all, so it
  // has no entry in the ledger and still has to reach its windows as a marker.
  const days = new Set([...Object.keys(daily ?? {}), ...unpriced]);
  if (days.size === 0) return out;
  const now = new Date(nowMs);
  const todayKey = utcDayKey(nowMs);
  const dow = (now.getUTCDay() + 6) % 7; // days since Monday (0 = Monday)
  const mondayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - dow
  );
  const mondayKey = utcDayKey(mondayMs);
  const monthKey = utcDayKey(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  // Month index -1 rolls back into the previous December, so January needs no
  // special case.
  const lastMonthKey = utcDayKey(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const add = (w: CostWindow, usd: number, lowerBound: boolean): void => {
    w.usd += usd;
    if (lowerBound) w.lowerBound = true;
  };
  for (const key of days) {
    const usd = daily?.[key] ?? 0;
    const lb = unpriced.has(key);
    if (key === todayKey) add(out.today, usd, lb);
    if (key >= mondayKey) add(out.week, usd, lb);
    if (key >= monthKey) add(out.month, usd, lb);
    else if (key >= lastMonthKey) add(out.lastMonth, usd, lb);
  }
  return out;
}

/** The turn to display: the one whose {@link turnKey} is the current display id.
 *  A snapshot written before rows were keyed per model carries a bare prompt.id,
 *  so fall back to matching that, keeping the bar populated across an upgrade
 *  (and while a window still running the older build is the leader). */
export function selectLatest(
  turns: Turn[],
  displayId: string | undefined
): Turn | undefined {
  if (!displayId) return undefined;
  return (
    turns.find((t) => turnKey(t) === displayId) ??
    turns.find((t) => t.promptId === displayId)
  );
}

/** Most recent turns that produced output, newest first. */
export function selectRecent(turns: Turn[], limit: number): Turn[] {
  return turns
    .filter((t) => t.outputTokens > 0)
    .sort((a, b) => b.lastMs - a.lastMs)
    .slice(0, limit);
}

/** Derived, display-ready figures for a turn. */
export interface TurnView {
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;

  totalMs: number;
  requests: number;

  totalTokPerSec: number;

  cost: PricedCost;
  endpoint?: string;
  costBasis?: CostBasis;
  model?: string;
  speed?: string;
  effort?: string;
  sessionId?: string;
  terminalType?: string;
  workspace?: string;
  ageMs: number;
  lastMs: number; // wall-clock ms of the most recent event (for absolute time)
}

// Shared rather than built per call: a price table is only ever read, and this
// is the default on a function the recent-interactions list calls per row.
const NO_PRICES: PriceTable = emptyPriceTable();

/** `prices` is what turns a row Claude Code could not price into a figure. Omit
 *  it when only the non-cost fields are read, and every such row reads as
 *  unpriced. */
export function viewOf(
  t: Turn,
  nowMs: number,
  prices: PriceTable = NO_PRICES
): TurnView {
  const totalSec = t.totalDurationMs / 1000;
  return {
    outputTokens: t.outputTokens,
    inputTokens: t.inputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    totalTokens:
      t.inputTokens +
      t.outputTokens +
      t.cacheReadTokens +
      t.cacheCreationTokens,
    totalMs: t.totalDurationMs,
    requests: t.requests,
    totalTokPerSec: totalSec > 0 ? t.outputTokens / totalSec : 0,
    cost: priceTurn(t, prices),
    endpoint: t.endpoint,
    costBasis: t.costBasis,
    model: t.model,
    speed: t.speed,
    effort: t.effort,
    sessionId: t.sessionId,
    terminalType: t.terminalType,
    workspace: t.workspace,
    ageMs: Math.max(0, nowMs - t.lastMs),
    lastMs: t.lastMs,
  };
}
