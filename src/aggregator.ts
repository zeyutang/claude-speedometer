import { EventEmitter } from "events";
import {
  Attrs,
  Snapshot,
  Turn,
  num,
  selectLatest,
  selectRecent,
  str,
  turnKey,
  utcDayKey,
} from "./types";
import { resolveWorkspace } from "./workspace";

// Cap on retained turns. The whole set is serialized into state.json on every
// update and re-parsed by each window, so this bounds that file's size; ~1k
// small turn records is well under a megabyte. Age-based retention (retentionDays)
// still applies, so the effective history is whichever limit is reached first.
const MAX_TURNS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How many days of the daily-cost ledger to keep. Last Month reaches furthest
// back of the windows shown: its first day sits up to 61 days behind today (a
// 31-day previous month, viewed on the 31st of a 31-day one), so this leaves a
// full month of headroom. The ledger is a handful of bytes per day regardless.
const COST_LEDGER_DAYS = 95;

/** Parse an ISO-8601 timestamp to epoch ms, or undefined if unparseable. */
function isoMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Folds Claude Code OTEL events into per-turn aggregates (keyed by
 * {@link turnKey}: prompt.id plus model configuration).
 *
 * Only *completed* turns are displayed: while a turn is still receiving
 * api_request events it stays "running" and the bar keeps showing the previous
 * completed turn. Finalization is scoped per session.id: prompts are serial
 * within a session, so a new prompt.id in the *same* session marks that
 * session's previous prompt complete. Events from other concurrent sessions
 * never finalize each other, so two panels running at once keep accumulating
 * into their own turns instead of prematurely displaying each other's partials.
 * A turn is also finalized once its own session goes quiet. Throughput sums
 * each request's wall-clock `duration_ms` (server time plus network and any
 * retries), so only active request time counts; tool-execution gaps and idle
 * time between requests are excluded. Each request_id is folded in once, so a
 * redelivered export never double-counts a turn.
 *
 * Running state is tracked at prompt grain even though rows are finer: one
 * prompt's rows start and complete together, so a helper call on another model
 * never shows up on its own while the prompt it belongs to is still working.
 *
 * Emits "update" only when the displayed (finalized) turn changes.
 */
export class Aggregator extends EventEmitter {
  private turns = new Map<string, Turn>(); // insertion-ordered, turnKey -> Turn
  private displayId: string | undefined; // turnKey of the last finalized turn
  // Per session.id, the prompt.id currently receiving requests. Scoping by
  // session keeps concurrent sessions from cross-finalizing one another.
  private runningBySession = new Map<string, string>();
  // Per session.id quiet-timer, so each session finalizes on its own idle gap.
  private settleTimers = new Map<string, NodeJS.Timeout>();
  // Per prompt.id, the request_ids already folded in, so a duplicated or
  // redelivered export never double-counts. Kept at prompt grain so a prompt's
  // rows share one dedup scope. In-memory and leader-lifetime only (not
  // serialized): seeded turns keep their baked-in counts after a handover.
  private seenRequests = new Map<string, Set<string>>();
  // Running cost per UTC calendar day ("YYYY-MM-DD"). Banked as events arrive
  // (deduped via seenRequests) and persisted, so day/week/month totals survive
  // turn pruning.
  private dailyCost = new Map<string, number>();

  constructor(
    private readonly retentionDays = 7,
    private readonly settleMs = 3000
  ) {
    super();
  }

