// Provider relays: how a billing-context provider extension is heard by the
// window running the receiver when that is not its own window.
//
// VS Code exposes an extension's exports only within its own window, while one
// window runs the receiver for the whole machine (see `./leader`). Read only
// there, a provider is heard for its window's sessions just while that window
// leads, so the same session is attributed one way or another depending on
// which window bound the port. The difference is not cosmetic: a first-party
// session in a project that has billed a gateway before has only its provider
// to vouch for it (see `reconcileHistory` in `./pricing`), and without that it
// reads as unpriced.
//
// So each window writes down what its own provider says, scoped to its own
// folders, and the reader parses the other windows' files with the BYOK record
// reader, whose format they share. One file per window, named by its extension
// host's pid, so no two writers ever share a path. The files live in this
// extension's own directory rather than in `~/.claude-code-byok/`, because a
// relay is not a declaration by whatever configured the endpoint, and nothing
// else reading that directory should take it for one.
//
// A relay is leased to the process that wrote it and refreshed often, so a
// window that closes stops speaking for its folders at once, and a pid recycled
// onto another process keeps a dead window's answer alive for minutes at most.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ModelRate } from "./pricing";
import { ByokRecord, readRecordsIn } from "./byokRecords";
import { sweepDeadPidFiles, writeFileAtomic } from "./pidFiles";

const RELAY_DIR = path.join(os.homedir(), ".claude-speedometer", "windows");
const OWN_FILE = path.join(RELAY_DIR, `${process.pid}.json`);
// A relay, or the temporary file it is written through, by its writer's pid.
const RELAY_NAME = /^(\d+)\.json(?:\..+)?$/;

/** How often a window re-reads its provider, rewriting its relay when the
 *  answer changed. Short, because a turn's endpoint is stamped when the turn
 *  opens and never revised, so an answer that lands late misses every turn
 *  opened before it. */
export const RELAY_TICK_MS = 5000;

// How often an unchanged relay is rewritten anyway, keeping its `updatedMs`
// well inside MAX_AGE_MS.
const REFRESH_MS = 60_000;

// How old a relay may grow before it is ignored. Several refreshes' worth, so a
// window stalled for a moment is not dropped, while a recycled pid can prolong
// a dead window's answer by minutes rather than by the twelve hours a BYOK
// record may sit idle.
const MAX_AGE_MS = 5 * 60_000;

/** What a window relays: its own provider's answer, once validated. */
export interface RelayedAnswer {
  /** Normalized base URL, or undefined when the provider is armed but silent
   *  about the endpoint. */
  endpoint?: string;
  reportedCostIsGuess: boolean;
  /** Rates keyed by reported model id, alias-expanded. */
  pricing?: Map<string, ModelRate>;
}

/** This window's relay file, written and removed on its behalf. */
export class ProviderRelay {
  // What was last written and when, so an unchanged answer is not rewritten on
  // every tick.
  private written: { body: string; at: number } | undefined;

  constructor() {
    // Swept at startup as well as after each write, so a crashed window's
    // relay is reclaimed even while no window has a provider to publish.
    pruneDeadRelays();
  }

  /** Write this window's answer for its `dirs`, or remove the relay when there
   *  is no answer, or no folder a session could be joined to. */
  publish(answer: RelayedAnswer | undefined, dirs: readonly string[]): void {
    if (!answer || dirs.length === 0) {
      this.clear();
      return;
    }
    const payload = {
      projectDirs: [...dirs],
      ...(answer.endpoint ? { endpoint: answer.endpoint } : {}),
      ...(answer.reportedCostIsGuess ? { costBasis: "unknown" } : {}),
      // Already alias-expanded, so every reported id is an entry of its own.
      models: [...(answer.pricing?.entries() ?? [])].map(
        ([requestedId, rate]) => ({ requestedId, rate })
      ),
    };
    const body = JSON.stringify(payload);
    const now = Date.now();
    if (this.written?.body === body && now - this.written.at < REFRESH_MS) {
      return;
    }
    const record = { apiVersion: 1, pid: process.pid, updatedMs: now };
    try {
      fs.mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 });
      writeFileAtomic(
        OWN_FILE,
        JSON.stringify({ ...record, ...payload }),
        0o600
      );
      this.written = { body, at: now };
    } catch {
      // Best effort: a window that cannot write is heard only while it leads.
      return;
    }
    pruneDeadRelays();
  }

  /** Remove this window's relay, if it wrote one. */
  clear(): void {
    if (!this.written) return;
    this.written = undefined;
    try {
      fs.rmSync(OWN_FILE, { force: true });
    } catch {
      /* already gone */
    }
  }
}

/** Every other window's live relay. This window's own is skipped, its provider
 *  being read directly rather than as relayed a moment ago. */
export function readRelays(): ByokRecord[] {
  return readRecordsIn(RELAY_DIR, MAX_AGE_MS).filter(
    (record) => record.pid !== process.pid
  );
}

/** Remove relays left by windows that exited without cleaning up, as a crash or
 *  a force quit does. Readers already pass over them on the pid test, so this
 *  only stops the directory growing. Unlike `~/.claude-code-byok/`, the
 *  directory is this extension's own and every file in it is named by the pid
 *  that wrote it, so it is safe to collect. */
function pruneDeadRelays(): void {
  sweepDeadPidFiles(RELAY_DIR, RELAY_NAME);
}
