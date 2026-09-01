# RAC — what the docs specified that isn't built

Consolidated after a full doc sweep against the implementation. Excludes benchmark/evaluation work (Phase 4), which is known-outstanding and blocked on provider credentials.

Ordered by whether it looks worth doing, with the reasoning rather than just a verdict.

---

## Worth doing, in this order

### 1. Run a real session and replay it — *blocked on data, not on code*

Not a doc gap exactly, but it dominates everything below. The command is wired, typechecks and is unit-tested against synthetic messages, but has never been run against a live session.

The plan (§4 Phase 0, item 5) is blunt about why that matters: *"The whole design is justified by cache economics; if hit rate cannot be measured, the evaluation is crippled."*

**The requirement has since been relaxed.** The measurement no longer needs a provider that reports cache counters, which matters because local providers report none. `debug rac --replay` derives prefix reuse from the payloads themselves, so a session recorded against a local model is enough. See [evaluation-plan.md](./evaluation-plan.md).

Smallest useful step: one moderately long task, recorded once, then `opencode debug rac --replay` to price both arms off the same trajectory. Session listing is project-scoped, so run it from the directory the session was recorded in. **Make it long enough to compact** — that is the only regime where RAC should reduce prefill rather than slightly increase it, and it is the one thing the synthetic sessions cannot show.

### 2. Agent-authored stub summaries — plan §3.2

The plan calls this *"the single highest-leverage part of the design"* and *"the cheapest possible implementation of the most valuable feature"*: prompt the agent to comment in one sentence on each tool result, so the semantic hint lands in assistant turn text that is never collapsed, at zero marginal token cost and no extra inference.

Currently stubs are mechanical — `[t14] read(src/app.ts) → 412 lines collapsed.` — which is precisely the ARC-style stub §3.2 calls *bad*, and VISTA's proprioception argument says stub quality is what determines whether recall is aimed or a lottery.

**Deliberately deferred, and the reason still holds:** §7 asks whether recall gets used *without* heavy prompting. Adding scaffolding before observing baseline behaviour destroys that measurement. But this is the top candidate the moment (1) produces traces — and note §3.2's own hypothesis that the agent's surviving commentary may already carry enough hinting to make explicit stub summaries redundant. That's cheap to test and would be a real finding either way.

### 3. Measure recall depth, not recall count

A standing hypothesis worth settling early: **`remember` will be rare**, not because the agent prefers re-running idempotent tools but because relevance decays with age — a stub that has fallen behind the compaction horizon is by then negligibly relevant to the current task.

It is load-bearing rather than merely interesting. [motivation-and-research.md](./motivation-and-research.md) §4.2 finds that compacting more often is a real saving whose only serious cost is lost addressability past the horizon. If pre-horizon addresses are worthless anyway, that objection dissolves and the saving becomes takeable; if they are not, it stands.

The measurable quantity is **recall depth** — how many turns back a `remember` call reaches — not how often one fires. Concentrated at one to five turns and the deep archive is dead weight. Fat-tailed and it is not.

Low frequency alone would not falsify the design. §1.1's case for recall is tail insurance, not average utility, and a 23-token stub is cheap enough that rare use still pays. What would falsify it is recall that fires but never at a moment that mattered — which is a trace-reading question, not a counting one.

Needs the same thing everything else does: a real session. Free to collect once one exists.

### 4. Replayable vs archival tool distinction — plan §3.6

A per-tool flag on the collapse rule: idempotent reads can just be re-run, and re-reading is *more correct* than recalling, because a recalled result is a point-in-time snapshot. Real value is in non-reproducible results — API responses, expensive computations, non-deterministic search.

The plan defers this as *"cheap to add later"*. **The case has strengthened since the plan was written**: `remember` now reaches past the compaction horizon, so the oldest, stalest snapshots in a session are reachable — the reach is longest exactly where staleness risk is highest. `remember`'s output carries a warning, which is the weakest possible mitigation.

Cheap version: mark `read`/`glob`/`grep`/`lsp` replayable, and have their stubs say *"re-run rather than recall"*. Watch traces for the plan's own listed failure mode — *"agent acts on stale recalled content after a file changed"* — before deciding how far to take it.

### 5. Recall batching — *harness half done, model half still open*

The plan declines an anti-thrash mechanism on the grounds that *"multiple `remember` calls in one turn are the canonical way to avoid recall thrash… batching is already the answer, as it is for any other tool."* That was an assumption about the harness, and it is the plan's only stated defence against recall thrash.

**Verified** (`test/session/rac-batching.test.ts`): driving the processor with a synthesised stream carrying three tool calls in one step, all three settle as distinct completed tool parts with their own call IDs. Nothing collapses them or drops them. No provider needed — the LLM service is mocked at the layer boundary.

