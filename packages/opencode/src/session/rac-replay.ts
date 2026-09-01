export * as RACReplay from "./rac-replay"

import { RAC } from "./rac"
import { Token } from "@/util/token"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * Offline prefix-cache accounting for RAC — see specs/rac/evaluation-plan.md.
 *
 * `debug rac` reads the cache counters the provider reports. Most providers
 * report nothing: Ollama, measured on 0.33.2, returns an identical
 * `prompt_eval_count` cold and warm and has no `cached_tokens` field at all,
 * even though its prefill drops from 8653ms to 25ms on a hit. On any such
 * provider that command reads a flat 0% and the central claim is untestable.
 *
 * So derive it instead. Prefix reuse is a property of the payloads, not of the
 * provider: replay a stored session, rebuild the exact request sequence that
 * produced it, and diff each request against its predecessor. What a prefix
 * cache can reuse is precisely the common prefix. No inference, no credentials,
 * no provider cooperation, and identical numbers on every run.
 *
 * The deliberate limitation: replaying one recorded trajectory through both
 * arms is counterfactual, since a RAC-enabled agent would have issued `remember`
 * calls and diverged. This measures the prefix economics of a *fixed* history,
 * which is the cleanest isolation of the mechanism and not a claim about what
 * the agent would do. Behavioural claims need live runs.
 */

/**
 * One reconstructed provider request.
 *
 * The unit is the request, not the message, because that is the unit a prefix
 * cache actually sees. An agentic loop issues one request per step, and the
 * distinction matters here: within a turn the steps are pure appends and cache
 * perfectly in both arms, while at a turn boundary RAC rewrites older tool
 * results and breaks the prefix. Measuring per-message would hide the appends
 * that RAC gets for free and flatter nothing, but it would also blur where the
 * invalidation lands, which is the whole question.
 */
export interface Request {
  /** 1-indexed user turn. */
  turn: number
  /** 1-indexed step within that turn's agentic loop. */
  step: number
  context: SessionV1.WithParts[]
}

/**
 * Rebuilds the request sequence that produced a stored session.
 *
 * For each assistant message: one request before it produced anything, then one
 * more after each tool result was appended. Parts are stored in order, so
 * truncating the part list reproduces what the model saw at each step.
 */
export function requests(msgs: SessionV1.WithParts[]): Request[] {
  const out: Request[] = []
  let turn = 0
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (msg.info.role === "user") turn++
    if (msg.info.role !== "assistant") continue
    const before = msgs.slice(0, i)
    let step = 1
    out.push({ turn, step, context: before })
    for (let j = 0; j < msg.parts.length; j++) {
      if (msg.parts[j].type !== "tool") continue
      step++
      out.push({ turn, step, context: [...before, { info: msg.info, parts: msg.parts.slice(0, j + 1) }] })
    }
  }
  return out
}

/** Length of the longest common prefix, in characters. */
export function lcp(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++
  return n
}

export interface Cost {
  turn: number
  step: number
  /** Payload size. */
  tokens: number
  /** Tokens the previous request already put in cache. */
  reused: number
  /** Tokens that must be prefilled — the number the cache claim is about. */
  fresh: number
  /** Tool parts collapsed to stubs in this payload. */
  collapsed: number
}

export interface Arm {
  label: string
  costs: Cost[]
  total: { tokens: number; reused: number; fresh: number; collapsed: number }
  /** Share of payload tokens served from the previous request's prefix. */
  hitRate: number
}

/**
 * Renders a request context exactly as it would go over the wire.
 *
 * Injected rather than fixed so the core stays testable without a provider, and
 * so the CLI can use the real `MessageV2.toModelMessages` — the numbers are only
 * worth reporting if they come from the actual serialisation.
 */
export type Serialize = (context: SessionV1.WithParts[]) => Promise<string>

export interface Options {
  label: string
  serialize: Serialize
  /** Omit for the control arm. */
  rac?: RAC.Options
}

