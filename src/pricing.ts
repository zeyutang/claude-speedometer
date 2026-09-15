// Cost attribution: deciding whether the cost Claude Code reports for a request
// can be believed, and recomputing it from token counts when it cannot.
//
// Claude Code prices every request client-side against a table bundled into the
// CLI. When no row matches the model id it does not report nothing: it falls
// back to the default model's rate, so a third-party model is billed at Claude's
// price and the figure reaches `cost_usd` looking entirely ordinary. Claude
// Code's own settings schema names that case (a `costBasis` of "unknown"), but
// no such marker is exported, so the api_request event alone cannot separate a
// real figure from a guess. Nor can the mispricing be configured away:
// `modelPricing` is Claude Code's only setting that accepts rates, and its
// schema says it is honored solely from managed settings or a managing host
// application, never from user, project, local or --settings sources.
//
// So trust is decided here, from the endpoint the requests are going to, and
// this module carries the rates needed to recompute what the upstream figure
// gets wrong.

import { URL } from "url";

/** Claude Code's own base URL. Also what a billing-context provider means when
 *  it reports a null endpoint, so that answer can be carried as a plain string
 *  instead of a third state. */
export const ANTHROPIC_DEFAULT_ENDPOINT = "https://api.anthropic.com";

/**
 * Rates for one model, in USD per million tokens.
 *
 * All four are required rather than derived from `input`, because the cache
 * write rate genuinely varies by biller: Anthropic surcharges a write (1.25x
 * the input rate at the 5-minute TTL, 2x at the 1-hour one), whereas a gateway
 * that bills only input, cached input and output charges a write as an ordinary
 * input token. Deriving the write rate would be right for one and wrong for the
 * other, and wrong silently.
 */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The rates available for recomputing a turn. Keys are lowercased on the way in
 * and lookups lowercase their arguments, so matching is case-insensitive.
 */
export interface PriceTable {
  /** Normalized base URL -> reported model id -> rate.
   *
   *  Keyed by every id a rate can arrive under, not by the id that was
   *  requested: a model entry's own key plus each of its `reportedAs` aliases
   *  are inserted as separate keys onto the same rate. There is deliberately no
   *  wildcard key. A blanket per-endpoint rate would price every model a gateway
   *  serves at one figure and so swallow exactly the mismatch this module exists
   *  to surface, turning a visible "unpriced" into a plausible wrong number. */
  byEndpoint: Map<string, Map<string, ModelRate>>;
  /** Reported model id -> rate, consulted only when the endpoint is unknown.
   *  Alias-expanded the same way. */
  byModel: Map<string, ModelRate>;
}

export function emptyPriceTable(): PriceTable {
  return { byEndpoint: new Map(), byModel: new Map() };
}

/**
 * Where Claude Code is sending requests, as best this extension can tell.
 *
 * Every field is a snapshot of current configuration, so this is resolved once
 * at ingest and stamped onto the turn. Re-deriving it at render time would
 * re-attribute history the moment a user switched providers.
 */
export interface BillingContext {
  /** Normalized base URL, or undefined when it could not be resolved. */
  endpoint?: string;
  /**
   * True when a base-URL override was seen anywhere: a Claude Code settings
   * file, this process's environment, or an armed billing-context provider.
   * Kept separate from `endpoint` because an override that fails to parse still
   * rules out the "plain first-party install" reading that the model-only
   * fallback in {@link costBasisFor} depends on.
   */
  overrideSeen: boolean;
  /**
   * True when a billing-context provider reported outright that Claude Code
   * priced these requests at its default model's rate. Only a provider can know
   * this, so it is the one direct answer to a question every other input here
   * can only be evidence about.
   */
  reportedCostIsGuess?: boolean;
}

/**
 * Whether a turn's cost comes from Claude Code or from this extension.
 *
 * - `upstream`: the requests went to first-party Anthropic, so Claude Code's
 *   `cost_usd` is authoritative and is what the turn accumulates.
 * - `local`: the requests went, or may have gone, somewhere else, so the
 *   reported figure is a guess at Anthropic's rate and is discarded. Cost is
 *   recomputed from the turn's token counts at render time.
 */
export type CostBasis = "upstream" | "local";

/** The parts of a turn that determine its cost. `Turn` satisfies this
 *  structurally, and naming the subset here keeps this module free of a
 *  back-edge to the shared type module, which imports from it. */
