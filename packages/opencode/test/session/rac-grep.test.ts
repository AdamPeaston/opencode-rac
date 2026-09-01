import { describe, expect, test } from "bun:test"
import { RAC } from "@/session/rac"
import { respond as grepMemory } from "@/tool/grep_memory"
import { respond as remember } from "@/tool/remember"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const logOutput = [
  "starting server",
  "listening on 5432",
  "Error: connect ECONNREFUSED 127.0.0.1:5432",
  "retrying in 2s",
  ...Array.from({ length: 60 }, (_, i) => `noise ${i}`),
].join("\n")

const configOutput = ["# retries on ECONNREFUSED", "retries = 3", ...Array.from({ length: 60 }, (_, i) => `k${i} = ${i}`)].join(
  "\n",
)

function tool(id: string, name: string, output: string, input: Record<string, unknown> = {}): SessionV1.ToolPart {
  return {
    id,
    type: "tool",
    callID: "call_" + id,
    tool: name,
    state: { status: "completed", input, output, title: name, metadata: {}, time: { start: 0, end: 1 } },
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

const convo = (): SessionV1.WithParts[] => [
  user("u0"),
  assistant("a0", [tool("p0", "shell", logOutput, { command: "npm start" })]),
  user("u1"),
  assistant("a1", [tool("p1", "read", configOutput, { filePath: "app.toml" })]),
  user("u2"),
]

describe("RAC.search", () => {
  test("finds matches across results and reports where, not what", () => {
    const result = RAC.search(convo(), { pattern: "ECONNREFUSED" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.matches).toEqual([
      { id: "t1", tool: "shell", line: 3, text: "Error: connect ECONNREFUSED 127.0.0.1:5432" },
      { id: "t2", tool: "read", line: 1, text: "# retries on ECONNREFUSED" },
    ])
    expect(result.scanned).toBe(2)
  })

  test("line numbers are 1-indexed and line up with remember's offset", () => {
    const found = RAC.search(convo(), { pattern: "ECONNREFUSED" })
    if ("error" in found) throw new Error("unexpected")
    const match = found.matches[0]
    const recalled = remember(convo(), { id: match.id, offset: match.line, limit: 1 })
    expect(recalled.output).toContain(match.text)
  })

  test("is case-insensitive by default and exact on request", () => {
    const loose = RAC.search(convo(), { pattern: "econnrefused" })
    const strict = RAC.search(convo(), { pattern: "econnrefused", caseSensitive: true })
    expect("error" in loose ? -1 : loose.matches.length).toBe(2)
    expect("error" in strict ? -1 : strict.matches.length).toBe(0)
  })

  test("scopes to a single result when given an id", () => {
    const result = RAC.search(convo(), { pattern: "ECONNREFUSED", id: "t2" })
    if ("error" in result) throw new Error("unexpected")
    expect(result.matches.map((m) => m.id)).toEqual(["t2"])
    expect(result.scanned).toBe(1)
  })

  test("caps results and says so", () => {
    const result = RAC.search(convo(), { pattern: "noise", limit: 5 })
    if ("error" in result) throw new Error("unexpected")
    expect(result.matches).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })

  test("does not report truncation when everything fit", () => {
    const result = RAC.search(convo(), { pattern: "ECONNREFUSED", limit: 50 })
    expect("error" in result ? true : result.truncated).toBe(false)
  })

  test("returns an error for an invalid regex rather than throwing", () => {
    const result = RAC.search(convo(), { pattern: "(unclosed" })
    expect("error" in result).toBe(true)
  })

  test("searches collapsed results, which is the point", () => {
    const msgs = convo()
    const { messages, stats } = RAC.project(msgs, {
      collapseAfterTurns: 0,
      minLinesToCollapse: 50,
      recallable: true,
    })
    expect(stats.collapsed).toBe(2)
    // The model can no longer see the content...
    const visible = JSON.stringify(messages)
    expect(visible).not.toContain("ECONNREFUSED")
    // ...but it is still findable against stored state.
    const result = RAC.search(msgs, { pattern: "ECONNREFUSED" })
    expect("error" in result ? -1 : result.matches.length).toBe(2)
  })

  test("ignores non-tool parts and incomplete calls", () => {
    const msgs: SessionV1.WithParts[] = [
      user("u0"),
      assistant("a0", [
        { id: "px", type: "text", text: "ECONNREFUSED in prose" } as unknown as SessionV1.Part,
        { id: "py", type: "tool", callID: "c", tool: "shell", state: { status: "running", input: {} } } as unknown as SessionV1.Part,
      ]),
    ]
    const result = RAC.search(msgs, { pattern: "ECONNREFUSED" })
    expect("error" in result ? -1 : result.matches.length).toBe(0)
  })
})

describe("grep_memory tool output", () => {
  test("returns addresses and line numbers, never the surrounding content", () => {
    const result = grepMemory(convo(), { pattern: "ECONNREFUSED" })
    expect(result.output).toContain("[t1] shell, line 3:")
    expect(result.output).toContain("[t2] read, line 1:")
    // The two-stage split: the matching line is echoed, but nothing around it.
    expect(result.output).not.toContain("retrying in 2s")
    expect(result.output).not.toContain("starting server")
    expect(result.output).toContain("Use remember(id)")
  })

  test("search cost is bounded while recall cost scales with the result", () => {
    // The reason grep_memory and remember are separate tools. The saving is
    // proportional to how large the source is: against a huge result, locating
    // a match costs a tiny fraction of pulling it back.
    const huge = Array.from({ length: 20_000 }, (_, i) => `line ${i} filler`).join("\n") + "\nNEEDLE here"
    const msgs = [user("u0"), assistant("a0", [tool("p0", "shell", huge, { command: "x" })]), user("u1")]
    const search = grepMemory(msgs, { pattern: "NEEDLE" })
    const everything = remember(msgs, { id: "t1" })
    expect(search.output.length).toBeLessThan(everything.output.length / 100)
  })

  test("a broad pattern against a small result is not a saving, and is capped", () => {
    // Honest limitation: N matches cost ~N lines, so a broad search over a
    // small result can exceed simply recalling it. The cap bounds the damage
    // and the footer tells the model to narrow instead.
    const search = grepMemory(convo(), { pattern: "noise" })
    expect(search.metadata.matches).toBe(20)
    expect(search.output).toContain("Narrow the pattern")
  })

  test("tells the model to narrow rather than to raise the cap", () => {
    const result = grepMemory(convo(), { pattern: "noise", limit: 3 })
    expect(result.output).toContain("truncated")
    expect(result.output).toContain("Narrow the pattern")
    expect(result.metadata.truncated).toBe(true)
  })

  test("reports a clean miss with the scope it searched", () => {
    const result = grepMemory(convo(), { pattern: "zzz-not-present" })
    expect(result.output).toContain("No matches")
    expect(result.output).toContain("2 stored results")
    expect(result.metadata.matches).toBe(0)
  })

  test("explains an invalid pattern instead of failing the turn", () => {
    const result = grepMemory(convo(), { pattern: "(unclosed" })
    expect(result.output).toContain("Invalid regular expression")
    expect(result.metadata.matches).toBe(0)
  })

  test("requires a pattern", () => {
    expect(grepMemory(convo(), { pattern: "" }).output).toBe("pattern is required")
  })
})

describe("search then recall", () => {
  test("the full loop: locate an exact string, then pull only its neighbourhood", () => {
    const msgs = convo()
    const search = RAC.search(msgs, { pattern: "ECONNREFUSED", id: "t1" })
    if ("error" in search) throw new Error("unexpected")
    const hit = search.matches[0]

    const recalled = remember(msgs, { id: hit.id, offset: hit.line - 1, limit: 3 })
    expect(recalled.output).toContain("listening on 5432")
    expect(recalled.output).toContain("Error: connect ECONNREFUSED")
    expect(recalled.output).toContain("retrying in 2s")
    // Three lines, not the whole 64-line log.
    expect(recalled.output).not.toContain("noise 59")
  })
})
