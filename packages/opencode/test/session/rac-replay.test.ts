import { describe, expect, test } from "bun:test"
import { RAC } from "@/session/rac"
import { RACReplay } from "@/session/rac-replay"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const big = Array.from({ length: 120 }, (_, i) => `line ${i} of a large tool result`).join("\n")

function tool(id: string, output: string, input: Record<string, unknown> = {}): SessionV1.ToolPart {
  return {
    id,
    type: "tool",
    callID: "call_" + id,
    tool: "read",
    sessionID: "ses_1",
    messageID: "msg_1",
    state: { status: "completed", input, output, title: "read", metadata: {}, time: { start: 0, end: 1 } },
  } as unknown as SessionV1.ToolPart
}

function user(id: string): SessionV1.WithParts {
  return {
    info: { id, role: "user" } as SessionV1.Info,
    parts: [{ id: "prt_" + id, type: "text", text: "hi" } as unknown as SessionV1.Part],
  }
}

function assistant(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return { info: { id, role: "assistant" } as SessionV1.Info, parts }
}

/** N turns, each a user message and one assistant message with `tools` big tool calls. */
function conversationWith(turns: number, tools: number) {
  return Array.from({ length: turns }, (_, i) => [
    user("msg_u" + i),
    assistant(
      "msg_a" + i,
      Array.from({ length: tools }, (_, j) => tool(`prt_t${i}_${j}`, big, { filePath: `src/f${i}_${j}.ts` })),
    ),
  ]).flat()
}

/** N turns, each a user message and one assistant message with one big tool call. */
function conversation(turns: number) {
  return Array.from({ length: turns }, (_, i) => [
    user("msg_u" + i),
    assistant("msg_a" + i, [tool("prt_t" + i, big, { filePath: `src/f${i}.ts` })]),
  ]).flat()
}

/** Stands in for MessageV2.toModelMessages: ordered, deterministic, prefix-stable. */
const serialize = async (msgs: SessionV1.WithParts[]) =>
  JSON.stringify(
    msgs.map((msg) => ({
      role: msg.info.role,
      parts: msg.parts.map((part) =>
        part.type === "tool" && part.state.status === "completed" ? part.state.output : JSON.stringify(part),
      ),
    })),
  )

const options: RAC.Options = { collapseAfterTurns: 0, minLinesToCollapse: 50, recallable: true }

describe("request reconstruction", () => {
  test("emits one request per assistant message plus one per tool result", () => {
    const msgs = [user("u1"), assistant("a1", [tool("t1", big), tool("t2", big)]), user("u2"), assistant("a2", [])]
    const requests = RACReplay.requests(msgs)
    expect(requests.map((r) => [r.turn, r.step])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
    ])
  })

  test("each step sees exactly the tool results available when it was sent", () => {
    const msgs = [user("u1"), assistant("a1", [tool("t1", "one"), tool("t2", "two")])]
    const requests = RACReplay.requests(msgs)
    const partsOfLast = (r: RACReplay.Request) => r.context.at(-1)?.parts.length ?? 0
    // Step 1 predates the assistant message entirely, so the context ends at the user turn.
    expect(requests[0].context.map((m) => m.info.role)).toEqual(["user"])
    expect(partsOfLast(requests[1])).toBe(1)
    expect(partsOfLast(requests[2])).toBe(2)
  })

  test("ignores messages that never reached the provider", () => {
    expect(RACReplay.requests([user("u1")])).toHaveLength(0)
  })
})

describe("longest common prefix", () => {
  test("counts shared leading characters", () => {
    expect(RACReplay.lcp("abcdef", "abcxyz")).toBe(3)
    expect(RACReplay.lcp("abc", "abcdef")).toBe(3)
    expect(RACReplay.lcp("", "abc")).toBe(0)
    expect(RACReplay.lcp("abc", "xyz")).toBe(0)
  })
})

