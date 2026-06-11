import * as vscode from "vscode";
import { SpeedStore } from "./store";
import { fmtTokPerSec } from "./format";
import { Turn, viewOf } from "./types";
import { buildTooltip } from "./tooltip";

/**
 * The bolt indicator. Reads the shared store, so every window shows the same
 * machine-wide value. Hovering shows the stats overlay; clicking toggles the
 * solid (highlighted) vs hollow (plain) appearance.
 */
export class SpeedStatusBar {
  private item: vscode.StatusBarItem;
  private active = false;

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
  }

  /** Reflect the stats tab being open (solid) vs closed (hollow). */
  setActive(active: boolean): void {
    this.active = active;
    this.render();
  }

  private render(): void {
    const turn = this.store.getLatest();
    const speedStr = turn ? fmtTokPerSec(speedBasisValue(turn)) : "-";

    this.item.text = `$(zap) ${speedStr} tok/sec`;
    // VS Code only honors two themed *backgrounds* for status-bar items, so a
    // background fill (while the stats tab is open) uses the warning color.
    // Foreground is left at the theme default (no text-color change of our own).
    this.item.backgroundColor = this.active
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = buildTooltip(this.store);
  }

  dispose(): void {
    this.item.dispose();
  }
}

function speedBasisValue(turn: Turn): number {
  const v = viewOf(turn, Date.now());
  const basis = vscode.workspace
    .getConfiguration("claudeSpeedometer")
    .get<string>("speedBasis", "total");
  return basis === "generation" ? v.generationTokPerSec : v.totalTokPerSec;
}
