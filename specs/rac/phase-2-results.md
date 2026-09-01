# RAC Phase 2 — `remember`, and live cache measurement

Companion to [implementation-plan.md](./implementation-plan.md) §4 Phase 2, following [phase-1-results.md](./phase-1-results.md).

## What shipped

| File | Change |
|---|---|
| `src/session/rac.ts` | `lookup()` (address → stored result, with nearest-match on miss), `slice()` (line ranges), stubs now advertise recall |
| `src/tool/remember.ts` + `.txt` | New tool. `remember(id, offset?, limit?)` |
| `src/tool/registry.ts` | Registers `remember` only when `rac.enabled` |
| `src/session/prompt.ts` | Passes `recallable` so stubs only promise recall when the tool is actually present |
| `src/cli/cmd/debug/rac.ts` | New. `opencode debug rac [sessionID]` — per-turn prompt-cache accounting |
| `test/session/rac-remember.test.ts`, `rac-cache.test.ts` | 17 + 5 tests |
| `packages/core/src/flag/flag.ts` | `OPENCODE_RAC=1` to enable for one run (added later, for A/B runs) |

`remember` originally took no service dependencies, reading `ctx.messages`. It now reads the **full session** via `Session.Service`, so recall reaches past the compaction horizon — see [compaction-interop.md](./compaction-interop.md).

## Default changed: `collapse_after_turns` 2 → 0

A deliberate departure from the plan, and the Phase 1 measurements support it: at `0`, re-prefill (3,903) is indistinguishable from plain append-only (3,794), so the cache cost of RAC effectively vanishes. The original rationale for `2` — protecting read-then-edit workflows — was largely misplaced, because collapse counts *user* turns, so every tool call inside the current agentic loop stays verbatim regardless. The exposure is only across user turns, where §3.6 already argues re-reading beats recalling. `implementation-plan.md` §3.3 has been amended.

## Deliberate deviation: no system-prompt scaffolding

The plan's Phase 2 says to "add stub instructions to the system prompt explaining the collapse mechanism, the ID convention, and when to recall." **Not done, on purpose.**

The stub is self-describing (`Retrieve verbatim with remember("t14").`) and the tool description covers the rest. System-prompt text costs tokens on every request and would be a permanent edit to a file upstream actively maintains. §7 asks directly: *"Does recall get used at all without heavy system-prompt scaffolding? If it needs a lot of prompting, that is a finding worth reporting."* Starting without it is what makes that question answerable — adding scaffolding pre-emptively would destroy the measurement. If traces show recall going unused, add it then and record the delta.

## Verification

Confirmed against the real payload through `MessageV2.toModelMessages`, not just the code path, as the plan requires:

- **Recall returns byte-identical content** — the body after the header line is `===` the stored output.
- **Tail injection** — after a recall, the original stub is still at its original position and the recalled content appears strictly after it, in the final message. Nothing is injected into the prefix.
- **Re-collapse** — one more user turn and the recalled body collapses like any other result.
- **Conditional registration** — `opencode debug agent build` lists `remember` with `rac.enabled`, and does not without it.
- Nearest-match on a bad address, case/whitespace tolerance, and line-range clamping are unit-tested.

One gap found and fixed during this: a re-collapsed `remember` result rendered as a bare `[t2] remember` because `signature()` only knew file/path/pattern-style arguments. It now includes `id`, so a recalled result collapses to `[t2] remember(t1)` and the model can still see what it was looking at.

## Live cache measurement

`opencode debug rac [sessionID]` prints per-turn `input / cache read / cache write / output / tools / stubs`, plus totals and a hit rate, reading the provider-reported `SessionTokens.cache.{read,write}`. `--json` for scripting. Run the same task twice, once with `rac.enabled` off and once on, and compare.

Cache *writes* are counted as uncached in the hit rate. Folding them in would flatter a policy that thrashes the cache, which is precisely what this is built to detect.

**This is unvalidated against real data.** Only the empty path has actually run. The aggregation logic is unit-tested against synthetic messages, and the command is wired and typechecks, but the first real session should be treated as the actual test of it.

> **Partly superseded.** The compaction interaction described above has since changed — `remember` now reads the full archive and reaches past the compaction horizon. See [compaction-interop.md](./compaction-interop.md).

## Still open

- **Everything in Phase 1's caveats still stands.** The cache numbers so far are payload-prefix proxies, not provider-reported. That is what this command exists to replace.
- ~~**ID stability across session resume is untested**~~ — **done**, verified against a real database, and addresses now number over the whole archive. See [address-stability.md](./address-stability.md).
- **Chunked recall** (plan §3.4, "412 lines, 5 chunks") is not implemented. Line ranges via `offset`/`limit` are, matching `read`'s convention. Chunks become more useful alongside `grep_memory` in Phase 3.
- No agent-authored stub summaries yet (§3.2) — the other half of Phase 2 in the plan, deferred with the system-prompt question above.