/**
 * Replays a session and accounts for prefix reuse request by request.
 *
 * Reuse is measured against the immediately preceding request only. That is the
 * behaviour of the caches this targets — a llama.cpp slot holds one prefix, and
 * Anthropic's cache is a prefix cache over the linear conversation — so crediting
 * reuse from any earlier request would overstate the hit rate for both arms.
 */
export async function measure(msgs: SessionV1.WithParts[], options: Options): Promise<Arm> {
  const costs: Cost[] = []
  let previous = ""
  for (const request of requests(msgs)) {
    // Address assignment reads the whole archive, matching the live path in
    // prompt.ts: numbering over stored history rather than the visible slice is
    // what keeps addresses stable across compaction.
    const projected = options.rac ? RAC.project(request.context, { ...options.rac, archive: msgs }) : undefined
    const text = await options.serialize(projected?.messages ?? request.context)
    // Character-exact prefix, converted to tokens by the same estimator the rest
    // of the codebase uses. The boundary is exact; only the token conversion is
    // approximate, and it is applied identically to both arms — so the ratios
    // are trustworthy even where the absolute counts are not.
    const shared = lcp(previous, text)
    const tokens = Token.estimate(text)
    const reused = Math.min(tokens, Token.estimate(text.slice(0, shared)))
    costs.push({
      turn: request.turn,
      step: request.step,
      tokens,
      reused,
      fresh: tokens - reused,
      collapsed: projected?.stats.collapsed ?? 0,
    })
    previous = text
  }

  const total = costs.reduce(
    (acc, cost) => ({
      tokens: acc.tokens + cost.tokens,
      reused: acc.reused + cost.reused,
      fresh: acc.fresh + cost.fresh,
      collapsed: acc.collapsed + cost.collapsed,
    }),
    { tokens: 0, reused: 0, fresh: 0, collapsed: 0 },
  )

  return { label: options.label, costs, total, hitRate: total.tokens === 0 ? 0 : (100 * total.reused) / total.tokens }
}

export interface Comparison {
  off: Arm
  on: Arm
  delta: {
    /** Negative is a saving. */
    tokens: number
    tokensPct: number
    fresh: number
    freshPct: number
  }
  /**
   * The re-prefill collapse costs, and whether that cost stays constant.
   *
   * `early` and `late` are the mean per-turn overhead over the first and second
   * half of the session, excluding the opening turn. Fixed-age collapse predicts they are equal: it always
   * rewrites the same small offset from the tail, so the invalidation cannot
   * compound. A policy that evicted by utility or budget would rewrite deeper as
   * history grew and `late` would climb. This is the sharpest falsifiable test of
   * claim 1 available without a provider.
   */
  overhead: { total: number; perTurn: number; early: number; late: number }
}

/** Prefill tokens per turn, summed across that turn's steps. */
export function perTurn(arm: Arm) {
  const out = new Map<number, number>()
  for (const cost of arm.costs) out.set(cost.turn, (out.get(cost.turn) ?? 0) + cost.fresh)
  return out
}

/**
 * Both arms of the comparison.
 *
 * Read `tokens` and `fresh` as two different costs, not one. Payload tokens are
 * what the provider bills and what consumes the context window; prefill tokens
 * are the work actually done, which is latency on local hardware and full-rate
 * input on a caching provider.
 *
 * Expect collapse to *raise* prefill slightly on an append-only trajectory. A
 * perfect prefix cache already serves an old tool result for free, so replacing
 * it with a stub can only invalidate something that was costing nothing. That is
 * not a defect — it is the trade the design makes, buying a large payload
 * reduction for a small constant re-prefill. What would be a defect is that cost
 * growing with session length, which is what `overhead.early` vs `overhead.late`
 * exists to detect.
 *
 * One prefill win this cannot see on a short session: the baseline arm
 * eventually exhausts the context window and compacts, rewriting the whole prefix
 * at once. Replaying a session long enough to have compacted is where RAC should
 * show a prefill saving rather than a small cost.
 */