**Also established:** there is no opencode-side serialisation of tool dispatch. `llm.ts` delegates to the AI SDK's `streamText`, which owns tool dispatch, and the processor tracks in-flight calls in a `Record<string, ToolCall>` keyed by call ID. Also worth knowing: `batch_tool` exists in the config schema but is **wired to nothing** in this revision, so it is not an alternative route.

**Scope limit, stated plainly.** The test uses `providerExecuted: true` with pre-supplied results, so it exercises the processor's handling of concurrent calls, not the AI SDK's execution of three local tools. Concurrent local execution is standard `streamText` behaviour and nothing in opencode serialises it, but that specific path is not covered by this test.

**Still open and not testable offline:** whether a model actually emits several `remember` calls in one turn rather than one per turn. That is the behavioural half, and it needs live traces. If it turns out models recall one at a time, the plan's dismissal of recall-thrash does not hold and the failure mode is live.

### 6. TokenPilot prefix-hygiene audit — *done, and it found something*

See [prefix-hygiene.md](./prefix-hygiene.md) for the full audit. Headline: **`Today's date` sits at the very head of the system prompt**, so a session that crosses midnight — or is resumed the next day — invalidates its entire cached prefix, including tool definitions and the whole message history.

Day granularity, so not a per-turn cost. But session resume is a normal thing to do, and long-horizon sessions crossing midnight are exactly RAC's target case. Worth fixing, and the fix is cheap; whether to touch opencode's shared system prompt is a judgement call spelled out in the audit.

Tool-definition stability came out clean: the tool set does not vary per turn from anything RAC introduced, and `bypassAgentCheck` — which does change per turn — only reaches `ctx.extra`, not tool filtering.

---

## Deliberately not doing

### System-prompt scaffolding — plan §4 Phase 2

The plan says to add stub instructions to the system prompt. Not done, on purpose, and the same reasoning later removed a compaction-summary instruction: it biases the behaviour the evaluation exists to observe, and would make a positive result unattributable. Add it *after* baseline traces, as a measured intervention. See [compaction-interop.md](./compaction-interop.md).

### Chunked recall — plan §3.4

The stub was meant to advertise `5 chunks` and support chunk-wise recall. Line ranges via `offset`/`limit` are implemented instead, which is the plan's own stated alternative: *"or rely on `grep_memory` to supply exact line numbers"*. Since `grep_memory` supplies exactly that and its line numbers align with `remember`'s `offset`, chunking would be a second addressing scheme for the same need. The plan wanted *"both, ideally"*; the case for adding the second scheme needs evidence that the agent struggles with line ranges.

### Graduated stub decay — plan §3.6

Scroll-style progressive decay of older stubs to bare IDs. The plan defers *"until stub accumulation is measured to matter"*.

**It has now been measured, and it does not.** An earlier revision of this entry claimed the opposite, on the strength of a tool-call-only synthetic where stubs were about 63% of the per-turn residual. On a realistically-shaped turn — user message, reasoning, prose answer, tool-call *inputs* (which never collapse, since RAC replaces `state.output` only) and sub-threshold results — stubs are **about 2%** of it. See the note opening [motivation-and-research.md](./motivation-and-research.md) §4.1.

So decay attacks 2% of the wrong term. The residual RAC leaves behind is overwhelmingly content RAC was never going to touch, and shortening `[t14] read(src/app.ts) → 412 lines collapsed.` to `[t14]` would save tens of tokens per turn against a residual of thousands.

The plan's original instruction was right and stands unchanged: defer until stub accumulation is measured to matter. It has been, and it doesn't. Revisit only if a real session shows a materially different shape — a trajectory of many small tool calls and little prose would push the stub share back up.

### Semantic search over the archive — plan §3.6

Deferred *"only if failure traces show the agent groping for concepts rather than strings"*. No traces yet. Note Letta keeps exact and semantic search as distinct tools rather than blending them — worth copying that shape if it ever lands.

---

## Smaller gaps worth knowing about

- **"TUI still shows full results" is argued, not tested.** Phase 1's checklist item is satisfied structurally — the TUI reads stored state, and the projection is copy-on-write and never persisted — and stored-state immutability *is* tested. But no test drives the TUI. Low risk, non-zero.
- **Compaction-summary address citation is unverified.** Tool results now serialise as `[Tool result t14]` so the summariser *can* carry an address forward, but nothing checks that it ever does. This is the mechanism behind pre-horizon recall being usable at all, and it's an untested prompt-level behaviour.
- **Subagent RAC scope is undecided.** Phase 0 established the mechanical default — subagents are real child sessions with their own store, so isolation is automatic. Whether an agent *should* be able to `remember` into a parent's archive (plan §7) is still an open product question, currently answered "no" by default rather than by decision.
- **Overflow behaviour under RAC changed and is untested.** With compaction now left enabled, a RAC session that still overflows falls back to normal compaction rather than erroring. That is the intended behaviour and better than before, but the path hasn't been exercised.
