import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface TelemetryEnv {
  port: number;
  exportIntervalMs: number;
}

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

function desiredEnv(cfg: TelemetryEnv): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${cfg.port}`,
    OTEL_LOGS_EXPORT_INTERVAL: String(cfg.exportIntervalMs),
  };
}

/**
 * The settings file's contents, or `{}` when there is no file yet. A file that
 * exists but cannot be read as a JSON object throws rather than reading as
 * empty: `applyConfiguration` writes back what this returns, so a typo read as
 * an empty file would erase every other setting in it.
 */
function readSettings(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    // A byte-order mark is valid UTF-8 but not valid JSON.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`it is not valid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("its top level is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** True if settings.json already has every desired var with the right value. */
export function isConfigured(cfg: TelemetryEnv): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = readSettings();
  } catch {
    return false;
  }
  const env = (parsed.env ?? {}) as Record<string, unknown>;
  const want = desiredEnv(cfg);
  return Object.entries(want).every(([k, v]) => env[k] === v);
}

/**
 * Merge the telemetry env vars into ~/.claude/settings.json, preserving all
 * other settings and existing env entries. Creates the file/dir if needed, and
 * throws without writing when an existing file cannot be read as an object.
 */
export function applyConfiguration(cfg: TelemetryEnv): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = readSettings();
  } catch (err) {
    throw new Error(`${(err as Error).message}, so it was left unchanged`);
  }
  const env =
    typeof parsed.env === "object" && parsed.env !== null
      ? (parsed.env as Record<string, string>)
      : {};
  parsed.env = { ...env, ...desiredEnv(cfg) };

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  // Written in place rather than through a temporary file renamed over it: a
  // rename would turn a symlinked settings file (as dotfile managers keep it)
  // into a plain copy, and would reset a mode tightened because its `env` can
  // carry an API token.
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

export function settingsPath(): string {
  return SETTINGS_PATH;
}
