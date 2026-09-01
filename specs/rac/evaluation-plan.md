# RAC — evaluation plan

How the four claims in [motivation-and-research.md](./motivation-and-research.md) §5.1 get tested on hardware that has no provider budget: an M5 MacBook Pro with 24GB unified memory, running local models through Ollama.

The research doc chose benchmarks assuming an API. Most of those choices do not survive contact with this machine. This document supersedes §5.2 for local work; §5.2 stays the right list for anyone who does have an API budget.

---

## 1. The finding that reshaped the plan

**Ollama reports no cache information at all.** Measured on 0.33.2 against a ~6.8k-token prompt:

| request | `prompt_eval_count` | `prompt_eval_duration` |
|---|---|---|
| cold, long prompt | 6817 | **8653 ms** |
| identical repeat | 6817 | **25 ms** |
| same prefix, 16 more tokens | 6833 | 130 ms |
| unrelated short prompt | 17 | 75 ms |

The token count is identical cold and warm. The OpenAI-compatible endpoint is worse — `{"prompt_tokens": 6413, ...}` both times, with no `prompt_tokens_details.cached_tokens` field. The cache is unambiguously working; a 346× prefill collapse is not ambiguous. It is simply not reported as tokens.

This breaks the instrument already built. `opencode debug rac` reads `msg.info.tokens.cache.read` / `.write`, which on Ollama are structurally zero, so it reports a flat 0% hit rate in both arms. Plan §4 Phase 0 item 5 is blunt about the consequence: *"if hit rate cannot be measured, the evaluation is crippled."*

So the primary instrument had to stop depending on the provider.

---

## 2. Tier 0 — offline replay (`debug rac --replay`)

Prefix reuse is a property of the payloads, not of the provider. Replay a stored session, reconstruct the exact request sequence that produced it, and diff each request against its predecessor: what a prefix cache can reuse is precisely the common prefix.

`packages/opencode/src/session/rac-replay.ts`, surfaced as `opencode debug rac --replay [sessionID]`.

- **Requests, not messages.** An agentic loop issues one request per step. Within a turn the steps are pure appends and cache perfectly in both arms; at a turn boundary RAC rewrites older results and breaks the prefix. Measuring per message would blur where the invalidation lands, which is the entire question.
- **Real serialisation.** Payloads come from `MessageV2.toModelMessages` against the model that actually produced the session, so the numbers describe the bytes that would have gone over the wire.
- **Character-exact prefix, estimated tokens.** The prefix boundary is exact. Only the conversion to tokens is approximate (`Token.estimate`, 4 chars/token), and it is applied identically to both arms — so the ratios are trustworthy where the absolute counts are not.
- **Reuse is credited from the immediately preceding request only.** That is how the caches this targets behave: a llama.cpp slot holds one prefix, and Anthropic's is a prefix cache over the linear conversation. Crediting reuse from any earlier request would flatter both arms.

Both arms run over one recorded trajectory, so there is **zero variance** — no repeats, no model-quality confound, no credentials, seconds per run.

### What it already shows

On synthetic conversations (12 turns, two 120-line tool results per turn, and *no prose* — see the caveat below, and *not* a real session):

```
                     rac off      rac on       delta
payload tokens        105669       20959      -80.2%
prefill tokens         11724       11941       +1.9%
stubs                      0          90

per-turn re-prefill  early 44  late 43  (constant)
```

Two things worth stating plainly, because both were mildly surprising:

**Collapse *raises* prefill, and that is correct.** Against a perfect prefix cache an old tool result is already free, so replacing it with a stub can only invalidate something that was costing nothing. RAC is not buying cheaper prefill on an append-only trajectory; it is buying an 80% payload reduction for a small constant re-prefill. Payload tokens are what the provider bills and what fills the context window; prefill tokens are the work actually done. Conflating the two is how this gets misread in both directions.

