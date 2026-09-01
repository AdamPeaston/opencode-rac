# RAC Phase 0 — Reconnaissance Findings

Companion to [implementation-plan.md](./implementation-plan.md) (the *how*) and [motivation-and-research.md](./motivation-and-research.md) (the *why* and the prior art). Verified against the checked-out revision (dev branch, commit `dc4449df0d` at time of writing) by reading source directly, not from prior knowledge of the opencode repo.

**Gate verdict: PASS.** There is a single chokepoint, all provider-bound paths go through it (or are exempt for the reasons the plan already anticipated), and every Phase 0 checklist item resolves favorably. Proceed to Phase 1.

---

## 1. The chokepoint

`MessageV2.toModelMessagesEffect` — `packages/opencode/src/session/message-v2.ts:131` (sync wrapper `toModelMessages` at line 417) is the single function that projects stored `WithParts[]` into an AI-SDK `ModelMessage[]` payload. It is the only place that reads `part.state.output` / `part.state.time.compacted` and decides what the model sees for a tool result.

Correction to the plan: there is no `session.sql.ts`. The actual schema lives in `packages/schema/src/v1/session.ts` (Effect `Schema.Struct` definitions), re-exported as domain types through `packages/core/src/v1/session.ts` and imported into `packages/opencode` as the `SessionV1` namespace. Storage/persistence (Drizzle) is a separate layer underneath that; the plan's mental model (stored state vs. projected payload) is correct, the file path was just wrong, exactly as §0 warned might happen.

## 2. Every path to the provider

Grepped for all callers of `toModelMessages`/`toModelMessagesEffect` — there are exactly three:

| Call site | Purpose | Needs RAC? |
|---|---|---|
| `session/prompt.ts:1262` | Main agent loop, once per step, inside the per-session prompt loop | **Yes — this is the target.** |
| `session/prompt.ts:224` | One-shot title generation for a new session | No — single short-lived call, not a sustained conversation; exempt as the plan implicitly assumes. |
| `session/compaction.ts:219` | Compaction's own use of the projection (to build the text it summarizes) | No. Compaction summarises *stored* output, not the projected view — which is why the summariser never saw a stub until it was given addresses explicitly. See §6 and [compaction-interop.md](./compaction-interop.md). |

Other paths checked:

- **Subagents (`tool/task.ts`).** `TaskTool` calls `sessions.create(...)` and then the same `SessionPrompt.prompt(...)` used by the main loop — a subagent is a first-class child `Session`, not a special code path. It goes through the identical chokepoint automatically. It also gets its **own** SQLite-backed message store (sessions are the storage key), so subagent tool results are already isolated from the parent's. This doesn't fully answer the plan's open question in §7 ("do subagents need their own RAC scope") — that's still a product decision about whether an agent should be able to `remember` into a *parent* session's archive — but it confirms the mechanical default is per-session isolation, which is the safer starting point.
- **ACP (`acp/agent.ts`).** `prompt(params)` calls `this.service.prompt(params)`, which resolves to the same `SessionPrompt.prompt`. No separate payload-construction path.
- **Retry (`session/retry.ts`).** Operates on an already-built request; does not re-derive messages from stored parts independently.
- **`session/llm.ts`.** Takes a pre-built `ModelMessage[]` and hands it to the provider (or `LLMNativeRuntime.stream`). Confirmed to have no message-construction logic of its own — it is strictly downstream of `toModelMessagesEffect`.

**Conclusion: single chokepoint, three callers, only one needs the RAC projection.** This is a stronger result than the plan hoped for.

## 3. Shape of the tool result part, and where a stub can live

Real location: `packages/schema/src/v1/session.ts`. Tool state is a discriminated union (`ToolState`) over `pending` / `running` / `completed` / `error`. `ToolStateCompleted` (lines 277–290) is:

```ts
{
  status: "completed",
  input: Record<string, any>,
  output: string,
  title: string,
  metadata: Record<string, any>,      // <-- free-form, already persisted
  time: { start, end, compacted?: number },  // <-- compacted timestamp already exists
  attachments?: FilePart[],
}
```

Two things fall directly out of this, both good news for Phase 1/2:

- `metadata: Schema.Record(Schema.String, Schema.Any)` is a free-form bag already persisted per tool part. RAC's sequential ID and precomputed stub (`{ rac: { id: "t14", collapsedAtTurn: N, stub?: "..." } }`) can live here with **no schema migration**. *(In the end nothing needed persisting — addresses are derived from archive position and stubs are rendered on the fly. This slot remains free if agent-authored stub summaries ever land.)*
- `time.compacted?: NonNegativeInt` already exists as a field, currently written by the compaction/prune mechanism (§6). Its presence and current consumer are useful precedent for exactly how the projection should branch on collapsed-vs-not.

## 4. Tool registration

