# Random Access Context (RAC)
## Motivation, Background Research, and Proposal

*Companion to [implementation-plan.md](./implementation-plan.md). This document covers why, the prior art, what RAC actually claims, and how to evaluate it. The implementation plan covers how.*

---

## 1. Motivation

### 1.1 The problem

A coding agent's conversation is dominated by tool results. File reads, greps, test output, build logs, directory listings — these accumulate turn after turn, and because language models are stateless between calls, the entire transcript is re-sent on every single turn. A task that runs for two hundred turns pays for early file reads two hundred times.

Most of that content is dead weight within a turn or two of being produced. The agent read the file, extracted what it needed, and moved on. But the bytes stay, competing for context window space, driving up cost, and degrading model attention — the "lost in the middle" and context-rot effects are well documented, and more context is not automatically better context.

The scale is not marginal. Long-Horizon-Terminal-Bench, evaluating fifteen frontier models, found agents consumed an average of 9.9M tokens per task across roughly 231 episodes and 85 minutes of execution. At that volume, the difference between carrying tool results forward and not carrying them is the difference between a viable product and an unviable one.

### 1.2 Why existing answers are unsatisfying

Every mainstream approach to this problem is lossy, and lossiness in an agent harness has a specific, nasty failure mode: the discarded content contains the one detail the agent needs forty turns later — an exact error string, a variable name, a user constraint — and the agent must either re-derive it expensively or hallucinate a substitute, compounding errors down the trajectory.

The four established families:

- **Truncation / sliding window.** Drop the oldest N turns. Simple, budget-compliant, and once a value falls outside the window it is gone permanently.
- **Summarisation / compaction.** Have a model condense history into prose. Retains more semantics than truncation but still lossy — omitted or paraphrased details cannot be recovered — and each compaction event costs an extra inference call and latency.
- **Structured state folding.** Compress history into a fixed JSON schema. Preserves anticipated fields reliably; anything unmodelled is discarded irreversibly.
- **RAG over history.** Store observations externally, retrieve by similarity. The store may retain everything, but recall is *implicit*: the agent cannot request a specific prior item, and recovery depends entirely on retrieval quality.

The shipped implementations reflect this. Anthropic's `clear_tool_uses_20250919` clears oldest tool results past a token threshold and substitutes a placeholder so the model knows something was removed, though it can no longer see what. Its sibling `compact_20260112` summarises and replaces. Claude Code persists oversized tool results to disk and substitutes previews. All useful, none recoverable by address.

### 1.3 The second problem: cache economics

There is a constraint that most context-management work ignores, and it inverts the usual intuitions.

Prompt caching (KV prefix caching) means that if the token prefix of a request matches a previously cached one, the cached activations are reused and the request is dramatically cheaper. This is consistent across providers — OpenAI does automatic prefix matching at 128-token granularity, DeepSeek caches by default, Gemini uses explicit CachedContent objects — and the underlying constraint is identical everywhere: **any modification to the prefix invalidates the cache from that point onward.** This follows from how KV caches work and will persist as long as the transformer architecture does.

Context management, by definition, modifies the transcript. So there is a direct tension between token sparsity and cache continuity, and it is easy to end up net-negative. "Beyond Compaction: Structured Context Eviction" analyses exactly this: under sustained token pressure, incremental in-place eviction causes the system to pay cache-*write* costs on every request without ever amortising them through cache *reads*, because each new eviction invalidates the entry before the next request can reuse it. Their conclusion is striking — in a narrow sense this is *worse than compaction*, which at least produces one stable prefix per pass and can sustain a hit rate until the next one.

Anthropic's own documentation concedes the same point about context editing, recommending a `clear_at_least` parameter to ensure enough tokens are cleared to make the cache invalidation worthwhile.

This is the constraint that shapes RAC's most counterintuitive design decision. §4 puts numbers on it: the net-negative regime is real but one turn wide.

---

## 2. Background research

### 2.1 The organising axis: recoverability

The most useful way to classify this literature is by what happens to information that no longer fits verbatim: is it *lost*, or is it *recoverable*, and if recoverable, by what mechanism? This determines whether a compaction event can silently destroy something the agent will later need — independent of how fluent or efficient the compaction itself is.

| Family | Recoverable? | Mechanism |
|---|---|---|
| Truncation / sliding window | No | — |
| LLM summarisation | No | — |
| Structured state | Partially | Only anticipated schema fields |
| RAG memory | Yes, implicitly | Similarity retrieval; agent cannot address a specific item |
| **Addressable recall** | **Yes, explicitly** | **Agent requests a specific item by ID** |

### 2.2 ARC — Addressable Recall Compaction

*arXiv 2607.25066, July 2026. The closest prior work; effectively the same core idea.*

ARC separates archival storage from active-context presentation. It stores tool observations in an append-only, ID-addressable log, replaces older observations with compact citations when compaction is required, and lets the agent use those identifiers to request stored content without re-executing the tool or depending on similarity retrieval.

Its framing is the key contribution and worth quoting in spirit: every baseline conflates two decisions that need not be coupled — *what to keep* and *what to show the model right now*. ARC keeps everything always, decides what to show using the same length-bounded logic as everyone else, and leaves an explicit dereferenceable pointer behind every omission. Recovery becomes a decision the agent makes rather than a probability the retriever gets right.

Mechanically: SHA1-derived IDs (first 8 hex chars, extended on collision), citations carrying fixed head and tail previews plus metadata and a recall hint, observations below a threshold ρ left verbatim, a per-step recall limit, chunked recall for oversized observations, and nearest-match suggestions on invalid IDs.

**Results.** On needle-in-a-haystack, 99.0% (Qwen3-8B) and 99.8% (Qwen3-32B) versus 88.12% for the best baseline. On LongBench-v2 Hard, 27.47% and 32.47% versus ~28.25%. Also 38.8%/73.5% reductions in HBM traffic versus a sliding window.

**How to read those numbers.** The needle result is spectacular and the reasoning result is nearly noise. The authors are honest about why: needle-in-a-haystack isolates verbatim recall, which is exactly what ARC targets, while LongBench-v2 additionally requires synthesis, where perfect recall can still yield a wrong answer through faulty reasoning. They frame their advantage as a lower bound on how much of the failure rate is attributable to recall. This is the correct interpretation and it sets expectations for RAC: **addressable recall fixes recall failures, not reasoning failures.**