> **These constants are shape-dependent and this session shape is unrepresentative.** The turns here carry nothing but tool calls. Add a user message, reasoning, a prose answer and real tool-call inputs — none of which collapse — and the per-turn residual rises from 73 tokens to about 2,300, taking the payload saving from 93% to 56%. `w/m` is the parameter everything downstream turns on, and it is exactly what a real session is needed to pin down. See the note opening [motivation-and-research.md](./motivation-and-research.md) §4.1.

These two numbers are the inputs to the cost model in [motivation-and-research.md](./motivation-and-research.md) §4.1. The replay applies it automatically: it bills both arms in cached-token equivalents, reports the turn from which RAC is cheaper alongside the closed form's prediction, and prints the tokens of recall per turn the session can afford while staying ahead. The ratio `k` comes from the session model's own published rates — 12.5 for Anthropic, 10 for OpenAI's current lineup — with `--price k` overriding it, for the 1-hour cache (20) or any rate the catalog does not carry. The report names which of the two it used, since a looked-up rate and an assumed one deserve different trust.

Local models publish no cache rate, so a locally recorded session prints the block with the ratio missing and says what to pass. That is the honest answer rather than an omission: `k` is effectively unbounded on hardware where a cached read costs no measurable time, which is the regime [motivation-and-research.md](./motivation-and-research.md) §4.1 describes, and inventing a ratio there would manufacture a saving that does not exist.

**The overhead is flat.** Constant per turn regardless of how far into the session it is measured — 43–44 tokens on the tool-call-only synthetic quoted above, 256 on a realistically-shaped turn, but flat with length in both cases. That is claim 1 — *"fixed-age collapse always mutates at the same small offset from the tail, so the re-prefill cost is constant and tiny"* — confirmed as a measurement rather than an argument. A budget- or utility-triggered policy would rewrite deeper as history grew, and `overhead.early` vs `overhead.late` is built to detect exactly that. The instrument prints `GROWING` when it does.

The residual creep across session lengths (~1 token between a 6-turn and a 24-turn session) is address width — `t6` costs less than `t24` — and grows with the log of session length.

### The limitation to state in any writeup

Replaying one recorded trajectory through both arms is **counterfactual**. A RAC-enabled agent would have issued `remember` calls and diverged. This measures the prefix economics of a *fixed* history, which is the cleanest isolation of the mechanism and not a claim about what the agent would do. Behavioural claims need Tier 2.

### The prefill win this cannot see yet

Every session replayed so far is short enough that the baseline arm never exhausts its context window. When it does, stock opencode compacts — rewriting the entire prefix at once. That is a prefill spike RAC should avoid or delay, and it is the one regime where RAC should show a prefill *saving* rather than a small cost. **Replaying a session long enough to have compacted is the highest-value single measurement still outstanding.**

---

## 3. Tier 1 — can a local model drive the tools at all

Before anything expensive: given a stub, does `qwen3.5:9b` reliably emit `remember("t14")`?

This is the needle-in-a-haystack smoke test the research doc's §5.4 permits — *"use it once as a smoke test that recall works at all, then never cite it."* It is a genuine go/no-go. RAC's recall path assumes a model that notices stubs and aims at them unprompted, and small models are weak precisely at that kind of meta-behaviour. Twenty minutes here can invalidate the whole agentic arm.

If it fails, that is not a null result. It is evidence for the deferred agent-authored stub summaries ([outstanding.md](./outstanding.md) item 2) and it reframes what can be claimed: collapse economics without demonstrated recall.

---

## 4. Tier 2 — task success

§5.2's recommendations mostly do not survive the hardware:

| | verdict |
|---|---|
| **Long-Horizon-Terminal-Bench** | 9.9M tokens/task. Days per task locally. Viable as two or three deep case studies, not as a benchmark. |
| **SWE-bench Verified** | Needs per-instance Docker; most images are x86, so Apple silicon emulates. Worse, a 9B scores near zero — **"performance held" cannot be demonstrated against a floor of zero.** Drop for local work. |
| **Terminal-Bench** | Best of the three. Shorter tasks, established agent-adapter mechanism. A stratified subset is plausible. |
| **SWE-EVO** | Same scale problem as LH-Terminal-Bench. |

