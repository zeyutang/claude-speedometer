import * as vscode from "vscode";
import { SpeedStore } from "./store";
import { LeaderManager } from "./leader";
import { SpeedStatusBar } from "./statusBar";
import { StatsPanel } from "./panel";
import {
  applyConfiguration,
  isConfigured,
  settingsPath,
  TelemetryEnv,
} from "./claudeSettings";

const DONT_ASK_KEY = "claudeSpeedometer.dontAskConfigure";

let store: SpeedStore | undefined;
let leader: LeaderManager | undefined;
let statusBar: SpeedStatusBar | undefined;
let panel: StatsPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();

  store = new SpeedStore();
  store.startWatching();

  statusBar = new SpeedStatusBar(store, cfg.statusBarPriority);
  panel = new StatsPanel(store, (visible) => statusBar?.setActive(visible));

  // Elect a leader: the window that binds the port runs the receiver and
  // publishes to the shared store. Followers mirror it; on leader close, a
  // follower takes over automatically.
  leader = new LeaderManager(store, cfg.port, cfg.retentionDays);
  await leader.start();

  context.subscriptions.push(
    statusBar,
    { dispose: () => panel?.dispose() },
    { dispose: () => leader?.dispose() },
    { dispose: () => store?.dispose() },
    vscode.commands.registerCommand("claudeSpeedometer.togglePanel", () =>
      panel?.toggle()
    ),
    vscode.commands.registerCommand("claudeSpeedometer.configureTelemetry", () =>
      configure(readConfig(), true)
    )
  );

  // First-run: offer to wire up Claude Code's telemetry unless already done.
  if (
    !isConfigured(cfg) &&
    !context.globalState.get<boolean>(DONT_ASK_KEY, false)
  ) {
    void promptToConfigure(context, cfg);
  }
}

export function deactivate(): void {
  leader?.dispose();
  panel?.dispose();
  statusBar?.dispose();
  store?.dispose();
}

function readConfig(): TelemetryEnv & {
  statusBarPriority: number;
  retentionDays: number;
} {
  const c = vscode.workspace.getConfiguration("claudeSpeedometer");
  return {
    port: c.get<number>("port", 4318),
    exportIntervalMs: c.get<number>("exportIntervalMs", 2000),
    statusBarPriority: c.get<number>("statusBarPriority", -Number.MAX_SAFE_INTEGER),
    retentionDays: c.get<number>("retentionDays", 7),
  };
}

async function promptToConfigure(
  context: vscode.ExtensionContext,
  cfg: TelemetryEnv
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Claude Speedometer: enable telemetry so this extension can read interaction stats? " +
      "This adds an `env` block to ~/.claude/settings.json (Claude Code must be restarted afterward).",
    "Configure",
    "Not now",
    "Don't ask again"
  );
  if (choice === "Configure") {
    configure(cfg, true);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(DONT_ASK_KEY, true);
  }
}

function configure(cfg: TelemetryEnv, notify: boolean): void {
  try {
    applyConfiguration(cfg);
    if (notify) {
      vscode.window.showInformationMessage(
        `Telemetry configured in ${settingsPath()}. Restart Claude Code for it to take effect.`
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Speedometer: failed to write ${settingsPath()}: ${
        (err as Error).message
      }`
    );
  }
}