**Limitations that RAC addresses.** ARC does not discuss prompt caching at all. It compacts reactively on overflow or proactively at a length estimate — both meaning large prefix rewrites at unpredictable moments. It LRU-evicts recalled bodies back to stubs, mutating deep history. Its stubs are mechanical previews carrying no semantic summary. Its IDs are hashes whose fingerprint component does no work (their own appendix concedes the occurrence index provides uniqueness). And it has no search over the archive — their conclusion flags as an open question why implicit retrieval still beats them on dialogue-history tasks, suggesting explicit and implicit recall are complementary rather than competing.

### 2.3 Scroll — Context as an Environment

*arXiv 2608.21690.*

The most sophisticated system in the space. Combines a queryable append-only event log with external payload references and an executable resident namespace. Context management becomes *writing programs*: the model issues `exec` actions to search and expand the log, and retrieved records stay in the kernel unless explicitly surfaced via `print`, which the harness inserts as an observation into the next context.

That `exec`/`print` split is the single most valuable idea to steal. It decouples the cost of *searching* the archive from the cost of *reading* results, so a broad query does not blow the budget it was meant to protect.

Scroll also uses graduated representation: recent history as fine-grained sequence-addressed headlines, older history as coarser ranges, with an eviction index of compact landmarks tied to exact log addresses so the agent navigates to a region rather than scanning.

Reported: 94.8% LongMemEvalS, 73.1% BEAM10M (+5.1 over best published memory system), 86.7% LOCA256K (+37.4 over best published long-horizon agent).

### 2.4 VISTA

*arXiv 2606.30005.*

Formalises the split RAC depends on: **recovery preserves evidence after eviction, while "proprioception" — an informative dashboard of what was evicted — helps select what to evict.** These solve different problems, and VISTA argues via Fano's inequality that recovery is necessary under budget pressure.

This is the theoretical justification for caring about stub quality. A recall mechanism the agent cannot aim is worth much less than one it can.

### 2.5 TokenPilot

*arXiv 2606.17016.*

Attacks the sparsity/cache tension from the prefix-stability side rather than the recall side. Ingestion-Aware Compaction neutralises volatile runtime variables with stable placeholders and shifts tool definitions downstream to secure a byte-identical prompt prefix from the first turn. Lifecycle-Aware Eviction is deliberately conservative, deferring structural purge until a segment's residual value has thoroughly expired rather than paging frequently. Reports 61%/56% cost reductions.

The prefix-hygiene techniques are directly applicable to any harness and worth auditing opencode against independently of RAC.

### 2.6 Production implementations

- **hermes-lcm** and **Volt** (Martian-Engineering) both ship `lcm_grep`: regex search over conversation messages including those no longer in active context, querying the raw message database directly, returning `store_id`s that feed a separate expansion tool. Externalisation preserves the same `store_id` and payload files when rows are rewritten to placeholders, keeping addresses stable across collapse. Their schemas are worth reading before designing anything similar.
- **Letta** exposes `grep_files` for exact matching alongside `semantic_search_files` over embeddings, with LRU eviction of open files. Notable for keeping exact and semantic search as distinct tools rather than blending them.
- **Claude Code** persists oversized tool results to disk with previews substituted, under a per-tool cap.

### 2.7 Prior art coverage matrix

● implemented · ◐ partial · ○ absent · ? not established

| | ARC | Scroll | VISTA | TokenPilot | Anthropic API | hermes-lcm / Volt | **RAC** |
|---|---|---|---|---|---|---|---|
| Append-only archival store | ● | ● | ● | ○ | ○ | ● | ● |
| Recall by explicit address | ● | ● | ● | ○ | ○ | ● | ● |
| Sequential IDs (not hashes) | ○ | ● | ? | — | — | ● | ● |
| Semantic content in stub | ○ | ◐ | ● | ○ | ○ | ◐ | ○ |
| Grep over archive | ○ | ● | ○ | ○ | ○ | ● | ● |
| Sub-range / chunked recall | ● | ● | ? | — | — | ● | ● |
| Eager fixed-age collapse | ○ | ○ | ○ | ◐ | ○ | ○ | ● |
| Prefix-cache stability as goal | ○ | ◐ | ○ | ● | ◐ | ◐ | ● |
| Recall injected at tail | ? | ◐ | ? | — | — | ? | ● |
| Small results stay verbatim | ● | ● | ? | ● | ○ | ● | ● |
| Two-stage search/surface split | ○ | ● | ○ | ○ | ○ | ◐ | ● |
| Replayable vs archival tools | ○ | ○ | ○ | ◐ | ● | ● | ○ |

Every RAC component exists somewhere. The combination in rows 7–9 — eager constant-lag collapse, cache stability as the primary driver, tail injection — layered on an ARC-style addressable store is not attested anywhere. Every recall-capable system in the table triggers on pressure, which is precisely what forces their prefix rewrites deep into history.

> **The RAC column describes what is built, not what is planned.** Rows 1–3, 5–11 are implemented, including the two-stage split — `grep_memory` returns locations, `remember` returns content.
>
> Two cells are ○ by choice. **Semantic content in the stub** is absent: a shipped stub carries an address, a tool signature, a line count and a recall hint, and nothing derived from the result itself — `[t14] read(src/app.ts) → 412 lines collapsed. Retrieve verbatim with remember("t14").` Neither an ARC-style head/tail preview nor a generated one-line summary; §3.3 gives the reasoning. **Replayable vs archival** is deferred, and the case for it has strengthened now that recall reaches past the compaction horizon — see [outstanding.md](./outstanding.md).
>
> One row is worth adding that no system in this table has: **recoverable compaction** — compaction that drops turns from view while leaving them addressable. See [compaction-interop.md](./compaction-interop.md).

---

## 3. The RAC proposal

### 3.1 Summary

Each tool result appears in full in the model's view for the turn it was produced and a small fixed number of turns after. It then collapses to a short stub carrying a sequential ID, the tool and its main argument, and a size. (The design also called for a one-line semantic hint; §3.3 explains why the shipped stub deliberately omits it.) The full content is retained, unmodified, in the harness's existing message store. A `remember` tool takes an ID and optional range and appends the verbatim content back at the tail of the conversation. A `grep_memory` tool searches the archive and returns IDs and line numbers, not content.

