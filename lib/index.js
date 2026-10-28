/**
 * dsh-dsml-guard — 专治 DSML 泄漏 + 有条件的自动续跑
 *
 * 为什么需要它（本机实测，2026-10-28）：
 *   - 245 个 v4 会话里 28 次真实泄漏，全部来自 deepseek-v4.1-flash 的第三方直连
 *     （beichen 18 / beichen-ds 9 / aiaaa 1）。
 *   - 泄漏那一轮的 `turn/end.reason` 一律是 `{"kind":"completed"}` —— 上游写完了
 *     标记、正常关流，宿主认为这一轮顺利结束。所以 market 里的 dsh-auto-continue
 *     永远触发不了（它只认 kind==='error' 且错误码在白名单里）。
 *   - 12 次 `invoke-block`（整段 <｜DSML｜invoke …> 写进正文）里，泄漏前的正文中位数
 *     只有 1 个字符、同一消息里 tool-call 块数为 0 —— 这一轮什么也没产出。
 *     17 次 `tail-close`（只有结尾闭合标签）正文中位数 755 字符，答案是完整的。
 *
 * 两件事分开做：
 *   ① 清洗：把正文里的 DSML 标记抹掉（代码围栏内不动，那是人在讨论语法）。
 *   ② 续跑：只在「重试有意义」时补一条 继续 ——
 *        - 这一轮泄漏且什么都没产出（invoke-block，或正文极短的 tail-close）；
 *        - `turn/end` 是 TIMEOUT / TRANSPORT / SERVER 这类上游抖动。
 *      余额、额度、上下文超限、鉴权、未知模型这类「发继续也照样报错」的一律不续。
 *
 * 约束（踩过才知道）：
 *   - `llm/stream` 监听器必须**同步**返回 AsyncIterable；把监听器写成 async 会让
 *     返回值变成 Promise，宿主抛 "stream is not async iterable"。这里返回的是
 *     async generator 对象（调用 asyncGenerator() 本身是同步的）。
 *   - 注入消息的 source 必须是 producer-owned kind（`plugin:<label>`），否则 v4
 *     会话行准入抛 "format v4 message requires a producer-owned source kind"。
 *   - 不 import '@deepseek-ai/dsh-llm'：createUserMessage 在这里内联，避免宿主
 *     版本差异把插件整只拖死。
 */

// ── DSML 标记的两种竖线写法 ───────────────────────────────────────────
// 本机捕获的全是**双全角竖线** ｜｜DSML｜｜；插件自带文档里是单竖线；还有 ASCII 的 ||DSML||。
// 三种都要认，否则清洗器对着真实流量一个字都不动（@goodandready 那个插件就是这么失效的）。
const BAR = '\uFF5C' // ｜
const BARS = `(?:${BAR}{1,2}|\\|{1,2})`
const OPEN_NAMES = '(?:tool_calls|tool-calls|toolcalls|invoke)'
const ALL_NAMES = '(?:tool_calls|tool-calls|toolcalls|invoke|parameter|calls|tool)'

const RE_OPENER = new RegExp(`^<${BARS}DSML${BARS}\\s*${OPEN_NAMES}(?:\\s[^>]*)?>`, 'i')
const RE_CLOSER = new RegExp(`^<\\/${BARS}DSML${BARS}\\s*${ALL_NAMES}\\s*>`, 'i')
/**
 * 单个标签（不是「块的开始」也不是「块的结尾」）—— 例如真实流量里捕获的
 * `<｜｜DSML｜｜ calls>`：外层的 tool_calls 包裹在泄漏时常常只剩这个残片，
 * 或者块的 openers 被摘掉后内部的 `<parameter …>` 还留在正文里。
 * 这些一律按「残渣」丢掉，只丢标签本身，不动它周围的字。
 */
const RE_DEBRIS_TAG = new RegExp(`^</?${BARS}DSML${BARS}\\s*${ALL_NAMES}(?:\\s[^>]*)?>`, 'i')
/**
 * 光头标记：`<｜｜DSML｜｜>` —— 标记后面**没有标签名**。
 * 真实流量里出现过（beichen，2026-10-22）：块的 openers 被摘掉，只剩这层壳。
 * 它自己不成块，但必须从显示里抹掉，否则用户还是会看到一截标记。
 */