export interface CostInputs {
  model?: string;
  endpoint?: string;
  costBasis?: CostBasis;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** A turn's cost and where the number came from. `unpriced` carries no figure
 *  at all: rendering it as $0.00, or falling back to the upstream guess, would
 *  turn a visible gap back into an invisible error. */
export type PricedCost =
  | { state: "upstream"; usd: number }
  | { state: "recomputed"; usd: number }
  | { state: "unpriced" };

/**
 * Canonical form of a base URL, used both as a price-table key and for the
 * first-party test: lowercased scheme and host, a default port dropped, a
 * trailing slash removed, the path kept.
 *
 * The path has to stay. Providers sit under one host at different paths
 * ("/coding/", "/api/anthropic", "/api"), so folding it away would merge
 * endpoints that bill differently. Returns undefined for anything that is not
 * an absolute http(s) URL.
 */
export function normalizeEndpoint(
  raw: string | undefined | null,
): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  // URL already drops a port that is the scheme's default, and lowercases both
  // the scheme and the host.
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * True for Anthropic's own API, the only endpoint whose `cost_usd` is
 * authoritative. Any host under anthropic.com is Anthropic billing by
 * definition, and no third-party gateway can be one.
 *
 * A corporate proxy that forwards to Anthropic is deliberately not first party:
 * it may add a margin, and it cannot be told apart from a reseller. Such a setup
 * reads as unpriced until a rate is configured for it, which is the intended
 * direction of error.
 */
export function isFirstPartyEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

/**
 * True when a model id is a first-party Anthropic spelling and nothing else.
 *
 * The test is anchored to the whole string, which is the point. A gateway alias
 * can embed a first-party name: OpenRouter serves the model id
 * "~anthropic/claude-opus-latest[1m]" at OpenRouter's rates, so any prefix or
 * substring test for "claude" reads it as Anthropic's and trusts a wrong
 * number. Here the known platform prefixes and suffixes are peeled off first
 * and whatever remains must be exactly a `claude-<family>` id, so a vendor
 * namespace or path segment disqualifies it.
 *
 * Recognizing the shape rather than listing every released id is deliberate. A
 * literal list would go stale on each new dated spelling, and this is the branch
 * an ordinary first-party user always lands in (they never set a base URL, so
 * their endpoint is unresolvable), which would leave them unpriced until the
 * extension shipped an update. The residual risk is a gateway that both hides
 * behind process-environment injection and names its model with an exact
 * first-party spelling. {@link costBasisFor} only reaches this test when no
 * override was found anywhere, and a billing-context provider closes even that.
 */
export function isFirstPartyModelId(model: string | undefined): boolean {
  if (!model) return false;
  let s = model.trim().toLowerCase();
  s = s.replace(/\[1m\]$/, ""); // 1M-context variants: claude-opus-5[1m]
  s = s.replace(/@\d{6,8}$/, ""); // Vertex pins a release: ...-4-1@20250805
  s = s.replace(/-v\d+:\d+$/, ""); // Bedrock model version: ...-v1:0
  s = s.replace(/^(?:us|eu|apac|us-gov|global)\./, ""); // Bedrock region prefix
  s = s.replace(/^anthropic\./, ""); // Bedrock/Foundry vendor prefix
  return /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(s);
}

/**
 * Whether Claude Code's reported cost can be believed for one request.
 *
 * Decided from the endpoint whenever the endpoint is known, and from the model
 * only when it is not, because a model id can be made to look first-party
 * (see {@link isFirstPartyModelId}) while an endpoint cannot. The model-only
 * fallback additionally requires that no base-URL override was found anywhere,
 * so it only ever fires on a machine with no third-party configuration in sight.
 */
export function costBasisFor(
  model: string | undefined,
  ctx: BillingContext,
): CostBasis {
  // A provider managing this window's Claude Code can state the answer rather
  // than leave it to be inferred, and it is checked first because it is the only
  // input that cannot be misread: an endpoint can be unresolvable and a model id
  // can be made to look first-party, but nothing else is in a position to say
  // that the reported figure is the default-model fallback. It can only withdraw
  // trust, never grant it, so a provider claiming a usable figure still has to
  // get past the endpoint test below.
  if (ctx.reportedCostIsGuess) return "local";
  if (ctx.endpoint) {
    return isFirstPartyEndpoint(ctx.endpoint) ? "upstream" : "local";
  }
  if (ctx.overrideSeen) return "local";
  return isFirstPartyModelId(model) ? "upstream" : "local";
}

/**
 * Reconcile a resolved billing context with the model the event actually names.
 *
 * A first-party endpoint claim is refuted when the served model id is one
 * Anthropic's API does not have: the id on the event is direct evidence of what
 * served the request, while the endpoint is inferred from configuration, which
 * can be stale or describe another account than the one serving this process (a
 * billing-context provider answering for an account it did not inject is how
 * this fires). The claim is disbelieved rather than the model, so the turn is
 * costed locally from a configured rate, and its endpoint is left unknown
 * instead of being stamped with a URL it did not use.
 *
 * A turn whose event names no model carries no contradicting evidence, and a
 * `claude-` id cannot refute a first-party claim, so both pass through
 * unchanged.
 */
export function reconcileContext(
  model: string | undefined,
  ctx: BillingContext,
): BillingContext {
  if (!model) return ctx;
  if (!ctx.endpoint || !isFirstPartyEndpoint(ctx.endpoint)) return ctx;
  if (isFirstPartyModelId(model)) return ctx;
  return { ...ctx, endpoint: undefined };
}

/**
 * The configured rate for one turn, or undefined if none matches.
 *
 * The model is looked up under the id the *event* reports, which on a gateway
 * that resolves aliases server-side is not the id that was requested: Fireworks
 * serves `accounts/fireworks/models/glm-5p3` and reports
 * `accounts/fireworks/models/glm-5p3` on every streamed request, and Claude Code
 * only streams. That is what `reportedAs` is for, and because the aliases are
 * expanded into keys at parse time this stays a single map lookup.
 *
 * A known endpoint is matched against `byEndpoint` and nothing else. Falling
 * through to the model-only table would let one gateway's rate price another's
 * traffic whenever the two serve the same model id, which is exactly the error
 * this whole module exists to avoid. `byModel` therefore covers only the case
 * where the endpoint could not be resolved at all.
 */
export function lookupRate(
  prices: PriceTable,
  endpoint: string | undefined,
  model: string | undefined,
): ModelRate | undefined {
  const m = (model ?? "").trim().toLowerCase();
  if (endpoint) {
    const forEndpoint = prices.byEndpoint.get(endpoint.toLowerCase());
    if (!forEndpoint) return undefined;
    return forEndpoint.get(m);
  }
  return prices.byModel.get(m);
}

/** Token counts times their rates, per million. The four buckets Claude Code
 *  reports are disjoint (`input_tokens` excludes both cache buckets), so they
 *  simply add. */
export function computeCost(t: CostInputs, r: ModelRate): number {
  return (
    (t.inputTokens * r.input +
      t.outputTokens * r.output +
      t.cacheReadTokens * r.cacheRead +
      t.cacheCreationTokens * r.cacheWrite) /
    1e6
  );
}

/**
 * What to show for a turn's cost, derived at render time rather than baked at
 * ingest: turns are retained for days, so a later correction to the price table
 * has to be able to fix history that was already recorded.
 */
export function priceTurn(t: CostInputs, prices: PriceTable): PricedCost {
  // Absent on snapshots written before cost attribution existed. Those turns
  // were shown at the upstream figure and cannot be re-classified now (the
  // configuration that produced them is gone), so leave them as they read.
  if ((t.costBasis ?? "upstream") === "upstream") {
    return { state: "upstream", usd: t.costUsd };
  }
  const rate = lookupRate(prices, t.endpoint, t.model);
  if (!rate) return { state: "unpriced" };
  return { state: "recomputed", usd: computeCost(t, rate) };
}

/** One rate object from configuration, or undefined if it is not four finite,
 *  non-negative numbers. A partial row is dropped rather than half-applied: a
 *  missing rate would silently undercount, which is the failure mode this
 *  module is here to prevent. */
function readRate(raw: unknown): ModelRate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out = {} as ModelRate;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const n = typeof o[k] === "number" ? (o[k] as number) : NaN;
    if (!Number.isFinite(n) || n < 0) return undefined;
    out[k] = n;
  }
  return out;
}