export function compare(off: Arm, on: Arm): Comparison {
  const pct = (before: number, after: number) => (before === 0 ? 0 : (100 * (after - before)) / before)
  const offTurns = perTurn(off)
  const onTurns = perTurn(on)
  // Drop the first turn: it has no history above it to collapse, so it
  // contributes a structural zero that drags `early` down and can read as growth
  // where there is none. Comparing only turns that could actually collapse keeps
  // the two halves like for like.
  const turns = [...offTurns.keys()].sort((a, b) => a - b).slice(1)
  const overheads = turns.map((turn) => (onTurns.get(turn) ?? 0) - (offTurns.get(turn) ?? 0))
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)
  const half = Math.floor(overheads.length / 2)

  return {
    off,
    on,
    delta: {
      tokens: on.total.tokens - off.total.tokens,
      tokensPct: pct(off.total.tokens, on.total.tokens),
      fresh: on.total.fresh - off.total.fresh,
      freshPct: pct(off.total.fresh, on.total.fresh),
    },
    overhead: {
      total: on.total.fresh - off.total.fresh,
      perTurn: mean(overheads),
      early: mean(overheads.slice(0, half)),
      late: mean(overheads.slice(half)),
    },
  }
}

export interface Economics {
  /** Prefill price divided by cached-read price. */
  k: number
  /** Where `k` came from, so a looked-up rate is never mistaken for an assumed one. */
  source: string
  /** Billed cost in cached-token equivalents, i.e. units where a cached read is 1. */
  cost: { off: number; on: number; savedPct: number }
  /** First turn whose cumulative cost is lower with RAC. Undefined if it never crosses. */
  crossover?: number
  /** Structural parameters read off the two arms. */
  params: {
    /** New content a turn adds. */
    w: number
    /** Per-turn residual once collapsed. */
    m: number
    /** Extra re-prefill the newest collapse forces. */
    delta: number
  }
  /**
   * Closed-form crossover from those parameters, for comparison with the
   * measured one. Its ceiling should equal `crossover`; a wider gap means the
   * session violates a model assumption, most likely uniform turn size.
   */
  predicted: number
  /** Tokens of recall per turn affordable at the final turn while staying ahead. */
  recallBudget: number
}

/** Largest payload within each turn, keyed by turn. */
function peak(arm: Arm) {
  const out = new Map<number, number>()
  for (const cost of arm.costs) out.set(cost.turn, Math.max(out.get(cost.turn) ?? 0, cost.tokens))
  return out
}

/** Mean of the consecutive differences of a per-turn series. */
function growth(series: Map<number, number>) {
  const turns = [...series.keys()].sort((a, b) => a - b)
  if (turns.length < 2) return 0
  const diffs = turns.slice(1).map((turn, i) => series.get(turn)! - series.get(turns[i])!)
  return diffs.reduce((a, b) => a + b, 0) / diffs.length
}

/**
 * Derives `k` from a model's published rates, or undefined if it has none.
 *
 * The numerator is the cache *write* price where there is one. A prefilled token
 * is not merely processed, it is stored for the next turn to reuse, so on a
 * provider that charges for the write that is what a fresh token actually costs.
 * Anthropic prices writes at 1.25x base input and reads at 0.1x, giving 12.5;
 * OpenAI does not charge for writes, so input over read gives 10 across its
 * current lineup. Providers that publish no cache rate — local models among them
 * — return undefined rather than a fabricated ratio.
 */
export function ratio(cost: { input: number; cache: { read: number; write: number } }) {
  if (!cost || cost.cache.read <= 0) return undefined
  const prefill = cost.cache.write > 0 ? cost.cache.write : cost.input
  if (prefill <= 0) return undefined
  return prefill / cost.cache.read
}