const RE_BARE_TAG = new RegExp(`^</?${BARS}DSML${BARS}\\s*>`, 'i')
const RE_ANY_TAG = new RegExp(`</?${BARS}DSML${BARS}\\s*${ALL_NAMES}(?:\\s[^>]*)?>`, 'gi')
const RE_TAG_WALK = new RegExp(
  `<(/?)${BARS}DSML${BARS}\\s*${ALL_NAMES}(?:\\s[^>]*)?>`,
  'gi',
)
/** 只有这几种才参与「块」的深度配对；`parameter` 在块内部，不改变深度。 */
const DEPTH_NAMES = new Set(['tool_calls', 'tool-calls', 'toolcalls', 'invoke', 'calls'])
const RE_MARKER = new RegExp(`${BARS}DSML${BARS}`, 'i')
/** 末尾只剩闭合标签的情形（tail-close）。 */
const RE_TAIL_CLOSERS = new RegExp(
  `(?:\\s*<\\/${BARS}DSML${BARS}\\s*${ALL_NAMES}\\s*>)+\\s*$`,
  'i',
)

const FENCE = ['```', '~~~']

/**
 * 这个片段是否像「一个还没写完的标记开头」，值得压住等下一个分片。
 *
 * 竖线写法有三套（｜｜ / ｜ / ||），逐字符比前缀会把组合数乘起来；先把任何连续竖线
 * 归一成 `#`，前缀表就只剩一份。
 */
const PARTIAL_PREFIXES = ['#', '#D', '#DS', '#DSM', '#DSML', '#DSML#']
function looksLikePartialMarker(text) {
  if (text.length > 40) return false
  if (!text.startsWith('<')) return false
  let body = text.slice(1)
  if (body.startsWith('/')) body = body.slice(1)
  body = body.trimStart()
  if (body.includes('>')) return false // 已经收口的标签交给正规的正则
  const normalized = body.replace(/[｜|]+/gu, '#')
  if (normalized === '') return true
  return PARTIAL_PREFIXES.some(
    (prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix),
  )
}

/** 从 start（一个 opener 的起点）向后找配对的块尾；找不到返回 -1。 */
function findBlockEnd(buffer, start) {
  const first = RE_OPENER.exec(buffer.slice(start))
  if (first === null) return -1
  let depth = 0
  let cursor = start
  RE_TAG_WALK.lastIndex = start
  let match
  while ((match = RE_TAG_WALK.exec(buffer)) !== null) {
    const closing = match[1] === '/'
    const name = /DSML(?:｜{1,2}|\|{1,2})\s*([A-Za-z_-]+)/.exec(match[0])
    const rawName = name === null ? '' : name[1].toLowerCase()
    if (DEPTH_NAMES.has(rawName)) {
      depth += closing ? -1 : 1
      if (depth === 0) return match.index + match[0].length
    }
    cursor = match.index + match[0].length
    if (cursor > buffer.length) break
  }
  return -1
}

/**
 * 单遍清洗器：喂分片、拿回可以安全显示的部分。
 *
 * @param {{final?: boolean, track?: object}} options - `track` 收集诊断信息：
 *   `{ leak, block, tailClose, proseChars }`。
 */
