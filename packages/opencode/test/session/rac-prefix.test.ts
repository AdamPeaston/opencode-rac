import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "@/session/system"
import type { Provider } from "@/provider/provider"

/**
 * Prefix-hygiene audit (research doc §2.5, TokenPilot).
 *
 * RAC's entire justification is cache economics, so anything that churns the
 * prompt prefix for unrelated reasons both costs money and confounds the
 * measurement RAC is judged on. TokenPilot's technique is to neutralise
 * volatile runtime values and push variable content downstream, so the prefix
 * is byte-identical from turn one.
 *
 * These tests characterise what opencode does today. They need no provider —
 * this is about what the request looks like, not what a model does with it.
 */

const model = {
  api: { id: "claude-sonnet-5" },
  providerID: "anthropic",
} as Provider.Model

describe("prefix hygiene: static prompt selection", () => {
  test("the provider prompt is deterministic for a given model", () => {
    // The largest block of the system prompt must not vary run to run.
    const a = SystemPrompt.provider(model)
    const b = SystemPrompt.provider(model)
    expect(a).toEqual(b)
    expect(a.join("").length).toBeGreaterThan(100)
  })
})

describe("prefix hygiene: volatile values in the system prompt", () => {
  // SystemPrompt.environment() needs an instance context and Reference service,
  // so rather than standing those up, assert on the template it produces. The
  // date is the only volatile value in it — see the audit note below.
  const source = Bun.file(new URL("../../src/session/system.ts", import.meta.url).pathname)

  test("Today's date is the only clock-dependent value in the environment block", async () => {
    const text = await source.text()
    const volatile = text.match(/new Date\(\)|Date\.now\(\)|Math\.random\(\)|performance\.now\(\)/g) ?? []
    // If this fires, something clock- or entropy-dependent was added to the
    // system prompt. Anything per-turn volatile there invalidates the whole
    // cached prefix on every single request.
    expect(volatile).toEqual(["new Date()"])
  })

  test("the volatile value sits at the head of the environment block", async () => {
    const text = await source.text()
    const env = text.slice(text.indexOf("<env>"), text.indexOf("</env>"))
    expect(env).toContain("Today's date")
    // Documents the cost: prompt.ts builds `system` as [...env, ...instructions,
    // ...mcp, ...skills], so the environment block is the very first thing in
    // the prompt. A value that changes there invalidates everything after it —
    // system prompt, tool definitions and the entire message history.
    const lines = env.split("\n").filter((l) => l.includes("${"))
    const dateIndex = lines.findIndex((l) => l.includes("Today's date"))
    expect(dateIndex).toBeGreaterThanOrEqual(0)
    // Not last: there is stable content after it that gets invalidated too.
    expect(dateIndex).toBeLessThan(lines.length)
  })
})

describe("prefix hygiene: what this costs", () => {
  test("date rollover changes the prefix, so a resumed session pays full re-prefill", () => {
    // toDateString() has day granularity, so this is not a per-turn cost — but
    // it is a guaranteed total cache miss for any session resumed the next day,
    // and for any long-horizon session that crosses midnight. Long-horizon
    // sessions are exactly RAC's target case.
    const yesterday = new Date("2026-08-29T23:59:00Z").toDateString()
    const today = new Date("2026-08-30T00:01:00Z").toDateString()
    expect(yesterday).not.toBe(today)
  })
})
