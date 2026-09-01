export * as RAC from "./rac"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Token } from "@/util/token"

/**
 * Random Access Context — see specs/rac/ for the design.
 *
 * Collapses tool results to short addressable stubs on a fixed schedule, so the
 * model's view of old observations shrinks while stored state stays lossless.
 *
 * Deliberately a pure projection over the message list, applied immediately
 * before MessageV2.toModelMessages. It never touches stored parts, and the
 * chokepoint itself needs no changes.
 *
 * Collapse is fixed-age rather than budget-triggered on purpose: it always
 * mutates at the same small offset from the tail, so the prompt-cache prefix
 * below that point survives. A "smarter" policy that evicts by utility or LRU
 * would rewrite arbitrary depths of history and defeat caching. Do not make
 * this cleverer without measuring cache hit rate first.
 */

export interface Options {
  /** Full visibility for the producing turn plus this many following turns. */
  collapseAfterTurns: number
  /** Results shorter than this stay verbatim forever — a stub costs tokens too. */
  minLinesToCollapse: number
  /** Whether the `remember` tool is available, so stubs can say how to recall. */
  recallable?: boolean
  /**
   * Full session history, used solely to assign addresses.
   *
   * Numbering over the whole archive rather than the visible view is what makes
   * addresses survive compaction: truncating the front of the view removes
   * t1..t5 without renaming t6 onward. Defaults to the view when omitted, which
   * is only correct if nothing has been compacted away.
   */
  archive?: SessionV1.WithParts[]
}

export const DEFAULTS: Options = {
  // Zero, not two. Re-prefill cost scales as (collapseAfterTurns + 1) x turn
  // size, so every increment permanently costs one turn's cache invalidation
  // per turn; at 0 the cost is indistinguishable from plain append-only. An
  // agent that needs an old result in view should ask for it rather than have
  // the harness speculatively carry it for everyone. Note this collapses only
  // across *user* turns — every tool call inside the current agentic loop stays
  // verbatim, so read-then-edit within a turn is unaffected.
  collapseAfterTurns: 0,
  minLinesToCollapse: 50,
}

export interface Stats {
  /** Tool parts replaced with a stub in this projection. */
  collapsed: number
  /** Rough tokens removed from the payload, stub cost already netted off. */
  saved: number
}

/** Tools whose output must never collapse. Mirrors compaction's protected list. */
const PROTECTED = new Set(["skill", "todowrite", "todoread"])

function lines(text: string) {
  if (text === "") return 0
  let count = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
  return count
}

/**
 * Compact one-line rendering of the call's most identifying argument, so a stub
 * says `read(src/app.ts)` rather than a bare `read`. Falls back to nothing
 * rather than dumping an arbitrary object into the context we are shrinking.
 */
function signature(tool: string, input: Record<string, unknown>) {
  // `id` covers remember's own results, so a re-collapsed recall still says
  // which address it came from rather than a bare "remember".
  for (const key of ["filePath", "path", "pattern", "query", "command", "url", "description", "id"]) {
    const value = input[key]
    if (typeof value !== "string" || value === "") continue
    return `${tool}(${value.length > 80 ? value.slice(0, 77) + "..." : value})`
  }
  return tool
}

export function stub(id: string, part: SessionV1.ToolPart, output: string, recallable: boolean) {
  const head = `[${id}] ${signature(part.tool, part.state.input)} → ${lines(output)} lines collapsed.`
  if (!recallable) return head + " Full output retained verbatim; it is no longer shown here."
  return head + ` Retrieve verbatim with remember("${id}").`
}

/**
 * Assigns sequential per-session IDs (t1, t2, ...) in tool-call order.
 *
 * Sequential rather than content-hashed: fewer tokens, ordered so the model can
 * reason about recency, and far easier to copy without corruption. Derived from
 * position, which is stable as long as message ordering is — worth re-checking
 * when recall lands in Phase 2, since a wrong ID there is a user-visible error
 * rather than just a cosmetic one.
 */
export function identify(msgs: readonly SessionV1.WithParts[]) {
  const ids = new Map<string, string>()
  let n = 0
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      n++
      ids.set(part.id, "t" + n)
    }
  }
  return ids
}

export interface Found {
  id: string
  part: SessionV1.ToolPart
  output: string
}

/**
 * Resolves an address like `t14` back to its stored tool result.
 *
 * On a miss, returns the numerically nearest live addresses rather than a bare
 * error — a model that has hallucinated an address will otherwise flail, and
 * suggesting neighbours is far cheaper than another failed turn.
 */