describe("replay accounting", () => {
  test("an append-only prefix is reused once the payload is large", async () => {
    // One turn, several tool calls: nothing collapses inside a turn, so each
    // step should cost roughly its own new content and nothing more. Steps 1 and
    // 2 are excluded because there is barely any prefix to reuse yet — the
    // measure only becomes meaningful once history exists.
    const msgs = [user("u1"), assistant("a1", [tool("t1", big), tool("t2", big), tool("t3", big)])]
    const arm = await RACReplay.measure(msgs, { label: "off", serialize })
    expect(arm.costs).toHaveLength(4)
    for (const cost of arm.costs.slice(2)) expect(cost.fresh).toBeLessThan(cost.tokens / 2)
    expect(arm.hitRate).toBeGreaterThan(50)
  })

  test("collapse shrinks the payload", async () => {
    const msgs = conversation(4)
    const off = await RACReplay.measure(msgs, { label: "off", serialize })
    const on = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    expect(on.total.collapsed).toBeGreaterThan(0)
    expect(on.total.tokens).toBeLessThan(off.total.tokens)
  })

  test("and is charged for the re-prefill it forces", async () => {
    // The load-bearing property: a stub rewrites history above the tail, so the
    // measurement must show fresh tokens where the rewrite lands. If this ever
    // reports zero, the instrument is not measuring invalidation at all.
    const msgs = conversation(4)
    const on = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    const collapsing = on.costs.filter((cost) => cost.collapsed > 0)
    expect(collapsing.length).toBeGreaterThan(0)
    expect(collapsing.some((cost) => cost.fresh > 0)).toBe(true)
  })

  test("net effect is a large payload saving for a small prefill cost", async () => {
    // The trade the design actually makes. Against a perfect prefix cache an old
    // tool result is already free, so collapsing it can only add re-prefill —
    // what has to hold is that the payload saving dwarfs that cost.
    const msgs = conversation(12)
    const off = await RACReplay.measure(msgs, { label: "off", serialize })
    const on = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    const result = RACReplay.compare(off, on)
    expect(result.delta.tokensPct).toBeLessThan(-50)
    expect(Math.abs(result.overhead.total)).toBeLessThan(Math.abs(result.delta.tokens) / 20)
  })

  test("re-prefill overhead stays constant as the session grows", async () => {
    // Claim 1, stated as a test. Fixed-age collapse rewrites the same small
    // offset from the tail every turn, so the overhead cannot compound. If this
    // ever fails, the collapse rule has started reaching deeper into history.
    const result = RACReplay.compare(
      await RACReplay.measure(conversation(16), { label: "off", serialize }),
      await RACReplay.measure(conversation(16), { label: "on", serialize, rac: options }),
    )
    expect(result.overhead.early).toBeGreaterThan(0)
    expect(result.overhead.late).toBeLessThanOrEqual(result.overhead.early * 1.5)
  })

  test("a longer session does not cost proportionally more overhead", async () => {
    const short = RACReplay.compare(
      await RACReplay.measure(conversation(6), { label: "off", serialize }),
      await RACReplay.measure(conversation(6), { label: "on", serialize, rac: options }),
    )
    const long = RACReplay.compare(
      await RACReplay.measure(conversation(24), { label: "off", serialize }),
      await RACReplay.measure(conversation(24), { label: "on", serialize, rac: options }),
    )
    // Compared on `late` rather than `perTurn`: the first turn has nothing above
    // it to collapse, so it contributes a zero that dilutes the mean more in a
    // short session than a long one and manufactures growth that is not there.
    //
    // The residual creep that remains — a token or so between a 6-turn and a
    // 24-turn session — is address width, `t6` costing less than `t24`, not the
    // collapse rule reaching deeper. It grows with the log of session length and
    // is bounded in practice by how many tool calls a session can hold.
    expect(long.overhead.late - short.overhead.late).toBeLessThan(2)
    expect(long.delta.tokensPct).toBeLessThan(short.delta.tokensPct)
  })

  test("results below the threshold change nothing", async () => {
    const msgs = [user("u1"), assistant("a1", [tool("t1", "short")]), user("u2"), assistant("a2", [tool("t2", "also")])]
    const off = await RACReplay.measure(msgs, { label: "off", serialize })
    const on = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    expect(on.total.collapsed).toBe(0)
    expect(on.total).toEqual(off.total)
  })

  test("is deterministic", async () => {
    const msgs = conversation(5)
    const a = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    const b = await RACReplay.measure(msgs, { label: "on", serialize, rac: options })
    expect(a.total).toEqual(b.total)
  })

  test("empty session reports nothing rather than dividing by zero", async () => {
    const arm = await RACReplay.measure([], { label: "off", serialize })
    expect(arm.hitRate).toBe(0)
    expect(arm.total).toEqual({ tokens: 0, reused: 0, fresh: 0, collapsed: 0 })
  })
})

