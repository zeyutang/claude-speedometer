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

/**
 * Folds Claude Code OTEL events into per-turn aggregates (keyed by prompt.id).
 *
 * Only *completed* turns are displayed: while a turn is still receiving
 * api_request events it stays "running" and the bar keeps showing the previous
 * completed turn. A turn is finalized when the next turn begins (a different
 * prompt.id produces output) or after a quiet period with no further requests.
 * Throughput uses summed server-measured `duration_ms`, so tool-execution gaps
 * and client-side queueing never count.
 *
 * Emits "update" only when the displayed (finalized) turn changes.
 */
export class Aggregator extends EventEmitter {
  private turns = new Map<string, Turn>(); // insertion-ordered, prompt.id -> Turn
  private displayId: string | undefined; // last finalized turn (shown)
  private runningId: string | undefined; // turn currently receiving requests
  private settleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly retentionDays = 7,
    private readonly settleMs = 3000
  ) {
    super();
  }

  /** Feed one normalized event (attrs already merged with resource attrs). */
  handleEvent(eventName: string, attrs: Attrs): void {
    const name = eventName.replace(/^claude_code\./, "");
    if (name !== "api_request") return; // user_prompt etc. don't drive display
    const promptId = str(attrs, "prompt.id");
    if (!promptId) return;

    const turn = this.ensureTurn(promptId, attrs);
    const now = Date.now();

    const duration = num(attrs, "duration_ms") ?? 0;

    turn.requests += 1;
    turn.inputTokens += num(attrs, "input_tokens") ?? 0;
    turn.outputTokens += num(attrs, "output_tokens") ?? 0;
    turn.cacheReadTokens += num(attrs, "cache_read_tokens") ?? 0;
    turn.cacheCreationTokens += num(attrs, "cache_creation_tokens") ?? 0;
    turn.totalDurationMs += duration;
    turn.costUsd += num(attrs, "cost_usd") ?? 0;
    turn.lastMs = now;

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

    // A new turn began: the previous running turn is now complete -> display it.
    if (promptId !== this.runningId) {
      const prev = this.runningId;
      this.runningId = promptId;
      if (prev) this.finalize(prev);
    }

    // Fallback: finalize the running turn once it goes quiet (last turn of a
    // session, or a long idle gap).
    this.armSettleTimer();
  }

  private ensureTurn(promptId: string, attrs: Attrs): Turn {
    let t = this.turns.get(promptId);
    if (!t) {
      const now = Date.now();
      t = {
        promptId,
        startMs: now,
        lastMs: now,
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

  private armSettleTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.runningId) this.finalize(this.runningId);
    }, this.settleMs);
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const [id, t] of this.turns) {
      // Never drop the running or displayed turns by age.
      if (id === this.runningId || id === this.displayId) continue;
      if (t.lastMs < cutoff) this.turns.delete(id);
    }
    while (this.turns.size > MAX_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === this.runningId) break;
      this.turns.delete(oldest);
    }
  }

  /** The turn currently shown on the status bar, if any. */
  getLatest(): Turn | undefined {
    return selectLatest([...this.turns.values()], this.displayId);
  }

  /** Most recent completed turns, newest first (excludes the running one). */
  getRecent(limit: number): Turn[] {
    const completed = [...this.turns.values()].filter(
      (t) => t.promptId !== this.runningId || t.promptId === this.displayId
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
    for (const t of snap.turns) this.turns.set(t.promptId, t);
    this.displayId = snap.displayId;
    this.runningId = undefined;
    this.prune();
  }

  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }
}
