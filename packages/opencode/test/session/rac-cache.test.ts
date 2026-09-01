import { describe, expect, test } from "bun:test"
import { summarize } from "@/cli/cmd/debug/rac"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

function turn(
  id: string,
  tokens: { input: number; read: number; write: number; output?: number },
  parts: SessionV1.Part[] = [],
): SessionV1.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      tokens: {
        input: tokens.input,
        output: tokens.output ?? 0,
        reasoning: 0,
        cache: { read: tokens.read, write: tokens.write },
      },
    } as unknown as SessionV1.Info,
    parts,
  }
}

function toolPart(id: string, output: string): SessionV1.Part {
  return {
    id,
    type: "tool",
    callID: "c_" + id,
    tool: "read",
    state: { status: "completed", input: {}, output, title: "read", metadata: {}, time: { start: 0, end: 1 } },
  } as unknown as SessionV1.Part
}

describe("debug rac cache summary", () => {
  test("ignores user messages and assistant turns with no usage yet", () => {
    const msgs = [
      { info: { id: "u", role: "user" } as unknown as SessionV1.Info, parts: [] },
      { info: { id: "a0", role: "assistant" } as unknown as SessionV1.Info, parts: [] },
      turn("a1", { input: 10, read: 90, write: 0 }),
    ]
    expect(summarize(msgs).turns).toHaveLength(1)
  })

  test("totals across turns", () => {
    const summary = summarize([
      turn("a1", { input: 100, read: 0, write: 400, output: 5 }),
      turn("a2", { input: 20, read: 480, write: 0, output: 7 }),
    ])
    expect(summary.total).toEqual({ input: 120, cacheRead: 480, cacheWrite: 400, output: 12 })
  })

  test("hit rate counts cache writes as uncached", () => {
    // 480 read of 1000 billable input. Folding the 400 write in as a "hit"
    // would report 88% and hide exactly the thrash this is meant to catch.
    const summary = summarize([
      turn("a1", { input: 100, read: 0, write: 400 }),
      turn("a2", { input: 20, read: 480, write: 0 }),
    ])
    expect(summary.hitRate).toBeCloseTo(48.0, 1)
  })

  test("counts collapsed stubs by their address prefix", () => {
    const summary = summarize([
      turn("a1", { input: 1, read: 0, write: 0 }, [
        toolPart("p1", "[t1] read(a.ts) → 400 lines collapsed."),
        toolPart("p2", "real file content"),
        toolPart("p3", "[t2] read(b.ts) → 90 lines collapsed."),
      ]),
    ])
    expect(summary.turns[0].tools).toBe(3)
    expect(summary.turns[0].collapsed).toBe(2)
  })

  test("empty session reports a zero hit rate rather than dividing by zero", () => {
    const summary = summarize([])
    expect(summary.hitRate).toBe(0)
    expect(summary.total).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  })
})