describe("report", () => {
  const meta = { sessionID: "ses_1", model: "ollama/qwen3.5:9b", rac: options }

  test("names both costs and does not present the trade as a verdict", async () => {
    const msgs = conversation(8)
    const result = RACReplay.compare(
      await RACReplay.measure(msgs, { label: "off", serialize }),
      await RACReplay.measure(msgs, { label: "on", serialize, rac: options }),
    )
    const report = RACReplay.render(result, meta)
    expect(report).toContain("payload tokens")
    expect(report).toContain("prefill tokens")
    expect(report).toContain("ollama/qwen3.5:9b")
    // The numbers in the summary line must be the ones in the table above it.
    expect(report).toContain(String(Math.abs(result.delta.tokens)))
    expect(report).toContain(String(result.on.total.collapsed))
  })

  test("reports constant invalidation for fixed-age collapse", async () => {
    const msgs = conversation(12)
    const result = RACReplay.compare(
      await RACReplay.measure(msgs, { label: "off", serialize }),
      await RACReplay.measure(msgs, { label: "on", serialize, rac: options }),
    )
    expect(RACReplay.render(result, meta)).toContain("constant")
  })

  test("calls out compounding invalidation when it appears", () => {
    // Synthetic: the arms differ only in that the "on" arm's prefill climbs with
    // turn number, which is the signature of a policy rewriting ever deeper.
    const arm = (label: string, fresh: (turn: number) => number): RACReplay.Arm => {
      const costs = Array.from({ length: 10 }, (_, i) => ({
        turn: i + 1,
        step: 1,
        tokens: 1000,
        reused: 1000 - fresh(i + 1),
        fresh: fresh(i + 1),
        collapsed: label === "on" ? 1 : 0,
      }))
      const total = costs.reduce(
        (acc, cost) => ({
          tokens: acc.tokens + cost.tokens,
          reused: acc.reused + cost.reused,
          fresh: acc.fresh + cost.fresh,
          collapsed: acc.collapsed + cost.collapsed,
        }),
        { tokens: 0, reused: 0, fresh: 0, collapsed: 0 },
      )
      return { label, costs, total, hitRate: (100 * total.reused) / total.tokens }
    }
    const result = RACReplay.compare(
      arm("off", () => 20),
      arm("on", (turn) => 20 + turn * 10),
    )
    expect(result.overhead.late).toBeGreaterThan(result.overhead.early)
    expect(RACReplay.render(result, meta)).toContain("GROWING")
  })

  test("survives a session with nothing in it", () => {
    const empty: RACReplay.Arm = {
      label: "off",
      costs: [],
      total: { tokens: 0, reused: 0, fresh: 0, collapsed: 0 },
      hitRate: 0,
    }
    expect(() => RACReplay.render(RACReplay.compare(empty, empty), meta)).not.toThrow()
  })
})

