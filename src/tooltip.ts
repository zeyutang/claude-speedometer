import * as vscode from "vscode";
import { SpeedStore } from "./store";
import {
  fmtAgo,
  fmtCost,
  fmtFastMode,
  fmtInt,
  fmtTime,
  fmtTokPerSec,
} from "./format";
import { viewOf } from "./types";

type Row = [string, string];
interface Section {
  title: string;
  rows: Row[];
}

const GAP = "     "; // spacing between the label and value columns
const MIN_VALUE_WIDTH = 12; // keep the value column roomy even for small numbers

/**
 * The overlay shown when hovering the bolt: a rich Markdown box that pops up just
 * above the status bar (lower-right). Sections render as monospace code blocks
 * sharing one column layout, so values align across every section.
 */
export function buildTooltip(store: SpeedStore): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const now = Date.now();

  const latest = store.getLatest();
  if (!latest) {
    md.appendMarkdown(
      "**Claude Code Speed**\n\nWaiting for the next Claude Code interaction…"
    );
    return md;
  }

  const v = viewOf(latest, now);

  const L: string[] = [];
  L.push(`**Latest interaction** · ${fmtAgo(v.ageMs)}`);
  L.push("");
  L.push(`## ${fmtTokPerSec(v.totalTokPerSec)} tok/sec`);
  L.push(
    `output / total time · generation ${fmtTokPerSec(
      v.generationTokPerSec
    )} tok/sec`
  );

  const sections: Section[] = [
    {
      title: "Tokens",
      rows: [
        ["Text Input", fmtInt(v.inputTokens)],
        ["Text Output", fmtInt(v.outputTokens)],
        ["Cache Write", fmtInt(v.cacheCreationTokens)],
        ["Cache Read", fmtInt(v.cacheReadTokens)],
      ],
    },
    {
      title: "Timing",
      rows: [
        ["Time to First Token", fmtTime(v.ttftMs)],
        ["Generation Time", fmtTime(v.generationMs)],
        ["Total Time", fmtTime(v.totalMs)],
        ["API Requests", String(v.requests)],
      ],
    },
    {
      title: "Cost & Model",
      rows: [
        ["Estimated Cost", fmtCost(v.costUsd)],
        ["Model", v.model ?? "-"],
        ["Fast mode", fmtFastMode(v.speed)],
      ],
    },
  ];

  // Shared widths across ALL sections so value columns align everywhere.
  const allRows = sections.flatMap((s) => s.rows);
  const kw = Math.max(...allRows.map((r) => r[0].length));
  const vw = Math.max(MIN_VALUE_WIDTH, ...allRows.map((r) => r[1].length));
  const lineWidth = kw + GAP.length + vw; // right edge shared by every section

  for (const s of sections) {
    L.push("", "---", "");
    L.push(`**${s.title}**`);
    const body = s.rows
      .map(([k, val]) => `${k.padEnd(kw)}${GAP}${val.padStart(vw)}`)
      .join("\n");
    L.push("```text\n" + body + "\n```");
  }

  const recent = store.getRecent(6).map((t) => viewOf(t, now));
  if (recent.length) {
    L.push("", "---", "");
    L.push("**Recent**");
    L.push(
      "```text\n" +
        table(
          ["When", "Output", "tok/sec", "Total"],
          ["l", "r", "r", "r"],
          recent.map((r) => [
            fmtAgo(r.ageMs),
            fmtInt(r.outputTokens),
            fmtTokPerSec(r.totalTokPerSec),
            fmtTime(r.totalMs),
          ]),
          lineWidth
        ) +
        "\n```"
    );
  }

  md.appendMarkdown(L.join("\n"));
  return md;
}

/** N-column table with per-column left/right alignment. When targetWidth is
 *  given, the last column is widened so the table's right edge reaches it. */
function table(
  headers: string[],
  align: Array<"l" | "r">,
  rows: string[][],
  targetWidth?: number
): string {
  const sep = "   ";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  if (targetWidth !== undefined) {
    const natural =
      widths.reduce((a, b) => a + b, 0) + sep.length * (widths.length - 1);
    if (targetWidth > natural) widths[widths.length - 1] += targetWidth - natural;
  }
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) =>
        align[i] === "r" ? c.padStart(widths[i]) : c.padEnd(widths[i])
      )
      .join(sep);
  return [fmtRow(headers), ...rows.map(fmtRow)].join("\n");
}