### 3.2 The three claims

**1. Eager, fixed-age collapse.** Collapse happens on a fixed schedule, not under context pressure.

This is the counterintuitive core. A smarter policy — LRU, budget-aware, utility-scored — evicts from wherever in history is least useful, invalidating the KV cache from that point onward and landing in the net-negative regime described in §1.3. Fixed-age collapse always mutates at the same small offset from the tail, so the re-prefill cost is constant and tiny.

**A dumber eviction policy is the cache-optimal one.** This should be defended against well-meaning improvement.

**2. Addressable recovery.** Collapse is not deletion. The mechanism guarantees address-conditioned recoverability; it does not guarantee the model picks the right address or reasons correctly once it has the content. ARC draws this distinction explicitly and it is worth preserving — it clarifies what to measure.

**3. Append-only presentation.** Recalled content is appended at the tail as a normal tool result, never injected into the prefix. Recalled content re-collapses under the same rule. There is no LRU eviction of recalled bodies.

### 3.3 Design decisions worth defending

**Sequential IDs (`t1`, `t2`, ...) over content hashes.** Fewer tokens, orderable so the agent can reason about recency, and far easier for a model to copy without corruption.

**Agent-authored stubs.** The agent decides whether to recall based only on the stub, so stub quality determines whether recall is aimed or a lottery — this is VISTA's proprioception argument. Rather than generating summaries at collapse time with a second model, prompt the agent to comment in one sentence on the salient content of each tool result. The comment lands in the assistant's own turn text, which is never collapsed. The semantic hint is baked into surviving conversation at zero marginal token cost and zero extra inference.

This may make explicit stub summaries redundant — the surrounding conversation may already carry enough implicit hinting. That is an empirical question the evaluation should answer.

> **As built: the stub carries no semantic content at all, and that is the control condition.**
>
> Two shortcuts were available and both were rejected. A fixed head/tail preview is what the implementation plan (§3.2) names as the *bad* stub, and it is what ARC does: it pays tokens on every collapsed result forever in exchange for whatever the first and last lines happen to contain, which for a file read is imports and a closing brace. A summary generated at collapse time by a small model is the plan's explicit *fallback*, to be reached for only if the agent-authored route proves unreliable — taking it first would cost an inference call per collapse and forfeit precisely the zero-marginal-cost property that makes the preferred route worth preferring.
>
> The preferred route is not built either, and that is the deliberate part. It is a prompting intervention, and §6 asks whether the agent recalls *without* heavy system-prompt scaffolding. Shipping the scaffolding before observing baseline behaviour destroys the measurement that would say whether the scaffolding is needed — including the hypothesis directly above, that surviving assistant commentary may already supply enough implicit hinting to make explicit stub summaries redundant. So the mechanical stub is the experimental control, not a shortfall against the design, and it is the first thing to add once traces exist. The same reasoning kept stub instructions out of the system prompt. Tracked as item 2 in [outstanding.md](./outstanding.md).

**No special anti-thrash mechanism.** Multiple `remember` calls in a single turn are the canonical way to avoid recall loops, exactly as batching works for any other tool.

**Deferred: the replayable/archival distinction.** For idempotent reads the agent can simply re-read, and re-reading is *more correct*, since a recalled result is a point-in-time snapshot that may be stale if the file changed. The real value of recall is for non-reproducible results: API responses, expensive computations, non-deterministic search. Marking tools as replayable versus archival is a per-tool flag on the collapse rule — cheap to add later, so it is deferred rather than designed in.

### 3.4 What RAC is not

It is not a memory system. It is within-session context management. Cross-session memory, semantic retrieval, and knowledge consolidation are out of scope.

It will not fix reasoning failures. ARC's LongBench result is the calibration: addressable recall closes recall gaps and leaves synthesis gaps roughly where it found them.

---

## 4. Economics

### 4.1 When RAC pays for itself

§1.3 argues that context management is easy to get net-negative on cache economics. That argument is qualitative. This section makes it quantitative.

> **One parameter governs everything below: `w/m`**, the ratio of what a turn adds to what survives collapsing it. It is also the one number never measured on a real session, and it is violently sensitive to session shape. A tool-call-only trajectory gives 39.5x; a turn that also carries a user message, reasoning, a prose answer, real tool-call *inputs* (which never collapse — RAC replaces `state.output` only) and a sub-threshold result gives **2.4x**. Every figure in §4 is quoted at the realistic shape. Quoted at the tool-call-only shape they would be larger by up to an order of magnitude, which is the size of the error available to anyone who benchmarks this mechanism against synthetic tool traffic. Treat the algebra as sound and every constant as provisional until [outstanding.md](./outstanding.md) item 1 lands.

**The model.** Per turn *n*, with `w` the new content a turn adds, `m` the per-turn residual once collapsed (stub plus whatever does not collapse), `Δ` the extra re-prefill the newest collapse forces, `p` the prefill price, `c` the cached-read price, and `k = p/c`:

```
cost_off(n) = p·w + c·(n−1)·w
cost_on(n)  = p·(w + Δ) + c·[(n−1)·m − Δ]
```

**A turn is several requests, and that multiplies the saving.** An agentic loop issues one request per step, and *every* request bills the whole cached prefix. So the cached-read differential `(w − m)` is collected once per step, while `Δ` is paid once per turn, at the boundary where the stub rewrites the prefix. With `S` requests per turn, RAC is cheaper for that turn once `S·(n−1)·(w−m) > Δ·(k−1)`, and summing over turns gives the cumulative crossover:

```
saving(n) = S·c·(n−1)·(w − m) − Δ·(p − c)
N* = 1 + 2·Δ·(k−1) / (S·(w − m))
```

Note `k−1`, not `k`. The Δ tokens are not newly created, they are *reclassified*: they were already being paid for at the cached-read rate and now attract the prefill rate, so the marginal cost is `Δ(p−c)`. Using `k` overstates the penalty by one part in `k`.

