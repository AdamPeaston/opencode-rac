import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

/**
 * Plan §3.4 declines any anti-thrash mechanism for `remember`, on the grounds
 * that "multiple `remember` calls in one turn are the canonical way to avoid
 * recall thrash… batching is already the answer, as it is for any other tool."
 *
 * That is an assumption about the harness, not a verified fact, and it is the
 * plan's only stated defence against recall thrash. This checks the half that
 * can be checked without a provider: whether opencode settles several tool
 * calls issued in one assistant turn. Whether a *model* chooses to batch
 * `remember` calls is behavioural and needs live traces.
 */

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

/** One step carrying three tool calls, as a batched recall turn would look. */
const batchedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        ...["call-1", "call-2", "call-3"].flatMap((id, index) => [
          LLMEvent.toolInputStart({ id, name: "remember" }),
          LLMEvent.toolInputEnd({ id, name: "remember" }),
          LLMEvent.toolCall({ id, name: "remember", input: { id: `t${index + 1}` }, providerExecuted: true }),
          LLMEvent.toolResult({
            id,
            name: "remember",
            result: { type: "text", value: `recalled t${index + 1}` },
            providerExecuted: true,
          }),
        ]),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [LLM.node, batchedLLM],
  ]),
)

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  } as SessionV1.User)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  } as SessionV1.Part)
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  rootDir: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: rootDir, root: rootDir },
    system: [],
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  } as SessionV1.Assistant
  yield* session.updateMessage(msg)
  return msg
})

it.live("settles every tool call issued in a single assistant turn", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const processors = yield* SessionProcessor.Service
        const provider = yield* Provider.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "recall three things")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "recall three things" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")

        // All three land as distinct completed tool parts, so a batched recall
        // turn is neither collapsed to one call nor dropped.
        expect(calls).toHaveLength(3)
        expect(calls.every((part) => part.state.status === "completed")).toBe(true)
        expect(calls.map((part) => part.callID)).toEqual(["call-1", "call-2", "call-3"])
      }),
    { config: cfg },
  ),
)
