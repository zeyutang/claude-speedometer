// BYOK records: a drop-in directory where a provider that this extension cannot
// otherwise see can declare which projects it serves, and at what rates.
//
// It exists because of a scope mismatch. The receiver ingests the api_request
// events of *every* Claude Code session on the machine, since Claude Code's OTEL
// exporter talks to a single localhost port and only one process can hold it.
// The configuration this extension can read for itself, though, reaches less far
// than that: the two settings files, and this extension host's own environment.
// A base URL exported in a terminal the host never inherited, or set directly on
// the Claude Code process, appears in none of them.
//
// Left there, such a session arrives with nothing to attribute it by, and
// falling back to whatever configuration *is* readable does not merely leave a
// gap: it stamps one provider's endpoint and rates onto another provider's
// traffic. A confident wrong number, which is worse than none.
//
// A record is scoped by project directory rather than being a single global
// answer, because a BYOK setup legitimately is: a project's own
// `.claude/settings.local.json` is where some vendor guides put the base URL, so
// two checkouts on one machine can bill two different providers. Directories are
// also the only join available, telemetry carrying a session id and a session id
// resolving to a directory through its transcript.
//
// A file in a known place, rather than a message, because it is not tied to the
// process that wrote it and it outlives this one: a reader that takes over the
// receiver sees the same records the previous one did instead of starting blind.
//
// The contract is metadata only, and any tool may write it. A record carries an
// endpoint, the model ids served there and their per-token rates. It must never
// carry a credential, and it has no field for one.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ModelRate,
  PriceTable,
  emptyPriceTable,
  mergePriceTables,
  normalizeEndpoint,
  parseProviders,
} from "./pricing";
import { isWithinDir } from "./workspace";

const RECORDS_DIR = path.join(os.homedir(), ".claude-code-byok");

// How long a record that declares a `updatedMs` stays live. It bounds the one
// case the pid check cannot, a pid recycled onto an unrelated process. Generous
// because a writer can sit idle for a long time, and one that opts into a
// timestamp is expected to refresh it rather than rewrite only on a change.
//
// Only a record that *carries* a timestamp is bounded by this. See
// {@link readRecord} for why absence means permanence rather than staleness.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** One BYOK record, once validated. */
export interface ByokRecord {
  /** Absolute project directories this record speaks for. A session matches when
   *  its own project directory is one of these or sits inside one. */
  dirs: string[];
  /** Normalized base URL, or undefined when the record names none (a provider
   *  billing Anthropic directly, or one whose URL will not parse). */
  endpoint?: string;
  /** True when the record reports that Claude Code priced these requests at its
   *  default model's rate, i.e. a `costBasis` of "unknown". Only the writer can
   *  know this, so it is the one direct answer to a question every other input
   *  here can merely be evidence about. */
  reportedCostIsGuess: boolean;
  /** Rates for the models this record's endpoint serves, alias-expanded. */
  prices: PriceTable;
  /** Epoch ms the record was last written, or 0 when it declares none. Used
   *  only to break a tie between two records matching a session equally well,
   *  where a record that dates itself beats one that does not. */
  updatedMs: number;
}

/** True when a pid names a live process. `signal 0` delivers nothing and only
 *  tests for existence; EPERM means the process is there but owned by someone
 *  else, which still counts as alive. */
function isLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Absolute, separator-normalized form of a directory path, for prefix tests. A
 *  trailing separator is dropped so `/a/b` and `/a/b/` compare equal. */
function normalizeDir(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return undefined;
  const resolved = path.resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

/**
 * The rates in one record, run through the provider parser so that validation
 * and `reportedAs` expansion are the same code that handles the setting.
 *
 * A record's `models` is a list rather than a map because it is generated, and a
 * generator has no reason to key by a string it also carries as a field.
 */
function readPrices(endpoint: string | undefined, raw: unknown): PriceTable {
  if (!Array.isArray(raw)) return emptyPriceTable();
  const models: Record<string, unknown> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as {
      requestedId?: unknown;
      reportedAs?: unknown;
      rate?: unknown;
    };
    if (typeof model.requestedId !== "string" || !model.requestedId.trim()) {
      continue;
    }
    // An entry with no rate prices nothing: it would add a key mapping to no
    // figure, which `readRateMap` drops anyway.
    if (!model.rate || typeof model.rate !== "object") continue;
    models[model.requestedId] = {
      ...(model.rate as Record<string, unknown>),
      reportedAs: model.reportedAs,
    };
  }
  if (Object.keys(models).length === 0) return emptyPriceTable();
  return parseProviders({ record: { endpoint, models } });
}

