import { EOL } from "os"
import { Effect } from "effect"
import { NotFoundError } from "@/storage/storage"
import { RAC } from "@/session/rac"
import { RACReplay } from "@/session/rac-replay"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import { effectCmd } from "../../effect-cmd"

/**
 * Per-turn prompt-cache accounting for a session.
 *
 * RAC's central claim is about cache economics, so it has to be checked against
 * provider-reported numbers rather than the payload byte counts used during
 * development. Run the same task twice — once with `rac.enabled` off, once on —
 * and compare `cache hit rate` and the input/cache-write totals.
 *
 * Reads stored state only; safe to run against a live session.
 */

export interface Turn {
  turn: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  tools: number
  collapsed: number
}

export interface Summary {
  turns: Turn[]
  total: { input: number; cacheRead: number; cacheWrite: number; output: number }
  /** Share of billable input tokens served from cache. */
  hitRate: number
}

export function summarize(messages: SessionV1.WithParts[]): Summary {
  const turns = messages
    .flatMap((msg) => (msg.info.role === "assistant" && msg.info.tokens ? [{ msg, tokens: msg.info.tokens }] : []))
    .map(({ msg, tokens }, index) => {
      return {
        turn: index + 1,
        input: tokens.input ?? 0,
        cacheRead: tokens.cache?.read ?? 0,
        cacheWrite: tokens.cache?.write ?? 0,
        output: tokens.output ?? 0,
        tools: msg.parts.filter((part) => part.type === "tool").length,
        // A stub is recognisable by its leading address, so a session can be
        // audited after the fact without RAC needing to record anything extra.
        collapsed: msg.parts.filter(
          (part) => part.type === "tool" && part.state.status === "completed" && part.state.output.startsWith("[t"),
        ).length,
      }
    })

  const total = turns.reduce(
    (acc, turn) => ({
      input: acc.input + turn.input,
      cacheRead: acc.cacheRead + turn.cacheRead,
      cacheWrite: acc.cacheWrite + turn.cacheWrite,
      output: acc.output + turn.output,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  )

  // Cache writes count as served-but-uncached: they are fresh tokens this turn,
  // just priced differently. Folding them into the hit rate would flatter a
  // policy that thrashes the cache, which is exactly what this must detect.
  const served = total.cacheRead + total.cacheWrite + total.input
  return { turns, total, hitRate: served === 0 ? 0 : (100 * total.cacheRead) / served }
}

/**
 * Offline arm-vs-arm replay.
 *
 * Split out from the provider-counter path because it answers the same question
 * by different means: `summarize` reports what the provider billed, this reports
 * what the payloads imply. Where a provider reports cache counters, running both
 * and seeing them agree is the strongest evidence available; where it reports
 * none, this is the only evidence there is.
 */
const replay = Effect.fn("Cli.debug.rac.replay")(function* (input: {
  sessionID: string
  messages: SessionV1.WithParts[]
  rac: RAC.Options
  json: boolean
  price?: number
}) {
  const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
  const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
  const provider = yield* Provider.Service

  // Serialisation depends on the model — media handling and tool-result shape
  // both vary by provider — so replay the session against the model that
  // actually produced it, falling back to the default only for a session that
  // never got that far.
  const model = yield* Effect.gen(function* () {
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const info = input.messages[i].info as {
        role: string
        providerID?: ProviderV2.ID
        modelID?: ModelV2.ID
      }
      if (info.role !== "assistant" || !info.providerID || !info.modelID) continue
      const found = yield* provider.getModel(info.providerID, info.modelID).pipe(Effect.option)
      if (found._tag === "Some") return found.value
    }
    const fallback = yield* provider.defaultModel()
    return yield* provider.getModel(fallback.providerID, fallback.modelID)
  }).pipe(Effect.option)

  if (model._tag === "None") {
    process.stderr.write("could not resolve a model to serialise against" + EOL)
    return
  }

  const serialize = (context: SessionV1.WithParts[]) =>
    MessageV2.toModelMessages(context, model.value).then((msgs) => JSON.stringify(msgs))

  const [off, on] = yield* Effect.promise(() =>
    Promise.all([
      RACReplay.measure(input.messages, { label: "rac off", serialize }),
      RACReplay.measure(input.messages, { label: "rac on", serialize, rac: input.rac }),
    ]),
  )
  const result = RACReplay.compare(off, on)

  // An explicit --price wins, otherwise take the model's own published rates.
  // Falling back to the catalog rather than to a constant is what keeps this
  // honest: the ratio differs six-fold across models still in service, so a
  // fixed default would silently misprice most sessions, while the catalog
  // prices each one against what it actually cost. Where the catalog has no
  // cache rate — local models — nothing is invented and the report says so.
  const derived = RACReplay.ratio(model.value.cost)
  const k = input.price ?? derived
  const economics =
    k === undefined
      ? undefined
      : RACReplay.economics(
          result,
          k,
          input.price === undefined ? `${model.value.providerID}/${model.value.id}` : "--price",
        )

  if (input.json) {
    process.stdout.write(
      JSON.stringify({ sessionID: input.sessionID, rac: input.rac, ...result, economics }, null, 2) + EOL,
    )
    return
  }

  process.stdout.write(
    RACReplay.render(result, {
      sessionID: input.sessionID,
      model: `${model.value.providerID}/${model.value.id}`,
      rac: input.rac,
      economics,
    }),
  )
})

export const RacCommand = effectCmd({
  command: "rac [sessionID]",
  describe: "show per-turn prompt cache usage for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { type: "string", describe: "session to inspect (defaults to the most recent)" })
      .option("json", { type: "boolean", describe: "emit raw JSON instead of a table" })
      .option("replay", {
        type: "boolean",
        describe: "derive prefix reuse offline instead of reading provider counters",
      })
      .option("price", {
        type: "number",
        describe: "prefill/cached-read cost ratio; defaults to the model's published rates",
      }),
  handler: Effect.fn("Cli.debug.rac")(function* (args) {
    const { Session } = yield* Effect.promise(() => import("@/session/session"))
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const svc = yield* Session.Service
    const config = yield* Config.Service.use((cfg) => cfg.get())

    const sessionID = yield* Effect.gen(function* () {
      if (args.sessionID) return args.sessionID
      const sessions = yield* svc.list()
      return sessions.sort((a, b) => b.time.updated - a.time.updated)[0]?.id
    })
    if (!sessionID) {
      process.stderr.write("no sessions found" + EOL)
      return
    }

    const messages = yield* svc
      .messages({ sessionID })
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))

    if (args.replay) {
      // Deliberately independent of `rac.enabled`: the point is to replay a
      // session recorded either way and see what the other arm would have cost.
      yield* replay({
        sessionID,
        messages,
        json: args.json ?? false,
        price: args.price,
        rac: {
          collapseAfterTurns: config.rac?.collapse_after_turns ?? RAC.DEFAULTS.collapseAfterTurns,
          minLinesToCollapse: config.rac?.min_lines_to_collapse ?? RAC.DEFAULTS.minLinesToCollapse,
          recallable: true,
        },
      })
      return
    }

    const summary = summarize(messages)

    if (args.json) {
      process.stdout.write(JSON.stringify({ sessionID, rac: config.rac ?? null, ...summary }, null, 2) + EOL)
      return
    }

    const pad = (value: string | number, width: number) => String(value).padStart(width)
    process.stdout.write(`session ${sessionID}` + EOL)
    process.stdout.write(
      `rac ${config.rac?.enabled ? "enabled" : "disabled"}` +
        (config.rac?.enabled
          ? ` (collapse_after_turns=${config.rac.collapse_after_turns ?? 0}, min_lines_to_collapse=${config.rac.min_lines_to_collapse ?? 50})`
          : "") +
        EOL +
        EOL,
    )
    process.stdout.write(
      ["turn", "input", "cache rd", "cache wr", "output", "tools", "stubs"]
        .map((head, i) => pad(head, i === 0 ? 5 : 9))
        .join("") + EOL,
    )
    for (const turn of summary.turns) {
      process.stdout.write(
        pad(turn.turn, 5) +
          pad(turn.input, 9) +
          pad(turn.cacheRead, 9) +
          pad(turn.cacheWrite, 9) +
          pad(turn.output, 9) +
          pad(turn.tools, 9) +
          pad(turn.collapsed, 9) +
          EOL,
      )
    }
    process.stdout.write(EOL)
    process.stdout.write(
      `totals  input=${summary.total.input}  cache read=${summary.total.cacheRead}  cache write=${summary.total.cacheWrite}  output=${summary.total.output}` +
        EOL,
    )
    process.stdout.write(`cache hit rate  ${summary.hitRate.toFixed(1)}% of input tokens served from cache` + EOL)
  }),
})
