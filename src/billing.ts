import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  ANTHROPIC_DEFAULT_ENDPOINT,
  BillingContext,
  BillingSource,
  ModelRate,
  PriceTable,
  mergePriceTables,
  normalizeEndpoint,
  parseProviders,
  withEndpointRates,
  withModelRates,
} from "./pricing";
import {
  ByokRecord,
  claimDepth,
  findByokRecord,
  readByokRecords,
  recordPrices,
} from "./byokRecords";
import { ProviderRelay, RELAY_TICK_MS, readRelays } from "./providerRelay";

// How long a resolved answer is reused. Every input (three settings files, this
// process's environment, a provider extension's exports) is re-read behind this,
// so a provider switch takes effect within a couple of seconds, which is well
// inside the Claude Code restart the switch requires anyway. Without it, each of
// the several api_request events a turn produces would re-stat and re-parse the
// same files.
const CACHE_MS = 2000;

const HOME_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

/**
 * The exports this extension looks for on another extension in the same window:
 * a callable `getBillingContext` returning the object below. Only `armed`,
 * `endpoint` and `pricing` are consumed. The rest of the published shape
 * (`model`, `models`, `tierModels`, `costBasis`) says nothing this extension
 * does not already read off each event.
 */
interface ProviderExports {
  getBillingContext?: () => unknown;
}

/** A provider answer with the moment it was read. An `answer` of undefined
 *  means the scan found no armed provider, which is as worth caching as a hit. */
interface CachedProvider {
  at: number;
  answer: ProviderAnswer | undefined;
}

/** What a provider told us, once validated. Its mere existence means a provider
 *  is managing this window's Claude Code, which is itself a base-URL override
 *  even when the provider declines to say where requests go. */
interface ProviderAnswer {
  /** Normalized base URL, or undefined when the provider is armed but silent
   *  about the endpoint. */
  endpoint?: string;
  /** The provider's own `costBasis` of "unknown": Claude Code did not recognize
   *  the model, so what it reported is its default model's rate. */
  reportedCostIsGuess: boolean;
  /** Rates keyed by model id, if the provider supplies them. */
  pricing?: Map<string, ModelRate>;
}

/**
 * Resolves where Claude Code is sending requests, and at what rates.
 *
 * Claude Code's own precedence is mirrored: a settings file is applied over the
 * process environment unconditionally, and a project file over the user's. Two
 * sources outrank both, being the only ones that can see the fourth
 * configuration route, where the endpoint is injected straight into the Claude
 * binary's environment and appears in no file and in no environment this
 * extension host can read:
 *
 * 1. A BYOK record, consulted first because it is the only source scoped to the
 *    *session's own* project directory rather than to whichever window happens
 *    to be reading. See `./byokRecords`.
 * 2. A billing-context provider extension, which answers for its own window
 *    alone. It is therefore trusted only for a session that its window's
 *    folders could plausibly contain, and never for one a record has already
 *    claimed. Each window relays its provider's answer to the others (see
 *    `./providerRelay`), so a session is attributed the same way whichever
 *    window runs the receiver.
 *
 * Reads are per Claude Code *session project directory*, not per VS Code
 * workspace folder. One window's receiver ingests events from every session on
 * the machine, so keying on the window's own folders would apply one project's
 * provider to another project's traffic.
 */
export class BillingService implements BillingSource {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the configured rates change, so the leader can re-derive the
   *  daily ledger it publishes. */
  readonly onDidChange = this.emitter.event;

