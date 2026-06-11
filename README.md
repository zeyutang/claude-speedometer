# Claude Code Speed

A VS Code status-bar indicator showing the **token throughput and timing of your latest Claude Code interaction**.

- A bolt sits at the left edge of the right-hand status-bar cluster: `↯ 68.20 tok/sec`. It updates automatically after every interaction.
- The bolt is **hollow** (plain) by default and turns **solid** (highlighted) while the stats panel is open.
- Click it to pop up a panel with full per-interaction stats, organized into sections.

## How it works

VS Code extensions can't read Claude Code's internal timing directly, and the transcript files (`~/.claude/projects/.../*.jsonl`) only store token counts, not the time-to-first-token / generation-time split. So this extension reads Claude Code's **OpenTelemetry** output instead:

1. The extension runs a tiny OTLP/HTTP receiver on `localhost:4318` (loopback only).
2. Claude Code is configured to export telemetry logs to that endpoint.
3. Each `claude_code.api_request` event carries `ttft_ms`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `model`, and `speed`.
4. Events are aggregated **per user turn** using the `prompt.id` attribute, so one "interaction" sums all API calls (including tool-call steps) of a single prompt.

## Setup

1. Build and run the extension (see Development below), or install the packaged `.vsix`.
2. On first run it offers to configure Claude Code for you. Accept it, or run **`Claude Code Speed: Configure Claude Code Telemetry`** from the Command Palette. This merges the following into `~/.claude/settings.json` (existing settings are preserved):

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

3. **Restart Claude Code** so it picks up the new environment.
4. Run a prompt. The bolt updates with the throughput; hover it for details.

## The bolt, its overlay, and the stats tab

- The bolt shows the **last completed** interaction's tok/sec. It updates when the current interaction concludes, not while it is still running, so the figure is stable and reflects a finished turn.
- **Hover** it to pop up the stats overlay (a box just above the status bar, in the lower-right). Move away and it's gone.
- **Click** it to open the full stats in a tab in the current editor group (reused if already open); click again to close it. The item gets a highlighted background while the tab is open.

Both the overlay and the tab are organized into sections:

- **Speed**: output tokens/sec (total basis), with the generation-only figure.
- **Tokens**: input, output, cache-write, cache-read, total.
- **Timing**: time to first token, generation time, total time, API requests.
- **Cost & Model**: estimated cost, model, and whether fast mode is on.
- **Recent**: the last several interactions at a glance.

> VS Code has no API for a free-floating, click-pinned overlay at a screen corner. The status-bar hover tooltip is the native equivalent: a rich box that appears in the lower-right, right above the bolt.

### A note on the throughput figure

tok/sec is `output tokens / total request time`, where total request time is the sum of the server-measured `duration_ms` of each API call in the turn. Tool-execution gaps between calls, and any time you spend typing or queueing a message while a turn runs, are **not** included.

## Data & storage

All windows share one small JSON file at `~/.claude-code-speed/state.json`. It holds only the most recent interactions (capped at 50 turns, a few tens of KB at most) and is pruned to the last **7 days** on every update (configurable via `claudeCodeSpeed.retentionDays`). Delete the file any time; it is recreated as needed.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `claudeCodeSpeed.port` | `4318` | Port the receiver listens on (must match the OTLP endpoint). |
| `claudeCodeSpeed.speedBasis` | `total` | `total` (output / total time, matches Claude Code) or `generation` (output / generation time). |
| `claudeCodeSpeed.exportIntervalMs` | `2000` | `OTEL_LOGS_EXPORT_INTERVAL` written during auto-config. Lower = more responsive. |
| `claudeCodeSpeed.statusBarPriority` | `10000` | Higher = further left within the right cluster. |
| `claudeCodeSpeed.retentionDays` | `7` | Discard interactions older than this many days from the shared history file. |

## Multi-window behavior

This is **one machine-wide speedometer**, mirrored into every VS Code window:

- Each window tries to bind the OTLP port. The one that succeeds is the **leader**: it runs the receiver and publishes aggregated stats to a shared state file (in the OS temp dir).
- Every other window is a **follower**: it reads and watches that file, so it shows the exact same numbers as the leader. No "offline" windows.
- When the leader window closes, the port frees and a follower **takes over automatically** within a couple of seconds, seeding itself from the shared file so history is continuous. No manual re-binding.

Because Claude Code's telemetry carries no working directory, the figure always reflects the most recent interaction from *any* Claude Code session, regardless of which window or project it ran in.

## Limitations

- A brief gap (≤ a few seconds) during leader handover may drop at most one export batch.
- The bolt uses VS Code's `$(zap)` codicon; "hollow vs solid" is rendered via the status-bar highlight (there is no outline-zap codicon). A true outline/filled glyph pair would require bundling a custom icon font.

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host.

Package a `.vsix` with [`vsce`](https://github.com/microsoft/vscode-vsce):

```bash
npx @vscode/vsce package
```
