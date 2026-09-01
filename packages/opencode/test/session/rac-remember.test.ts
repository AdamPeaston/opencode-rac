import { describe, expect, test } from "bun:test"
import { RAC } from "@/session/rac"
import { respond } from "@/tool/remember"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const big = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")

function tool(id: string, name: string, output: string, input: Record<string, unknown> = {}): SessionV1.ToolPart {
  return {
    id,
    type: "tool",
    callID: "call_" + id,
    tool: name,
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

const user = (id: string): SessionV1.WithParts => ({
  info: { id, role: "user" } as unknown as SessionV1.Info,
  parts: [],
})
const assistant = (id: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
  info: { id, role: "assistant" } as unknown as SessionV1.Info,
  parts,
})

const convo = () => [
  user("u0"),
  assistant("a0", [tool("p0", "read", big, { filePath: "src/a.ts" })]),
  user("u1"),
  assistant("a1", [tool("p1", "grep", big, { pattern: "foo" })]),
  user("u2"),
]

describe("RAC.lookup", () => {
  test("resolves an address to its verbatim stored output", () => {
    const found = RAC.lookup(convo(), "t1")
    expect("near" in found).toBe(false)
    if ("near" in found) return
    expect(found.output).toBe(big)
    expect(found.part.tool).toBe("read")
  })

  test("addresses survive collapse, so a stub can be recalled", () => {
    const msgs = convo()
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 0, minLinesToCollapse: 50, recallable: true })
    // The model sees the stub...
    const stub = (messages[1].parts[0] as SessionV1.ToolPart).state
    expect(stub.status === "completed" && stub.output).toContain('remember("t1")')
    // ...and recalling that address against stored state returns the original.
    const found = RAC.lookup(msgs, "t1")
    expect("near" in found ? null : found.output).toBe(big)
  })

  test("suggests nearest addresses for an unknown one", () => {
    const found = RAC.lookup(convo(), "t9")
    expect("near" in found && found.near).toEqual(["t2", "t1"])
  })

  test("suggests something for a malformed address rather than nothing", () => {
    const found = RAC.lookup(convo(), "banana")
    expect("near" in found && found.near.length).toBeGreaterThan(0)
  })

  test("is case and whitespace tolerant", () => {
    const found = RAC.lookup(convo(), "  T2 ")
    expect("near" in found ? null : found.part.tool).toBe("grep")
  })

  test("reports no addresses when the session has no tool calls", () => {
    expect(RAC.lookup([user("u0")], "t1")).toEqual({ near: [] })
  })
})

describe("RAC.slice", () => {
  test("returns everything when unbounded", () => {
    expect(RAC.slice(big).text).toBe(big)
    expect(RAC.slice(big).to).toBe(120)
  })

  test("extracts an inclusive 1-indexed range", () => {
    const sliced = RAC.slice(big, 3, 2)
    expect(sliced.text).toBe("line 2\nline 3")
    expect([sliced.from, sliced.to]).toEqual([3, 4])
  })

  test("clamps past the end instead of erroring", () => {
    const sliced = RAC.slice(big, 119, 50)
    expect(sliced.to).toBe(120)
    expect(sliced.text).toBe("line 118\nline 119")
  })

  test("clamps a zero or negative offset to the first line", () => {
    expect(RAC.slice(big, 0, 1).text).toBe("line 0")
    expect(RAC.slice(big, -5, 1).from).toBe(1)
  })
})

describe("stub recall hint", () => {
  test("only promises recall when the tool is available", () => {
    const msgs = convo()
    const without = RAC.project(msgs, { collapseAfterTurns: 0, minLinesToCollapse: 50 })
    const state = (without.messages[1].parts[0] as SessionV1.ToolPart).state
    expect(state.status === "completed" && state.output).not.toContain("remember(")
    expect(state.status === "completed" && state.output).toContain("no longer shown here")
  })
})

describe("remember tool output", () => {
  test("returns the verbatim result with a staleness caveat", () => {
    const result = respond(convo(), { id: "t1" })
    expect(result.title).toBe("t1 (read)")
    expect(result.metadata).toEqual({ tool: "read", from: 1, to: 120, total: 120 })
    // The body after the header line must be byte-identical to what was stored.
    expect(result.output.split("\n").slice(2).join("\n")).toBe(big)
    expect(result.output).toContain("re-run the tool if the source may have changed")
  })

  test("reports the range when only part was asked for", () => {
    const result = respond(convo(), { id: "t1", offset: 10, limit: 3 })
    expect(result.output).toContain("lines 10-12 of 120")
    expect(result.output.split("\n").slice(2).join("\n")).toBe("line 9\nline 10\nline 11")
  })

  test("guides the model back on a bad address instead of failing", () => {
    const result = respond(convo(), { id: "t99" })
    expect(result.output).toContain('No stored result with address "t99"')
    expect(result.output).toContain("Nearest valid addresses: t2, t1")
    expect(result.metadata).toEqual({})
  })

  test("says so plainly when nothing has been collapsed yet", () => {
    expect(respond([user("u0")], { id: "t1" }).output).toContain("No collapsed results are available")
  })
})

describe("recalled results re-collapse", () => {
  test("a remember result names the address it recalled", () => {
    // Otherwise a re-collapsed recall reads as a bare "remember" and the model
    // cannot tell which result it was looking at.
    const msgs = [
      user("u0"),
      assistant("a0", [tool("p0", "remember", big, { id: "t1" })]),
      user("u1"),
    ]
    const { messages } = RAC.project(msgs, { collapseAfterTurns: 0, minLinesToCollapse: 50, recallable: true })
    const state = (messages[1].parts[0] as SessionV1.ToolPart).state
    expect(state.status === "completed" && state.output).toContain("remember(t1)")
  })

  test("recalled content is subject to the same collapse rule", () => {
    const msgs = [
      user("u0"),
      assistant("a0", [tool("p0", "remember", big, { id: "t1" })]),
      user("u1"),
    ]
    expect(RAC.project(msgs, { collapseAfterTurns: 0, minLinesToCollapse: 50 }).stats.collapsed).toBe(1)
  })
})