/**
 * Prices the trade under a two-rate model — see motivation-and-research.md §3.4.
 *
 * Providers that cache bill a reused prefix at a fraction of the prefill rate:
 * Anthropic charges 10% for cache reads, so `k` is around 10, or 12.5 once the
 * cache write is included. This turns the two token counts, which move in
 * opposite directions, into one number that can be compared.
 *
 * Costs come out in cached-token equivalents rather than currency. The ratio is
 * what the model depends on, and quoting dollars would imply a precision the
 * 4-chars-per-token estimate does not have.
 *
 * `crossover` is measured directly from the cumulative bills and is the number to
 * trust. `predicted` is the closed form over `params`, reported beside it as a
 * check: if the two diverge badly, the session violates an assumption of the
 * model — most likely that turns are roughly uniform in size.
 *
 * On a provider with no cached-read discount, `k` is unbounded and there is no
 * crossover to find. Local inference is that case: a cached read costs no
 * measurable time, so RAC buys context-window headroom rather than throughput.
 */
export function economics(result: Comparison, k: number, source = "given"): Economics {
  const billed = (arm: Arm) => {
    const out = new Map<number, number>()
    for (const cost of arm.costs) {
      out.set(cost.turn, (out.get(cost.turn) ?? 0) + k * cost.fresh + (cost.tokens - cost.fresh))
    }
    return out
  }
  const offBill = billed(result.off)
  const onBill = billed(result.on)
  const turns = [...offBill.keys()].sort((a, b) => a - b)

  let off = 0
  let on = 0
  let crossover: number | undefined
  for (const turn of turns) {
    off += offBill.get(turn) ?? 0
    on += onBill.get(turn) ?? 0
    if (crossover === undefined && on < off) crossover = turn
  }

  const w = growth(peak(result.off))
  const m = growth(peak(result.on))
  const delta = result.overhead.perTurn
  // Requests per turn, and it belongs in the denominator. Every request in an
  // agentic loop bills the whole cached prefix, so the payload saving is
  // collected once per step, while the collapse penalty is paid once per turn at
  // the boundary where the stub rewrites the prefix. Omitting this undercounts
  // the saving by exactly this factor and predicts a crossover later than the
  // one the same data measures.
  const steps = turns.length === 0 ? 1 : result.off.costs.length / turns.length
  const predicted = w - m <= 0 ? Infinity : 1 + (2 * delta * (k - 1)) / (steps * (w - m))

  // How much recalled content a turn can carry and still stay ahead. Grows
  // linearly with turn number, so it is tight early and generous later — which
  // makes compulsive early recall, not recall in general, the behaviour that
  // would undo the saving.
  const last = turns.at(-1) ?? 1
  const recallBudget = Math.max(0, ((last - 1) * (w - m) - delta * (k - 1)) / k)

  return {
    k,
    source,
    cost: { off, on, savedPct: off === 0 ? 0 : (100 * (off - on)) / off },
    crossover,
    params: { w: Math.round(w), m: Math.round(m), delta: Math.round(delta) },
    predicted,
    recallBudget: Math.round(recallBudget),
  }
}

/**
 * Renders a comparison as a fixed-width report.
 *
 * Lives here rather than in the command so it can be tested — the numbers are
 * the deliverable, and a report that misattributes a column is worse than no
 * report. Mirrors how `summarize` is exported from the debug command for the
 * same reason.
 */
