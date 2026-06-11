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

/** True if settings.json already has every desired var with the right value. */
export function isConfigured(cfg: TelemetryEnv): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  } catch {
    return false;
  }
  let parsed: { env?: Record<string, string> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const env = parsed.env ?? {};
  const want = desiredEnv(cfg);
  return Object.entries(want).every(([k, v]) => env[k] === v);
}

/**
 * Merge the telemetry env vars into ~/.claude/settings.json, preserving all
 * other settings and existing env entries. Creates the file/dir if needed.
 */
export function applyConfiguration(cfg: TelemetryEnv): void {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    /* missing or invalid: start fresh */
  }
  const env =
    typeof parsed.env === "object" && parsed.env !== null
      ? (parsed.env as Record<string, string>)
      : {};
  parsed.env = { ...env, ...desiredEnv(cfg) };

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

export function settingsPath(): string {
  return SETTINGS_PATH;
}