`packages/opencode/src/tool/registry.ts` confirmed as the tool registry. The `.txt`-sibling description-file convention is real: e.g. `tool/read.txt` imported as `DESCRIPTION` into `read.ts` and passed into the tool definition. Conditional registration by config/flags is an established pattern — see `webSearchEnabled()` in `registry.ts`, which gates the web-search tool on provider ID and feature flags, and `RuntimeFlags.Service`, which is already threaded through `SessionTools.resolve(...)` (called from `prompt.ts`'s main loop) via `Effect.provideService(RuntimeFlags.Service, flags)`. Gating `remember` / `grep_memory` behind `rac.enabled` is a straightforward extension of this, not new plumbing.

## 5. Cache observability and cache-breakpoint mechanics

This was flagged in the plan as a blocking risk ("solve before Phase 1"). It's already solved:

- **Cache token counts are tracked and exposed today.** `SessionTokens.cache: { read, write }` (`packages/schema/src/v1/session.ts:520`) is populated per message/session and surfaced through `cli/cmd/stats.ts` (the `opencode stats` command) and `acp/usage.ts`. This is a real, provider-reported metric pipeline, not something that needs to be built for Phase 4 evaluation — it needs to be *read*.
- **Cache breakpoints are explicitly, manually managed** — this is new information not anticipated in the plan. `applyCaching()` in `packages/opencode/src/provider/transform.ts:358` places `cacheControl: { type: "ephemeral" }` (or the Bedrock/OpenRouter/Copilot/Alibaba equivalents) on **the last 2 system messages and the last 2 non-system messages** of every outgoing request, tagged fresh each turn.

  This also partly discharges the standing action item in the research doc's §2.5 (TokenPilot): "the prefix-hygiene techniques are worth auditing opencode against independently of RAC." opencode is *not* naive here — it already manages breakpoints deliberately. The remaining TokenPilot-style audit questions (are tool definitions positioned for a byte-identical prefix from turn one? are volatile runtime values neutralised with stable placeholders?) are untouched by this finding and remain open.

  Implication for tuning `collapse_after_turns`: the rolling breakpoint already sits within the last couple of messages of every request. For the "fixed small offset from the tail preserves the cache prefix" claim in §1/§3.3 to hold in practice, RAC's collapse boundary needs to stay *behind* (older than) wherever this breakpoint lands — i.e. `collapse_after_turns` should not be so small that it starts mutating content inside the window that's being freshly marked as a breakpoint anyway.

  > **Measured, and the concern did not materialise.** At `collapse_after_turns: 0` — the eventual default, where the boundary is closest to that window — re-prefill was 3,903 chars against plain append-only's 3,794 ([phase-1-results.md](./phase-1-results.md)). Indistinguishable. Still worth re-checking against provider-reported hit rates rather than payload proxies, which is what `opencode debug rac` is for.

## 6. Compaction: two distinct sub-mechanisms, not one

`session/compaction.ts` contains two separate things, both currently active, both needing to be addressed when "disable compaction under RAC" is implemented:

1. **Prune** (roughly lines 260–317): walks backward from the tail of the message list, protects the most recent `PRUNE_PROTECT = 40_000` tokens of tool output, and once cumulative prunable tokens exceed `PRUNE_MINIMUM = 20_000`, sets `part.state.time.compacted = Date.now()` on whichever tool parts fall past that budget line, then persists via `session.updatePart(part)`. At projection time, `message-v2.ts:293-296` sees `time.compacted` set and replaces the output with the literal string `"[Old tool result content cleared]"`, dropping attachments too. This is irreversible from the model's point of view — no address, no recall.
2. **Summarize** (`processCompaction`, ~line 319 onward): LLM-driven summarization-and-replace, triggered independently on context-limit conditions, using a dedicated part type to mark where compaction occurred.

**This matters beyond "disable it."** Prune is a real, already-shipped instance of exactly the failure mode §2 of the plan argues against: it mutates the payload at a *variable* offset determined by a running token budget, not a fixed offset from the tail, so by the plan's own cache-economics argument it should be measurably cache-hostile. This turns the plan's abstract argument into something empirically checkable in this exact codebase, and gives Phase 4 a natural, already-existing negative control (arm 1, "stock opencode, compaction enabled," already includes prune's behavior — it wasn't clear from the plan text whether its authors knew prune specifically, as distinct from summarize, was the mechanism doing this).

Practical consequence for Phase 1: "disable compaction when RAC is enabled" means finding and gating both the prune trigger and the summarize trigger — they are not behind one shared boolean today.

## 7. Build/test/dev-loop

Already resolved outside of Phase 0 proper, included here for completeness: the repo is a Bun workspace (`bun install` at root). Running from source needs a wrapper that invokes `packages/opencode/src/index.ts` by absolute path, with no `--cwd` override, so `process.cwd()`/`PWD` resolve to the real invocation directory rather than the repo. Editing source then takes effect on the next invocation with no build or link step, which satisfies the plan's requirement that RAC development iterate against live source.

> **Two flags are not optional.** Bun reads both `bunfig.toml` and `tsconfig.json` from `$cwd`, and neither is discovered relative to the entrypoint. Invoked from anywhere other than `packages/opencode`, the wrapper silently loses `bunfig.toml`'s `preload = ["@opentui/solid/preload"]`, which installs the SolidJS compile transform, and `tsconfig.json`'s `jsxImportSource`. The first failure is a bare `Cannot find package 'react'`; fixing that alone surfaces a second, `TuiStartupProvider is missing`, because without the transform JSX children evaluate eagerly and every context lookup fails. Both are cured by passing them explicitly, which Bun propagates into the TUI worker thread:
>
> ```
> bun run --conditions=browser \
>   --preload <repo>/packages/opencode/node_modules/@opentui/solid/scripts/preload.js \
>   --jsx-import-source=@opentui/solid \
>   <repo>/packages/opencode/src/index.ts "$@"
> ```
>
> `bun dev` is unaffected because its cwd is already `packages/opencode`. Note the preload path goes through the workspace symlink rather than the hashed store path, so it survives reinstalls.

---

## Net effect on the plan

- No changes needed to the phasing or design in §3–§5 of the plan.
- Two concrete numbers to fold into Phase 1 config/tuning discussion: the 40k/20k prune thresholds (as a baseline reference point, not something RAC needs to match) and the 2-message cache-breakpoint window (as a floor on how small `collapse_after_turns` can safely be).
- One correction: `session.sql.ts` → `packages/schema/src/v1/session.ts`.
- One addition to the Phase 1 task list: when disabling compaction under `rac.enabled`, gate prune and summarize separately — confirm both trigger points before assuming a single flag flip covers it.
