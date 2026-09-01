import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { RAC } from "@/session/rac"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import DESCRIPTION from "./grep_memory.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Regular expression to search for. Case-insensitive unless case_sensitive is set.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: 'Restrict the search to a single stored result, e.g. "t14". Omit to search all of them.',
  }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({
    description: "Match case exactly. Defaults to false.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum matches to return (default 20).",
  }),
})

type Params = { pattern: string; id?: string; case_sensitive?: boolean; limit?: number }

/** Renders search results as addresses and line numbers only — never content. */
export function respond(messages: SessionV1.WithParts[], params: Params): Tool.ExecuteResult {
  if (!params.pattern) {
    return { title: "", metadata: { matches: 0 }, output: "pattern is required" }
  }

  const result = RAC.search(messages, {
    pattern: params.pattern,
    id: params.id,
    limit: params.limit,
    caseSensitive: params.case_sensitive,
  })
  if ("error" in result) {
    return {
      title: params.pattern,
      metadata: { matches: 0 },
      output: `Invalid regular expression: ${result.error}`,
    }
  }

  if (result.matches.length === 0) {
    const scope = params.id ? `result ${params.id}` : `${result.scanned} stored result${result.scanned === 1 ? "" : "s"}`
    return {
      title: params.pattern,
      metadata: { matches: 0, scanned: result.scanned },
      output: `No matches for /${params.pattern}/ in ${scope}.`,
    }
  }

  const lines = result.matches.map((match) => `[${match.id}] ${match.tool}, line ${match.line}: ${match.text}`)
  const header = `${result.matches.length} match${result.matches.length === 1 ? "" : "es"} across ${result.scanned} stored result${result.scanned === 1 ? "" : "s"}.`
  const footer = result.truncated
    ? "\n\nResults truncated at the limit. Narrow the pattern for the rest."
    : "\n\nUse remember(id) for the full result, or remember(id, offset, limit) for a range around a line."

  return {
    title: params.pattern,
    metadata: { matches: result.matches.length, scanned: result.scanned, truncated: result.truncated },
    output: [header, "", ...lines].join("\n") + footer,
  }
}

export const GrepMemoryTool = Tool.define(
  "grep_memory",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Full session, not ctx.messages: searching only the compacted view
          // would hide exactly the old results worth finding.
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(ctx.messages)))
          return respond(messages, params)
        }),
    }
  }),
)
