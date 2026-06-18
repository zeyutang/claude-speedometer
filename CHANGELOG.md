# Changelog

All notable changes to Claude Speedometer are documented here. This project
follows [Semantic Versioning](https://semver.org).

## What's next

- Per-window stats: an option to scope the speedometer to the current
  window's workspace instead of the machine-wide latest interaction.
- Richer timing (needs Claude Code's tracing beta): time to first token, a
  decode-only speed, exact per-turn boundaries, and excluding failed or retried
  calls and tool time from the throughput.

## 1.6.2 - 2026-06-18

- Moved the status-bar bolt to the far right, immediately left of the
  notification bell (or rightmost when the bell is hidden). The default
  `statusBarPriority` is now `-Number.MAX_SAFE_INTEGER`; raise it to move the
  bolt further left.
- Gave the bolt a fixed width so it no longer jitters as the speed changes:
  tok/s now shows one decimal with the integer part padded to three digits.
  Values of 1,000 tok/s and above gain a thousands separator and widen the
  item.

## 1.6.1 - 2026-06-13

- Fixed the Cost section showing $0.00 for Today, This Week, and This Month
  (only the current interaction had a value) after upgrading. The daily ledger
  used to accrue from live events only, so it started empty and ignored existing
  history. It now recomputes from the retained turns, banking each day's total
  with a max so it never shrinks as turns age out, and the leader publishes the
  rebuilt totals immediately on startup instead of only after the next turn.

## 1.6.0 - 2026-06-13

- Added a Cost section (split out from the old "Cost & Model") showing the
  estimated spend for the current interaction, today, this week (from Monday),
  and this month. Totals are summed in local time from a small daily ledger that
  is kept for ~70 days, so they stay accurate even after older turns are pruned.
  Model, reasoning effort, and Fast mode now live in their own Model section.
- Interaction times now show the wall-clock time with a live "x ago" hint
  instead of a relative age that froze at the value captured on the last update.
  The status-bar overlay and the stats tab refresh on their own so the hint
  stays current.
- Raised the retained-turn cap from 50 to 1,000 turns. Age-based retention
  (default 7 days) still applies, so the effective history is whichever limit is
  reached first.

## 1.5.5 - 2026-06-13

- The Effort row now appears only when the model supports effort
  configuration, instead of always showing a placeholder. It is read from
  Claude Code's telemetry, so models that do not report an effort setting omit
  the row, the same way Fast mode shows only when it is on.
- Tidied the stats tab: dropped the throughput formula from under the headline
  number (it is still in the footnote and the hover overlay) and clarified the
  token and timing labels.

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