**The tool-call count does not cancel — more tool calls per turn make RAC pay sooner.** With `T` tool calls of `r` tokens each and stubs of `s`, the prefix breaks at the *first* collapsed result, so everything after it is re-prefilled: `Δ ≈ T·(s + i) + C`, where `i` is a tool call's input (never collapsed, but downstream of the break) and `C` is the trailing answer text. Meanwhile `w − m ≈ T·(r − s)`, and critically `S ≈ T + 2`. Substituting, the numerator grows as `T` while the denominator grows as `T²`:

```
N* ≈ 1 + 2·(T·(s + i) + C)·(k−1) / ((T + 2)·T·(r − s))     →     1   as T grows
```

So the crossover falls toward turn 1 as turns get more tool-heavy. The trap here is modelling a turn as a single request: `Δ` and `w − m` both scale as `T`, so `T` appears to cancel exactly and the crossover appears independent of tool density. It is the `S` in the denominator, easy to omit because it never appears in a per-turn accounting, that makes tool-heavy turns pay off sooner.

**Checked against the instrument.** Replaying realistically-shaped sessions and billing each request at `k·fresh + cached`, at `k` = 12.5:

**Table: crossover turn, predicted versus measured.** Session parameters measured off the replay; `N*` is the first turn at which cumulative cost with RAC falls below cumulative cost without it.

| tools/turn | result size | `w` | `m` | `Δ` | `S` | `N*` predicted | ⌈`N*`⌉ | `N*` measured |
|---|---|---|---|---|---|---|---|---|
| 1 | 120 lines | 3,809 | 2,186 | 146 | 3 | 1.69 | 2 | 2 |
| 2 | 120 lines | 5,542 | 2,296 | 256 | 4 | 1.45 | 2 | 2 |
| 4 | 120 lines | 9,008 | 2,516 | 476 | 6 | 1.28 | 2 | 2 |
| 8 | 120 lines | 15,940 | 2,958 | 918 | 10 | 1.16 | 2 | 2 |
| 2 | 60 lines | 3,882 | 2,295 | 255 | 4 | 1.93 | 2 | 2 |
| 2 | 400 lines | 13,382 | 2,296 | 256 | 4 | 1.13 | 2 | 2 |

`⌈N*⌉` matches the measured crossover in every row, which is what a correct closed form should do — the model predicts a real-valued break-even point and the session can only cross at an integer turn. The predicted value falls toward 1 as tool calls per turn rise, exactly as the `T²` denominator requires.

Note how little `m` moves: 2,186 to 2,516 as tool calls quadruple. The per-turn residual is dominated by prose and tool-call inputs, not by stubs, which are around 2% of it. It is therefore nearly independent of how tool-heavy the turns are, which is what keeps `w/m` — and every conclusion resting on it — a property of session shape rather than of tool usage.

This is implemented as `opencode debug rac --replay --price k`, which reports the measured crossover beside the closed form's prediction. A large divergence between them means the session violates a model assumption — most likely that turns are roughly uniform in size.

**What `k` actually is.** Priced from the published rates on 31 August 2026:

| provider | cache read | prefill | `k` |
|---|---|---|---|
| Anthropic, all Claude models | 0.1× base input | 1.25× (5-minute cache write) | **12.5** |
| Anthropic, 1-hour cache | 0.1× base input | 2× (1-hour cache write) | **20** |
| OpenAI, current lineup (gpt-5, 5.4, 5.5, 5.6 families) | 0.1× input | 1× input, no write charge | **10** |
| OpenAI legacy (gpt-4o, o1, o3-mini) | 0.5× input | 1× input | 2 |
| OpenAI o3 | 0.25× input | 1× input | 4 |

The numerator for Anthropic is the *write* price, not base input: a prefilled token is also stored for the next turn's reuse, so it is billed at the write rate. Anthropic's own catalog entry for Opus 4.5 — `cache_write: 6.25, cache_read: 0.5` — is 12.5 exactly.

`k` is invariant under every Anthropic pricing modifier. Batch (50%), data residency (1.1×) and fast mode scale input, output, writes and reads uniformly, so they cancel in the ratio. It does not vary by model either, on either vendor's current lineup. The two vendors have converged on a cache read at 10% of input; the only difference is Anthropic's write surcharge.

Applied to a 30-turn synthetic session:

**Table: percentage of the billed input cost that RAC saves.** Rows are conversation length; columns are the price ratio `k`. Both arms replay the same trajectory at the realistic shape (`w` = 5,542, `m` = 2,296, `Δ` = 256), billed in cached-token equivalents.

| conversation length (turns) | saving at k=2 | at k=10 | at k=12.5 | at k=20 |
|---|---|---|---|---|
| 2 | 21.3% | 7.4% | 5.9% | 3.2% |
| 5 | 40.7% | 22.6% | 19.6% | 13.7% |
| 10 | 49.0% | 34.6% | 31.6% | 24.8% |
| 20 | 53.6% | 44.3% | 41.9% | 36.1% |
| 40 | 56.0% | 50.6% | 49.1% | 45.1% |
| 80 | 57.3% | 54.4% | 53.5% | 51.1% |

`k` = 2 is gpt-4o, o1 and o3-mini; 10 is OpenAI's current lineup; 12.5 is Anthropic on the 5-minute cache; 20 is Anthropic on the 1-hour cache.

Four things fall out.

*The loss region is one turn wide.* There is a regime where collapse costs more than it saves, exactly as §1.3 warns, but it is turn 1 — and turn 1 has nothing above it to collapse, so the arms are identical by construction. The measured crossover is turn 2 at every price and session shape tried, and nothing in the real range of `k` comes close to the value that would make collapse a net loss past the opening turn. `k` determines how much RAC saves, not whether it saves.

*The saving grows with conversation length, up to a ceiling set by `w/m`.* The baseline's cached-read bill is a sum over a growing payload, so it is **O(N²)**; RAC's re-prefill penalty is constant per turn, so it is **O(N)**. A quadratic beats a linear early and keeps pulling away, which is why every column rises monotonically. It converges rather than diverging: the asymptote is `1 − m/w`, **59%** at the realistic shape, and the k=2 column is visibly flattening onto it by 80 turns. On the tool-call-only synthetic that asymptote is 97% and the curve looks unbounded, which is session shape rather than mechanism. **`w/m` sets the ceiling; `k` sets how fast you approach it.**