export function createStreamSanitizer(options = {}) {
  const track = options.track ?? { leak: false, block: false, tailClose: false, proseChars: 0 }
  let buffer = ''
  let inFence = false

  const emitProse = (text) => {
    if (text !== '') track.proseChars += text.length
    return text
  }

  function drain(final) {
    let out = ''
    let index = 0
    while (index < buffer.length) {
      if (inFence) {
        const closeAt = Math.min(
          ...FENCE.map((fence) => {
            const at = buffer.indexOf(fence, index)
            return at === -1 ? Number.POSITIVE_INFINITY : at
          }),
        )
        if (closeAt === Number.POSITIVE_INFINITY) {
          out += emitProse(buffer.slice(index))
          index = buffer.length
          break
        }
        out += emitProse(buffer.slice(index, closeAt + 3))
        inFence = false
        index = closeAt + 3
        continue
      }

      // 下一个可能改变状态的位置：`<` 或代码围栏
      const nextTag = buffer.indexOf('<', index)
      const nextFence = Math.min(
        ...FENCE.map((fence) => {
          const at = buffer.indexOf(fence, index)
          return at === -1 ? Number.POSITIVE_INFINITY : at
        }),
      )
      const next = Math.min(nextTag === -1 ? Number.POSITIVE_INFINITY : nextTag, nextFence)

      if (next === Number.POSITIVE_INFINITY) {
        out += emitProse(buffer.slice(index))
        index = buffer.length
        break
      }
      if (next > index) {
        out += emitProse(buffer.slice(index, next))
        index = next
      }
      if (nextFence === next) {
        out += emitProse(buffer.slice(index, index + 3))
        inFence = true
        index += 3
        continue
      }

      // 位于 `<`
      const rest = buffer.slice(index)
      if (looksLikePartialMarker(rest)) {
        if (final) {
          // 收尾了还是半截标记：整段当作残渣丢掉
          if (RE_MARKER.test(rest)) {
            track.leak = true
            track.tailClose = true
            index = buffer.length
            break
          }
          out += emitProse(rest)
          index = buffer.length
          break
        }
        break // 压住，等下一个分片
      }

      if (RE_OPENER.test(rest)) {
        const end = findBlockEnd(buffer, index)
        if (end === -1) {
          if (!final) break // 块还没写完，压住
          // 收尾仍不完整：opener 之后全是标记，直接丢
          track.leak = true
          track.block = true
          index = buffer.length
          break
        }
        track.leak = true
        track.block = true
        index = end
        continue
      }
      if (RE_CLOSER.test(rest)) {
        track.leak = true
        track.tailClose = true
        const tagEnd = rest.indexOf('>')
        index += tagEnd + 1
        continue
      }
      // 开标签 / 孤立包裹残片（`<｜｜DSML｜｜ calls>` 这类）：整颗标签丢掉，周围的字保留
      if (RE_DEBRIS_TAG.test(rest) || RE_BARE_TAG.test(rest)) {
        track.leak = true
        track.tailClose = true
        const tagEnd = rest.indexOf('>')
        index += tagEnd + 1
        continue
      }
      // 普通文本里的 `<`
      out += emitProse('<')
      index += 1
    }

    buffer = buffer.slice(index)
    // 收尾后残留的裸闭合标签（没有 opener 配对的）也清掉
    if (final && buffer !== '') {
      if (RE_MARKER.test(buffer)) {
        track.leak = true
        track.tailClose = true
        buffer = ''
      }
    }
    return out
  }

  return {
    get track() {
      return track
    },
    push(text) {
      buffer += text
      return drain(false)
    },
    flush() {
      return drain(true)
    },
  }
}

/** 一次性清洗（测试与回放用）。 */
export function sanitizeText(text) {
  const track = { leak: false, block: false, tailClose: false, proseChars: 0 }
  const sanitizer = createStreamSanitizer({ track })
  return { text: sanitizer.push(text) + sanitizer.flush(), track }
}

/** 正文里是否出现 DSML 标记（代码围栏内不算，那是讨论语法）。 */
export function detectLeak(text) {
  return sanitizeText(text).track.leak
}

// ── 续跑判据 ─────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: true,
  /** 把泄漏的标记从显示里抹掉。 */
  sanitize: true,
  /** 自动补发 继续。 */
  autoContinue: true,
  continueText: '继续',
  /** 同一会话连续续跑的上限，超过就停下等人。 */
  maxConsecutive: 5,
  /** 上游抖动：发继续有意义。 */
  retryCodes: ['TIMEOUT', 'TRANSPORT', 'SERVER', 'MALFORMED_RESPONSE', 'PI_AI_ERROR', 'UNKNOWN'],
  /** 发继续只会再报一次同样的错，不续。 */
  neverCodes: [
    'QUOTA',
    'QUOTA_EXCEEDED',
    'ACCOUNT_QUOTA',
    'RATE_LIMIT',
    'AUTH',
    'MISSING_CREDENTIAL',
    'CONTEXT_WINDOW_EXCEEDED',
    'UNKNOWN_MODEL',
    'HTTP_413',
    'INVALID_REQUEST',
  ],
  /** tail-close 且正文短于这个字符数，视为「这一轮什么都没产出」。 */
  tailCloseMinChars: 80,
}

