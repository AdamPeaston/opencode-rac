import { describe, expect, test } from "bun:test"
import { RAC } from "@/session/rac"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const big = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")
const small = "line 0\nline 1"

function tool(id: string, name: string, output: string, input: Record<string, unknown> = {}): SessionV1.ToolPart {
  return {
    id,
    type: "tool",
    callID: "call_" + id,
    tool: name,
    sessionID: "ses_1",
    messageID: "msg_1",
    state: {
      status: "completed",
      input,
      output,
      title: name,
      metadata: {},
      time: { start: 0, end: 1 },
    },
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

/** N complete turns, each a user message followed by one big-output tool call. */
function conversation(turns: number) {
  return Array.from({ length: turns }, (_, i) => [
    user("msg_u" + i),
    assistant("msg_a" + i, [tool("prt_t" + i, "read", big, { filePath: `src/f${i}.ts` })]),
  ]).flat()
}

const outputs = (msgs: readonly SessionV1.WithParts[]) =>
  msgs.flatMap((m) =>
    m.parts.flatMap((p) => {
      if (p.type !== "tool") return []
      const state = (p as SessionV1.ToolPart).state
      return state.status === "completed" ? [state.output] : []
    }),
  )

describe("RAC defaults", () => {
  test("collapses one user turn back, keeping cache cost at append-only levels", () => {
    // Deliberate: re-prefill scales as (collapseAfterTurns + 1) x turn size, so
    // anything above 0 permanently costs cache on every turn. Raising this is a
    // measurable regression, not a preference.
    expect(RAC.DEFAULTS.collapseAfterTurns).toBe(0)
    expect(RAC.DEFAULTS.minLinesToCollapse).toBe(50)
  })

  test("still keeps the whole current agentic loop verbatim", () => {
    // Many tool calls inside one user turn must all survive, or read-then-edit
    // breaks within a single turn.
    const msgs = [
      user("msg_u0"),
      assistant("msg_a0", [tool("prt_t0", "read", big), tool("prt_t1", "read", big)]),
    ]
    expect(RAC.project(msgs).stats.collapsed).toBe(0)
  })

  test("collapses as soon as the next user turn arrives", () => {
    const msgs = [user("msg_u0"), assistant("msg_a0", [tool("prt_t0", "read", big)]), user("msg_u1")]
    expect(RAC.project(msgs).stats.collapsed).toBe(1)
  })
})

describe("RAC.project", () => {
  test("keeps recent turns verbatim and collapses older ones", () => {
    const msgs = conversation(5)
    const { messages, stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })

    // Turn 4 produced the newest result; turns 4, 3 and 2 stay verbatim
    // (producing turn plus two following), so turns 1 and 0 collapse.
    expect(stats.collapsed).toBe(2)
    const result = outputs(messages)
    expect(result.slice(0, 2).every((o) => o.startsWith("[t"))).toBe(true)
    expect(result.slice(2)).toEqual([big, big, big])
  })

  test("does not mutate stored parts", () => {
    const msgs = conversation(5)
    const snapshot = JSON.stringify(msgs)
    RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(JSON.stringify(msgs)).toBe(snapshot)
  })

  test("passes through untouched messages by reference", () => {
    const msgs = conversation(5)
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    // Recent turns collapse nothing, so they are the same objects. So is the
    // leading user message, which holds no tool parts at all.
    expect(messages[messages.length - 1]).toBe(msgs[msgs.length - 1])
    expect(messages[0]).toBe(msgs[0])
    // The assistant message whose tool result collapsed must be a fresh object.
    expect(messages[1]).not.toBe(msgs[1])
  })

  test("leaves results below the line threshold verbatim", () => {
    const msgs = [
      user("msg_u0"),
      assistant("msg_a0", [tool("prt_t0", "read", small)]),
      user("msg_u1"),
      assistant("msg_a1", [tool("prt_t1", "read", big)]),
      user("msg_u2"),
      user("msg_u3"),
      user("msg_u4"),
    ]
    const { messages, stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(stats.collapsed).toBe(1)
    expect(outputs(messages)[0]).toBe(small)
  })

  test("assigns sequential ids in tool-call order", () => {
    const msgs = conversation(5)
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    const stubs = outputs(messages).filter((o) => o.startsWith("[t"))
    // IDs count every tool call in the session, not just collapsed ones, so the
    // two oldest results are t1 and t2.
    expect(stubs).toHaveLength(2)
    expect(stubs[0]).toContain("[t1]")
    expect(stubs[1]).toContain("[t2]")
  })

  test("stub names the tool and its identifying argument", () => {
    const msgs = conversation(5)
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(outputs(messages)[0]).toContain("read(src/f0.ts)")
    expect(outputs(messages)[0]).toContain("120 lines")
  })

  test("never collapses protected tools", () => {
    const msgs = conversation(5)
    const target = msgs[1].parts[0] as SessionV1.ToolPart
    ;(target as { tool: string }).tool = "skill"
    // Would otherwise be one of the two collapsed results.
    const { stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(stats.collapsed).toBe(1)
  })

  test("leaves parts already cleared by compaction alone", () => {
    const msgs = conversation(5)
    const target = msgs[1].parts[0] as SessionV1.ToolPart
    if (target.state.status === "completed") target.state.time.compacted = 1
    const { messages, stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(stats.collapsed).toBe(1)
    // Left for compaction's own "[Old tool result content cleared]" path.
    expect(outputs(messages)[0]).toBe(big)
  })

  test("is a no-op when nothing is old enough", () => {
    const msgs = conversation(2)
    const { messages, stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(stats.collapsed).toBe(0)
    expect(messages).toBe(msgs)
  })

  test("reports tokens saved net of stub cost", () => {
    const msgs = conversation(5)
    const { stats } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    expect(stats.saved).toBeGreaterThan(0)
    expect(stats.saved).toBeLessThan(3 * Math.ceil(big.length / 4))
  })

  test("drops attachments from collapsed results", () => {
    const msgs = conversation(5)
    const target = msgs[1].parts[0] as SessionV1.ToolPart
    if (target.state.status === "completed")
      target.state.attachments = [{ mime: "image/png", url: "data:image/png;base64,AAAA" } as never]
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 2, minLinesToCollapse: 50 })
    const collapsed = messages[1].parts[0] as SessionV1.ToolPart
    expect(collapsed.state.status === "completed" && collapsed.state.attachments).toEqual([])
  })
})