*A higher `k` gives a **smaller** percentage saving.* This runs against the intuition that expensive prefill should flatter a cache-preserving design. It does not, because both arms prefill almost the same amount — RAC's whole penalty is a constant `Δ` per turn. What RAC shrinks is the *cached-read* bill over an ever-growing payload, so the more of the bill that sits in cached reads (low `k`), the more there is to save. As `k → ∞` the bill becomes pure prefill, the arms converge, and the saving goes to zero.

A practical corollary: Anthropic's 1-hour cache and RAC partly substitute for each other. Moving a long session from the 5-minute to the 1-hour cache takes `k` from 12.5 to 20 and, at 80 turns, cuts the saving from 53.5% to 51.1%. Both remain large; they overlap.

*`min_lines_to_collapse` is load-bearing.* §3.3 justifies the threshold as "a stub costs tokens too", which reads like a rounding-error guard. It is in fact what pins `N*` near 2, by holding `r ≫ s`. Lower it far enough, `r − s` approaches zero, and the crossover runs away.

**What the model omits, in order of how much it matters.**

*Cache expiry, which is probably the dominant term.* This assumes a perfect cache. Anthropic's TTL is five minutes; every idle gap longer than that makes the baseline re-prefill `n·w` at full rate while RAC re-prefills `w + (n−1)m`. That is a second O(N²) term, entirely in RAC's favour and larger than the cached-read saving. Real economics are likely better than the table shows.

*Local inference inverts the result.* On Ollama a cached read costs no measurable time — 25ms for 6,817 tokens — so `c → 0`, `k → ∞`, and `N* → ∞`. It is the `k → ∞` limit of the consequence above rather than a separate phenomenon. RAC is permanently a couple of percent slower and never breaks even on prefill time. The local benefit is not speed but window headroom: `w/m` more turns before compaction, about 2.4x at the realistic shape — which is what §4.2 takes up. A local benchmark showing no cost saving is the expected result, not a negative one.

*Recall spending, which the replay cannot see.* If the agent recalls a fraction `f` of collapsed results per turn, that is `f·r` tokens re-appended at the tail at full prefill rate. Break-even is `f < [(n−1)(w−m) − Δ(k−1)] / (r·k)`, and at the realistic shape with `k` = 12.5 and a 1,622-token result:

**Table: how much recalled content a turn can carry before it cancels the saving.** The budget is the break-even spend, so a turn recalling less than this still leaves RAC ahead of the control. The right-hand column expresses the same budget as a count of full 1,622-token tool results, which is what a `remember` call with no line range returns.

| at turn | break-even recall budget | equivalent in full results recalled |
|---|---|---|
| 5 | 804 tokens/turn | 0.50 |
| 20 | 4,699 tokens/turn | 2.90 |
| 40 | 9,892 tokens/turn | 6.10 |
| 80 | 20,275 tokens/turn | 12.50 |

So at turn 5 a single unrestricted recall already overspends the budget twice over, while by turn 20 the session can afford nearly three of them per turn. The budget grows linearly with conversation length: tight early, generous later. **Compulsive early recall is the one agent behaviour that would destroy these economics**, which is why it sits on §5.5's list of things to look for in traces. The complementary hypothesis — that recall will be *rare*, because relevance decays with age and old results are seldom what a current task needs — is taken up in §4.2.

### 4.2 Context economy and the compaction threshold

§4.1 prices a fixed conversation. This section asks the other question: RAC buys room in the context window, and room can be spent two ways — on longer sessions, or on cheaper ones. They are alternatives, not both.

**The motivation.** With RAC on, the payload grows at `m` per turn instead of `w`, so the turns a window holds rise from `C/w` to `C/m` — a factor of `w/m`, **2.4x at the realistic session shape**. That is the context-economy claim, and unlike the cost claim it depends on no price ratio, no cache TTL, and no provider reporting anything. It is also a far more modest claim than a tool-call-only synthetic suggests, where the same ratio reads 39.5x; see the note opening §4.1.

It also invites a question nobody asks. On a long session the dominant cost is not generating tokens, and not prefilling new content: it is **re-reading the same cached prefix, every single turn**. At a 200k payload with `k` = 12.5, the cached prefix costs about 200k units per turn while the turn's own new content costs about 50k. Over a 48-turn compaction cycle that standing re-read is 5M of a 7.65M total. Both RAC and compaction attack exactly this term — RAC by shrinking the prefix continuously with constant-lag invalidation, compaction by shrinking it periodically with a full rewrite. Which means the compaction threshold is a cost lever, and it is worth knowing where it should sit.

#### The model

In cached-token equivalents, where reading one cached token costs 1 and prefilling one costs `k`:

| | |
|---|---|
| `S` | the floor the payload never drops below: system prompt, tools, and the summary the last compaction left |
| `g` | tokens the payload grows per turn (`w` with RAC off, `m` with it on) |
| `T` | the compaction threshold — compact on reaching it, dropping back to `S` |
| `K` | the cost of one compaction event |
| `U = T − S` | the usable room above the floor |

Between compactions the payload after `i` turns is `P(i) = S + i·g`. Each turn pays the whole prefix at the cached rate and its own new content at the prefill rate, so `cost(i) = P(i) + k·g`. A cycle lasts `n = U/g` turns:

```
cycle = Σ(S + i·g) + n·k·g + K
      = n·S + g·n²/2 + n·k·g + K
```

Dividing by `n` and substituting `n = U/g`:

```
cost/turn = S + k·g  +  U/2  +  K·g/U
            └ fixed ┘   └── variable, v(U) ──┘
```

**The variable cost `v(U) = U/2 + K·g/U` is the part of the per-turn bill that the threshold controls**, in cached-token equivalents per turn. The fixed part — the floor `S` you re-read every turn no matter what, and the `k·g` you pay to prefill the turn's own new content — is incurred identically at any threshold, so choosing `T` can only move `v`. That is why the penalty for a mis-set threshold is naturally expressed against `v` and has to be converted before it describes the whole bill.

Its two terms pull opposite ways. `U/2` is the average payload over a cycle, so the standing cached-read bill — **linear in `U`**. `K·g/U` is compaction amortised over the `U/g` turns between events — **inversely proportional to `U`**. Halving the threshold halves the standing bill and doubles the compaction frequency.

