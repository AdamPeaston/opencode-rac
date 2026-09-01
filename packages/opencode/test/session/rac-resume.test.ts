import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { RAC } from "@/session/rac"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * RAC addresses are derived from position in the message list, so they are only
 * trustworthy if reading a session back produces the same ordering every time.
 * In Phase 1 a wrong address was cosmetic; with `remember` it sends the model to
 * the wrong content, so this is exercised against the real database rather than
 * synthetic arrays.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const big = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, time: number) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: "go" })
  return id
})

/** An assistant turn carrying `count` completed tool results. */
const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  time: number,
  count: number,
  tool = "read",
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    parentID,
    role: "assistant",
    time: { created: time, completed: time + 1 },
    system: [],
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    agent: "test",
    mode: "",
    finish: "stop",
  } as unknown as SessionV1.Info)
  for (let i = 0; i < count; i++) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "tool",
      callID: `call_${id}_${i}`,
      tool,
      state: {
        status: "completed",
        input: { filePath: `src/f${i}.ts` },
        output: big,
        title: tool,
        metadata: {},
        time: { start: time, end: time + 1 },
      },
    } as unknown as SessionV1.Part)
  }
  return id
})

/** Builds a session of `turns` turns, each one user message + one tool call. */
const build = Effect.fn("Test.build")(function* (sessionID: SessionID, turns: number) {
  const base = Date.now()
  for (let i = 0; i < turns; i++) {
    const user = yield* addUser(sessionID, base + i * 10)
    yield* addAssistant(sessionID, user, base + i * 10 + 1, 1)
  }
})

const addresses = (msgs: SessionV1.WithParts[]) => Array.from(RAC.identify(msgs).values())

describe("RAC address stability across resume", () => {
  it.instance("assigns identical addresses on a fresh read of the same session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* build(sessionID, 6)
        // Two independent reads, as a resume would do.
        const first = yield* MessageV2.filterCompactedEffect(sessionID)
        const second = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(addresses(first)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"])
        expect(addresses(second)).toEqual(addresses(first))
        // And each address must still point at the same tool call.
        for (const id of addresses(first)) {
          const a = RAC.lookup(first, id)
          const b = RAC.lookup(second, id)
          expect("near" in a ? null : a.part.callID).toBe("near" in b ? null : b.part.callID)
        }
      }),
    ))

  it.instance("does not renumber existing addresses when the conversation grows", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* build(sessionID, 4)
        const before = yield* MessageV2.filterCompactedEffect(sessionID)
        const target = RAC.lookup(before, "t2")
        expect("near" in target).toBe(false)

        // Continue the session, as resuming and carrying on would.
        const base = Date.now() + 10_000
        const user = yield* addUser(sessionID, base)
        yield* addAssistant(sessionID, user, base + 1, 1)

        const after = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(addresses(after)).toEqual(["t1", "t2", "t3", "t4", "t5"])
        // t2 must still resolve to exactly the same tool call it did before.
        const still = RAC.lookup(after, "t2")
        expect("near" in still ? null : still.part.callID).toBe("near" in target ? null : target.part.callID)
      }),
    ))

  it.instance("numbers multiple tool calls within one turn by stored part order", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const base = Date.now()
        const user = yield* addUser(sessionID, base)
        yield* addAssistant(sessionID, user, base + 1, 3)
        const first = yield* MessageV2.filterCompactedEffect(sessionID)
        const second = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(addresses(first)).toEqual(["t1", "t2", "t3"])
        expect(addresses(second)).toEqual(addresses(first))
      }),
    ))

  it.instance("keeps a stub's address resolvable after the projection that produced it", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* build(sessionID, 5)
        const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
        const { messages } = RAC.project(msgs, {
          collapseAfterTurns: 0,
          minLinesToCollapse: 50,
          recallable: true,
        })
        // Pull an address out of a rendered stub the way the model would.
        const stubbed = messages
          .flatMap((m) => m.parts)
          .flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.output] : []))
          .find((output) => output.startsWith("[t"))
        const id = stubbed?.match(/^\[(t\d+)\]/)?.[1]
        expect(id).toBeDefined()

        // A later read must resolve that address to the full original output.
        const reread = yield* MessageV2.filterCompactedEffect(sessionID)
        const found = RAC.lookup(reread, id!)
        expect("near" in found ? null : found.output).toBe(big)
      }),
    ))
})