  /** Feed one normalized event (attrs already merged with resource attrs).
   *  eventTimeMs is the event's own wall-clock time (from the OTLP record),
   *  used in preference to our receive time so batched exports keep ordering. */
  handleEvent(eventName: string, attrs: Attrs, eventTimeMs?: number): void {
    const name = eventName.replace(/^claude_code\./, "");
    if (name !== "api_request") return; // user_prompt etc. don't drive display
    const promptId = str(attrs, "prompt.id");
    if (!promptId) return;

    // Idempotency: skip an api_request whose request_id was already folded into
    // this turn (a duplicate/redelivered export), so counts stay exact. Retries
    // of a logical request carry distinct request_ids, so real work isn't lost.
    const requestId = str(attrs, "request_id");
    if (requestId) {
      let seen = this.seenRequests.get(promptId);
      if (!seen) {
        seen = new Set();
        this.seenRequests.set(promptId, seen);
      }
      if (seen.has(requestId)) return;
      seen.add(requestId);
    }

    // Prefer the event's own timestamp over our receive time; with batched
    // exports (up to exportIntervalMs apart) receive time collapses ordering.
    const ts =
      eventTimeMs ?? isoMs(str(attrs, "event.timestamp")) ?? Date.now();

    const turn = this.ensureTurn(promptId, attrs, ts);

    const duration = num(attrs, "duration_ms") ?? 0;

    turn.requests += 1;
    turn.inputTokens += num(attrs, "input_tokens") ?? 0;
    turn.outputTokens += num(attrs, "output_tokens") ?? 0;
    turn.cacheReadTokens += num(attrs, "cache_read_tokens") ?? 0;
    turn.cacheCreationTokens += num(attrs, "cache_creation_tokens") ?? 0;
    turn.totalDurationMs += duration;
    turn.costUsd += num(attrs, "cost_usd") ?? 0;
    // Events can arrive out of order within a batch: keep the extremes.
    if (ts > turn.lastMs) turn.lastMs = ts;
    if (ts < turn.startMs) turn.startMs = ts;

    // model and effort are part of the key, so they are already set and must
    // not be reassigned: a request reporting a different pair belongs to a
    // different row.
    const speed = str(attrs, "speed");
    if (speed) turn.speed = speed;
    const sessionId = str(attrs, "session.id");
    if (sessionId) turn.sessionId = sessionId;
    const terminal = str(attrs, "terminal.type");
    if (terminal) turn.terminalType = terminal;
    if (!turn.workspace && turn.sessionId) {
      turn.workspace = resolveWorkspace(turn.sessionId);
    }

    // Within a session, prompts are serial: a new prompt.id means this session's
    // previous prompt finished -> display it. Events from other sessions don't
    // touch this scope, so concurrent turns never finalize each other.
    const scope = turn.sessionId ?? promptId;
    const prevRunning = this.runningBySession.get(scope);
    if (prevRunning !== promptId) {
      this.runningBySession.set(scope, promptId);
      if (prevRunning) this.finalize(prevRunning);
    }

    // Fallback: finalize this session's turn once it goes quiet (last turn of a
    // session, or a long idle gap).
    this.armSettleTimer(scope, promptId);
  }

  /** The row this request belongs to, created on first sight. The model and
   *  effort it reports form part of the row's key, so a request Claude Code
   *  routes to another model under the same prompt.id opens its own row rather
   *  than landing in (and relabelling) the user's turn. */
  private ensureTurn(promptId: string, attrs: Attrs, nowMs: number): Turn {
    const model = str(attrs, "model");
    const effort = str(attrs, "effort");
    const key = turnKey({ promptId, model, effort });
    let t = this.turns.get(key);
    if (!t) {
      t = {
        promptId,
        startMs: nowMs,
        lastMs: nowMs,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalDurationMs: 0,
        costUsd: 0,
        model,
        effort,
        sessionId: str(attrs, "session.id"),
        terminalType: str(attrs, "terminal.type"),
      };
      this.turns.set(key, t);
    }
    return t;
  }

  /**
   * Complete a prompt: pick the row to display and notify. A prompt can hold
   * several rows (one per model configuration it used), so the displayed one is
   * whichever produced the most output, which is the agent's own turn: the
   * helper calls Claude Code makes alongside it (naming a session, summarizing
   * a tool result) run on small models and emit a fraction of the tokens.
   * A prompt that produced no output leaves the display untouched.
   */
  private finalize(promptId: string): void {
    let main: Turn | undefined;
    for (const t of this.turns.values()) {
      if (t.promptId !== promptId || t.outputTokens <= 0) continue;
      if (!main || t.outputTokens > main.outputTokens) main = t;
    }
    if (!main) return;
    this.displayId = turnKey(main);
    this.prune();
    this.emit("update");
  }