  private readonly subscription: vscode.Disposable;
  private contexts = new Map<string, { at: number; ctx: BillingContext }>();
  private provider: CachedProvider | undefined;
  private priceTable: PriceTable | undefined;
  private mergedPrices: { at: number; table: PriceTable } | undefined;
  // The record directory, re-read behind the same cache window as everything
  // else: one scan serves every api_request in a burst, and a configuration
  // change in another window takes effect within a couple of seconds.
  private records: { at: number; list: ByokRecord[] } | undefined;
  // Every other window's relayed provider answer, cached the same way.
  private relays: { at: number; list: ByokRecord[] } | undefined;
  // This window's own answer, passed on for whichever window runs the receiver.
  private readonly relay = new ProviderRelay();
  private readonly relayTimer: ReturnType<typeof setInterval>;
  private readonly folderSubscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeSpeedometer")) return;
      this.priceTable = undefined;
      this.mergedPrices = undefined;
      this.provider = undefined;
      this.records = undefined;
      this.relays = undefined;
      this.contexts.clear();
      this.publishRelay();
      this.emitter.fire();
    });
    this.folderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.publishRelay()
    );
    // A provider announces nothing when its answer changes, and may not even be
    // active yet at this point, so its answer is polled.
    this.relayTimer = setInterval(() => this.publishRelay(), RELAY_TICK_MS);
    this.publishRelay();
  }

  dispose(): void {
    clearInterval(this.relayTimer);
    this.relay.clear();
    this.folderSubscription.dispose();
    this.subscription.dispose();
    this.emitter.dispose();
  }

  context(workspace: string | undefined): BillingContext {
    const key = workspace ?? "";
    const now = Date.now();
    const hit = this.contexts.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.ctx;
    const ctx = this.resolveContext(workspace);
    this.contexts.set(key, { at: now, ctx });
    return ctx;
  }

  prices(): PriceTable {
    const now = Date.now();
    if (this.mergedPrices && now - this.mergedPrices.at < CACHE_MS) {
      return this.mergedPrices.table;
    }
    if (!this.priceTable) {
      this.priceTable = parseProviders(
        vscode.workspace
          .getConfiguration("claudeSpeedometer")
          .get<unknown>("providers")
      );
    }
    // Rates declared in a BYOK record win over the setting: they are generated
    // by whatever configures that endpoint, so unlike a hand-written table they
    // cannot drift out of date. Every one is filed under its own endpoint, so
    // two records on two gateways cannot price each other's turns.
    let table = mergePriceTables(
      this.priceTable,
      recordPrices(this.resolveRecords())
    );
    // Another window's provider rates rank as this window's own do, over the
    // records, but beneath this window's, which are read live.
    table = mergePriceTables(table, recordPrices(this.resolveRelays()));
    const answer = this.resolveProvider();
    if (answer?.pricing && answer.pricing.size > 0) {
      table = answer.endpoint
        ? withEndpointRates(table, answer.endpoint, answer.pricing)
        : withModelRates(table, answer.pricing);
    }
    this.mergedPrices = { at: now, table };
    return table;
  }

  /** The live BYOK records, cached for {@link CACHE_MS}. */
  private resolveRecords(): ByokRecord[] {
    const now = Date.now();
    if (this.records && now - this.records.at < CACHE_MS) {
      return this.records.list;
    }
    const list = readByokRecords();
    this.records = { at: now, list };
    return list;
  }

  /** Every other window's relayed provider answer, cached for
   *  {@link CACHE_MS}. */
  private resolveRelays(): ByokRecord[] {
    const now = Date.now();
    if (this.relays && now - this.relays.at < CACHE_MS) {
      return this.relays.list;
    }
    const list = readRelays();
    this.relays = { at: now, list };
    return list;
  }

  /** Pass this window's provider answer on to whichever window reads it. */
  private publishRelay(): void {
    this.relay.publish(this.resolveProvider(), this.folderPaths());
  }

  private resolveContext(workspace: string | undefined): BillingContext {
    // A record is asked for first and taken as final when one covers this
    // session, being the one source that answers for the session's own project
    // directory rather than for whoever is reading.
    const record = findByokRecord(this.resolveRecords(), workspace);
    if (record) return claimedContext(record);

    // A provider speaks only for its own window. Applying its answer to a
    // session rooted elsewhere is what stamps one window's endpoint onto
    // another window's traffic, and at that point the figure is not merely
    // unknown but confidently wrong. Every window's provider is heard, this
    // window's read directly and the others' as relayed, so which window runs
    // the receiver makes no difference to the answer.
    const answer = this.resolveProvider();
    const relay = findByokRecord(this.resolveRelays(), workspace);
    if (answer && this.speaksFor(workspace, relay)) {
      return claimedContext(answer);
    }
    if (relay) return claimedContext(relay);

    // Later files win, matching Claude Code: the project's shared settings are
    // applied over the user's, and the project's local settings over those.
    const files = [HOME_SETTINGS];
    if (workspace) {
      files.push(path.join(workspace, ".claude", "settings.json"));
      files.push(path.join(workspace, ".claude", "settings.local.json"));
    }
    let raw: string | undefined;
    let overrideSeen = false;
    for (const file of files) {
      const value = baseUrlIn(file);
      if (value) {
        raw = value;
        overrideSeen = true;
      }
    }
    if (!raw) {
      // Visible only when VS Code inherited the login shell environment. An
      // export made inside an integrated terminal never reaches here.
      const fromEnv = (process.env.ANTHROPIC_BASE_URL ?? "").trim();
      if (fromEnv) {
        raw = fromEnv;
        overrideSeen = true;
      }
    }
    // An override that fails to parse leaves the endpoint unresolved but still
    // counts as seen, so the model-id fallback stays shut.
    return { endpoint: normalizeEndpoint(raw), overrideSeen };
  }

  /**
   * True when this window's provider, rather than the `relay` matched for
   * another window, speaks for a session rooted at `workspace`: when this
   * window's folders contain the session at least as specifically as the
   * relay's do, so that it could be one this window spawned. The more specific
   * claim wins as it does between records, and a tie goes to this window, whose
   * answer is live rather than relayed. A session whose directory has not
   * resolved yet is the one case with nothing to compare, and there this
   * window's provider is still the best answer available.
   */
  private speaksFor(
    workspace: string | undefined,
    relay: ByokRecord | undefined
  ): boolean {
    if (workspace === undefined) return true;
    const own = claimDepth(this.folderPaths(), workspace);
    const other = relay ? claimDepth(relay.dirs, workspace) : -1;
    return own >= 0 && own >= other;
  }

  /** This window's own folders on disk. */
  private folderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
  }

  /**
   * Ask the billing-context provider extension in this window, if there is one.
   * The setting gates the scan: "auto" takes the first armed provider found,
   * "off" skips it, and any other value pins one extension id.
   */
  private resolveProvider(): ProviderAnswer | undefined {
    const now = Date.now();
    if (this.provider && now - this.provider.at < CACHE_MS) {
      return this.provider.answer;
    }
    const answer = this.scanProviders();
    this.provider = { at: now, answer };
    return answer;
  }

  private scanProviders(): ProviderAnswer | undefined {
    const pin = vscode.workspace
      .getConfiguration("claudeSpeedometer")
      .get<string>("billingContextProvider", "auto")
      .trim();
    if (pin.toLowerCase() === "off") return undefined;
    const pinned = pin.toLowerCase() === "auto" ? undefined : pin.toLowerCase();
    for (const ext of vscode.extensions.all) {
      if (pinned && ext.id.toLowerCase() !== pinned) continue;
      if (!ext.isActive) continue; // exports are only populated once activated
      const api = ext.exports as ProviderExports | undefined;
      if (!api || typeof api.getBillingContext !== "function") continue;
      let raw: unknown;
      try {
        raw = api.getBillingContext();
      } catch {
        continue; // a provider that throws is no provider
      }
      const answer = readProviderContext(raw);
      if (answer) return answer;
    }
    return undefined;
  }
}

