import * as vscode from "vscode";
import { BillingService } from "./billing";
import { SpeedStore } from "./store";
import { fmtTokPerSecFixed } from "./format";
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
    private readonly billing: BillingService,
    alignment: vscode.StatusBarAlignment,
    priority: number
  ) {
    this.item = this.createItem(alignment, priority);
    this.store.on("update", () => this.render());
    this.timer = setInterval(() => this.render(), REFRESH_MS);
  }

  /** Move the bolt to another side or position. VS Code fixes an item's
   *  alignment and priority when it is created, so moving the bolt means
   *  replacing its item. */
  place(alignment: vscode.StatusBarAlignment, priority: number): void {
    if (alignment === this.item.alignment && priority === this.item.priority) {
      return;
    }
    this.item.dispose();
    this.item = this.createItem(alignment, priority);
  }

  /** Reflect the stats tab being open (solid) vs closed (hollow). */
  setActive(active: boolean): void {
    this.active = active;
    this.render();
  }

  /** Rebuild outside the usual triggers, for a change (an edited price table)
   *  that alters the hover without altering the shared state. */
  refresh(): void {
    this.render();
  }

  private createItem(
    alignment: vscode.StatusBarAlignment,
    priority: number
  ): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(alignment, priority);
    item.command = "claudeSpeedometer.togglePanel";
    // The label the status bar's context menu lists the bolt under.
    item.name = "Claude Code Speedometer";
    this.render(item);
    item.show();
    return item;
  }

  private render(item = this.item): void {
    const turn = this.store.getLatest();
    const speedStr = fmtTokPerSecFixed(
      turn ? viewOf(turn, Date.now()).totalTokPerSec : undefined
    );

    item.text = `$(zap) ${speedStr} tok/s`;
    // While the stats tab is open, fill the item with the warning background to
    // mark the active state. VS Code only allows warning/error *backgrounds* for
    // status-bar items, and it auto-pairs a contrasting foreground, so this stays
    // legible in both light and dark themes. (A plain foreground tint such as
    // prominentForeground renders near-white and vanishes on light backgrounds.)
    item.backgroundColor = this.active
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    item.tooltip = buildTooltip(this.store, this.billing);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