export function resolveConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  merged.maxConsecutive = Math.max(1, Math.min(100, Number(merged.maxConsecutive) || 5))
  merged.tailCloseMinChars = Math.max(1, Number(merged.tailCloseMinChars) || 80)
  merged.retryCodes = Array.isArray(merged.retryCodes) ? merged.retryCodes : DEFAULT_CONFIG.retryCodes
  merged.neverCodes = Array.isArray(merged.neverCodes) ? merged.neverCodes : DEFAULT_CONFIG.neverCodes
  return merged
}

/**
 * 这一轮该不该补一条 继续？
 *
 * @param {any} reason - `turn/end` 的 reason 对象（可能是 undefined）。
 * @param {{leak:boolean, block:boolean, tailClose:boolean, hadToolCall:boolean, proseChars:number}} state
 *   本轮累计：是否泄漏、是哪种形态、有没有真的发出过 tool-call、正文多长。
 */
export function decideContinue(reason, state, cfg = DEFAULT_CONFIG) {
  if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
    return { retry: false, why: '这一轮是被人为取消/打断的，不替用户续' }
  }

  if (reason?.kind === 'error') {
    const code = String(reason.error?.code ?? '')
    if (cfg.neverCodes.includes(code)) {
      return { retry: false, why: `${code} 发继续也会照样报错` }
    }
    if (cfg.retryCodes.includes(code)) {
      return { retry: true, why: `${code} 属于上游抖动，续跑有意义` }
    }
    return { retry: false, why: `${code} 不在可续跑清单里` }
  }

  if (state?.leak === true && state.hadToolCall !== true) {
    if (state.block === true) {
      return { retry: true, why: 'DSML 把整段工具调用写进了正文，这一轮没有任何产出' }
    }
    if (state.tailClose === true && state.proseChars < cfg.tailCloseMinChars) {
      return {
        retry: true,
        why: `只有结尾闭合标签，正文仅 ${state.proseChars} 字符`,
      }
    }
    if (state.tailClose === true) {
      return { retry: false, why: '正文是完整的，只清标记、不续跑' }
    }
    return { retry: false, why: '泄漏但看不出中断' }
  }

  return { retry: false, why: '正常结束' }
}

// ── 插件本体 ─────────────────────────────────────────────────────────
const SOURCE_KIND = 'plugin:dsml-guard'

/** 内联的 user message 构造（不依赖宿主包，v4 准入认 producer-owned source）。 */
function createPluginUserMessage(text) {
  return Object.freeze({
    role: 'user',
    id: globalThis.crypto.randomUUID(),
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: SOURCE_KIND }),
  })
}

