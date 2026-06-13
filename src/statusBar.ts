import * as vscode from "vscode";
import { SpeedStore } from "./store";
import { fmtTokPerSec } from "./format";
import { viewOf } from "./types";
import { buildTooltip } from "./tooltip";

/**
 * The bolt indicator. Reads the shared store, so every window shows the same
 * machine-wide value. Hovering shows the stats overlay; clicking toggles the
 * solid (highlighted) vs hollow (plain) appearance.
 */
// How often to rebuild the tooltip so its relative "(x ago)" hint stays current
// between interactions. The tooltip is a static MarkdownString computed at render
// time, so without this it would freeze at whatever age it had on the last update.
const REFRESH_MS = 10_000;

export class SpeedStatusBar {
  private item: vscode.StatusBarItem;
  private active = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: SpeedStore,
    priority: number
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      priority
    );
    this.item.command = "claudeSpeedometer.togglePanel";
    this.item.name = "Claude Speedometer";
    this.render();
    this.item.show();
    this.store.on("update", () => this.render());
    this.timer = setInterval(() => this.render(), REFRESH_MS);
  }

  /** Reflect the stats tab being open (solid) vs closed (hollow). */
  setActive(active: boolean): void {
    this.active = active;
    this.render();
  }

  private render(): void {
    const turn = this.store.getLatest();
    const speedStr = turn
      ? fmtTokPerSec(viewOf(turn, Date.now()).totalTokPerSec)
      : "-";

    this.item.text = `$(zap) ${speedStr} tok/s`;
    // While the stats tab is open, fill the item with the warning background to
    // mark the active state. VS Code only allows warning/error *backgrounds* for
    // status-bar items, and it auto-pairs a contrasting foreground, so this stays
    // legible in both light and dark themes. (A plain foreground tint such as
    // prominentForeground renders near-white and vanishes on light backgrounds.)
    this.item.backgroundColor = this.active
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = buildTooltip(this.store);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