/** The context a record or a provider claims. Either is an override in its own
 *  right, whether or not it names an endpoint. */
function claimedContext(claim: {
  endpoint?: string;
  reportedCostIsGuess: boolean;
}): BillingContext {
  return {
    endpoint: claim.endpoint,
    overrideSeen: true,
    reportedCostIsGuess: claim.reportedCostIsGuess,
  };
}

/** Validate one provider's reply. A falsy `armed` means the provider is present
 *  but not managing anything right now, so it is passed over rather than taken
 *  as an authoritative "no override". */
function readProviderContext(raw: unknown): ProviderAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!o.armed) return undefined;
  // "unknown" is the provider reporting that Claude Code had no row for this
  // model and fell back to its default model's rate. Any other value, including
  // a provider that publishes no costBasis at all, leaves the question to be
  // decided from the endpoint as before.
  const reportedCostIsGuess = o.costBasis === "unknown";
  const url = typeof o.endpoint === "string" ? o.endpoint : undefined;
  // A null endpoint is the provider's way of saying "first party", but only from
  // one that also stands behind the reported figure. Said together with
  // "unknown" it means the opposite: an account somewhere else whose URL the
  // provider is not naming. Reading that as Anthropic's would both trust the
  // figure the provider just disowned and file the turn's history under an
  // endpoint it never used, so the endpoint stays unresolved and the rates the
  // provider supplies are what price the turn.
  const endpoint =
    o.endpoint === null && !reportedCostIsGuess
      ? ANTHROPIC_DEFAULT_ENDPOINT
      : normalizeEndpoint(url);
  // Filed under no endpoint, so the rates land in the model-only table and the
  // caller decides where to apply them; `parseProviders` also expands whatever
  // `reportedAs` aliases the provider declared.
  const pricing = parseProviders({ provider: { models: o.pricing } }).byModel;
  return {
    endpoint,
    reportedCostIsGuess,
    pricing: pricing.size > 0 ? pricing : undefined,
  };
}

/** `env.ANTHROPIC_BASE_URL` from one Claude Code settings file, or undefined if
 *  the file is missing, unparseable, or does not set it. An empty string counts
 *  as unset, which is how Claude Code reads it too. */
function baseUrlIn(file: string): string | undefined {
  let parsed: { env?: Record<string, unknown> };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const value = parsed?.env?.ANTHROPIC_BASE_URL;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
