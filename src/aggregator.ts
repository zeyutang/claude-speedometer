import { EventEmitter } from "events";
import {
  Attrs,
  Snapshot,
  Turn,
  num,
  selectLatest,
  selectRecent,
  str,
} from "./types";
import { resolveWorkspace } from "./workspace";

const MAX_TURNS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO-8601 timestamp to epoch ms, or undefined if unparseable. */
function isoMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Folds Claude Code OTEL events into per-turn aggregates (keyed by prompt.id).
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
 * Emits "update" only when the displayed (finalized) turn changes.
 */
export class Aggregator extends EventEmitter {
  private turns = new Map<string, Turn>(); // insertion-ordered, prompt.id -> Turn
  private displayId: string | undefined; // last finalized turn (shown)
  // Per session.id, the prompt.id currently receiving requests. Scoping by
  // session keeps concurrent sessions from cross-finalizing one another.
  private runningBySession = new Map<string, string>();
  // Per session.id quiet-timer, so each session finalizes on its own idle gap.
  private settleTimers = new Map<string, NodeJS.Timeout>();
  // Per prompt.id, the request_ids already folded in, so a duplicated or
  // redelivered export never double-counts. In-memory and leader-lifetime only
  // (not serialized): seeded turns keep their baked-in counts after a handover.
  private seenRequests = new Map<string, Set<string>>();

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

    const model = str(attrs, "model");
    if (model) turn.model = model;
    const speed = str(attrs, "speed");
    if (speed) turn.speed = speed;
    const effort = str(attrs, "effort");
    if (effort) turn.effort = effort;
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

  private ensureTurn(promptId: string, attrs: Attrs, nowMs: number): Turn {
    let t = this.turns.get(promptId);
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
        sessionId: str(attrs, "session.id"),
        terminalType: str(attrs, "terminal.type"),
      };
      this.turns.set(promptId, t);
    }
    return t;
  }

  /** Mark a turn as the displayed value and notify, if it produced output. */
  private finalize(promptId: string): void {
    const t = this.turns.get(promptId);
    if (!t || t.outputTokens <= 0) return;
    this.displayId = promptId;
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

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    const running = new Set(this.runningBySession.values());
    for (const [id, t] of this.turns) {
      // Never drop a running or the displayed turn by age.
      if (running.has(id) || id === this.displayId) continue;
      if (t.lastMs < cutoff) {
        this.turns.delete(id);
        this.seenRequests.delete(id);
      }
    }
    // Cap total size, evicting oldest first but never a running/displayed turn.
    while (this.turns.size > MAX_TURNS) {
      let evicted = false;
      for (const id of this.turns.keys()) {
        if (running.has(id) || id === this.displayId) continue;
        this.turns.delete(id);
        this.seenRequests.delete(id);
        evicted = true;
        break;
      }
      if (!evicted) break; // only protected turns remain
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
      (t) => !running.has(t.promptId) || t.promptId === this.displayId
    );
    return selectRecent(completed, limit);
  }

  /** Serialize current state for publishing to the shared store. */
  snapshot(): Snapshot {
    return {
      version: 1,
      updatedMs: Date.now(),
      displayId: this.displayId,
      turns: [...this.turns.values()],
    };
  }

  /** Seed state from a shared snapshot (continuity on leadership handover). */
  load(snap: Snapshot): void {
    this.turns.clear();
    this.seenRequests.clear();
    for (const t of snap.turns) this.turns.set(t.promptId, t);
    this.displayId = snap.displayId;
    this.runningBySession.clear();
    this.prune();
  }

  dispose(): void {
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    this.seenRequests.clear();
  }
}
