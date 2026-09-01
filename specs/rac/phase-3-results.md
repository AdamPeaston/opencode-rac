# RAC Phase 3 — `grep_memory`

Companion to [implementation-plan.md](./implementation-plan.md) §3.5 and §4 Phase 3, following [phase-2-results.md](./phase-2-results.md).

## What shipped

| File | Change |
|---|---|
| `src/session/rac.ts` | `search()` — regex over stored tool results, returning addresses and line numbers |
| `src/tool/grep_memory.ts` + `.txt` | New tool. `grep_memory(pattern, id?, case_sensitive?, limit?)` |
| `src/tool/registry.ts` | Registered alongside `remember`, gated on `rac.enabled` |
| `test/session/rac-grep.test.ts` | 17 tests |

Output is addresses, tool names, line numbers and one matching line each:

```
2 matches across 2 stored results.

[t1] shell, line 3: Error: connect ECONNREFUSED 127.0.0.1:5432
[t2] read, line 1: # retries on ECONNREFUSED

Use remember(id) for the full result, or remember(id, offset, limit) for a range around a line.
```

Line numbers are 1-indexed and line up with `remember`'s `offset`, so the two compose directly. Tested end-to-end: locate a string, then pull three lines around it rather than the whole 64-line log.

## The two-stage split holds — with a caveat worth stating

The plan (§3.5) is emphatic that search must return locations, not content, or "a broad grep costs exactly the tokens RAC was built to save." Implemented as specified, and the saving is real: against a 20,000-line stored result, locating a match costs **under 1%** of recalling it.

**But the saving is proportional to how sparse matches are within the source, and that is not always favourable.** A test asserting that search is unconditionally cheaper than recall fails, correctly: searching `noise` across a 64-line result returned 50 matches costing 1,586 chars, while simply recalling the entire result cost 740. N matches cost roughly N lines, so against a *small* result a broad pattern can cost more than just pulling the whole thing.

Two changes came out of that:

- **Default match cap lowered from 50 to 20.** Worst case is now roughly 20 × 200 chars rather than 50 × 200, keeping a search predictably cheap. Both the cap and the per-line truncation (`MATCH_LINE_MAX`) exist to bound this.
- The truncation footer tells the model to **narrow the pattern rather than raise the cap**, and the tool description says the same.

The limitation is pinned by a test rather than papered over. It does not undermine the design — RAC targets long-horizon sessions with large results, which is exactly where the split pays — but "search is always cheaper" is not true and should not be assumed when reading traces.

## Design decisions

- **Searches all stored tool results, not only collapsed ones.** Simpler and predictable: results would otherwise shift as things collapse, and with `collapse_after_turns: 0` nearly everything except the current turn is collapsed anyway.
- **Regex only.** No embeddings, no index, no semantic search, per §3.5. An invalid pattern returns an explanation rather than failing the turn, matching how a bad address is handled in `remember`.
- **Case-insensitive by default**, `case_sensitive` to opt out — the common case when hunting for a remembered string is not knowing the exact casing.
- **`id` scopes to a single result**, for when the model already knows where to look.
- Non-tool parts and incomplete tool calls are skipped, so prose that happens to mention the pattern is not reported as a stored match.

## Verified

17 tests. Matching, line-number alignment with `remember`, case sensitivity, `id` scoping, capping and truncation reporting, invalid-regex handling, and the search-then-recall loop. Two are specifically about cost: that search stays bounded while recall scales with result size, and that the broad-pattern-on-small-result case is capped and signposted.

The property that matters most is also tested: **collapsed results are searchable.** After projection the content is absent from the model's view, but `search` still finds it against stored state — which is the entire point.

## Still open

Unchanged from Phase 2, and none of it is resolved by this phase:

- **Cache measurement is still unvalidated against real data.** `opencode debug rac` exists and is unit-tested but has never seen a real session. This remains the single most important gap: the central claim rests on it.
- **No system-prompt scaffolding**, still deliberate, still the thing to measure (§7).
- **Chunked recall** (§3.4) not implemented; line ranges cover the need now that `grep_memory` supplies exact line numbers, which was the plan's own stated alternative ("or rely on `grep_memory` to supply exact line numbers").
- ~~**Address renumbering under manual compaction**~~ — **resolved.** Addresses now number over the whole archive, and `grep_memory` resolves against the full session, so it searches results compaction removed from view. See [compaction-interop.md](./compaction-interop.md).
- Agent-authored stub summaries (§3.2) still not implemented.

Phases 1–3 are now complete. What remains is Phase 4, evaluation, which needs a configured provider and real sessions to measure. For the consolidated list of what was deliberately left undone, see [outstanding.md](./outstanding.md).