/** The ids one configured model can arrive under: its own key first, then each
 *  `reportedAs` alias. Lowercased and de-duplicated, so the caller can insert
 *  them as keys without checking. A non-string or blank alias is skipped. */
function readReportedIds(model: string, raw: unknown): string[] {
  const out: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id !== "string") return;
    const key = id.trim().toLowerCase();
    if (key && !out.includes(key)) out.push(key);
  };
  add(model);
  const aliases = (raw as { reportedAs?: unknown } | null)?.reportedAs;
  if (Array.isArray(aliases)) for (const id of aliases) add(id);
  return out;
}

/**
 * Model-id -> rate map from a configuration object, lowercasing the keys and
 * inserting each entry's `reportedAs` aliases as further keys onto the same
 * rate.
 *
 * An alias never displaces a model configured in its own right, whichever order
 * the two appear in, so the rate filed under an id is the one written against
 * that id. Where a provider serves two tiers of one model and reports both under
 * the same id (Fireworks' fast router and its standard model), no table keyed on
 * the reported id can separate them, and this rule at least makes which one
 * wins predictable. A BYOK record resolves it properly, declaring the rate of
 * the tier actually in use and nothing else.
 */
function readRateMap(raw: unknown): Map<string, ModelRate> {
  const out = new Map<string, ModelRate>();
  if (!raw || typeof raw !== "object") return out;
  const explicit = new Set<string>();
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const rate = readRate(value);
    if (!rate) continue;
    const ids = readReportedIds(model, value);
    for (const [i, id] of ids.entries()) {
      // i === 0 is the entry's own key; the rest are its aliases, which yield
      // to any model configured under that id directly.
      if (i > 0 && explicit.has(id)) continue;
      if (i === 0) explicit.add(id);
      out.set(id, rate);
    }
  }
  return out;
}

