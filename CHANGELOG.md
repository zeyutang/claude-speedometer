# Changelog

All notable changes to Claude Speedometer are documented here. This project
follows [Semantic Versioning](https://semver.org).

## 1.5.0 - 2026-06-11

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
