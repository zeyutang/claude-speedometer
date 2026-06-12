// Shared types and OTLP value helpers.

/** A flat attribute bag, merged from a log record's attributes and its
 *  resource attributes. Values are coerced to primitives. */
export type Attrs = Record<string, string | number | boolean>;

/** One Claude Code "interaction" = all api_request events sharing a prompt.id. */
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

  costUsd: number;

  // context (last-write-wins; stable within a turn anyway)
  model?: string;
  speed?: string;
  effort?: string;
  sessionId?: string;
  terminalType?: string;
  workspace?: string; // resolved from session.id -> transcript cwd
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
  version: number;
  updatedMs: number;
  displayId?: string;
  turns: Turn[];
}

/** The turn to display: the one whose prompt.id is the current display id. */
export function selectLatest(
  turns: Turn[],
  displayId: string | undefined
): Turn | undefined {
  if (!displayId) return undefined;
  return turns.find((t) => t.promptId === displayId);
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

  costUsd: number;
  model?: string;
  speed?: string;
  effort?: string;
  sessionId?: string;
  terminalType?: string;
  workspace?: string;
  ageMs: number;
}

export function viewOf(t: Turn, nowMs: number): TurnView {
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
    costUsd: t.costUsd,
    model: t.model,
    speed: t.speed,
    effort: t.effort,
    sessionId: t.sessionId,
    terminalType: t.terminalType,
    workspace: t.workspace,
    ageMs: Math.max(0, nowMs - t.lastMs),
  };
}