  private armSettleTimer(scope: string, promptId: string): void {
    const existing = this.settleTimers.get(scope);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.settleTimers.delete(scope);
      // Only finalize if this prompt is still the session's running one.
      if (this.runningBySession.get(scope) === promptId) {
        this.runningBySession.delete(scope);
        this.finalize(promptId);
      }
    }, this.settleMs);
    this.settleTimers.set(scope, timer);
  }

  /**
   * Fold the retained turns into the daily ledger, banking each UTC day's summed
   * cost. Uses max(banked, sum-of-retained-turns-that-day) so that once a day's
   * turns start aging out of the retained set, its already-banked total is
   * preserved rather than shrinking. Recomputing from turns (instead of adding
   * per event) also self-heals: the ledger fills in immediately from existing
   * history, e.g. after upgrading from a version that had no ledger.
   */
  private bankTurnsIntoLedger(): void {
    const fromTurns = new Map<string, number>();
    for (const t of this.turns.values()) {
      if (!t.costUsd) continue;
      const key = utcDayKey(t.lastMs);
      fromTurns.set(key, (fromTurns.get(key) ?? 0) + t.costUsd);
    }
    for (const [key, sum] of fromTurns) {
      if (sum > (this.dailyCost.get(key) ?? 0)) this.dailyCost.set(key, sum);
    }
  }

  /** Drop ledger days older than the cost-retention window. */
  private pruneDailyCost(): void {
    const cutoffKey = utcDayKey(Date.now() - COST_LEDGER_DAYS * DAY_MS);
    for (const key of this.dailyCost.keys()) {
      if (key < cutoffKey) this.dailyCost.delete(key);
    }
  }

  private prune(): void {
    this.pruneDailyCost();
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    // Running prompts, protected as a whole: dropping one row of a prompt that
    // is still accumulating would let its requests be counted again.
    const running = new Set(this.runningBySession.values());
    for (const [key, t] of this.turns) {
      // Never drop a running or the displayed turn by age.
      if (running.has(t.promptId) || key === this.displayId) continue;
      if (t.lastMs < cutoff) this.turns.delete(key);
    }
    // Cap total size, evicting oldest first but never a running/displayed turn.
    while (this.turns.size > MAX_TURNS) {
      let evicted = false;
      for (const [key, t] of this.turns) {
        if (running.has(t.promptId) || key === this.displayId) continue;
        this.turns.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) break; // only protected turns remain
    }
    this.pruneSeenRequests();
  }

  /** Drop the request-id sets of prompts that have no rows left. They are keyed
   *  at prompt grain, so one outlives any single row of its prompt and can only
   *  be released once every row of that prompt is gone. */
  private pruneSeenRequests(): void {
    if (this.seenRequests.size === 0) return;
    const live = new Set<string>();
    for (const t of this.turns.values()) live.add(t.promptId);
    for (const promptId of this.seenRequests.keys()) {
      if (!live.has(promptId)) this.seenRequests.delete(promptId);
    }
  }

  /** The turn currently shown on the status bar, if any. */
  getLatest(): Turn | undefined {
    return selectLatest([...this.turns.values()], this.displayId);
  }

  /** Most recent completed turns, newest first (excludes in-progress ones). */
  getRecent(limit: number): Turn[] {
    const running = new Set(this.runningBySession.values());
    const completed = [...this.turns.values()].filter(
      (t) => !running.has(t.promptId) || turnKey(t) === this.displayId
    );
    return selectRecent(completed, limit);
  }

  /** Serialize current state for publishing to the shared store. */
  snapshot(): Snapshot {
    this.bankTurnsIntoLedger();
    this.pruneDailyCost();
    return {
      version: 1,
      updatedMs: Date.now(),
      displayId: this.displayId,
      turns: [...this.turns.values()],
      dailyCost: Object.fromEntries(this.dailyCost),
    };
  }

  /** Seed state from a shared snapshot (continuity on leadership handover). */
  load(snap: Snapshot): void {
    this.turns.clear();
    this.seenRequests.clear();
    for (const t of snap.turns) this.turns.set(turnKey(t), t);
    // Re-derive the display key from the turn it points at, so a snapshot
    // written before rows were keyed per model (displayId is a bare prompt.id
    // there) still resolves to the same turn.
    const shown = selectLatest(snap.turns, snap.displayId);
    this.displayId = shown ? turnKey(shown) : undefined;
    this.runningBySession.clear();
    this.dailyCost = new Map(Object.entries(snap.dailyCost ?? {}));
    // Seed the ledger from the retained turns too, so an upgrade from a version
    // without the ledger (or a handover) shows history immediately.
    this.bankTurnsIntoLedger();
    this.prune();
  }

  dispose(): void {
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    this.seenRequests.clear();
  }
}
