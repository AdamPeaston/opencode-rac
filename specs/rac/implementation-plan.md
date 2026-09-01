# Random Access Context (RAC) — Implementation Plan

**Target harness:** [opencode](https://github.com/sst/opencode) (TypeScript / Bun / Turbo monorepo), installed globally with source linked so edits are live.

**Status:** design + phasing document. Written to be handed to a Claude Code session as a working brief.

---

## 0. Read this first (instructions to the implementing agent)

- **Verify every path in this document before relying on it.** File paths were derived from public documentation of the opencode repo and may be stale or wrong for the checked-out revision. Locate the real integration points by reading the code. Where this document says "probably at X", treat that as a search hint, not a fact.
- **Do not begin editing until Phase 0 is complete.** The reconnaissance phase determines whether the central architectural bet (see §2) actually holds. If it does not, stop and report back rather than improvising a different design.
- Work phase by phase. Each phase ends in a state where opencode still runs normally with RAC disabled.
- Keep RAC behind a config flag from the very first commit.

---

## 1. What RAC is

An agent harness usually appends every tool result to the conversation verbatim and re-sends the whole transcript on every turn. Tool results dominate that transcript and most of them are dead weight within a turn or two of being produced.

RAC replaces the tool result in the model's view with a short stub, one turn after it was produced, while retaining the full result in an append-only store. The stub carries an address. The agent can call a `remember` tool with that address to pull the content back — appended at the tail of the conversation, never injected into the prefix.

Three properties define it:

1. **Eager, fixed-age collapse.** A tool result is visible in full on the turn it is produced and (configurably) for a small number of turns after. Then it collapses. Collapse is not triggered by context pressure; it happens on a fixed schedule.
2. **Addressable recovery.** Collapse is not deletion. Every result remains retrievable verbatim by ID, optionally by line range.
3. **Append-only presentation.** The conversation prefix is never rewritten more than a fixed small distance from the tail, so prompt-cache prefixes survive.

### Why fixed-age collapse rather than a smarter policy

This is the counterintuitive core and it should not be "improved" during implementation.

A budget-aware or LRU eviction policy evicts whatever is least useful, which may be anywhere in the history. Evicting from the middle invalidates the KV cache from that point onward, and under sustained pressure the system pays cache-write costs on every turn without ever amortising them through cache reads. Published analysis of incremental in-place eviction finds it can be net-negative for caching versus doing nothing.

Fixed-age collapse always mutates at the same small offset from the tail. The re-prefill cost is constant and tiny. A dumber policy is the cache-optimal one. If someone proposes making the eviction policy smarter, the answer is no unless they have measured cache hit rate before and after.

---

## 2. The architectural bet

opencode already separates **stored conversation state** from **the payload sent to the provider**. Messages and their constituent parts are persisted to SQLite (Drizzle) via schemas defined in `packages/opencode/src/session/message-v2.ts` and `session.sql.ts`; a separate prompt-processing pipeline (around `session/prompt.ts` and `session/llm.ts`) turns stored messages into provider API calls.

**If that separation is clean, RAC is a projection function over stored parts and touches nothing else.**

- The SQLite message store *is already the append-only observation store.* No new archival storage is needed for v1.
- Collapse is a pure function applied while building the provider payload. Stored state is untouched and remains lossless.
- Nothing about revert, session resume, sharing, or the TUI needs to change, because they read stored state, not the projected view.

This is a materially better position than the papers were in. ARC and similar systems maintain a separate ObsStore because their harnesses conflate the transcript with the payload. opencode does not.

**Phase 0 exists to verify this bet.** The specific question: *is there a single place where the full message list is transformed into the provider request, such that a projection applied there is guaranteed to be the only view the model ever sees?* If there are multiple paths to the provider (main loop, subagents/TaskTool, summarisation, retry, ACP), each needs the projection or each needs an explicit exemption.

### Known complication: compaction already exists

opencode has its own compaction path (`session/compaction.ts`) with a dedicated part type marking where compaction occurred, triggered on context limits. RAC and compaction are alternative answers to the same problem.

For v1: **disable compaction when RAC is enabled.** Do not attempt to make them cooperate. Note in the config docs that they are mutually exclusive. Whether RAC delays or eliminates the need for compaction is one of the questions the evaluation should answer.

> **Revised during implementation — they now cooperate.** See [compaction-interop.md](./compaction-interop.md). Neither compaction mechanism deletes anything: prune sets a flag and leaves `state.output` intact, and `filterCompacted` is a pure view function. So with addresses numbered over the whole stored archive rather than the visible view, `remember` reaches past the compaction horizon and **compaction becomes recoverable rather than lossy**. `compaction.auto` is left alone; only `prune` is forced off, because it rewrites at a budget-determined position and its placeholder carries no address. The answer to the evaluation question above may be neither "eliminates" nor "delays" but "makes non-lossy".

---

## 3. Design specification

### 3.1 Identifiers

Sequential per session: `t1`, `t2`, `t3`, ... assigned in tool-call order.

Not content hashes. Sequential IDs are fewer tokens, are ordered (so the agent can reason about recency), and are far easier for a model to copy without corruption. ARC uses a SHA1-derived ID but its own appendix concedes that the occurrence index, not the fingerprint, is what actually provides uniqueness — the hash does no work.

IDs must be stable across session resume. If the ID is derived from position in the message list, verify that resume reconstructs the same ordering; if not, persist the ID.

> **Verified, and persistence proved unnecessary.** See [address-stability.md](./address-stability.md). Resume reconstructs the same ordering — messages read `desc(time_created), desc(id)`, parts `ORDER BY id`, both total orders with explicit tie-breaks — checked against a real database rather than synthetic arrays. Numbering runs front-to-back over the **whole stored archive**, so appending never renumbers and truncation drops `t1`–`t5` without renaming `t6` onward. That gives compaction-stability too, with no write path and no loss of the projection's purity.

### 3.2 The stub

The single highest-leverage part of the design. The agent decides whether to recall based only on the stub, so a stub that carries no meaning makes recall a lottery.

Bad (this is roughly what ARC does — mechanical head/tail previews):

```
[t14] read(src/app.py) → 412 lines
```

Good:

```
[t14] read(src/app.py) → 412 lines, 5 chunks
      FastAPI app; /login and /search routes; imports db.session
```

**Generation strategy — try in this order:**

1. **Agent-authored (preferred).** Prompt the agent to comment in one sentence on the salient content of each tool result. The comment lands in the assistant's own turn text, which is *never collapsed*, so the semantic hint is baked into surviving conversation at zero marginal token cost and zero extra inference. This is the cheapest possible implementation of the most valuable feature.
2. **Fallback: harness-generated at collapse time** via a small/fast model, if (1) proves unreliable.

Note the interaction: if (1) works, the stub itself can stay minimal, because the meaning lives in the surrounding conversation. Measure whether the explicit stub summary adds anything on top of the agent's own commentary. It may not.

### 3.3 Collapse rule

```
collapse_after_turns: 0      # full visibility for producing turn + N following turns
min_lines_to_collapse: 50    # smaller results stay verbatim forever
```

> **Revised during Phase 1.** This originally read `2`, on the rationale that read-then-edit workflows span two turns and collapsing a file mid-edit is a self-inflicted wound. Two findings overturned it. (a) Measurement: re-prefill cost scales as `(collapse_after_turns + 1) × turn size`, so the parameter is the dominant cache-cost term, and at `0` re-prefill is indistinguishable from plain append-only. (b) The read-then-edit worry was misplaced — collapse counts *user* turns, so every tool call within the current agentic loop stays verbatim regardless. The hazard only applies across user turns, where §3.6 already argues re-reading beats recalling because a recalled result is a stale snapshot. An agent needing several old results in view should ask for them rather than have the harness carry them speculatively for every session.

Rationale for `min_lines_to_collapse`: a stub costs tokens too. Below some size, collapsing is a net loss. ARC uses the same threshold concept (their ρ).

### 3.4 `remember` tool

```
remember(id: string, chunk?: number, lines?: [start, end]) → verbatim content
```

- Result is appended as a normal tool result at the tail. **Never injected at the head or into the prefix.**
- A remembered result is itself subject to the same collapse rule. Its stub reads `remembered t14 lines 100-160`.
- Invalid ID returns a nearest-match suggestion rather than a bare error (borrowed from ARC — cheap, and prevents flailing).
- Multiple `remember` calls in one turn are the canonical way to avoid recall thrash. Do not add a special anti-thrash mechanism; batching is already the answer, as it is for any other tool.

**Line-range recall is unusable blind.** The agent cannot see the content it is picking line numbers from. Either expose chunk indices in the stub (`5 chunks`) and let it recall by chunk, or rely on `grep_memory` to supply exact line numbers. Both, ideally.

### 3.5 `grep_memory` tool (Phase 3)

```
grep_memory(pattern: string, id_filter?: string) → [{id, line_no, matching_line}, ...]
```

> **As implemented:** `grep_memory(pattern, id?, case_sensitive?, limit?)`. Case-insensitive by default, since the common case is not knowing the exact casing of a half-remembered string. Default cap is 20 matches, not 50 — see [phase-3-results.md](./phase-3-results.md) for why that number moved.

Regex only for v1. No embeddings, no index maintenance, no semantic search. The exact-match case is where addressable recall has its largest measured advantage, and regex is stateless.

**Two-stage split (important).** `grep_memory` returns IDs and line numbers plus a single matching line each — *not* content. Pulling content is a separate `remember` call. Otherwise a broad grep costs exactly the tokens RAC was built to save. Scroll is the only prior system that got this right, via its `exec`/`print` separation, and it is worth copying.

Cap the number of matches returned and say so when truncating.

### 3.6 Explicitly deferred

- **Replayable vs archival tool distinction.** For idempotent reads the agent can just re-read, and re-reading is *more correct* since a recalled result is a stale snapshot if the file changed. Real value is in non-reproducible results. But this is a per-tool flag on the collapse rule — cheap to add later, so defer.
- **Graduated stub decay** (Scroll-style: older stubs collapse further to bare IDs). Defer until stub accumulation is measured to matter. *(Measured; it does not — stubs are ~2% of the per-turn residual on a realistically-shaped turn. See [outstanding.md](./outstanding.md).)*
- **Semantic search over the archive.** Only if failure traces show the agent groping for concepts rather than strings.

---

## 4. Phasing

### Phase 0 — Reconnaissance (no code changes)

Produce a written findings document covering:

1. Exact file/line of the transformation from stored messages to provider request payload. Confirm whether it is a single chokepoint.
2. Enumerate *every* path that reaches a provider: main loop, subagent/TaskTool spawning, summarisation/compaction, retry, ACP. For each: does it go through the chokepoint?
3. Shape of the tool result part in `message-v2.ts` — where does result content live, and is there a metadata field usable for stub text?
4. How tools are registered (`tool/registry.ts`), including the tool + `.txt` description file convention, and whether tools can be conditionally registered based on config.
5. Whether the provider integration (Vercel AI SDK) exposes prompt-cache / cache-breakpoint controls, and how cache hit rate can be observed. **The whole design is justified by cache economics; if hit rate cannot be measured, the evaluation is crippled.** Solve this before Phase 1.
6. How compaction is triggered and how cleanly it can be disabled.
7. Build/test/lint commands and how the live-linked global install picks up source changes.

**Gate:** if there is no single chokepoint, stop and report before proceeding.

### Phase 1 — Collapse only

Config flag `rac.enabled` (default off), plus `collapse_after_turns` and `min_lines_to_collapse`.

Implement the projection: when building the provider payload, replace tool result content older than N turns with a stub. Assign sequential IDs. No `remember` tool yet.

This phase deliberately ships a *lossy* harness. That is the point: it establishes the token/cache baseline and shows what breaks when results vanish irrecoverably. Log every collapse.

**Verify:** stored messages unchanged; TUI still shows full results; revert and resume still work; token counts drop; **cache hit rate does not degrade.**

### Phase 2 — `remember`

Add the tool. Add stub instructions to the system prompt explaining the collapse mechanism, the ID convention, and when to recall. Implement remembered-content re-collapse.

Add the agent-authored stub summary prompt (§3.2) and measure whether it changes recall behaviour.

**Verify:** recall returns byte-identical content; tail injection confirmed by inspecting the actual request payload, not just the code path.

### Phase 3 — `grep_memory`

Regex search over stored tool results in the session, returning IDs and line numbers only.

### Phase 4 — Evaluation

See §5, and [evaluation-plan.md](./evaluation-plan.md) for how this is actually being run without an API budget.

> **Revised by implementation.** Phase 0 item 5 required that cache hit rate be observable through the provider before Phase 1. It was, on providers that report it — but the only provider available for evaluation, local Ollama, reports no cache information whatsoever: identical `prompt_eval_count` cold and warm, and no `cached_tokens` field on either endpoint, despite prefill dropping from 8653ms to 25ms on a hit. `debug rac` reads a flat 0% there.
>
> The measurement therefore moved off the provider entirely. `debug rac --replay` reconstructs the request sequence from a stored session, serialises each request through the real `MessageV2.toModelMessages`, and diffs consecutive payloads: what a prefix cache can reuse is exactly the common prefix. No inference, no credentials, zero variance between arms because both replay one recorded trajectory.
>
> That change also sharpened what the metrics table below asks for. "Cache hit rate" conflates two costs that move in opposite directions, and the replay separates them: **payload tokens** (billed, and what fills the window) fall by ~56% on a realistically-shaped synthetic session, while **prefill tokens** (the work actually done) rise slightly. Against a perfect prefix cache an old result is already free, so collapsing it can only invalidate something that cost nothing — RAC buys a large payload reduction for a small constant re-prefill, and a report that shows only one of the two numbers is misleading in whichever direction it omits.
>
> The instrument also tests §3.2 claim 1 directly. Per-turn re-prefill is flat with session length wherever it is measured; a budget- or utility-triggered policy would rewrite deeper as history grew. `overhead.early` vs `overhead.late` reports that, and the command prints `GROWING` when the invalidation compounds.

---

## 5. Evaluation

### Metrics

| Metric | Why |
|---|---|
| Total input tokens per task | The headline claim |
| **Cache hit rate / cached vs uncached input tokens** | The load-bearing claim; RAC is worthless if it trades tokens for cache misses |
| Wall-clock time to task completion | Cache misses show up here as TTFT |
| Cost per completed task | The number that actually matters |
| Task success rate | The thing being risked |
| Recall calls per task; recall precision (was recalled content used?) | Whether the mechanism is being used well |
| Turns to completion | Detects recall-thrash loops |
| Context overflow / compaction events | Whether RAC removes the need for compaction |

### Arms to compare

1. Stock opencode (compaction enabled, RAC off) — baseline
2. RAC collapse only, no recall (Phase 1) — isolates the cost of losing information
3. RAC + `remember` (Phase 2)
4. RAC + `remember` + `grep_memory` (Phase 3)

Arm 2 is the important control. If arm 3 does not beat arm 2 on success rate, the recall mechanism is not earning its complexity and the agent is probably not using it — which is a stub-quality problem, not a mechanism problem.

### Task set

Use real repos, not synthetic needle tests. Needle-in-a-haystack flatters this design (ARC scored 99%+ on it while gaining only ~1.6 points on reasoning-heavy LongBench-v2 Hard) and will tell you nothing you don't already know. Aim for long-horizon tasks with heavy reads: multi-file refactors, bug hunts across a large codebase, dependency upgrades.

Fix the model and the task set across arms. Run each task multiple times — agent runs are high variance and single runs will mislead.

### Failure modes to watch in traces

- Agent ignores stubs entirely and re-runs tools instead of recalling (stub quality problem, or system prompt problem)
- Agent recalls compulsively, defeating the token savings (collapse window too aggressive)
- Recall thrash: recall → collapse → recall same ID (check whether batching in a single turn is happening)
- Agent hallucinates IDs (check the nearest-match path is firing)
- Agent acts on stale recalled content after a file changed (this is the argument for the deferred replayable/archival distinction — note if observed)

---

## 6. Prior art and where this sits

RAC is not novel component by component. The combination is.

- **ARC — "Addressable Recall Compaction"** (arXiv 2607.25066, Jul 2026). Closest prior work; nearly identical core. Append-only ID-addressable store, citations replacing evicted observations, `_recall §id`, sub-threshold results kept verbatim, chunked recall. Differs from RAC in ways RAC deliberately rejects: hash-derived IDs, mechanical head/tail stubs, pressure-triggered compaction rather than fixed-age, LRU eviction of recalled bodies (which rewrites the prefix), and no discussion of caching at all. Reports 99.0/99.8% on needle-in-a-haystack vs 88.12% best baseline, but only 27.47/32.47% on LongBench-v2 Hard vs ~28.25% — i.e. the recall win is real and the reasoning win is nearly noise. **Read this paper before implementing.**
- **Scroll — "Context as an Environment"** (arXiv 2608.21690). Append-only event log, sequence-addressed headlines for recent history collapsing to coarser ranges for older, and the `exec`/`print` two-stage search/surface split worth copying wholesale.
- **VISTA** (arXiv 2606.30005). Formalises the split between recovery (preserving evidence after eviction) and "proprioception" (knowing what was evicted well enough to choose). The theoretical argument for stub quality.
- **"Beyond Compaction: Structured Context Eviction"** (arXiv 2606.11213). Independently establishes the cache-thrash problem that fixed-age collapse is designed to avoid.
- **TokenPilot** (arXiv 2606.17016). Cache-alignment discipline: stable placeholders for volatile values, tool definitions moved downstream for a byte-identical prefix from turn one. Worth reading for prefix-stability techniques applicable to opencode's own prompt assembly.
- **Anthropic context editing** (`clear_tool_uses_20250919`) — the shipped, non-recoverable version: clears oldest-first past a threshold, substitutes a placeholder, invalidates cache. `compact_20260112` for summarise-and-replace.
- **hermes-lcm** and **Volt** (Martian-Engineering). Both ship a literal `lcm_grep` over messages no longer in active context, returning IDs that feed an expansion tool. **Read their schemas before designing `grep_memory`** — they have already hit the edge cases.

These are all recent and the area moves fast; check for newer work before committing to the design.

---

## 7. Open questions

- Does the agent-authored stub summary (§3.2) actually work, or does the agent's own turn text already carry enough implicit hinting to make explicit stubs redundant?
- Does RAC eliminate the need for compaction on long tasks, or merely delay it?
- What is the right `collapse_after_turns`? Is a fixed number right at all, or should it be tool-dependent?
- Do subagents need their own RAC scope, or should they inherit the parent's store?
- Does recall get used at all without heavy system-prompt scaffolding? If it needs a lot of prompting, that is a finding worth reporting.