/**
 * Addresses are relative to the projected view, not absolute within a session.
 * That is fine while the view only ever grows by appending — which is the case
 * with RAC on, since it forces compaction.auto and compaction.prune off. But the
 * manual /compact path (ACP `compact`, session.summarize) is not gated by
 * compaction.auto, and it truncates history, which renumbers everything.
 *
 * Pinned here so the limitation is a known, tested behaviour rather than a
 * surprise. If compaction is ever allowed alongside RAC, addresses must be
 * persisted at assignment instead of derived from position (plan §3.1).
 */
const bigFixture = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")

const p = (mid: string, pid: string) => ({ id: pid, sessionID: "s", messageID: mid })
const uinfo = (id: string, t: number) => ({ id, sessionID: "s", role: "user", time: { created: t } })
const ainfo = (id: string, parent: string, t: number, extra: object = {}) => ({
  id,
  sessionID: "s",
  role: "assistant",
  parentID: parent,
  time: { created: t, completed: t + 1 },
  finish: "stop",
  ...extra,
})
const toolPart = (mid: string, pid: string, i: number) => ({
  ...p(mid, pid),
  type: "tool",
  callID: `c${i}`,
  tool: "read",
  state: {
    status: "completed",
    input: { filePath: `f${i}.ts` },
    output: bigFixture,
    title: "read",
    metadata: {},
    time: { start: 0, end: 1 },
  },
})

/** Three tool results, then a compaction retaining only the last turn. */
const chronologicalFixture = () =>
  [
    { info: uinfo("u0", 10), parts: [{ ...p("u0", "x"), type: "text", text: "a" }] },
    { info: ainfo("a0", "u0", 11), parts: [toolPart("a0", "pa0", 0)] },
    { info: uinfo("u1", 20), parts: [{ ...p("u1", "x"), type: "text", text: "b" }] },
    { info: ainfo("a1", "u1", 21), parts: [toolPart("a1", "pa1", 1)] },
    { info: uinfo("u2", 30), parts: [{ ...p("u2", "x"), type: "text", text: "c" }] },
    { info: ainfo("a2", "u2", 31), parts: [toolPart("a2", "pa2", 2)] },
    { info: uinfo("uc", 40), parts: [{ ...p("uc", "x"), type: "compaction", auto: true, tail_start_id: "u2" }] },
    { info: ainfo("as", "uc", 41, { summary: true }), parts: [] },
  ] as unknown as SessionV1.WithParts[]

