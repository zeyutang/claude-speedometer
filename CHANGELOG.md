# Changelog

All notable changes to Claude Speedometer are documented here. This project
follows [Semantic Versioning](https://semver.org).

## 1.5.4 - 2026-06-12

- Fixed the active-state indicator washing out in light themes. When the stats
  tab is open the bolt now uses a filled highlight that stays legible in both
  light and dark themes, instead of a near-white foreground tint that vanished
  on light backgrounds.
- Scoped turn completion per session. Two Claude Code panels running at once no
  longer cut each other's turns short or make the bar flip between them; each
  session's turn is finalized only when that session starts its next prompt or
  goes quiet.
- Made per-turn counts exactly-once. A redelivered telemetry export whose
  request id was already counted is now ignored, so tokens, duration, and cost
  are never double-counted.
- Ordered the Recent list and the "x ago" age by each event's own timestamp
  rather than the time it was received, so batched exports no longer blur the
  ordering of close-together turns.
- Clarified that output tokens, and therefore tok/s, include both thinking and
  visible text; Claude Code reports a single output count. Relabeled the Output
  rows and corrected the throughput description (summed per-request wall-clock
  time, including retries).

## 1.5.2 - 2026-06-11

- Removed the time-to-first-token and generation-time readouts and the
  `speedBasis` setting. Claude Code's telemetry does not report time to first
  token, so those figures were always empty or identical to total time. The
  throughput figure is unchanged: output tokens divided by total request time.
- Renamed the "Total Time" field to "Total Request Time" for precision.

## 1.5.1 - 2026-06-11

Initial public release.

- Status-bar bolt showing the output throughput (`tok/s`) of your latest Claude
  Code interaction, updated when each turn completes.
- Hover overlay and a click-to-open stats tab with a per-interaction breakdown:
  Speed, Tokens, Timing, Cost & Model (including reasoning effort, and Fast mode
  when active), Recent interactions, and Context (session id and workspace path).
- One-command telemetry setup (offered on first run): merges the required OTLP
  environment into `~/.claude/settings.json` without disturbing existing settings.
- One machine-wide speedometer mirrored across every VS Code window, with
  automatic leader handover when the receiving window closes.
- Settings for the receiver port, speed basis, export interval, status-bar
  priority, and history retention.