```
d/dU [U/2 + K·g/U] = 1/2 − K·g/U² = 0     →     U* = √(2·K·g)     →     T* = S + √(2·K·g)
```

At the optimum the two terms are equal, each contributing `U*/2`, so `v(U*) = U*` exactly — the minimum variable cost per turn is numerically the optimal room itself. That identity is what lets `v(U)` be rewritten in terms of `U*` alone below.

The square root is not special to compaction. Any linear-versus-reciprocal pair produces one; this is the same shape as economic order quantity, trading holding cost against reorder cost.

**`g` is the term RAC changes, and it enters under the root.** Slower growth means fewer compactions per turn at a given `U`, so the amortised term shrinks, so a large `U` is no longer needed to spread that cost over. `U* ∝ √g`: the realistic 2.4x reduction in growth rate moves the optimal room by `√2.4 ≈ 1.55x`.

The result is more robust than it looks. Treating `K` as independent of `T` is questionable, since the summariser reads the context it is summarising. But writing `K(U) = K₀ + U` makes the amortised term `K₀·g/U + g`, and the extra `g` is constant in `U`, so it drops out of the optimisation entirely: `U* = √(2·K₀·g)` either way.

#### What that comes to

Heuristic constants for Claude Opus 5 — `S` = 8,000, summary output 3,000 tokens, `k` = 12.5, output at 50 — giving `K = k·S + 50·O = 250,000`, with `w` and `m` from the realistic session shape:

| arm | `g` | `U*` room | `T*` threshold | cost/turn @`T*` | turns/cycle |
|---|---|---|---|---|---|
| rac off | 5,542 | 52,640 | 60,640 | 129,915 | 9 |
| rac on | 2,296 | 33,882 | 41,882 | 70,582 | 15 |

`U*` ratio 1.55x, exactly `√(w/m)`. The `T*` ratio is 1.45x, lower still, because the floor `S` is shared and the law governs the room above it rather than the threshold itself. At their respective optima RAC is **1.84x cheaper per turn**.

This is where the square-root law cuts against the argument rather than for it. `√` compresses: even a 10x improvement in growth rate would move the optimal threshold only 3.2x, and the realistic 2.4x moves it 1.55x. **RAC barely relocates the optimum.** What it does is lower the cost at every threshold, which is a different and less interesting claim than "RAC lets you compact much earlier".

**Both figures still sit far below where anyone sets a threshold in practice.** opencode compacts at `context − reserved`, where `reserved = min(20_000, maxOutputTokens)` — essentially at the window limit, 180k on a 200k model. The cost-optimal setting is 61k *without RAC at all*, and 42k with it.

Why the gap? Probably not a considered trade. Three things plausibly set thresholds in practice and only one is about quality:

1. **Compaction is treated as a failure mode rather than a knob.** It is lossy and disruptive, so the instinct is to defer it as long as possible, not to ask how often it is worth paying.
2. **The cost is invisible.** Cached reads are cheap per token and never itemised per turn, so a 180k prefix re-read thirty times does not register. It is the classic shape of a cost that is individually negligible and collectively dominant.
3. **Nobody has the instrument.** Computing `U*` needs `g`, `K`, `S` and `k`. `g` in particular only becomes visible once something measures payload growth per turn, which is what the replay harness does.

The honest reading is that quality is the reason the default *survives*, but not obviously the reason it was chosen.

#### The penalty for being wrong

Substituting `K·g = U*²/2` into `v(U) = U/2 + K·g/U` clears `K` and `g` out of it, leaving the variable cost as a function of the threshold and its optimum alone — `v(U) = (U² + U*²)/2U`. With `r = U/U*`, and using `v(U*) = U*` from above:

```
v(U) / v(U*) = ½·(r + 1/r)
```

Symmetric in `r` and `1/r`, so the penalty is flat near the optimum and severe far from it.

**`r` is `U/U*`, the ratio of *room above the floor*, not `T/T*`.** The two are not interchangeable: `T = S + U`, and the shared floor `S` compresses the threshold ratio relative to the room ratio. At opencode's 200k default, rac off sits at `U/U*` = 3.27 but `T/T*` = 2.97; rac on at 5.08 against 4.30. Everything in this section is quoted as `U/U*`.

**Table: the cost of a mis-set threshold.** The middle row is `v(U)/v(U*)`, the penalty on the **variable** part of the cost — the two terms the threshold controls. The bottom row converts that into a premium on **total** cost per turn, for the rac-off arm, since the fixed part `S + k·g` is paid regardless and dilutes the penalty.

| `U/U*` | 1x | 1.5x | 2x | 3x | 5x | 10x | 30x |
|---|---|---|---|---|---|---|---|
| penalty on variable cost, `½(r + 1/r)` | 1.00x | 1.08x | 1.25x | 1.67x | 2.60x | 5.05x | 15.02x |
| resulting premium on total cost/turn | 1.00x | 1.03x | 1.10x | 1.27x | 1.65x | 2.64x | 6.68x |

**Being 2x off the optimal room costs 25% of the variable cost, and 10% of the total.** That flatness is the practically important part: precision is not required, only avoiding the far tail. Against opencode's actual threshold:

**Table: cost of opencode's compaction threshold against the optimum.** Each arm's own optimum is included as a baseline row at premium 1.00x. "Premium" is cost per turn at that threshold divided by cost per turn at that arm's `T*`.

| threshold in use | arm | `T` | `U/U*` | cost/turn | premium | turns to reach `T` |
|---|---|---|---|---|---|---|
| optimum | rac off | 60,640 | 1.0 | 129,915 | **1.00x** | 9 |
| optimum | rac on | 41,882 | 1.0 | 70,582 | **1.00x** | 15 |
| opencode default, 200k window | rac off | 180,000 | 3.3 | 171,330 | 1.32x | 31 |
| opencode default, 200k window | rac on | 180,000 | 5.1 | 126,037 | 1.79x | 75 |
| opencode default, 1M window | rac off | 980,000 | 18.5 | 564,700 | 4.35x | 175 |
| opencode default, 1M window | rac on | 980,000 | 28.7 | 523,291 | 7.41x | 423 |

