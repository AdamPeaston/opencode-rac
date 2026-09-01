# RAC address stability

Answers the open item flagged at the end of [phase-2-results.md](./phase-2-results.md) and the plan's §3.1 requirement that *"IDs must be stable across session resume."* Checked before starting Phase 3, because `grep_memory` will return addresses that must dereference correctly.

## The invariant

**Addresses are numbered over the whole stored session, and are stable for as long as that archive only grows by appending.**

`identify()` walks the message list front-to-back assigning `t1, t2, …` to each tool part in order. Three properties follow:

1. **Deterministic.** The list comes from `MessageV2.stream()` → `page()`, which orders messages `desc(time_created), desc(id)` and parts `ORDER BY id`. Total order, explicit tie-break, no reliance on insertion order. The same stored session always yields the same addresses.
2. **Append-stable.** Because numbering runs front-to-back, adding turns at the end never renumbers anything already assigned. `t2` on turn 4 is still `t2` on turn 40.
3. **View-independent.** Numbering runs over the full archive, not the compacted view the model sees, so truncating the front of that view removes `t1`–`t5` without renaming `t6` onward. `prompt.ts` streams the history once and passes the archive to `RAC.project` purely for address assignment, while `remember` and `grep_memory` resolve against the full session via `Session.Service`. `project()` is copy-on-write and never mutates stored parts, so what recall reads is always the full output rather than a stub.

## Verified

`test/session/rac-resume.test.ts`, 10 tests. Four run against a **real database** via the `testEffect` harness, persisting messages and reading them back rather than asserting over synthetic arrays:

- Two independent reads of the same session produce identical addresses, and each address resolves to the same `callID`.
- Continuing a session does not renumber existing addresses; `t2` still points at the same tool call after three more turns.
- Multiple tool calls within one turn are numbered by stored part order, reproducibly.
- An address parsed out of a rendered stub still resolves to the full original output on a later read — the actual end-to-end resume path.

> **Resolved.** Addresses are now numbered over the whole stored archive rather than the visible view, so compaction no longer renumbers them. The analysis below describes the previous behaviour and why it mattered; see [compaction-interop.md](./compaction-interop.md) for the fix.

## The one case where addresses do move: compaction

`filterCompacted` truncates history at a compaction point and reorders what survives into `[compaction-user, summary, …retained tail…]`. Everything before the retained tail disappears from the view, so the survivors renumber from `t1`.

Measured: a session with three tool results (`t1→c0, t2→c1, t3→c2`) compacted with `tail_start_id` at the third turn yields a filtered view where the sole survivor is `t1→c2`. The address `t3` no longer exists and falls through to the nearest-match path.

**Why this mattered:** the failure was silent. Resolved against the truncated view, `t1` did not error — it returned the *wrong* result, because the surviving tail had renumbered into that slot. And the manual `/compact` path (ACP `compact` → `session.summarize`) was never gated by `compaction.auto`, so it was reachable even while RAC forced auto-compaction off.

**This was fixed without persistence.** The plan's §3.1 fallback ("if not, persist the ID") turned out to be unnecessary: numbering over the full stored archive rather than the visible view achieves the same stability with no write path and no loss of purity, since `prompt.ts` already reads the whole session each turn.

## Bearing on Phase 3

`grep_memory` returns addresses for the model to feed to `remember`. Both resolve against the full session, so the two-stage split inherits property 3 directly and is safe across compaction as well as within a turn.