/** One provider's endpoints, normalized. Accepts a single string or a list, so
 *  a gateway reachable at more than one base URL is one provider rather than a
 *  duplicated block of rates. */
function readEndpoints(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const value of list) {
    const endpoint = normalizeEndpoint(
      typeof value === "string" ? value : undefined,
    );
    if (endpoint && !out.includes(endpoint.toLowerCase())) {
      out.push(endpoint.toLowerCase());
    }
  }
  return out;
}

/**
 * Build a price table from the `claudeSpeedometer.providers` setting value:
 * provider name -> `{ endpoint, models }`, where each model id carries its four
 * rates and optionally the ids it is `reportedAs`.
 *
 * The provider name is a label the user chooses and nothing keys on it; the
 * `endpoint` is what a turn is matched against. A provider with no usable
 * endpoint has its models filed under {@link PriceTable.byModel} instead, which
 * is the table consulted when a turn's endpoint could not be resolved at all.
 * Malformed providers, endpoints and rates are skipped rather than rejecting the
 * whole table, so one bad row does not unprice everything else.
 */
export function parseProviders(raw: unknown): PriceTable {
  const table = emptyPriceTable();
  if (!raw || typeof raw !== "object") return table;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const provider = value as { endpoint?: unknown; models?: unknown };
    const rates = readRateMap(provider.models);
    if (rates.size === 0) continue;
    const endpoints = readEndpoints(provider.endpoint);
    if (endpoints.length === 0) {
      for (const [model, rate] of rates) table.byModel.set(model, rate);
      continue;
    }
    for (const endpoint of endpoints) {
      const merged = new Map(table.byEndpoint.get(endpoint) ?? []);
      for (const [model, rate] of rates) merged.set(model, rate);
      table.byEndpoint.set(endpoint, merged);
    }
  }
  return table;
}

/** `base` with `overlay` applied on top, the overlay winning per model rather
 *  than per endpoint: two sources can each know a different tier of the same
 *  gateway, and replacing a whole endpoint's map would drop the rates only the
 *  other one has. */
export function mergePriceTables(
  base: PriceTable,
  overlay: PriceTable,
): PriceTable {
  let table = base;
  for (const [endpoint, rates] of overlay.byEndpoint) {
    table = withEndpointRates(table, endpoint, rates);
  }
  if (overlay.byModel.size > 0) table = withModelRates(table, overlay.byModel);
  return table;
}

/** Overlay `rates` onto the table for `endpoint`, the added rows winning. Used
 *  for rates a billing-context provider supplies: they come from the window
 *  managing the provider, so they cannot be stale the way a hand-written
 *  setting can. */
export function withEndpointRates(
  table: PriceTable,
  endpoint: string,
  rates: Map<string, ModelRate>,
): PriceTable {
  const key = endpoint.toLowerCase();
  const merged = new Map(table.byEndpoint.get(key) ?? []);
  for (const [model, rate] of rates) merged.set(model, rate);
  const byEndpoint = new Map(table.byEndpoint);
  byEndpoint.set(key, merged);
  return { byEndpoint, byModel: table.byModel };
}

/** As {@link withEndpointRates}, for a provider that supplies rates without
 *  saying which endpoint they belong to. */
export function withModelRates(
  table: PriceTable,
  rates: Map<string, ModelRate>,
): PriceTable {
  const byModel = new Map(table.byModel);
  for (const [model, rate] of rates) byModel.set(model, rate);
  return { byEndpoint: table.byEndpoint, byModel };
}

/**
 * What the aggregator needs from its host: where a request is going, at ingest,
 * and what the rates are, at render time. Injected so the aggregator stays free
 * of VS Code and of the file lookups behind both.
 */
export interface BillingSource {
  /** Billing context for a request made from `workspace`, the Claude Code
   *  session's project directory when it is known. */
  context(workspace: string | undefined): BillingContext;
  /** The rates currently in force. */
  prices(): PriceTable;
}

/** A source that resolves no endpoint and finds no override, leaving every turn
 *  to the model-id fallback. Stands in when no host has been wired in. */
export const NO_BILLING_SOURCE: BillingSource = {
  context: () => ({ overrideSeen: false }),
  prices: emptyPriceTable,
};