On a 200k window the default costs 1.3–1.8x the optimum, which the flatness makes almost tolerable. On a 1M window it costs 4.4–7.4x, and that is where the threshold starts to be worth arguing about.

RAC's saving against the control also depends heavily on the shared threshold: **26%** on a 200k window at the default, **7%** on 1M, but **46%** with each arm at its own optimum. At a large shared threshold the standing cached-read bill dominates both arms identically and RAC's slower growth buys progressively less.

#### How long RAC postpones compaction

At `m` = 2,296 per turn, RAC reaches a 180k threshold in 75 turns against the control's 31 — a factor of 2.4x, the same `w/m` as everywhere else. The steady-state model above therefore applies to both arms: each one reaches its threshold, compacts, and cycles.

This conclusion is unusually sensitive to `m`. At the tool-call-only shape, where `m` is 73, RAC-on would need 2,356 turns to reach the same threshold — long enough that no real session would compact at all, and the steady-state model would not apply to it. The difference between "RAC postpones compaction by a factor of 2.4" and "RAC eliminates compaction" is entirely session shape, which is the strongest argument in this document for measuring `w/m` on a recorded trajectory before relying on either.

At the realistic shape the cycling regime is entered quickly: the optimal threshold of 42k is reached in 15 turns. The comparison that matters is then never-compact versus cycling at `T*`, which cross where `S + N·g = 2U*`:

**Table: two compaction policies compared, RAC on.** Both columns are cost per turn in cached-token equivalents at the stated session length. "Never compact" lets the payload grow unbounded, so its per-turn cost rises with length; "cycle at `T*`" compacts on reaching 42k, so its per-turn cost is flat forever.

| session length (turns) | cost/turn, never compact | cost/turn, cycle at `T*` = 42k | saving from cycling |
|---|---|---|---|
| 10 | 52,180 | 70,582 | — (cycling is worse) |
| 26 | 70,548 | 70,582 | 0% (break-even) |
| 50 | 98,100 | 70,582 | 28% |
| 100 | 155,500 | 70,582 | 55% |
| 300 | 385,100 | 70,582 | 82% |
| 1,000 | 1,188,700 | 70,582 | 94% |

Crossover at `N = (2U* − S)/g ≈ 26` turns. Below it, letting the payload grow is cheaper than paying to compact. Above it, cycling wins by a widening margin. Twenty-six turns is within reach of ordinary work, not only of thousand-turn trajectories, so this is a live question rather than a long-horizon one.

#### Recommendation

**Compaction economics are largely independent of RAC.** That is the honest summary. The `√` law compresses a 2.4x growth advantage into a 1.55x shift in the optimal threshold, so RAC does not meaningfully change *where* to compact. What it changes is the cost at whatever threshold is chosen, and how long you get before reaching it.

**The threshold is mispriced with or without RAC, and more so on large windows.** The default costs 1.3–1.8x the optimum per turn on a 200k window and 4.4–7.4x on 1M. The flatness of `½(r + 1/r)`, further diluted by the fixed part of the bill, makes the 200k case nearly forgivable; the 1M case is not. This is a finding about opencode's compaction default, not about RAC.

**Past ~26 turns, cycling beats letting the payload grow.** That threshold moves with `m`: a session of sparse, tool-light turns reaches it sooner, and one dominated by large tool results much later.

**The saving is paid for in addressability.** [compaction-interop.md](./compaction-interop.md) records that compaction truncates pre-horizon turns and their stubs go with them: the archive stays reachable in principle but nothing left in context tells the agent that `t14` exists. Cycling every 15 turns means a lot of compactions on a long task, each dropping a batch of addresses, with the summariser deliberately not instructed to carry any forward.

**Unless recall past the horizon is worthless anyway** — and it may well be. The standing hypothesis is that `remember` will be *rare*, not because the agent prefers re-running idempotent tools but because relevance decays with age: a stub that has fallen behind the compaction horizon is, by then, negligibly relevant to the current task. If that holds, the addressability objection above largely dissolves and the compaction saving becomes takeable.

That makes the hypothesis load-bearing rather than merely interesting, and it is testable well before any of this is settled. The measurable quantity is **recall depth** — how many turns back a `remember` call reaches — not recall count. Concentrated at one to five turns and the deep archive is dead weight; fat-tailed and it is not. Note that low frequency alone would *not* falsify the design: §1.1's case for recall is tail insurance, not average utility, and a 23-token stub is cheap enough that rare use can still pay. What would falsify it is recall that fires but never at a moment that mattered.

So: **treat the threshold as a variable to evaluate, not a setting to advise**, and settle the recall-depth question early, because it determines whether the saving is available at all.

Two limitations to carry with every number here. The constants are heuristic — `S`, the summary size, and above all `w` and `m`, which come from a synthetic session shaped to look plausible rather than from a recorded one — so the algebra is sound and the constants are provisional. And **the model contains no quality term whatsoever**: not a simplification, but a genuine absence. `U*` is a cost floor, and a cost floor is not a recommendation.

---

## 5. Benchmark selection

### 5.1 What the evaluation has to establish

Four distinct claims, requiring different evidence:

1. **Token reduction** — measurable on any long-running task.
2. **Cache preservation** — the load-bearing claim, and the one no prior work establishes. Requires observing cached versus uncached input tokens, not just totals.
3. **Task success is not degraded** — requires a benchmark with real pass/fail grading.
4. **Recall is used, and used well** — requires trace analysis, not just scores.

A benchmark that does not put the agent under sustained context pressure cannot test any of this. Most coding benchmarks resolve in a handful of turns, where RAC is a no-op.

### 5.2 Recommended, in priority order

**1. Long-Horizon-Terminal-Bench** (arXiv 2607.08964) — *the best fit.*

46 long-horizon tasks across nine categories, Terminal-Bench-style setup, but each task decomposed into fine-grained graded subtasks with deterministic environment-grounded checkers. Tasks typically require hundreds of episodes and minutes to hours, explicitly stressing long-context management and iterative debugging rather than one-shot problem solving. Agents averaged 9.9M tokens and ~231 episodes per task.