export function lookup(msgs: SessionV1.WithParts[], id: string): Found | { near: string[] } {
  const ids = identify(msgs)
  const wanted = id.trim().toLowerCase()
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (ids.get(part.id) !== wanted) continue
      if (part.state.status !== "completed") return { near: [] }
      return { id: wanted, part, output: part.state.output }
    }
  }

  const n = Number.parseInt(wanted.replace(/^t/, ""), 10)
  const all = Array.from(ids.values())
  if (!Number.isFinite(n)) return { near: all.slice(-3) }
  return {
    near: all
      .map((candidate) => ({ candidate, distance: Math.abs(Number.parseInt(candidate.slice(1), 10) - n) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map((entry) => entry.candidate),
  }
}

export interface Match {
  id: string
  tool: string
  line: number
  text: string
}

export interface SearchResult {
  matches: Match[]
  /** Results were capped; there were more. */
  truncated: boolean
  /** Stored results actually scanned, for reporting. */
  scanned: number
}

/** Longest matching line echoed back. Keeps one minified file from costing more
 * than the recall it was meant to avoid. */
const MATCH_LINE_MAX = 200

/**
 * Default cap on matches.
 *
 * Kept deliberately tight. The saving from the two-stage split is proportional
 * to how sparse matches are within the source: a search returning N lines costs
 * ~N lines, so against a small result a broad pattern can cost more than simply
 * recalling the whole thing. Bounding the worst case at roughly 20 x 200 chars
 * keeps a search predictably cheap, and the tool tells the model to narrow the
 * pattern rather than raise the cap.
 */
const DEFAULT_LIMIT = 20

/**
 * Regex search across stored tool results.
 *
 * Returns addresses and line numbers with one matching line each — deliberately
 * *not* content. Surfacing content here would make a broad search cost exactly
 * the tokens RAC exists to save; pulling it is a separate `remember` call. This
 * is Scroll's exec/print split, and it is the reason the two tools are separate.
 */
export function search(
  msgs: SessionV1.WithParts[],
  options: { pattern: string; id?: string; limit?: number; caseSensitive?: boolean },
): SearchResult | { error: string } {
  const regex = (() => {
    try {
      return new RegExp(options.pattern, options.caseSensitive ? "" : "i")
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  })()
  if (typeof regex === "string") return { error: regex }

  const ids = identify(msgs)
  const limit = options.limit ?? DEFAULT_LIMIT
  const wanted = options.id?.trim().toLowerCase()
  const matches: Match[] = []
  let truncated = false
  let scanned = 0

  scan: for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      const id = ids.get(part.id)
      if (!id) continue
      if (wanted && id !== wanted) continue
      scanned++
      const split = part.state.output.split("\n")
      for (let i = 0; i < split.length; i++) {
        const text = split[i]
        if (!regex.test(text)) continue
        if (matches.length >= limit) {
          truncated = true
          break scan
        }
        matches.push({
          id,
          tool: part.tool,
          line: i + 1,
          text: text.length > MATCH_LINE_MAX ? text.slice(0, MATCH_LINE_MAX - 3) + "..." : text,
        })
      }
    }
  }

  return { matches, truncated, scanned }
}

/** Extracts a 1-indexed, inclusive line range, clamped to what exists. */
export function slice(output: string, offset?: number, limit?: number) {
  if (offset === undefined && limit === undefined) return { text: output, from: 1, to: lines(output) }
  const all = output.split("\n")
  const from = Math.max(1, offset ?? 1)
  const to = Math.min(all.length, limit === undefined ? all.length : from + limit - 1)
  return { text: all.slice(from - 1, to).join("\n"), from, to }
}

/**
 * Returns a view of `msgs` with sufficiently old, sufficiently large tool
 * outputs replaced by stubs.
 *
 * Copy-on-write: messages and parts that do not collapse are passed through by
 * reference, so this stays cheap on the common path and cannot mutate stored
 * state by accident.
 */
export function project(
  msgs: SessionV1.WithParts[],
  options: Options = DEFAULTS,
): { messages: SessionV1.WithParts[]; stats: Stats } {
  const ids = identify(options.archive ?? msgs)
  const stats: Stats = { collapsed: 0, saved: 0 }

  // A turn boundary is a user message, matching how compaction counts them.
  // Walk backwards so `turns` is the message's age measured from the tail.
  let turns = 0
  const collapsing = new Set<string>()
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role === "user") turns++
    if (turns <= options.collapseAfterTurns) continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (PROTECTED.has(part.tool)) continue
      // Already cleared by compaction's prune; leave that path alone.
      if (part.state.time.compacted) continue
      if (lines(part.state.output) < options.minLinesToCollapse) continue
      collapsing.add(part.id)
    }
  }

  if (collapsing.size === 0) return { messages: msgs, stats }

  const messages = msgs.map((msg) => {
    if (!msg.parts.some((part) => collapsing.has(part.id))) return msg
    return {
      info: msg.info,
      parts: msg.parts.map((part) => {
        if (!collapsing.has(part.id) || part.type !== "tool" || part.state.status !== "completed") return part
        const output = part.state.output
        const replacement = stub(ids.get(part.id)!, part, output, options.recallable ?? false)
        stats.collapsed++
        stats.saved += Math.max(0, Token.estimate(output) - Token.estimate(replacement))
        return {
          ...part,
          state: {
            ...part.state,
            output: replacement,
            // Media in a collapsed result would dwarf the stub it belongs to.
            attachments: [],
          },
        }
      }),
    }
  })

  return { messages, stats }
}
