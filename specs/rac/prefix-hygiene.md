# Prefix-hygiene audit

Completes the action item from the research doc's §2.5 (TokenPilot): *"the prefix-hygiene techniques are directly applicable to any harness and worth auditing opencode against independently of RAC."* Partly discharged in [phase-0-findings.md](./phase-0-findings.md) §5; this finishes it.

Needed no provider — this is about what the request looks like, not what a model does with it. Tests in `test/session/rac-prefix.test.ts`.

## Why it matters to RAC specifically

RAC's justification is cache economics. Anything that churns the prompt prefix for unrelated reasons both costs money directly and **confounds the measurement RAC is judged on** — a cache-miss caused by prompt churn is indistinguishable, in the totals, from one caused by collapse.

TokenPilot's two techniques: neutralise volatile runtime values, and push variable content downstream so the prefix is byte-identical from turn one.

## Finding: the system prompt leads with a volatile value

`SystemPrompt.environment()` emits, inside `<env>`:

```
  Today's date: ${new Date().toDateString()}
```

and `prompt.ts` assembles the prompt as `[...env, ...instructions, ...mcp, ...skills]` — so **the environment block is the very first thing in the request**, and the date is inside it.

Cache invalidation is positional: everything from the first changed byte onward must be re-computed. A value at the head of the prompt therefore invalidates *everything* — the rest of the system prompt, the tool definitions, and the entire message history.

**How often.** `toDateString()` has day granularity, so this is not a per-turn cost. It bites when:

- a session is **resumed the next day** — guaranteed total cache miss, and resuming is ordinary usage;
- a **long-horizon session crosses midnight** — which is exactly RAC's target case. Long-Horizon-Terminal-Bench tasks average ~85 minutes; a run started late evening straddles the boundary.

It is the only clock- or entropy-dependent value in the system prompt. There is no `Date.now()`, `Math.random()`, `performance.now()` or PID anywhere in `system.ts`, `instruction.ts` or `reminders.ts` — a test pins that, so a per-turn volatile value added later will fail loudly rather than quietly halving cache hit rates.

### Fixing it

Cheapest change with the largest effect: **move the date to the end of the system prompt**, after the stable blocks. Everything before it then stays cached, so the loss shrinks from "the whole request" to "the tail of the system prompt onward".

Better still: move it out of the system prompt entirely and into a per-turn position near the tail, where it never touches the cached prefix. That is TokenPilot's placeholder technique in spirit — keep the information, deny it the prefix.

**Not done, deliberately.** `SystemPrompt.environment()` is shared by every opencode user, not just RAC sessions, so changing it alters behaviour for everyone and edits a hot upstream file. It is also a change whose benefit is *measurable* — which argues for making it after there is a live cache baseline to measure against, so the improvement can be demonstrated rather than assumed.

## Finding: tool definitions are stable

Clean. The tool set is derived from provider ID, model ID, runtime flags, agent permissions and MCP tools. None of those vary turn to turn within a session under normal use.

Specifically checked because it looked like a risk: `bypassAgentCheck` is recomputed **every turn** from whether the last user message carries an agent part. It only reaches `ctx.extra`, never tool filtering, so it cannot change the tool set. RAC's own tools are config-gated and therefore fixed for the life of a session.

Residual risks, both environment-dependent rather than inherent:

- **MCP servers connecting mid-session** would change the tool list and invalidate from the tools block onward. Only affects MCP users.
- **Switching model mid-session** changes tool selection (`usePatch` keys off `modelID`), but that is a deliberate user action with obvious cost.

## What this does not cover

- Whether the **provider** serialises a byte-identical prefix given identical input. Verified down to opencode's request construction, not into the SDK or over the wire.
- Real cache hit rates. This is static and payload-level; `opencode debug rac` against a live session is what confirms any of it.
