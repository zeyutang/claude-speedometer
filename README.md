# Claude Speedometer

A VS Code status-bar indicator showing the **token throughput and timing of your latest Claude Code interaction**.

The bolt sits at the far right of the status bar, immediately left of the notification bell: `↯ 70.2 tok/s`, and updates after every interaction. **Hover** it for a quick stats overlay; **click** it to open a full stats tab (click again to close).

## What it looks like

| ![Hover overlay showing the full stats breakdown](tooltip.png) | ![Stats tab with the full per-interaction breakdown](panel.png) |
| :------------------------------------------------------------: | :-------------------------------------------------------------: |
|              _Hover the bolt for a quick overlay_              |                _Click it for the full stats tab_                |

## Setup

Once installed, the extension needs Claude Code to export telemetry to it:

1. On first run it offers to configure Claude Code for you. Accept, or run **`Claude Speedometer: Configure Claude Code Telemetry`** from the Command Palette. This merges the following into `~/.claude/settings.json` (existing settings are preserved):

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
       "OTEL_LOGS_EXPORTER": "otlp",
       "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
       "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
       "OTEL_LOGS_EXPORT_INTERVAL": "2000"
     }
   }
   ```

2. **Restart Claude Code** so it picks up the new environment.
3. Run a prompt. The bolt updates with the throughput; hover for details.

## Reading the stats

The bolt shows the **last completed** interaction's tok/s. It updates when a turn finishes, not while it is still running, so the figure is stable. The overlay and the tab break the latest turn into sections:

- **Speed**: output tok/s (output tokens / total request time).
- **Tokens**: input, output, cache-write, cache-read. "Output" counts thinking and visible text together; Claude Code's telemetry does not report them separately.
- **Timing**: total request time and API request count.
- **Cost (estimated)**: spend for the current interaction, today, this week (from Monday), and this month. Day/week/month windows are bucketed by **UTC** calendar day; the totals accrue from when telemetry was enabled and survive turn pruning. See [where the cost figures come from](#where-the-cost-figures-come-from) for how the dollar amounts are computed and what they mean.
- **Model**: model, plus **reasoning effort** (only when the model supports it) and **Fast mode** (only when it is on).
- **Recent** (tab only): the last several interactions, one row each, with timestamp, session id, model, input tokens, output tokens, and speed (tok/s).
- **Workspace** (tab only): the session id and the full directory path. The session id is the name of the session's `~/.claude/projects/.../<id>.jsonl` transcript and the `claude --resume <id>` handle.

A few things to know about the numbers:

- tok/s is `output tokens / total request time`, summing each API call's wall-clock `duration_ms` (server time plus network and any retries). Tool-execution gaps and time you spend typing or queueing between requests are **not** counted.
- Output tokens, and therefore tok/s, include both thinking and visible text. Claude Code reports a single output count, so the two cannot be separated here.
- One "interaction" sums all API calls of a single prompt (`prompt.id`), including tool-call steps and any sub-agents the prompt spawns.
- Stats are **global** across all Claude Code sessions and windows, not filtered to the current workspace.
- Interaction times show the wall-clock time **in your local timezone** plus a live "x ago" hint that refreshes on its own, so it stays accurate instead of freezing at the value from the last interaction.

### Where the cost figures come from

The extension does no pricing math of its own: Claude Code computes each request's `cost_usd` client-side (token counts from the API response multiplied by a pricing table bundled into the CLI, covering input, output, cache-write, cache-read, and web-search rates), and the extension only sums those values. In practice:

- **Accuracy tracks your Claude Code version, not this extension.** The price table ships inside the CLI, so an outdated Claude Code prices new requests with the stale rates it shipped with. Keep Claude Code updated if you want current rates. Anthropic's own docs call these figures approximations; for authoritative billing use the [Claude Console](https://platform.claude.com/usage).
- **On a Pro/Max subscription the number is not a charge.** Claude Code computes `cost_usd` the same way regardless of how you authenticate, so for subscribers it reads as "what this usage would have cost at standard per-token API prices". It is a value-of-usage gauge; subscription quota consumption is not part of the telemetry.
- **Totals are a floor.** Telemetry is only received while a VS Code window is open to run the receiver, so Claude Code sessions run with every window closed (or started before telemetry was configured) are never recorded. Events that lack a `cost_usd` field count as $0 regardless of their token counts.

## Settings

| Setting                               | Default                    | Meaning                                                                                                                                      |
| ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `claudeSpeedometer.port`              | `4318`                     | Port the receiver listens on (must match the OTLP endpoint).                                                                                 |
| `claudeSpeedometer.exportIntervalMs`  | `2000`                     | `OTEL_LOGS_EXPORT_INTERVAL` written during auto-config. Lower = more responsive.                                                             |
| `claudeSpeedometer.statusBarPriority` | `-Number.MAX_SAFE_INTEGER` | Position in the right cluster. Higher = further left; the default pins the bolt at the far right, immediately left of the notification bell. |
| `claudeSpeedometer.retentionDays`     | `7`                        | Discard interactions older than this many days.                                                                                              |
