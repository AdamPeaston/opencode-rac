import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { RAC } from "@/session/rac"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import DESCRIPTION from "./remember.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({
    description: 'The address of the collapsed result, exactly as shown in its stub, e.g. "t14"',
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "1-indexed line to start from. Omit to return the whole result.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of lines to return, counting from offset.",
  }),
})

/**
 * Resolves an address against the session and renders the result.
 *
 * `messages` is `ctx.messages` — the same list the projection ran over, so
 * addresses resolve against exactly what the model was shown.
 */
export function respond(
  messages: SessionV1.WithParts[],
  params: { id: string; offset?: number; limit?: number },
): Tool.ExecuteResult {
  const found = RAC.lookup(messages, params.id)
  if ("near" in found) {
    // Deliberately not an error: a wrong address is a recoverable mistake, and
    // steering the model to a valid one costs less than a failed turn.
    const suggestion = found.near.length
      ? ` Nearest valid addresses: ${found.near.join(", ")}.`
      : " No collapsed results are available in this session yet."
    return {
      title: params.id,
      metadata: {},
      output: `No stored result with address "${params.id}".${suggestion}`,
    }
  }

  const sliced = RAC.slice(found.output, params.offset, params.limit)
  const total = found.output === "" ? 0 : found.output.split("\n").length
  const ranged = sliced.from !== 1 || sliced.to !== total
  return {
    title: `${found.id} (${found.part.tool})`,
    metadata: { tool: found.part.tool, from: sliced.from, to: sliced.to, total },
    output: [
      `Recalled ${found.id} — ${found.part.tool}` +
        (ranged ? `, lines ${sliced.from}-${sliced.to} of ${total}` : `, ${total} lines`) +
        ". Verbatim as originally produced; re-run the tool if the source may have changed since.",
      "",
      sliced.text,
    ].join("\n"),
  }
}

export const RememberTool = Tool.define(
  "remember",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { id: string; offset?: number; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Reads the full session rather than ctx.messages, which is the
          // compacted view. Compaction drops old turns from what the model sees
          // but deletes nothing, so recall can still reach past that horizon —
          // which is the point: compaction becomes recoverable rather than lossy.
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(ctx.messages)))
          return respond(messages, params)
        }),
    }
  }),
)
