# RAC Phase 1 — Collapse-only, results

Companion to [implementation-plan.md](./implementation-plan.md) §4 Phase 1 and [phase-0-findings.md](./phase-0-findings.md). Covers what shipped and what the measurements say. No `remember` tool yet — this phase is deliberately lossy.

## What shipped

| File | Change |
|---|---|
| `packages/opencode/src/session/rac.ts` | New. The whole projection: ID assignment, collapse rule, stub rendering. Pure function, no services. |
| `packages/opencode/src/session/prompt.ts` | ~12 lines at the main-loop call site: project, log, pass the projected list to the chokepoint. |
| `packages/core/src/v1/config/config.ts` | `rac.{enabled,collapse_after_turns,min_lines_to_collapse}` |
| `packages/opencode/src/config/config.ts` | forces `compaction.prune` off when `rac.enabled` (originally `auto` too — see [compaction-interop.md](./compaction-interop.md)) |
| `packages/opencode/test/session/rac.test.ts` | New. 11 tests. |

Config (default off):

```json
{ "rac": { "enabled": true, "collapse_after_turns": 0, "min_lines_to_collapse": 50 } }
```

Or `OPENCODE_RAC=1` for a single run, which is what the A/B comparison wants.

(The default shown here was `2` when this phase shipped; the measurements below are what moved it to `0`.)

**`message-v2.ts` was not modified.** The projection runs immediately *before* `toModelMessagesEffect` rather than inside it, so the chokepoint is untouched. This was a deliberate choice to keep the upstream conflict surface near zero — the only edit in a hot upstream file is the call site in `prompt.ts`.

> **Superseded.** RAC and compaction are no longer mutually exclusive — see [compaction-interop.md](./compaction-interop.md). `compaction.auto` is now left alone; only `prune` is forced off.

Compaction mutual exclusion turned out to need no new gating: `compaction.auto` and `compaction.prune` already exist as separate config switches (prune is already opt-in, `if (!cfg.compaction?.prune) return`), and there was already a precedent for forcing them off at the end of config load (`Flag.OPENCODE_DISABLE_AUTOCOMPACT`). RAC follows that pattern. Phase 0's warning that prune and summarize are not behind one shared flag still holds — they're two switches, both now forced.

## Verification

Against the plan's Phase 1 checklist:

- **Stored messages unchanged** — verified byte-identical (`JSON.stringify` snapshot before/after projection) in both a unit test and an end-to-end run through the real chokepoint. The projection is copy-on-write: messages with nothing to collapse pass through by reference.
- **TUI / revert / resume unaffected** — follows structurally, not just by test. All three read stored state; the projection output is passed directly to `toModelMessages` and never persisted.
- **Token counts drop** — 44.7% payload reduction at 6 turns, 86% at 96 turns (below).
- **Cache hit rate does not degrade** — this needs care; see below. The headline claim holds, with a caveat the plan didn't anticipate.

## Measurements

Synthetic conversation, one 200-line tool result per turn, rendered through the real `toModelMessages`. "Re-prefill" = payload bytes after the longest shared prefix with the previous turn, i.e. what a KV cache must re-compute.

```
turns |  RAC payload  reprefill |  no-RAC payload  reprefill
    6 |        12987      11478 |           26531       3791
   12 |        15421      11488 |           49280       3794
   24 |        20329      11489 |           94796       3794
   48 |        30145      11489 |          185828       3794
   96 |        49777      11489 |          367892       3794
```

**The central claim holds: re-prefill is constant at ~11,489 regardless of conversation length.** It does not grow with history, which is the whole point of fixed-age over pressure-triggered collapse. Payload grows sub-linearly (3.8× over a 16× increase in turns) versus 13.9× without RAC.

**The caveat: RAC's constant re-prefill is ~3× that of doing nothing.** Plain append-only is perfectly cache-stable — appending a turn invalidates nothing, so its re-prefill is just the new turn (3,794). RAC pays ~7,700 extra chars of invalidation *every turn* to buy a much smaller payload. That trade only pays off once the payload difference dominates, so **there is a crossover point below which RAC is net-negative on cost.** Rough sketch at Anthropic's ratios (cache read ≈ 0.1× base, write ≈ 1.25×): RAC is roughly 2× *worse* at 6 turns and roughly 2× *better* at 96, with the gap widening after that. This is consistent with the plan's own framing — RAC targets long-horizon tasks — but it means short sessions should arguably not enable it, and the evaluation must report cost, not tokens.

> **Superseded.** The crossover sketched here is wrong in both direction and magnitude. It models a turn as a single request, when a turn is several, and each one re-reads the whole cached prefix; and it measures a synthetic shape carrying nothing but tool calls. Corrected, the crossover is turn 2 at every price ratio any provider currently charges. See [motivation-and-research.md](./motivation-and-research.md) §4.1, which supersedes this paragraph and the byte-level figures above it.

### `collapse_after_turns` is a cache-cost knob, not just a usability one

Re-prefill and payload, both at 48 turns:

```
collapse_after_turns |  payload  reprefill
                   0 |    23377       3903
                   1 |    26761       7696
                   2 |    30145      11489
                   3 |    33529      15282
                   5 |    40297      22868
```

Each increment costs ~3,384 payload chars and ~3,793 re-prefill chars — almost exactly one turn's worth. So **re-prefill ≈ (collapse_after_turns + 1) × turn size**, and at `collapse_after_turns: 0` re-prefill (3,903) is essentially identical to plain append-only (3,794) — i.e. near-perfect cache behaviour.

The plan (§3.3) justifies `collapse_after_turns: 2` purely on usability grounds — read-then-edit workflows spanning two turns — and treats the cache argument as being about fixed-age *versus* pressure-triggered. The measurement shows the parameter is simultaneously the dominant cache-cost term, monotonic on both axes. Lower is strictly better for both payload and cache; the only force pushing it up is agent correctness. That reframes the tuning question: every increment buys workflow safety at a fixed, measurable price of one turn's re-prefill per turn, which is a sharper way to choose the value than "start at 2, tune from traces."

### Caveats on these numbers

Synthetic and uniform: every turn has exactly one large tool result, so real traces will differ. Byte length is a proxy for tokens. Most importantly this measures *payload prefix stability*, not provider-reported cache hits — `applyCaching()` (Phase 0 §5) places breakpoints on the last 2 system and last 2 non-system messages, so actual hit rates depend on how the collapse boundary interacts with those. Real `SessionTokens.cache.{read,write}` numbers from live sessions are needed before treating any of this as settled.

## Open items for Phase 2

- Stubs are minimal (`[t14] read(src/app.ts) → 412 lines collapsed.`). No semantic hint yet — that's the agent-authored summary in §3.2, and it matters more once `remember` exists and stub quality determines whether recall is aimed.
- ~~IDs are position-derived and stable within a projection. Stability across session resume is untested~~ — **done**, against a real database, and addresses now number over the whole archive rather than the projected view. See [address-stability.md](./address-stability.md).
- Logging is a per-projection summary (`collapsed`, `saved`), not per-part. Per-part would re-log the entire history every turn.
