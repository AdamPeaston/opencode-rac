# Random Access Context (RAC)

An experiment in opencode's context management: tool results collapse to short addressable stubs on a fixed schedule, while the full content stays retrievable by address. Collapse is not deletion.

Enable for one run with `OPENCODE_RAC=1 opencode`, or persistently:

```json
{ "rac": { "enabled": true, "collapse_after_turns": 0, "min_lines_to_collapse": 50 } }
```

`opencode debug rac [sessionID]` reports per-turn prompt-cache usage from the provider's own counters. `opencode debug rac --replay` derives the same accounting offline from the payloads, for the many providers that report no cache information at all. It always prices the trade, taking the ratio of prefill to cached-read cost from the session model's published rates; `--price k` overrides that, and where no rates exist the report says so rather than guessing. See [motivation-and-research.md](./motivation-and-research.md) §4.

## The documents

**Read first**

| | |
|---|---|
| [motivation-and-research.md](./motivation-and-research.md) | Why, prior art, the proposal, the cost model, benchmark selection |
| [implementation-plan.md](./implementation-plan.md) | The design spec and phasing, annotated where implementation revised it |
| [outstanding.md](./outstanding.md) | What the docs specified that isn't built, and whether it's worth doing |
| [evaluation-plan.md](./evaluation-plan.md) | How the claims get tested with no API budget — supersedes the research doc's benchmark picks for local work |

**Implementation record**

| | |
|---|---|
| [phase-0-findings.md](./phase-0-findings.md) | Reconnaissance: the chokepoint, and whether the architectural bet held |
| [phase-1-results.md](./phase-1-results.md) | Collapse-only, and the cache measurements that moved the default to `0` |
| [phase-2-results.md](./phase-2-results.md) | `remember`, and the cache-measurement command |
| [phase-3-results.md](./phase-3-results.md) | `grep_memory`, and where the two-stage split does *not* pay |
| [address-stability.md](./address-stability.md) | Whether addresses survive resume — verified against a real database |
| [compaction-interop.md](./compaction-interop.md) | How compaction went from "disable it" to "make it recoverable" |
| [prefix-hygiene.md](./prefix-hygiene.md) | TokenPilot audit — and the volatile value sitting at the head of every prompt |

## Where the implementation diverged from the plan

Four decisions worth knowing before reading the plan as though it were current:

1. **`collapse_after_turns` defaults to `0`, not `2`.** Re-prefill cost scales as `(collapse_after_turns + 1) × turn size`, making it the dominant cache-cost term rather than only a usability knob. At `0` the cache cost is indistinguishable from plain append-only.
2. **RAC and compaction are not mutually exclusive.** Neither compaction mechanism deletes anything, so numbering addresses over the whole archive lets `remember` reach past the compaction horizon. Compaction becomes recoverable rather than lossy. Only `prune` is forced off.
3. **Addresses did not need persisting.** The plan's §3.1 fallback proved unnecessary — numbering over the stored archive gives the same stability with no write path.
4. **No system-prompt scaffolding, anywhere.** §7 asks whether recall gets used without heavy prompting; adding it pre-emptively would destroy that measurement.

## Status

Phases 1–3 complete. 98 RAC tests, typecheck clean.

**The cache claim now has an instrument that does not depend on the provider.** `debug rac --replay` reconstructs a session's request sequence, serialises it through the real payload builder, and diffs consecutive requests — a character-exact prefix measurement, deterministic, no inference. This exists because the only provider available here, local Ollama, reports no cache information at all: identical prompt token counts cold and warm, despite prefill dropping 346×. See [evaluation-plan.md](./evaluation-plan.md).

On synthetic sessions it puts numbers on the trade for the first time: payload tokens −56%, prefill tokens up slightly, and per-turn re-prefill flat with session length — which is §3.2 claim 1 measured rather than argued. [motivation-and-research.md](./motivation-and-research.md) §4 turns those into a cost model and a context-economy one.

**Every constant in that analysis is provisional.** They turn on `w/m`, the ratio of what a turn adds to what survives collapsing it, and that ratio swings from 39.5x on a tool-call-only synthetic to 2.4x on a realistically-shaped turn. The algebra is sound; the numbers await a real session.

**It has still never run against a real session**, because no session has ever run with a configured provider. That remains [outstanding.md](./outstanding.md) item 1, and the most valuable single measurement left is a session long enough to have compacted — the one regime where RAC should reduce prefill rather than slightly increase it.
