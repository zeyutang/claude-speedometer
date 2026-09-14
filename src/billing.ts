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
  normalizeEndpoint,
  parsePriceTable,
  withEndpointRates,
  withModelRates,
} from "./pricing";

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
  /** Rates keyed by model id, if the provider supplies them. */
  pricing?: Map<string, ModelRate>;
}

/**
 * Resolves where Claude Code is sending requests, and at what rates.
 *
 * Claude Code's own precedence is mirrored: a settings file is applied over the
 * process environment unconditionally, and a project file over the user's. The
 * one source that outranks both is a billing-context provider extension, which
 * is also the only thing that can see the fourth configuration route, where the
 * endpoint is injected straight into the Claude binary's environment and appears
 * in no file and in no environment this extension host can read.
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

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeSpeedometer")) return;
      this.priceTable = undefined;
      this.mergedPrices = undefined;
      this.provider = undefined;
      this.contexts.clear();
      this.emitter.fire();
    });
  }

  dispose(): void {
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
      this.priceTable = parsePriceTable(
        vscode.workspace
          .getConfiguration("claudeSpeedometer")
          .get<unknown>("modelPricing")
      );
    }
    // Provider-supplied rates win over the setting: they come from the window
    // that manages the provider, so unlike a hand-written table they cannot
    // drift out of date. They are filed under the provider's own endpoint where
    // it names one, keeping them from pricing another endpoint's history.
    let table = this.priceTable;
    const answer = this.resolveProvider();
    if (answer?.pricing && answer.pricing.size > 0) {
      table = answer.endpoint
        ? withEndpointRates(table, answer.endpoint, answer.pricing)
        : withModelRates(table, answer.pricing);
    }
    this.mergedPrices = { at: now, table };
    return table;
  }

  private resolveContext(workspace: string | undefined): BillingContext {
    const answer = this.resolveProvider();
    if (answer) return { endpoint: answer.endpoint, overrideSeen: true };

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

/** Validate one provider's reply. A falsy `armed` means the provider is present
 *  but not managing anything right now, so it is passed over rather than taken
 *  as an authoritative "no override". */
function readProviderContext(raw: unknown): ProviderAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!o.armed) return undefined;
  // A null endpoint is the provider's way of saying "first party", which is a
  // positive answer rather than a missing one.
  const url = typeof o.endpoint === "string" ? o.endpoint : undefined;
  const endpoint =
    o.endpoint === null ? ANTHROPIC_DEFAULT_ENDPOINT : normalizeEndpoint(url);
  const pricing = parsePriceTable({ byModel: o.pricing }).byModel;
  return { endpoint, pricing: pricing.size > 0 ? pricing : undefined };
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