export function apply(ctx, rawConfig = {}) {
  const cfg = resolveConfig(rawConfig)
  /** sessionId → 状态 */
  const sessions = new Map()

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        // 本轮累计
        leak: false,
        block: false,
        tailClose: false,
        hadToolCall: false,
        proseChars: 0,
        // 跨轮
        consecutive: 0,
        timer: null,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  const resetTurn = (state) => {
    state.leak = false
    state.block = false
    state.tailClose = false
    state.hadToolCall = false
    state.proseChars = 0
  }

  // ① 流式清洗 + 统计本轮形态
  ctx.effect(() =>
    ctx.on('llm/stream', (options, next) => {
      const stream = next(options)
      if (!cfg.enabled || !cfg.sanitize) return stream

      return (async function* guard() {
        const sessionId = options?.sessionId
        const state = sessionId === undefined ? null : stateOf(sessionId)
        const track = { leak: false, block: false, tailClose: false, proseChars: 0 }
        const sanitizer = createStreamSanitizer({ track })
        let toolCalls = 0
        /** 每个 text block 已经发出去的正文（用于把 block-end 的全文拉回一致）。 */
        const emitted = new Map()

        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            const visible = sanitizer.push(chunk.text)
            if (visible !== '') {
              emitted.set(chunk.index, (emitted.get(chunk.index) ?? '') + visible)
              yield { ...chunk, text: visible }
            }
            continue
          }
          if (chunk?.type === 'tool-call-delta') toolCalls += 1

          /**
           * 承重的一步：block-end 携带的是**完整 block 全文**，而宿主是拿它组装
           * AssistantMessage 落进会话历史的（落盘的 assistant/message 里就是它）。
           * 只清 text-delta 的话，屏幕上干净、历史里仍是脏的 —— 下一轮又把标记喂回上游，
           * 正是「上下文被污染」的机制。所以这里把文本块换成我们实际发出去的内容。
           */
          if (chunk?.type === 'block-end') {
            const block = chunk.block
            if (block?.type === 'text' && typeof block.text === 'string') {
              const sent = emitted.get(chunk.index)
              if (sent !== undefined && sent !== block.text) {
                yield { ...chunk, block: { ...block, text: sent } }
                continue
              }
            }
            yield chunk
            continue
          }

          if (chunk?.type === 'finish') {
            const tail = sanitizer.flush()
            if (tail !== '') {
              // 尾巴也要算进「已发送」，否则最后一个 block 的 block-end 会对不上
              const index = chunk.index ?? 0
              emitted.set(index, (emitted.get(index) ?? '') + tail)
              yield { type: 'text-delta', index, text: tail }
            }
            if (state !== null) {
              state.leak = state.leak || track.leak
              state.block = state.block || track.block
              state.tailClose = state.tailClose || track.tailClose
              state.proseChars += track.proseChars
              if (toolCalls > 0) state.hadToolCall = true
            }
            yield chunk
            continue
          }
          yield chunk
        }
      })()
    }),
  )

  // ② 结束判据 → 续跑
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!cfg.enabled || !cfg.autoContinue) return
      const sessionId = session?.id ?? session?.sessionId
      if (sessionId === undefined) return
      const state = stateOf(sessionId)

      if (event.type === 'user/message') {
        const source = event.data?.source ?? {}
        if (source.kind === SOURCE_KIND) return // 自己补的那条
        // 用户自己说话了：取消待发的续跑，并把连续计数清零（自动续跑不算干预）
        if (state.timer !== null) {
          clearTimeout(state.timer)
          state.timer = null
        }
        state.consecutive = 0
        return
      }

      if (event.type !== 'turn/end') return

      const verdict = decideContinue(event.data?.reason, state, cfg)
      if (!verdict.retry) {
        if (event.data?.reason?.kind === 'completed') {
          state.consecutive = 0
          resetTurn(state)
        }
        return
      }

      if (state.consecutive >= cfg.maxConsecutive) {
        ctx.logger?.warn?.(
          `dsml-guard: 连续续跑已达上限 ${cfg.maxConsecutive}，停止自动继续（${verdict.why}）`,
        )
        return
      }

      state.consecutive += 1
      const attempt = state.consecutive
      // 随机 1–2 秒：避开同一瞬间的重放，也不越退越远
      const delay = 1000 + Math.floor(Math.random() * 1000)

      ctx.logger?.info?.(
        `dsml-guard: ${sessionId} 第 ${attempt}/${cfg.maxConsecutive} 次续跑（${verdict.why}），${delay}ms 后发送`,
      )

      state.timer = setTimeout(() => {
        state.timer = null
        try {
          const agent = ctx.agents.get(sessionId)
          if (agent === undefined || agent === null) {
            ctx.logger?.warn?.(`dsml-guard: 会话 ${sessionId} 已经没有 agent 了，跳过续跑`)
            return
          }
          agent.followup(createPluginUserMessage(cfg.continueText))
          resetTurn(state)
          ctx.logger?.info?.(`dsml-guard: 已向 ${sessionId} 补发「${cfg.continueText}」`)
        } catch (error) {
          ctx.logger?.error?.(`dsml-guard: 补发失败 ${String(error?.message ?? error)}`)
        }
      }, delay)
    }),
  )

  ctx.effect(() => () => {
    for (const state of sessions.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
    }
    sessions.clear()
  })
}

export const name = 'dsml-guard'
export const inject = ['agents', 'llm']

export default { apply, inject, name }