What actually fits is a **bespoke self-scoring task set**, designed around three properties the benchmarks above only sometimes have:

1. trajectories long enough to trigger collapse;
2. tool outputs above `min_lines_to_collapse`;
3. **dense subtask grading**, not binary pass/fail.

The third is not a convenience. §5.2 argues for partial credit on statistical-power grounds; with a 9B model it becomes mandatory, because binary grading will be all-zeros in every arm and distinguish nothing. Something like a synthetic repo with N independently-tested seeded bugs gives a graded score and a tunable trajectory length.

This is not externally credible on its own. For a mechanism result it is the right instrument, and Terminal-Bench remains the credibility gesture if API budget ever appears.

---

## 5. Design of the runs

**Arms.** Per §5.5: stock opencode with its own compaction; RAC collapse-only; RAC + `remember`; RAC + `remember` + `grep_memory`. The collapse-only arm is the control that says whether recall is being used at all.

**Sampling is inverted by local inference.** With an API budget you run many tasks once. With this machine the cost is time, not money, so you run few tasks many times — overnight, unattended. Since "performance held" is a null hypothesis, and proving a null needs an equivalence test rather than a t-test, many repeats of few tasks is what the claim actually requires. The constraint is the right shape for the question.

**Cost per completed task** (§5.5) has no dollar figure locally. Substitute wall-clock prefill time, which is the physical quantity the cache claim is about anyway, and which Ollama does report.

**Traces, not only scores.** §5.5's failure list is unchanged: ignoring stubs and re-running tools, compulsive recall, recall thrash on one address, hallucinated addresses, acting on stale recalled content.

---

## 6. Running it on this machine

Settings that silently ruin runs if left at defaults:

- **`OLLAMA_NUM_PARALLEL=1`.** Probing showed a prompt still hitting cache after an unrelated request should have evicted it — multiple slots. Multiple slots make cache behaviour non-deterministic and split the context window.
- **`OLLAMA_KEEP_ALIVE=-1`.** The default 5-minute unload destroys the KV cache. A slow agent loop would otherwise show cache misses that are an artifact of the harness rather than of RAC.
- **Context length.** `/api/ps` showed a 3B model occupying 13.2 GB at 131072 context. A 9B at 128k will not fit in 24 GB. Run `qwen3.5:9b-32k`; treat 64k as the ceiling. `qwen3.8:27b` at 17 GB is out once KV cache is added.
- **Determinism is not guaranteed at temperature 0.** llama.cpp results depend on prefill batch splits, so cached and uncached runs of an identical prompt can diverge. Another reason the cost claims live in Tier 0, where no sampling happens.
- **Provider wiring.** Local Ollama goes in as a custom provider on `@ai-sdk/openai-compatible` against `http://localhost:11434/v1`. Note that endpoint reports no timings at all — `prompt_eval_duration` exists only on the native `/api/chat`, so corroborating Tier 0 against real prefill times needs a recording proxy or an out-of-band read.

If a provider that *does* report cache counters ever becomes available, run `debug rac` and `debug rac --replay` on the same session. Two independent instruments agreeing is far stronger evidence than either alone, and no prior system in the §2.7 matrix reports the payload-derived number at all.

---

## 7. Order of work

1. **Replay a session long enough to have compacted.** The one regime where RAC should show a prefill saving, and the only major gap in Tier 0.
2. **Tier 1 go/no-go** on local tool-calling.
3. **Build the graded task set**, sized so a run finishes overnight.
4. **Tier 2 with many repeats**, equivalence-tested.

Steps 1 and 2 both need the one thing still missing: a real session, recorded end to end. That remains [outstanding.md](./outstanding.md) item 1, and it is still the thing everything else waits on — but the instrument waiting for it is now provider-independent.