Two reasons this is the primary recommendation. First, it is squarely in the regime RAC targets — at 9.9M tokens per task, context management is the dominant cost. Second, **dense subtask grading gives partial credit**, which means far better statistical power per run than binary pass/fail. Agent runs are high variance and expensive; a benchmark that distinguishes "got 60% of the way" from "got 20% of the way" lets you detect degradation with a fraction of the repeats.

The main cost is that tasks are slow and expensive, so budget accordingly and consider a stratified subset.

**2. SWE-bench Verified** — *the credibility benchmark.*

Still the benchmark people think of first for agentic coding, and the filtered subset with better label reliability than the original. Every relevant system reports on it, so it is how RAC's results become legible to anyone else.

Caveat: many SWE-bench Verified tasks resolve in relatively few turns, so a substantial fraction will exercise RAC barely or not at all. Report both the aggregate and a breakdown by trajectory length — the interesting signal is in the long tail. Consider pre-filtering to instances where the baseline exceeds some turn or token threshold.

**3. Terminal-Bench** — *breadth beyond repo patching.*

Hard, realistic command-line tasks. Moves past issue-resolution into general terminal work with a different tool-use profile — more shell output, more build and test logs, which is exactly the high-volume low-reuse content RAC targets. It also has an established agent-adapter mechanism, which reduces integration work for a custom harness.

**4. SWE-EVO** (arXiv 2512.18470) — *targeted long-horizon software evolution.*

Explicitly built for long-horizon evolution scenarios across large codebases and many turns, and its related-work section is itself framed around context management as the fundamental challenge. Good complement to SWE-bench Verified because it is designed to have the property SWE-bench only sometimes has.

### 5.3 Worth considering

- **LongCLI-Bench** — long-horizon agentic programming in CLIs; overlaps Terminal-Bench but explicitly length-focused.
- **SWE-Marathon** (arXiv 2606.07682) — ultra-long-horizon autonomous software work; the extreme end of the regime.
- **RoadmapBench** (arXiv 2605.15846) — long-horizon development across version upgrades.

### 5.4 Recommended against

- **Needle-in-a-haystack.** Will produce a spectacular, meaningless number. It isolates exactly the capability addressable recall trivially provides — ARC hit 99.8% on it. Use it once as a smoke test that recall works at all, then never cite it.
- **LongBench-v2 and long-context QA benchmarks generally.** These test long-*input* comprehension, not long-*trajectory* agent behaviour. There are no accumulating tool results to collapse. ARC used it as a reasoning-heavy complement, but for a coding harness the SWE-family benchmarks serve that role better.
- **SWE-bench Pro.** Attractive on paper — 1,865 problems from 41 repos, deliberately harder and requiring larger patches and more context. But a 2026 OpenAI audit raised dataset quality concerns affecting roughly 30% of instances, including broken or overly strict tests. Noise on that scale will swamp the effect sizes RAC is looking for.
- **Function-level benchmarks** (HumanEval, MBPP, APPS and descendants). No agent loop, nothing to manage.

### 5.5 Evaluation design notes

**Arms.** Stock opencode with its own compaction; RAC collapse-only with no recall; RAC + `remember`; RAC + `remember` + `grep_memory`.

The collapse-only arm is the critical control. If full RAC does not beat it on task success, the recall mechanism is not being used — which is a stub-quality or system-prompt problem, not a mechanism problem, and points at a different fix.

**Instrument cache hit rate before running anything.** If cached versus uncached input tokens cannot be observed through the provider integration, the central claim is untestable and everything else is secondary.

**Multiple runs per task.** Agent trajectories are high variance; single runs will mislead. This is the main argument for weighting effort toward the dense-reward benchmark.

**Report cost per completed task, not just tokens.** Tokens saved at the price of cache misses can be a net loss, and only the cost figure exposes that.

**Read traces, not only scores.** Specific failure modes to look for: the agent ignoring stubs and re-running tools instead of recalling; recalling compulsively and defeating the savings (§4.1 prices the budget that would blow); recall never reaching further back than a turn or two, which would make the deep archive dead weight; recall thrash on the same ID; hallucinated IDs; and acting on stale recalled content after a file changed — the last being the empirical argument for reinstating the deferred replayable/archival distinction.

---

## 6. Open questions

- Does the agent-authored stub summary work, or does the assistant's own surviving turn text already carry enough implicit hinting to make explicit stubs redundant?
- Does RAC eliminate the need for compaction on long tasks, or merely delay it? §4.2 says *delay*, by a factor of `w/m` — which turns the compaction threshold into a variable worth evaluating rather than a setting to leave alone.
- The compaction threshold sits well above its cost optimum with or without RAC. Is that saving reachable without dismantling addressability past the compaction horizon?
- Is a fixed `collapse_after_turns` right at all, or should the window be tool-dependent?
- Do subagents need their own RAC scope, or should they inherit the parent's store?
- Does recall get used without heavy system-prompt scaffolding? If it needs extensive prompting, that is itself a finding.
- How far back does recall reach? §4.2 argues this is load-bearing rather than incidental: if relevance decays sharply with age, the archive past the compaction horizon is dead weight and the compaction saving becomes takeable. The measurable is recall *depth*, not recall count.
- Does the two-stage search/surface split (Scroll's `exec`/`print`) matter enough to adopt more fully than the minimal `grep_memory` design?

---

## 7. References

| Work | Identifier |
|---|---|
| ARC — Addressable Recall Compaction | arXiv 2607.25066 |
| Scroll — Context as an Environment | arXiv 2608.21690 |
| VISTA — LLM Agents Are Latent Context Managers | arXiv 2606.30005 |
| TokenPilot — Cache-Efficient Context Management | arXiv 2606.17016 |
| Beyond Compaction: Structured Context Eviction | arXiv 2606.11213 |
| Long-Horizon-Terminal-Bench | arXiv 2607.08964 |
| SWE-EVO | arXiv 2512.18470 |
| SWE-Marathon | arXiv 2606.07682 |
| RoadmapBench | arXiv 2605.15846 |
| Anthropic context editing | platform.claude.com/docs/en/build-with-claude/context-editing |
| hermes-lcm | github.com/stephenschoettler/hermes-lcm |
| Volt | github.com/Martian-Engineering/volt |

*All arXiv entries above are from 2025–2026 and the area is moving quickly; check for newer work before finalising the design.*