export function render(
  result: Comparison,
  meta: { sessionID: string; model: string; rac: RAC.Options; economics?: Economics },
) {
  const { off, on } = result
  const pad = (value: string | number, width: number) => String(value).padStart(width)
  const pct = (value: number) => (value >= 0 ? "+" : "") + value.toFixed(1) + "%"
  const out: string[] = []

  out.push(`session ${meta.sessionID}`)
  out.push(`model ${meta.model}`)
  out.push(
    `replay ${off.costs.length} requests, no inference ` +
      `(collapse_after_turns=${meta.rac.collapseAfterTurns}, min_lines_to_collapse=${meta.rac.minLinesToCollapse})`,
  )
  out.push("")

  // Broken out per turn because that is where RAC acts: collapse is keyed on
  // user turns, so a turn whose prefill jumps is the row worth reading.
  const sum = (arm: Arm, turn: number, key: "tokens" | "fresh" | "collapsed") =>
    arm.costs.filter((cost) => cost.turn === turn).reduce((acc, cost) => acc + cost[key], 0)
  out.push(
    ["turn", "reqs", "off tok", "on tok", "off fill", "on fill", "stubs"]
      .map((head, i) => pad(head, i === 0 ? 5 : 10))
      .join(""),
  )
  for (const turn of [...new Set(off.costs.map((cost) => cost.turn))]) {
    out.push(
      pad(turn, 5) +
        pad(off.costs.filter((cost) => cost.turn === turn).length, 10) +
        pad(sum(off, turn, "tokens"), 10) +
        pad(sum(on, turn, "tokens"), 10) +
        pad(sum(off, turn, "fresh"), 10) +
        pad(sum(on, turn, "fresh"), 10) +
        pad(sum(on, turn, "collapsed"), 10),
    )
  }

  out.push("")
  out.push(pad("", 20) + pad("rac off", 12) + pad("rac on", 12) + pad("delta", 12))
  out.push(
    pad("payload tokens", 20) +
      pad(off.total.tokens, 12) +
      pad(on.total.tokens, 12) +
      pad(pct(result.delta.tokensPct), 12),
  )
  out.push(
    pad("prefill tokens", 20) +
      pad(off.total.fresh, 12) +
      pad(on.total.fresh, 12) +
      pad(pct(result.delta.freshPct), 12),
  )
  out.push(pad("prefix reuse", 20) + pad(off.hitRate.toFixed(1) + "%", 12) + pad(on.hitRate.toFixed(1) + "%", 12))
  out.push(pad("stubs", 20) + pad(0, 12) + pad(on.total.collapsed, 12))
  out.push("")

  // Stated as a trade rather than a verdict. The two costs are different things,
  // and conflating them is how this gets misread in both directions: payload
  // tokens are what the provider bills and what fills the window, prefill tokens
  // are the work actually done.
  out.push(
    `payload ${result.delta.tokens <= 0 ? "saved" : "grew"} ${Math.abs(result.delta.tokens)} tokens ` +
      `(${pct(result.delta.tokensPct)}) for ${result.overhead.total} tokens of re-prefill, ` +
      `${result.overhead.perTurn.toFixed(0)} per turn`,
  )
  // Claim 1 is that fixed-age collapse invalidates a constant amount however long
  // the session runs. A rising figure means the rewrite is reaching deeper as
  // history grows, which is the one result that would refute the design rather
  // than merely price it.
  out.push(
    `per-turn re-prefill  early ${result.overhead.early.toFixed(0)}  late ${result.overhead.late.toFixed(0)}  ` +
      (result.overhead.late <= result.overhead.early * 1.5
        ? "(constant - collapse is not reaching deeper as history grows)"
        : "(GROWING - invalidation is compounding, which claim 1 says it must not)"),
  )

  // Always rendered, even with nothing to price it with. The two token counts
  // move in opposite directions, so a report that stops before converting them
  // leaves the reader to guess which one won; saying the price is unknown is a
  // finding, whereas silently omitting the section reads like an oversight.
  out.push("")
  if (!meta.economics) {
    out.push("no price information available for this model")
    out.push("pass --price k, the ratio of prefill to cached-read cost, to estimate the real saving")
    out.push("(Anthropic is 12.5 on the 5-minute cache and 20 on the 1-hour; OpenAI is 10)")
  } else {
    const econ = meta.economics
    out.push(
      `priced at k=${econ.k} from ${econ.source} (prefill costs ${econ.k}x a cached read), ` +
        `in cached-token equivalents`,
    )
    out.push(
      pad("billed cost", 20) +
        pad(Math.round(econ.cost.off), 12) +
        pad(Math.round(econ.cost.on), 12) +
        pad(pct(-econ.cost.savedPct), 12),
    )
    out.push(
      econ.crossover === undefined
        ? `never cheaper within this session (${off.costs.length} requests replayed)`
        : `cheaper from turn ${econ.crossover} onward; closed form predicts ${econ.predicted.toFixed(2)}`,
    )
    out.push(
      `w=${econ.params.w} m=${econ.params.m} delta=${econ.params.delta}  ` +
        `recall budget at this length: ${econ.recallBudget} tokens/turn`,
    )
  }

  return out.join("\n") + "\n"
}
