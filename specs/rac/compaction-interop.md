# RAC and compaction: recoverable, not exclusive

Supersedes the "mutually exclusive" position taken in [phase-1-results.md](./phase-1-results.md) and [phase-2-results.md](./phase-2-results.md), and revises the plan's §2 *"For v1: disable compaction when RAC is enabled."*

## What was wrong

Three claims were overstated:

1. **"Compaction destroys RAC's cache stability."** That argument holds for *prune* — budget-triggered, fires at a position that moves with token pressure, repeatedly. It does not hold for *summarising compaction*, which fires once and then leaves a stable prefix. The research doc says so directly: incremental eviction is *"worse than compaction, which at least produces one stable prefix per pass and can sustain a hit rate until the next one."* Lumping both under "compaction" was the error.

2. **"Addresses renumber under compaction, so the two can't coexist."** Renumbering was an artifact of assigning addresses over the *visible view*. Numbering over the whole stored archive instead makes truncation harmless: the front drops out, everything else keeps its name.

3. **"Mutually exclusive by design."** The plan framed disabling compaction as an explicit v1 simplification, not an incompatibility. That got hardened into a design claim it never made.

## The actual relationship

Neither mechanism deletes anything:

- **Prune** sets `part.state.time.compacted` and writes the part back, leaving `state.output` fully intact (`compaction.ts`). The `"[Old tool result content cleared]"` string is a view-level substitution at render time.
- **`filterCompacted`** is a pure function over the array. It truncates what is returned for model consumption and touches no rows.

So the archive always survives. The only reason recall couldn't reach past the horizon was that `remember` read `ctx.messages` — the already-filtered view.

**Fixing that makes compaction recoverable.** Compaction frees context by dropping old turns from view; `remember` pulls any of it back verbatim by address. That is the RAC thesis — *collapse is not deletion* — extended to *compaction is not deletion*, and it is strictly better than stock compaction, which is irreversibly lossy.

## What changed

| Concern | Before | Now |
|---|---|---|
| Address source | the compacted view | the **whole stored archive** (`RAC.Options.archive`) |
| `remember` / `grep_memory` read from | `ctx.messages` (filtered) | the full session via `Session.Service` |
| `compaction.auto` under RAC | forced off | **left alone** |
| `compaction.prune` under RAC | forced off | still forced off |
| Compaction summary | no addresses | tool results tagged `[Tool result t14]`; whether to carry one forward is the agent's call |

`prompt.ts` now calls `MessageV2.stream` once and derives both views from it — `filterCompactedEffect` did exactly this internally, so splitting it costs no extra query.

**Prune stays off** and the reason is unchanged: it rewrites the payload at a budget-determined position rather than a fixed distance from the tail, which is the incremental in-place eviction pattern that pays cache-write costs every turn without amortising them. It also replaces output with a placeholder carrying no address, which is strictly worse than a RAC stub — same information loss, none of the recoverability.

## The addressability problem: capability, not directive

Compaction truncates pre-horizon turns, and their stubs go with them. So the archive was reachable in principle but **unaddressable in practice**: nothing left in context would tell the agent that `t14` exists.

The agent can only justify a pre-horizon recall from evidence that survived — its own turn text (never collapsed, but also truncated pre-horizon), or the compaction summary. And the summariser could not carry an address forward even if it wanted to, because `serialize()` reads stored output and so never saw a stub.

So with RAC on, tool results are serialised as `[Tool result t14]: …`. Addresses are numbered over the stored session, so anything the summary happens to mention is what `remember` will accept.

**That is where it stops.** There is deliberately no instruction telling the summariser to cite addresses. If the agent judges a particular result important enough to name, it can; whether it does is its own call.

An earlier version of this change *did* add such an instruction, and removing it corrected an inconsistency: [phase-2-results.md](./phase-2-results.md) declines to add system-prompt scaffolding for `remember` precisely because §7 asks whether recall gets used *without* heavy prompting, and pre-emptive scaffolding would destroy that measurement. Instructing the summariser was the same mistake in a different place — it would bias exactly the behaviour the evaluation exists to observe, and make any positive result unattributable.

The distinction to hold onto is **capability versus directive**: the agent needs to see addresses to be able to use one, and needs no encouragement beyond that. If traces show summaries never carrying addresses and pre-horizon recall never happening, that is a finding — and adding an instruction then is a measurable intervention rather than a confound baked in from the start.

## The cost of compacting more often

[motivation-and-research.md](./motivation-and-research.md) §4.2 derives the cost-optimal compaction threshold and finds it well below what opencode uses — 61k against an effective 180k on a 200k model, and worse on larger windows. That gap exists with or without RAC. The optimum scales as `√g`, and since RAC only cuts the growth rate `g` by about 2.4x on a realistically-shaped session, it shifts the optimum by just 1.55x: **compaction economics are largely independent of RAC.** Past about 26 turns, cycling beats letting the payload grow.

The addressability problem above is what makes that saving awkward to take. Every compaction drops a batch of stubs from view, and nothing instructs the summariser to carry addresses forward, so cycling frequently on a long task progressively dismantles the recall surface.

**Whether that matters depends on an open question.** If recall past the compaction horizon is rare because relevance decays with age — the hypothesis in [outstanding.md](./outstanding.md) item 3 — then little is being dismantled and the saving is simply available. The way to settle it is recall *depth*, not recall count. Until then the economics say compact earlier and this document says wait for the trace.

## The staleness caveat

Pre-compaction results are the oldest snapshots in the session, so reach is longest exactly where staleness risk is highest. §3.6's argument — re-reading is *more correct* than recalling for idempotent reads, because a recalled result is a point-in-time snapshot — applies with most force here. `remember`'s output already carries the warning. Worth watching in traces as the argument for the deferred replayable/archival distinction.

## Verified

`test/session/rac-resume.test.ts`, 10 tests. Specifically for this change:

- Numbered over the view, the survivor is renamed `t1`; numbered over the archive it stays `t3`.
- The projection stubs the view using archive addresses, so a rendered stub says `[t3]` and stays dereferenceable.
- Resolved against the view, `t1` silently returns the **wrong** result (`c2`); resolved against the archive it returns the right one (`c0`), verbatim.
- `grep_memory` finds matches inside results compaction removed from view.

Confirmed live: with `OPENCODE_RAC=1`, `compaction.auto` is left as configured while `prune` is forced `false`.

## Bearing on the evaluation

This creates a better arm than the plan's §5 set: **compaction + recoverable archive** versus **compaction alone** isolates precisely what addressable recall buys, holding the context-management strategy fixed. It also reframes §7's open question — "does RAC eliminate the need for compaction, or merely delay it?" The answer may be neither: it makes compaction non-lossy.