/**
 * Validate one record file's contents, or undefined if this build cannot use it.
 *
 * `pid` and `updatedMs` are both **optional**, and that is the whole point of
 * the format being usable by hand. Together they express a lease: a record that
 * names a live process, refreshed often enough to still look current, applies
 * only while that process is around, which is what an auto-writer wants so a
 * closed window stops pricing new sessions. A record that declares neither is a
 * standing declaration, like a settings entry, and stays live until deleted.
 *
 * So each is checked only when present. Requiring them would make a
 * hand-written record both impossible to author (whose pid?) and silently
 * self-expiring, which is the opposite of what someone writing a config file
 * means. Declaring one and not the other is fine: each constrains on its own.
 *
 * Rejected regardless: an unreadable `apiVersion`, and a record naming no
 * project directory, which nothing could ever match.
 */
function readRecord(raw: unknown): ByokRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.apiVersion !== "number" || o.apiVersion < 1) return undefined;
  // A non-numeric timestamp is a malformed claim rather than an absent one, so
  // it is read as 0 and then, being absent, left unbounded.
  const updatedMs = typeof o.updatedMs === "number" ? o.updatedMs : 0;
  if (updatedMs > 0 && Date.now() - updatedMs > MAX_AGE_MS) return undefined;
  if (o.pid !== undefined && !isLive(Number(o.pid))) return undefined;
  const dirs: string[] = [];
  if (Array.isArray(o.projectDirs)) {
    for (const value of o.projectDirs) {
      const dir = normalizeDir(value);
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    }
  }
  if (dirs.length === 0) return undefined;
  const endpoint = normalizeEndpoint(
    typeof o.endpoint === "string" ? o.endpoint : undefined
  );
  return {
    dirs,
    endpoint,
    reportedCostIsGuess: o.costBasis === "unknown",
    prices: readPrices(endpoint, o.models),
    updatedMs,
  };
}

/** Every readable, live record in the directory. A missing directory, which is
 *  the case whenever nothing writes one, is ordinary and yields an empty list. */
export function readByokRecords(): ByokRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(RECORDS_DIR);
  } catch {
    return [];
  }
  const out: ByokRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: ByokRecord | undefined;
    try {
      record = readRecord(
        JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, name), "utf8"))
      );
    } catch {
      continue; // half-written or hand-mangled; a writer rewrites it in time
    }
    if (record) out.push(record);
  }
  return out;
}

/**
 * The record covering a Claude Code session rooted at `workspace`, if any.
 *
 * Matched on the *longest* directory containing the session, so a record naming
 * a subdirectory wins over one naming the repository root above it, which is the
 * more specific claim. A tie on depth goes to the most recently written record.
 */
export function findByokRecord(
  records: readonly ByokRecord[],
  workspace: string | undefined
): ByokRecord | undefined {
  const dir = normalizeDir(workspace);
  if (!dir) return undefined;
  let best: ByokRecord | undefined;
  let bestDepth = -1;
  for (const record of records) {
    for (const parent of record.dirs) {
      if (!isWithinDir(dir, parent)) continue;
      const depth = parent.split(path.sep).length;
      if (
        depth > bestDepth ||
        (depth === bestDepth && best && record.updatedMs > best.updatedMs)
      ) {
        best = record;
        bestDepth = depth;
      }
    }
  }
  return best;
}

/** Every record's rates, merged. Filed per endpoint, so two records on two
 *  gateways cannot price each other's traffic; a record naming no endpoint
 *  contributes to the model-only table instead. */
export function recordPrices(records: readonly ByokRecord[]): PriceTable {
  let table = emptyPriceTable();
  for (const record of records) table = mergePriceTables(table, record.prices);
  return table;
}

/** Re-exported so callers need not reach into `pricing` for the rate shape. */
export type { ModelRate };