describe("economics", () => {
  const compare = async (turns: number) =>
    RACReplay.compare(
      await RACReplay.measure(conversation(turns), { label: "off", serialize }),
      await RACReplay.measure(conversation(turns), { label: "on", serialize, rac: options }),
    )

  test("recovers the structural parameters from the two arms", async () => {
    const econ = RACReplay.economics(await compare(12), 10)
    // w is a turn's worth of tool output, m is a stub plus the turn framing, and
    // the gap between them is what makes the crossover early.
    expect(econ.params.w).toBeGreaterThan(500)
    expect(econ.params.m).toBeLessThan(econ.params.w / 10)
    expect(econ.params.delta).toBeGreaterThan(0)
  })

  test("the closed form tracks the measured crossover", async () => {
    const econ = RACReplay.economics(await compare(20), 10)
    expect(econ.crossover).toBe(2)
    // The prediction is real-valued and the session can only cross at an integer
    // turn, so the ceiling is what has to match. It did not before the
    // requests-per-turn factor was restored to the denominator: every request
    // re-reads the cached prefix, so the payload saving accrues once per step
    // while the collapse penalty is paid once per turn.
    expect(Math.ceil(econ.predicted)).toBe(2)
  })

  test("counts every request in a turn, not just the turn", async () => {
    // A turn with more tool calls issues more requests, each re-reading the
    // prefix, so RAC pays off sooner rather than at the same point. Predicting
    // otherwise is the single-request model this replaces.
    const one = RACReplay.economics(await compare(20), 10)
    const busy = RACReplay.compare(
      await RACReplay.measure(conversationWith(20, 4), { label: "off", serialize }),
      await RACReplay.measure(conversationWith(20, 4), { label: "on", serialize, rac: options }),
    )
    expect(RACReplay.economics(busy, 10).predicted).toBeLessThan(one.predicted)
  })

  test("a higher price ratio pushes the crossover later and shrinks the saving", async () => {
    const result = await compare(20)
    const cheap = RACReplay.economics(result, 3)
    const dear = RACReplay.economics(result, 50)
    expect(dear.predicted).toBeGreaterThan(cheap.predicted)
    expect(dear.cost.savedPct).toBeLessThan(cheap.cost.savedPct)
  })

  test("the saving grows with conversation length", async () => {
    const short = RACReplay.economics(await compare(6), 10)
    const long = RACReplay.economics(await compare(30), 10)
    expect(long.cost.savedPct).toBeGreaterThan(short.cost.savedPct)
  })

  test("the recall budget grows with conversation length", async () => {
    // Tight early, generous later — which is why compulsive *early* recall is
    // the behaviour that would undo the saving, not recall as such.
    const short = RACReplay.economics(await compare(6), 10)
    const long = RACReplay.economics(await compare(30), 10)
    expect(long.recallBudget).toBeGreaterThan(short.recallBudget)
    expect(short.recallBudget).toBeGreaterThanOrEqual(0)
  })

  test("reports no crossover rather than a false one when there is none", async () => {
    const result = await compare(12)
    // Nothing collapses, so the arms are identical and neither is ever cheaper.
    const flat = RACReplay.compare(result.off, result.off)
    expect(RACReplay.economics(flat, 10).crossover).toBeUndefined()
    expect(
      RACReplay.render(flat, { sessionID: "s", model: "m", rac: options, economics: RACReplay.economics(flat, 10) }),
    ).toContain("never cheaper")
  })

  test("appears in the report only when a price is given", async () => {
    const result = await compare(8)
    const meta = { sessionID: "s", model: "m", rac: options }
    expect(RACReplay.render(result, meta)).not.toContain("billed cost")
    expect(RACReplay.render(result, { ...meta, economics: RACReplay.economics(result, 10) })).toContain("billed cost")
  })
})

describe("price ratio from published rates", () => {
  test("uses the cache write price where a provider charges for writes", () => {
    // Anthropic: writes at 1.25x base input, reads at 0.1x. A prefilled token is
    // stored for the next turn, so the write price is what it actually costs.
    expect(RACReplay.ratio({ input: 5, cache: { read: 0.5, write: 6.25 } })).toBe(12.5)
  })

  test("falls back to base input where writes are free", () => {
    // OpenAI does not charge for cache writes, so input over read is the ratio.
    expect(RACReplay.ratio({ input: 1.25, cache: { read: 0.125, write: 0 } })).toBe(10)
    expect(RACReplay.ratio({ input: 2.5, cache: { read: 1.25, write: 0 } })).toBe(2)
  })

  test("returns undefined rather than inventing a ratio", () => {
    // Local models carry zeroed costs. A fabricated ratio here would put a
    // fictional saving in the report.
    expect(RACReplay.ratio({ input: 0, cache: { read: 0, write: 0 } })).toBeUndefined()
    expect(RACReplay.ratio({ input: 5, cache: { read: 0, write: 0 } })).toBeUndefined()
    expect(RACReplay.ratio({ input: 0, cache: { read: 0.5, write: 0 } })).toBeUndefined()
  })
})

describe("economics block is always present", () => {
  const build = async () =>
    RACReplay.compare(
      await RACReplay.measure(conversation(10), { label: "off", serialize }),
      await RACReplay.measure(conversation(10), { label: "on", serialize, rac: options }),
    )
  const meta = { sessionID: "ses_1", model: "ollama/qwen3.5:9b", rac: options }

  test("says so when there is no price to apply", async () => {
    const report = RACReplay.render(await build(), meta)
    expect(report).toContain("no price information available")
    expect(report).toContain("--price k")
  })

  test("records where the ratio came from", async () => {
    const result = await build()
    expect(
      RACReplay.render(result, { ...meta, economics: RACReplay.economics(result, 12.5, "anthropic/claude-opus-5") }),
    ).toContain("k=12.5 from anthropic/claude-opus-5")
    expect(RACReplay.render(result, { ...meta, economics: RACReplay.economics(result, 20, "--price") })).toContain(
      "k=20 from --price",
    )
  })
})