describe("RAC addresses under compaction", () => {
  const chronological = chronologicalFixture()

  test("compaction truncates history and renumbers the view", () => {
    expect(addresses(chronological)).toEqual(["t1", "t2", "t3"])

    // stream() yields newest-first; filterCompacted reverses internally.
    const filtered = MessageV2.filterCompacted([...chronological].reverse())

    // Only the retained tail survives, and it is renumbered from t1.
    expect(addresses(filtered)).toEqual(["t1"])
    const found = RAC.lookup(filtered, "t1")
    expect("near" in found ? null : found.part.callID).toBe("c2")

    // The pre-compaction address the model used to see is simply gone, and the
    // nearest-match path is what catches it.
    expect(RAC.lookup(filtered, "t3")).toEqual({ near: ["t1"] })
  })

  test("stub and lookup still agree, because both read the same view", () => {
    // The property that keeps `remember` correct in practice: whatever list the
    // projection numbered is the list ctx.messages hands to the tool.
    // Needs a turn after the compaction, or the sole survivor is the newest
    // turn and correctly stays verbatim.
    const continued = [
      ...chronological,
      { info: uinfo("u3", 50), parts: [{ ...p("u3", "x"), type: "text", text: "d" }] },
      { info: ainfo("a3", "u3", 51), parts: [toolPart("a3", "pa3", 3)] },
    ] as unknown as SessionV1.WithParts[]
    const filtered = MessageV2.filterCompacted([...continued].reverse())
    const { messages } = RAC.project(filtered, {
      collapseAfterTurns: 0,
      minLinesToCollapse: 50,
      recallable: true,
    })
    const rendered = messages
      .flatMap((m) => m.parts)
      .flatMap((part) => (part.type === "tool" && part.state.status === "completed" ? [part.state.output] : []))
      .find((output) => output.startsWith("[t"))
    const id = rendered?.match(/^\[(t\d+)\]/)?.[1]
    const found = RAC.lookup(filtered, id!)
    expect("near" in found ? null : found.output).toBe(bigFixture)
  })
})

/**
 * Compaction removes turns from the model's view but deletes nothing. Because
 * addresses are numbered over the whole stored session rather than the visible
 * view, they survive that truncation and `remember` can still reach past the
 * horizon — which turns compaction from lossy into recoverable.
 */
describe("RAC reaches past the compaction horizon", () => {
  const archive = () => chronologicalFixture()

  test("addresses are stable when numbered over the archive, not the view", () => {
    const full = archive()
    const view = MessageV2.filterCompacted([...full].reverse())

    // Numbered over the view, the survivor is renamed t1 — the old bug.
    expect(addresses(view)).toEqual(["t1"])

    // Numbered over the archive, it keeps the name the model already saw.
    const ids = RAC.identify(full)
    const survivor = view.flatMap((m) => m.parts).find((p) => p.type === "tool")
    expect(ids.get(survivor!.id)).toBe("t3")
  })

  test("the projection stubs the view using archive addresses", () => {
    const full = archive()
    const view = MessageV2.filterCompacted([...full].reverse())
    const continued = [
      ...view,
      { info: { id: "u9", role: "user" } as unknown as SessionV1.Info, parts: [] },
      {
        info: { id: "a9", role: "assistant" } as unknown as SessionV1.Info,
        parts: [] as SessionV1.Part[],
      },
    ]
    const { messages } = RAC.project(continued, {
      collapseAfterTurns: 0,
      minLinesToCollapse: 50,
      recallable: true,
      archive: full,
    })
    const rendered = messages
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.output] : []))
      .find((o) => o.startsWith("[t"))
    // Not [t1]: the address matches the archive, so it stays dereferenceable.
    expect(rendered).toContain("[t3]")
  })

  test("remember retrieves a result compaction dropped from view", () => {
    const full = archive()
    const view = MessageV2.filterCompacted([...full].reverse())

    // Resolved against the view, "t1" silently returns the WRONG result — the
    // surviving tail renumbered into the slot the first result used to hold.
    const wrong = RAC.lookup(view, "t1")
    expect("near" in wrong ? null : wrong.part.callID).toBe("c2")

    // Resolved against the archive, it returns what the model was actually
    // shown as t1, verbatim, even though compaction removed it from view.
    const right = RAC.lookup(full, "t1")
    expect("near" in right ? null : right.part.callID).toBe("c0")
    expect("near" in right ? null : right.output).toBe(bigFixture)
  })

  test("grep_memory finds matches inside pre-horizon results", () => {
    const full = archive()
    const result = RAC.search(full, { pattern: "line 7$" })
    if ("error" in result) throw new Error("unexpected")
    // All three results are searchable, including the two compaction removed.
    expect(result.matches.map((m) => m.id)).toEqual(["t1", "t2", "t3"])
  })
})
