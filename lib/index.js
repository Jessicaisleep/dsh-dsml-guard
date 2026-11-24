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
 *   ② 续跑：只在「发继续能真正解决」时补一条 继续 ——
 *        - 这一轮泄漏且什么都没产出（invoke-block，或正文极短的 tail-close）；
 *        - 本机/上游网络临时波动、单次回复输出 token 到顶（max-tokens，继续能接着写）；
 *        - 上游空响应 / 流中断 / 5xx / 超时这类抖动。
 *      余额、额度、鉴权、上下文总体超限（CONTEXT_WINDOW_EXCEEDED / HTTP_413）、
 *      未知模型这类「发继续也照样报错，只能新开对话或压缩」的一律不续。
 *      同一会话连续续跑上限默认 3 次；中间出现一次正常回复就清零重算。
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

/**
 * schemastery 只在**宿主里**才解析得到：profile 的 node_modules 有它，但插件源码目录
 * （`E:\DSHWORK\DSH插件\dsh-dsml-guard`）没有自己的 node_modules，`node test/run.mjs`
 * 这类离线单测直接用静态 import 会 ERR_MODULE_NOT_FOUND。
 *
 * 所以这里用 createRequire 兜底：拿得到就定义带 `.volatile()` 的 `Config`（宿主设置页
 * 才会自动生成表单）；拿不到（离线测试 / 精简环境）就让 `Config` 为 undefined，
 * 插件其余逻辑（含 resolveConfig 的开关合并）完全照常工作。
 */
let z
try {
  const { createRequire } = await import('node:module')
  z = createRequire(import.meta.url)('@deepseek-ai/schemastery')
} catch {
  z = undefined
}

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
  /**
   * 命中的整段 DSML 工具调用，是「删掉」还是「包进围栏留在正文」。
   *
   * 用户实测（m02746）：整段删掉时那一轮会白跑 —— 宿主 agent-loop 组装完
   * assistant 消息后 `toolCalls.length === 0` 就 `return {kind:'completed'}`，
   * 于是这一轮既没有工具可执行、也没有正文可看，看起来就是「会话停了」。
   * 而空文本块本身不会让历史出错（serialize.ts 会 skip 空的 text block）。
   *
   * 包围栏之后：内容不丢，`track.block` 仍为 true，`decideContinue` 里那条
   * 「DSML 把整段调用写进正文 + 没真发过 tool-call」的补发「继续」照旧生效，
   * 白跑的那一轮照样会被续上。
   */
  const fenceMarkers = options.fenceMarkers === true
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
          // 收尾仍不完整：opener 之后全是标记
          track.leak = true
          track.block = true
          if (fenceMarkers) {
            // 用户要求（m02746）：不删内容，整段包进围栏留在正文。
            // 这里不计进 proseChars —— 它是标记本身，不是模型写的正文。
            out += fenceizeCode(buffer.slice(index), 'text')
          }
          index = buffer.length
          break
        }
        track.leak = true
        track.block = true
        if (fenceMarkers) {
          // 整块工具调用漏进了正文：原样保留内容，只包一层围栏，让它显示成代码块
          // 而不是一段散文（内容一字不动、不伪造 tool-call，理由见 fenceizeCode 上方）。
          out += fenceizeCode(buffer.slice(index, end), 'text')
        }
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
      //
      // 例外：上游常先吐一个被截断的 `<`，紧接着才吐完整标记（`<` + `<｜｜DSML｜｜ ...>`）。
      // 那个孤零零的 `<` 是标记的残渣，不是正文；留着它会让围栏落在行中、
      // markdown 认不出代码块。判定方式：下一个字符也是 `<`，且从那里开始就是完整 opener。
      if (buffer[index + 1] === '<' && RE_OPENER.test(buffer.slice(index + 1))) {
        track.leak = true
        index += 1
        continue
      }
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
export function sanitizeText(text, options = {}) {
  const track = { leak: false, block: false, tailClose: false, proseChars: 0 }
  const sanitizer = createStreamSanitizer({ ...options, track })
  return { text: sanitizer.push(text) + sanitizer.flush(), track }
}

/** 正文里是否出现 DSML 标记（代码围栏内不算，那是讨论语法）。 */
export function detectLeak(text) {
  return sanitizeText(text).track.leak
}

// ── THINKING 泄露：把「标签文字」搬回 reasoning 块 ──────────────────────
/**
 * 为什么是「改块类型」而不是「补标签」：
 *
 * 宿主 DSH 不认识 `<thinking>` 这个语法。TextBlock 里写 `<thinking>…</thinking>`，
 * 它只是一段字面文字，照原样显示、照原样回灌下一轮上下文 —— 补全标签不产生任何效果。
 * 宿主真正认识的思考载体是 `ReasoningBlock`（`{type:'reasoning', text}`），客户端有
 * 专门的折叠渲染器（`ReasoningRow.tsx`）。所以「补齐」的正确等价物是：
 * **把这段内容从 text 块搬到 reasoning 块**。
 *
 * 通道证据：`BlockAssembler.push()` 的 `case 'block-end'` 是
 *   `const partial = this.ensure(chunk.index, chunk.block.type); if (partial.block) return; partial.block = chunk.block`
 * —— `block-end` 携带的 `block.type` 是最终权威，即使 `block-start` 声明的是 text。
 * 而 `agent-loop` 里 `for await (const chunk of stream) live.push(chunk)` 的 stream
 * 正是本插件 `llm/stream` yield 出去的东西，所以改 chunk 就能改落盘历史。
 */
/**
 * 上游把「思考」念进正文时用的标签名。
 *
 * `analysis` 是 0.1.7 依实测补进来的：问题会话 seq=3947 出现
 * `<analysis 彩票代理> Latest mirror patch yields stable reduction…`——
 * 带属性（属性还是噪声）、内容是英文推理，整段漏进正文。全库共 7 例 `<analysis>`。
 */
const THINK_TAG_NAMES = 'thinking|think|reasoning|analysis'
const RE_THINK_OPEN = new RegExp(`<\\s*(?:${THINK_TAG_NAMES})(?:\\s[^>]*)?>`, 'i')
const RE_THINK_CLOSE = new RegExp(`<\\s*/\\s*(?:${THINK_TAG_NAMES})\\s*>`, 'i')
/** 全局版：正文里孤立多出来的闭合标签是坏标签，直接抹掉（真实样本里出现过）。 */
const RE_THINK_CLOSE_ALL = new RegExp(`<\\s*/\\s*(?:${THINK_TAG_NAMES})\\s*>`, 'gi')
/** 流式时最长压住的字符数：够容纳一个带属性的开标签，超过就认为不是标签。 */
const THINK_HOLD = 40

/**
 * 找出正文里的「代码区域」（围栏块 + 行内反引号），返回按起点排序的 `[start, end)` 区间。
 *
 * 为什么需要它：`<think>` 这几个词在正常正文里也会出现 —— 本机 22471 个 text 块里有 7 个
 * 是在**引用别人的 issue / 讨论语法**，例如
 *   「a stray 8-byte `<think>` discards a completed 11.7k-token generation」
 *   「会话里 135 条泄露形态为 `<thinking>**…**</thinking>` 成对」
 * 这些标签在反引号或围栏里，是**被讨论的对象**，不是上游漏出来的思考。若不排除，
 * 它们后面的整段正文会被误判成思考、搬进 reasoning 块（实测 seq=738 会误搬 2083 字）。
 */
function codeRanges(text) {
  const ranges = []
  // ① 围栏块：``` 或 ~~~ 起头，同种符号且长度不短于开启时才算闭合
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/gm
  let openFence = null
  let fence = fenceRe.exec(text)
  while (fence !== null) {
    const mark = fence[1]
    if (openFence === null) {
      openFence = { start: fence.index, mark: mark[0], len: mark.length }
    } else if (openFence.mark === mark[0] && mark.length >= openFence.len) {
      ranges.push([openFence.start, fence.index + fence[0].length])
      openFence = null
    }
    fence = fenceRe.exec(text)
  }
  if (openFence !== null) ranges.push([openFence.start, text.length])
  const covered = (pos) => ranges.some(([a, b]) => pos >= a && pos < b)

  // ② 行内反引号：同段落内（遇空行即放弃）、同等长度的反引号串成对
  let i = 0
  while (i < text.length) {
    const tick = text.indexOf('`', i)
    if (tick === -1) break
    if (covered(tick)) {
      i = tick + 1
      continue
    }
    let runLen = 0
    while (text[tick + runLen] === '`') runLen += 1
    let j = tick + runLen
    let close = -1
    while (j < text.length) {
      const next = text.indexOf('`', j)
      if (next === -1) break
      // 空行代表段落结束，行内代码不跨段
      if (/\n[ \t]*\n/.test(text.slice(j, next))) break
      let len = 0
      while (text[next + len] === '`') len += 1
      if (len === runLen) {
        close = next
        break
      }
      j = next + len
    }
    if (close === -1) {
      i = tick + runLen
      continue
    }
    ranges.push([tick, close + runLen])
    i = close + runLen
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

/**
 * 把一段正文按 thinking 标签切成有序片段（纯函数，测试与 block-end 收口共用）。
 *
 * 真实泄露形态（本机 135 例统计）：117 例标签在块首、18 例在中间；86 例成对闭合、
 * 42 例**没有闭合**（上游生成被截断，标签后直接换块）、6 例双开双闭、1 例一开双闭。
 * 未闭合时，从开标签到文本结尾全部算思考内容 —— 块都结束了，思考当然也结束。
 *
 * @param {string} text 宿主给的 block 全文（未经 DSML 清洗的原文）
 * @returns {Array<{kind: 'thinking' | 'text', text: string}>} 按出现顺序，已合并相邻同类、去掉空片
 */
export function splitThinkingSegments(text) {
  if (typeof text !== 'string' || text === '') return []
  /** @type {Array<{kind: 'thinking' | 'text', text: string}>} */
  const segments = []
  const push = (kind, value) => {
    // 正文片段里若还残留闭合标签，那一定是没有配套开标签的坏标签（真实样本见过
    // `<thinking>a</thinking>\n\n正文…</thinking>`）—— 不当思考，但必须抹掉。
    if (kind === 'text') value = value.replace(RE_THINK_CLOSE_ALL, '')
    if (value === '') return
    const last = segments[segments.length - 1]
    if (last !== undefined && last.kind === kind) last.text += value
    else segments.push({ kind, text: value })
  }

  const protectedRanges = codeRanges(text)
  const isProtected = (pos) => protectedRanges.some(([a, b]) => pos >= a && pos < b)

  let rest = text
  /** `rest[0]` 在原文里的下标（代码区判定要用原文坐标）。 */
  let base = 0
  while (rest !== '') {
    const open = RE_THINK_OPEN.exec(rest)
    if (open === null) {
      push('text', rest)
      break
    }
    push('text', rest.slice(0, open.index))
    // 开标签落在代码区（围栏 / 行内反引号）里 ⇒ 这是在「讨论语法」，不是泄露的思考。
    // 原样当正文，跳过这个标签继续往后找。
    if (isProtected(base + open.index)) {
      push('text', open[0])
      base += open.index + open[0].length
      rest = rest.slice(open.index + open[0].length)
      continue
    }
    let after = rest.slice(open.index + open[0].length)
    base += open.index + open[0].length
    const close = RE_THINK_CLOSE.exec(after)
    if (close === null) {
      push('thinking', after)
      break
    }
    push('thinking', after.slice(0, close.index))
    rest = after.slice(close.index + close[0].length)
    base += close.index + close[0].length
    // 闭合标签后紧跟的换行属于排版，不留在正文开头
    if (rest.startsWith('\r\n')) {
      rest = rest.slice(2)
      base += 2
    } else if (rest.startsWith('\n')) {
      rest = rest.slice(1)
      base += 1
    }
  }
  return segments
}

/**
 * 正文里有没有「孤立多出来的」闭合标签（没有对应开标签）。
 *
 * 真实样本里出现过 `<thinking>a</thinking>\n\n正文…</thinking>` 这种：开标签被上游
 * 吞掉过一次，剩一个孤零零的 `</thinking>` 留在正文尾部。它不需要当成思考，但绝不该
 * 留在正文里给用户看。
 */
export function hasOrphanThinkClose(text) {
  if (typeof text !== 'string' || text === '') return false
  const opens = text.match(new RegExp(RE_THINK_OPEN.source, 'gi'))?.length ?? 0
  const closes = text.match(RE_THINK_CLOSE_ALL)?.length ?? 0
  return closes > opens
}

export function detectThinkingLeak(text) {
  return splitThinkingSegments(text).some((segment) => segment.kind === 'thinking')
}

/**
 * 流式闸门：把「正在思考」的那一段从正文流里截下来，不让它先以正文形式闪一下；
 * 同时把截下来的思考内容按顺序记账，交给 block-end 一次性转成 reasoning 块。
 *
 * 注意它工作在 **DSML 清洗之后**：输入已是 sanitizer 吐出的可见正文。
 */
export function createThinkingGate() {
  /** 每个 block index 的有序片段（prose / thinking 交替） */
  const pieces = new Map()
  let index = 0
  let buffer = ''
  let inside = false
  /**
   * 本块已经放行出去的正文。判断「标签是不是在代码区里」需要看它前面的上下文
   * （围栏开没开、行内反引号配没配对），而 `buffer` 只是还没放行的那一小段。
   */
  let seen = ''

  const bucket = () => {
    let list = pieces.get(index)
    if (list === undefined) {
      list = []
      pieces.set(index, list)
    }
    return list
  }
  const push = (kind, value) => {
    if (value === '') return
    const list = bucket()
    const last = list[list.length - 1]
    if (last !== undefined && last.kind === kind) last.text += value
    else list.push({ kind, text: value })
  }

  /** 缓冲区末尾是否可能是「还没写完的标签」，是则返回该起始位置。 */
  const holdFrom = (text) => {
    const from = Math.max(0, text.length - THINK_HOLD)
    const lt = text.lastIndexOf('<')
    if (lt < from) return -1
    const tail = text.slice(lt)
    // 已是完整标签 → 不必压；只有「< 加若干字母、还没收尾」才压
    return /^<\s*\/?[a-zA-Z]{0,10}$/.test(tail) ? lt : -1
  }

  /** 某个绝对位置是否落在代码区（围栏 / 行内反引号）里。 */
  const isProtectedAt = (pos) => codeRanges(seen + buffer).some(([a, b]) => pos >= a && pos < b)

  return {
    /** 设定当前流到哪个 block。 */
    at(nextIndex) {
      index = nextIndex
      seen = ''
    },
    /**
     * 喂一段可见正文。
     * @returns {string} 现在就可以当正文发出去的部分（其余被压住或归入思考）
     */
    push(text) {
      buffer += text
      /** 本轮起点快照：`buffer` 永远只从头部切片，所以「消耗了多少」= 长度差。 */
      const snapshot = buffer
      let out = ''
      for (;;) {
        if (!inside) {
          const open = RE_THINK_OPEN.exec(buffer)
          if (open !== null && isProtectedAt(seen.length + open.index)) {
            // 落在代码区里的标签是「被讨论的语法」，当正文放行。
            out += buffer.slice(0, open.index + open[0].length)
            buffer = buffer.slice(open.index + open[0].length)
            continue
          }
          if (open !== null) {
            out += buffer.slice(0, open.index)
            buffer = buffer.slice(open.index + open[0].length)
            inside = true
            continue
          }
          const hold = holdFrom(buffer)
          if (hold >= 0) {
            out += buffer.slice(0, hold)
            buffer = buffer.slice(hold)
            break
          }
          out += buffer
          buffer = ''
          break
        }
        const close = RE_THINK_CLOSE.exec(buffer)
        if (close !== null) {
          push('thinking', buffer.slice(0, close.index))
          buffer = buffer.slice(close.index + close[0].length)
          inside = false
          if (buffer.startsWith('\r\n')) buffer = buffer.slice(2)
          else if (buffer.startsWith('\n')) buffer = buffer.slice(1)
          continue
        }
        const hold = holdFrom(buffer)
        if (hold >= 0) {
          push('thinking', buffer.slice(0, hold))
          buffer = buffer.slice(hold)
          break
        }
        push('thinking', buffer)
        buffer = ''
        break
      }
      seen += snapshot.slice(0, snapshot.length - buffer.length)
      // out 里只可能是正文（思考都被 push 进片段表了）。若正文里冒出没有配套开标签的
      // 闭合标签，那是上游把开标签弄丢了 —— 抹掉，别让用户看到。
      return out.replace(RE_THINK_CLOSE_ALL, '')
    },
    /** 块结束：把压住的内容与未闭合的思考全部结算，返回该块的完整片段表。 */
    settle(atIndex = index) {
      const target = atIndex
      if (buffer !== '') {
        const keep = index
        index = target
        push(inside ? 'thinking' : 'text', buffer)
        buffer = ''
        index = keep
      }
      const list = pieces.get(target) ?? []
      pieces.delete(target)
      const merged = []
      for (const piece of list) {
        const last = merged[merged.length - 1]
        if (last !== undefined && last.kind === piece.kind) last.text += piece.text
        else merged.push({ ...piece })
      }
      return merged
    },
    /** 丢掉某个 block 的记账（流里出现异常重复 index 时用）。 */
    forget(atIndex = index) {
      pieces.delete(atIndex)
    },
  }
}

// ── 代码泄露：把「念出来的命令 / 补丁」包进代码围栏 ────────────────────
/**
 * 为什么是「包围栏」而不是「改成 tool-call」：
 *
 * 用户实测的泄露（问题会话 `session-26470037…`）是模型**把要执行的命令念进正文**，
 * 却没有真的发起 pwsh / apply_patch 调用：
 *   · `seq=3141`（415 字符）：`$ffmpeg='…ffmpeg.exe'; $dir='…'; foreach($f in @('S01_remade_1080p.mp4',…)){…}`
 *   · `seq=3316`（576 字符）：`$blender='…blender.exe'; $blend='…blend'; $script=@' import bpy … '@; & $blender …`
 *   · `seq=2675`（8113 字符）：`*** Begin Patch / *** Add File: …motion_v02.py / +…`（28 行 `+`）
 * 这几段在任何 tool-call 的 `arguments` 里都**找不到**（`_dup.py` 验证），也就是说命令
 * 从未被执行。把文本伪造成 tool-call 会让宿主真的去执行模型没发起的命令 —— 改文件、
 * 跑渲染，副作用不可逆。因此这里只做显示层归位：**原样保留内容，包进 markdown 围栏**，
 * 让它显示成代码块而不是一段散文。
 *
 * 判据刻意收得很紧（块级、起点锚定），因为真实数据里 25345 个 text 块只有 3 例这种形态；
 * 宁可漏判，也不能把正常的 markdown 围栏或行内 `$` 误包一层。
 */

/** 命令/补丁文本的起点特征：`$var=` 开头的 PowerShell，或 `*** Begin Patch`。 */
const RE_CODE_LEAK_START = /^\s*(?:\$\w+\s*=|\*\*\*[ \t]*Begin[ \t]+Patch\b)/

/** 流式判定用：这一小段「还有可能」是代码泄露的开头吗（要等够字符才能确定）。 */
function looksLikeCodeLeakPrefix(text) {
  const trimmed = text.replace(/^[\s\uFEFF]+/, '')
  if (trimmed === '') return true
  if (trimmed[0] === '$') return true
  if (trimmed[0] === '*') {
    // 只有 `*` / `**` 这种还可能是 `*** Begin Patch` 的前缀才继续等
    return trimmed.length < 3 && '***'.startsWith(trimmed)
  }
  return false
}

/**
 * 判断一整段文字是否属于「命令/补丁念进正文」。
 *
 * @param {string} text
 * @returns {'diff' | 'powershell' | null} 命中的围栏语言，未命中返回 null
 */
export function detectCodeLeak(text) {
  if (typeof text !== 'string') return null
  const body = text.trim()
  if (body === '') return null
  if (/^\*\*\*[ \t]*Begin[ \t]+Patch\b/i.test(body) && /\*\*\*[ \t]*End[ \t]+Patch\b/i.test(body)) {
    return 'diff'
  }
  if (/^\$\w+\s*=/.test(body)) {
    // 必须同时出现「执行/取路径/循环」这类形态，否则可能只是一句提到变量的说明
    if (/(?:&\s*['"$]|\bforeach\s*\(|\bJoin-Path\b|\bTest-Path\b|\bWrite-Output\b)/i.test(body)) {
      return 'powershell'
    }
  }
  return null
}

/**
 * 把一段代码泄露文本包进围栏（原文一字不动，只是加上围栏行）。
 *
 * 围栏字符按内容自适应：CommonMark 规定「关闭围栏的反引号数必须 ≥ 开启围栏」，
 * 所以待包内容里若本身含 ``` 行（例如模型念出来的命令里嵌了 markdown 示例），
 * 用三个反引号包就会被撑破、后面整篇都被渲染成代码块。做法：找内容里最长的
 * 连续反引号串，取比它长一位的围栏；内容没有反引号时仍用最常见的三反引号。
 */
export function fenceizeCode(text, lang) {
  const body = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (body === '') return text
  const longest = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return ticks + lang + '\n' + body + '\n' + ticks
}

// ── 续跑判据 ─────────────────────────────────────────────────────────
/**
 * 报文里「本机/上游网络临时波动」的明确信号。
 *
 * 上游常把传输层失败误分类成 `INVALID_REQUEST`（本机 88 个 INVALID_REQUEST 里
 * 大量是 `400: read body: read tcp 127.0.0.1:...: i/o timeout`）。这类发继续
 * 能真正解决。对照 @aiwayds/dsh-llm-net-retry 的 collectErrorStrings → 分类盲区
 * 做法，只认明确的传输层信号，避免把「余额不足 / prompt 太长 / 体积过大」误判成可续。
 */
const RE_TRANSIENT_MESSAGE =
  /\b(?:i\/o timeout|read tcp|connection reset|connection refused|socket hang up|network[_ ]error|unexpected eof|stream[_ ](?:read[_ ]error|interrupted|closed)|bad record mac|econnreset|econnrefused|etimedout|epipe|eai_again|tls handshake|timed out)\b/i

/**
 * 顶层码里属于「上游把什么都往里塞」的兜底分类，允许用报文推翻顶层判定。
 * 明确的永久错误码（QUOTA / AUTH / CONTEXT_WINDOW_EXCEEDED / HTTP_413 …）不在此列，
 * 信任码本身，不被报文带偏 —— 保留用户已验收的行为。
 */
const MISCLASSIFIED_CODES = new Set([
  'INVALID_REQUEST',
  'CLIENT_ERROR',
  'PI_AI_ERROR',
  'UNKNOWN',
  'MALFORMED_RESPONSE',
  'EMPTY_RESPONSE',
  'STREAM_CLOSED',
  'NETWORK_ERROR',
])

/**
 * 宿主自己已经在**同一个 step 内**重试过的错误码。
 *
 * DSH ≥0.2.2 的模型设置页多了「重试策略」（默认「仅临时错误」），执行器是
 * `@deepseek-ai/dsh-llm-retry`：它挂在 `agent/request-error` 上，重跑失败的 step
 * （同一 turn、同一份持久历史），默认 5 次、500ms→10s 指数退避、带 ±10% 抖动，
 * 默认可重试集就是 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`
 * （asar 实测 0.2.2-rc.3：dsh-llm/lib/index.js 的 DEFAULT_RETRYABLE_CODES）。
 *
 * 与本插件 `retryCodes` 的交集就是下面这四个码。交集部分由宿主兜住之后，插件再补一条
 * 「继续」等于对同一份请求再打一轮 —— 拿到 turn/end 时重试早就耗尽了。
 * 所以默认交给宿主，插件只保留宿主不管的那部分（`MALFORMED_RESPONSE` / `PI_AI_ERROR` /
 * `UNKNOWN` / `STREAM_CLOSED` / `NETWORK_ERROR` 与报文化细分）。
 *
 * 刻意不含 `RATE_LIMIT`：插件本来就不续它（见 `neverCodes`），不是重叠面。
 */
export const HOST_RETRIED_CODES = new Set([
  'EMPTY_RESPONSE',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

function looksTransient(message) {
  return RE_TRANSIENT_MESSAGE.test(message)
}

/**
 * 报文里「发继续也修不好」的凭据/配置类永久错误。
 * 这些本该由各自的顶层码（AUTH / MISSING_CREDENTIAL / UNKNOWN_MODEL / QUOTA）拦下，
 * 但本机出现过被塞进 `UNKNOWN`（`未配置凭据，请先登录`）的情形。按报文否决，
 * 与「载荷级分类」的市场做法一致。刻意避开 `credits / add credits` 这类含糊措辞 ——
 * PI_AI_ERROR 常见的 `in_flight_budget_exhausted` 写的是 "Retry after in-flight
 * requests settle"，那其实是可重试的，不能被误杀。
 */
const RE_PERMANENT_MESSAGE =
  /(?:no usable credential|未配置凭据|请先登录|log in first|missing credential|token expired or incorrect|insufficient balance|has no configured model|no configured model)/i

function looksPermanent(message) {
  return RE_PERMANENT_MESSAGE.test(message)
}

/**
 * 这个错误码是否被设置页明确取消勾选了。
 *
 * 与「不在 retryCodes 里」是两件事：retryCodes 只决定**最后一步**放不放行，
 * 而 MISCLASSIFIED_CODES 那段会先按报文把码重新判成可续。所以取消勾选必须是
 * 一道前置闸门，否则「关掉 TIMEOUT」会被报文里的 `timed out` 绕过。
 */
function disabled(cfg, code) {
  return Array.isArray(cfg?.disabledCodes) && cfg.disabledCodes.includes(code)
}

/**
 * 这个错误码是否被设置页**显式勾选**（用户要求插件也接手）。
 *
 * 与 `retryCodes.includes(code)` 的区别：默认 `retryCodes` 里就含 TRANSPORT/TIMEOUT 等
 * 宿主重叠码，但宿主豁免会先一步拦下它们。只有用户亲手勾上（进 forceCodes）才算「想接手」，
 * 但**能不能真的接手还要看宿主重试是否在生效**（见 `hostRetryActive`）。
 */
function forced(cfg, code) {
  return Array.isArray(cfg?.forceCodes) && cfg.forceCodes.includes(code)
}

/**
 * 用户亲手勾上、且这个码**允许越过 `neverCodes`** 的黑名单拦截。
 *
 * 背景：`neverCodes` 里多数是「发继续只会照样报错」的码（配额、上下文超限、缺凭据），
 * 这些不该给用户「勾了就能救」的错觉。但实测里有两类例外 ——
 *   · `AUTH`：44 次里 13 次续跑、7 次跑完整轮，用户换密钥/换额度后发继续确实能接着干；
 *   · `INVALID_REQUEST`：89 次里 54 次续跑、20 次跑完整轮，其中大量是本机
 *     `read tcp … i/o timeout` 被误分类成 400，这类续跑有效。
 * 所以这两个码留在 `neverCodes`（默认不续）但标了 `forceable`：勾上才越过。
 * `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `MISSING_CREDENTIAL` 没有这个标记，勾了也拦。
 */
function forceable(cfg, code) {
  if (!forced(cfg, code)) return false
  const option = CODE_OPTIONS.find((candidate) => candidate.code === code)
  return option?.forceable === true
}

/**
 * 本轮 DSH 自带的「重试策略」（`@deepseek-ai/dsh-llm-retry`）是否真的在生效。
 *
 * 判据只用**运行时证据**：本轮里出现过 `llm/retry` 事件就说明宿主确实接管了这个错误码
 * 并排了退避重试；没出现过就说明它没接手（provider 没配 retryPolicy、该码不在
 * `retryableCodes` 里、或 llm-retry 根本没装）。
 *
 * 为什么不读 provider 的 retryPolicy：那份配置在 provider 注册表里，插件侧没有稳定读口；
 * 而 `llm/retry` 是宿主自己 `agent.session.append` 出来的事实，比读配置更可靠 ——
 * 「配置里写着要重试」和「这次真的重试了」是两件事，用户要的是后者。
 */
function hostRetryActive(state) {
  return state?.hostRetry === true
}

/**
 * 可在设置页逐项勾选的「自动续跑错误类型」注册表。
 *
 * 为什么每个码一个独立开关、而不是一个数组：
 *   0.2.2-rc.5 的 `validateVolatilePlacement` 禁止 volatile 字段出现在数组元素里
 *   （`volatile fields require a fixed object path without an enclosing volatile field`），
 *   而只有 volatile 字段能被设置页写入且不重启插件。所以「多选」= 一组 boolean。
 *
 * `group` 决定这一项是否与 DSH 自带「重试策略」重复（用户要求：重复项要写明、
 * 默认不勾、以 DSH 自带重试优先）。
 */
export const CODE_OPTIONS = [
  // ── 与 DSH 自带「重试策略」重复（默认不勾）──────────────────────────
  {
    field: 'retryEmptyResponse',
    code: 'EMPTY_RESPONSE',
    label: '空响应',
    hint: '上游返回了空内容，既没有正文也没有工具调用。与 DSH 设置里的「空响应」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryMalformedResponse',
    code: 'MALFORMED_RESPONSE',
    label: '响应格式错误',
    hint: '上游返回的数据结构无法解析。与 DSH 设置里的「响应格式错误」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryQuota',
    code: 'QUOTA',
    label: '配额已用尽',
    hint: '账号额度或余额已耗尽，续跑也只会再报一次。与 DSH 设置里的「配额已用尽」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryRateLimit',
    code: 'RATE_LIMIT',
    label: '请求限流',
    hint: '请求太频繁被上游限流。与 DSH 设置里的「请求限流」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryServer',
    code: 'SERVER',
    label: '服务器错误',
    hint: '上游返回 5xx 服务器故障。与 DSH 设置里的「服务器错误」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryStreamClosed',
    code: 'STREAM_CLOSED',
    label: '流提前结束',
    hint: '上游在正常收尾前关闭了输出流。与 DSH 设置里的「流提前结束」重复。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryTimeout',
    code: 'TIMEOUT',
    label: '超时',
    hint: '请求超时或流空闲超时（例如「Request timed out.」「pi-ai stream idle timeout」）。与 DSH 设置里的「超时」重复。本机实测 23 次里续跑 11 次、只有 2 次真出内容。',
    group: 'dsh',
    defaultOn: false,
  },
  {
    field: 'retryTransport',
    code: 'TRANSPORT',
    label: '网络中断',
    hint: '传输层断开或连接失败（例如「Connection error.」「upstream stream ended before a completion event」）。与 DSH 设置里的「网络错误」重复。本机实测 10 次里续跑 4 次、全部没有产出，靠继续基本救不回来。',
    group: 'dsh',
    defaultOn: false,
  },

  // ── 插件自有（DSH 自带重试不含，默认勾选）────────────────────────────
  {
    field: 'retryPiAiError',
    code: 'PI_AI_ERROR',
    label: '上游流被中断',
    hint: '上游响应流意外中断（例如「Upstream response stream was interrupted」）。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: true,
  },
  {
    field: 'retryUnknown',
    code: 'UNKNOWN',
    label: '未分类错误',
    hint: '上游返回了无法归类的错误，插件会按报错文本再判断是否值得续跑。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: true,
  },
  {
    field: 'retryNetworkError',
    code: 'NETWORK_ERROR',
    label: '网络错误（插件侧）',
    hint: 'DNS、TLS 或 socket 层网络错误。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: true,
  },
  {
    field: 'retryMaxTokens',
    code: 'MAX_TOKENS',
    label: '输出被截断',
    hint: '单次回复达到输出 token 上限，续跑能接着写。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: true,
  },
  {
    field: 'retryAuth',
    code: 'AUTH',
    label: '鉴权失败 / 密钥无效',
    hint: 'API 密钥无效或鉴权失败，界面上会显示成「API 密钥无效」。本机实测 44 次里续跑 13 次、10 次真出内容、7 次跑完整轮（换密钥/换额度后继续确实能接着干），所以留成可选项但不默认勾。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: false,
    // 允许勾选后越过 neverCodes：用户实测「换了密钥再发继续」是有效路径。
    forceable: true,
  },
  {
    field: 'retryInvalidRequest',
    code: 'INVALID_REQUEST',
    label: '请求被上游拒绝',
    hint: '上游返回 400/非预期拒绝。本机实测 89 次里续跑 54 次、34 次真出内容、20 次跑完整轮 —— 其中大量是 `read tcp … i/o timeout` 被误分类成 InvalidRequest，这类续跑有效；真正的坏请求仍会被报文判据拦下。DSH 自带重试不含此码。',
    group: 'plugin',
    defaultOn: false,
    // 同上：勾选后允许越过 neverCodes（默认不勾，行为不变）。
    forceable: true,
  },
]

/** 字段名 → 注册项，便于按开关反查错误码。 */
const CODE_BY_FIELD = new Map(CODE_OPTIONS.map((option) => [option.field, option]))

const DEFAULT_CONFIG = {
  enabled: true,
  /** 把泄漏的标记从显示里抹掉。 */
  sanitize: true,
  /**
   * DSML 整段工具调用漏进正文时：不删掉，包进代码围栏留在正文（0.1.9 起，默认开）。
   *
   * 为什么改（用户实测 m02746）：删掉会让那一轮白跑 —— 宿主 agent-loop 组装完
   * assistant 消息后 `toolCalls.length === 0` 就 `return {kind:'completed'}`，
   * 这一轮既没有工具可执行也没有正文可看。而空 text block 不会让历史出错
   * （serialize.ts 会 skip）。包围栏后内容不丢，`track.block` 仍为 true，
   * 「没真发过 tool-call」的补发「继续」照旧生效。
   */
  dsmlToFence: true,
  /**
   * THINKING 泄露：把正文里 `<thinking>…</thinking>` 的那一段搬回 reasoning 块。
   *
   * 为什么不是「补齐标签」：DSH 不认识 `<thinking>` 这个语法，补全标签它也只是字面文字。
   * 真正能让它变成「思考」的通道是 `block-end` 的 `block.type`（BlockAssembler 以它为准），
   * 所以这里做的是把这段文字从 text 块搬到 reasoning 块 —— 渲染上就是那个可折叠的思考行。
   * 见 `splitThinkingSegments` / `createThinkingGate` 上面的长注释。
   */
  thinkingToReasoning: true,
  /**
   * 代码泄露：上游把「准备执行的命令 / 补丁」念进正文时，把这段包进代码围栏。
   *
   * 只做显示层归位（内容一字不改、不进 tool-call、不改变执行语义），原因见
   * `detectCodeLeak` 上面的长注释。默认开。
   */
  codeLeakFence: true,
  /** 自动补发 继续。 */
  autoContinue: true,
  continueText: '继续',
  /** 同一会话连续续跑的上限，超过就停下等人（用户要求：连续 3 次失败后不再发继续）。 */
  maxConsecutive: 3,
  /**
   * 发「继续」能真正解决的失败：网络/上游临时波动、单次回复输出 token 到顶、空响应。
   * 依据本机 317 个 error 轮报文 + 市场同类插件对比（dsh-auto-continue / dsh-llm-net-retry）：
   *   · EMPTY_RESPONSE / STREAM_CLOSED / NETWORK_ERROR 属官方可重试集 / 分类盲区，本机 0 次但可能出现；
   *   · PI_AI_ERROR / MALFORMED_RESPONSE / SERVER / TIMEOUT / TRANSPORT / UNKNOWN 是既有上游抖动集。
   * 刻意不内置 QUOTA / RATE_LIMIT：本机报文显示是账号受限/余额不足/定时解禁，1–2 秒后立即发继续无益，
   * 且 dsh-llm 已在 step 内带退避重试过 RATE_LIMIT；保留用户已验收行为。
   */
  retryCodes: [
    'TIMEOUT',
    'TRANSPORT',
    'SERVER',
    'MALFORMED_RESPONSE',
    'PI_AI_ERROR',
    'UNKNOWN',
    'EMPTY_RESPONSE',
    'STREAM_CLOSED',
    'NETWORK_ERROR',
  ],
  /** 发继续只会再报一次同样的错，不续（尤其上下文总体超限：只能新开对话/压缩）。 */
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
    'CLIENT_ERROR',
    'INVALID_REQUEST',
  ],
  /** tail-close 且正文短于这个字符数，视为「这一轮什么都没产出」。 */
  tailCloseMinChars: 80,
  /**
   * ★ 与宿主重叠部分的开关（0.1.4）。
   * true（默认）= 与 DSH 自己的「重试策略」重叠的四个码
   *   （`EMPTY_RESPONSE / SERVER / TIMEOUT / TRANSPORT`，见 `HOST_RETRIED_CODES`）
   *   交给 `@deepseek-ai/dsh-llm-retry` 在 step 内退避重试，插件不再叠加一条「继续」，
   *   避免同一份请求被打两遍。
   * false = 恢复 0.1.3 的行为：宿主重试耗尽、turn 报错之后，插件再补一条继续兜底。
   * 什么时候该切 false：宿主根本没有这套重试时 —— DSH < 0.2.2，或从 profile 的
   * `cordis.patch.yml` 里摘掉了 `llm-retry` 那一行。（设置页只有 normal / always 两档，
   * 删掉 `retryPolicy` 并不等于关掉重试：llm-deepseek 的缺省就是 normal + 5 次。）
   * 代码里两套判据都保留，这里只是把重叠的那部分关掉，不删逻辑。
   */
  skipHostRetriedCodes: true,
}

/**
 * 设置页可见的配置字段（schemastery）。
 *
 * 两条硬约束决定了它的形状：
 *   ① 只有标了 `.volatile()` 的字段能被设置页写入，且改完**不重启插件**、原地生效；
 *   ② `validateVolatilePlacement` 禁止 volatile 字段出现在数组元素里
 *      （`volatile fields require a fixed object path without an enclosing volatile field`），
 *      所以「错误类型多选」只能拆成 14 个独立 boolean，不能是一个数组。
 *
 * `retryCodes` / `neverCodes` 刻意不进这里：它们是内部判据数组，由 DEFAULT_CONFIG 兜底，
 * 用户在界面上看到的是上面的 boolean 勾选框。
 *
 * `z` 拿不到时（离线单测）这里就是 undefined —— 宿主没拿到 schema 只按 profile 的 yaml
 * 取值，行为与 0.1.4 一致；判据本身由 resolveConfig 兜底，不受影响。
 */
export const Config =
  z === undefined
    ? undefined
    : z.object({
        /** 总开关：关掉后既不洗标记也不续跑。 */
        enabled: z.boolean().default(true).volatile(),
        /** DSML 补全：把漏进正文的标记抹掉。 */
        sanitize: z.boolean().default(true).volatile(),
        /** DSML 整段工具调用漏进正文时，包进代码围栏留在正文（不删内容）。 */
        dsmlToFence: z.boolean().default(true).volatile(),
        /** THINKING 泄露：把 `<thinking>…</thinking>` 那段从正文搬回思考块。 */
        thinkingToReasoning: z.boolean().default(true).volatile(),
        /** 代码泄露：把念进正文的命令/补丁包进代码围栏。 */
        codeLeakFence: z.boolean().default(true).volatile(),
        /** 自动补发「继续」。 */
        autoContinue: z.boolean().default(true).volatile(),
        /** 补发的内容（默认「继续」）。 */
        continueText: z.string().default('继续').volatile(),
        /** 同一会话连续续跑上限。 */
        maxConsecutive: z.number().step(1).min(1).max(100).default(3).volatile(),
        /** tail-close 且正文短于这个字符数时视为「什么都没产出」。 */
        tailCloseMinChars: z.number().step(1).min(1).default(80).volatile(),
        /** 与 DSH 自带「重试策略」重叠的码是否交给宿主处理（默认交）。 */
        skipHostRetriedCodes: z.boolean().default(true).volatile(),

        // ── 14 个错误类型勾选框（顺序与 CODE_OPTIONS 一致，勿单独增删）────
        retryEmptyResponse: z.boolean().default(false).volatile(),
        retryMalformedResponse: z.boolean().default(false).volatile(),
        retryQuota: z.boolean().default(false).volatile(),
        retryRateLimit: z.boolean().default(false).volatile(),
        retryServer: z.boolean().default(false).volatile(),
        retryStreamClosed: z.boolean().default(false).volatile(),
        retryTimeout: z.boolean().default(false).volatile(),
        retryTransport: z.boolean().default(false).volatile(),
        retryPiAiError: z.boolean().default(true).volatile(),
        retryUnknown: z.boolean().default(true).volatile(),
        retryNetworkError: z.boolean().default(true).volatile(),
        retryMaxTokens: z.boolean().default(true).volatile(),
        retryAuth: z.boolean().default(false).volatile(),
        retryInvalidRequest: z.boolean().default(false).volatile(),
      })

/** 从配置对象里读值：兼容 schemastery 的 ref（有 `.get()`）与普通对象。 */
function slotValue(slot) {
  if (slot === undefined || slot === null) return undefined
  if (typeof slot === 'object' && typeof slot.get === 'function') return slot.get()
  return slot
}

/**
 * 把「插件配置」（可能是 schemastery 的 ref 对象，也可能是普通对象/未给）归一成
 * `resolveConfig` 认识的普通对象。
 *
 * 为什么要每次重新读：volatile 字段改动不会重启插件，`apply` 里不能只读一次快照，
 * 否则设置页改了开关要等下次重启才生效。`loader/volatile-update` 时重新归一即可。
 */
function readConfigSource(source) {
  if (source === undefined || source === null) return {}
  const plain = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = slotValue(source[key])
    if (value !== undefined) plain[key] = value
  }
  for (const option of CODE_OPTIONS) {
    const value = slotValue(source[option.field])
    if (value !== undefined) plain[option.field] = value
  }
  return plain
}

/**
 * 从 `CODE_OPTIONS` 的 boolean 开关里读出「显式开启」和「显式关闭」的码。
 *
 * 只认**显式给出 boolean** 的字段：
 *   - 一个都没有（例如老 profile 里只有 retryCodes 数组、或单测直接 `resolveConfig({})`）
 *     → 返回 undefined，继续沿用 `retryCodes` / `neverCodes` 数组，行为与 0.1.4 完全一致；
 *   - 有（设置页总会写全 13 个）→ 这些开关成为权威，数组按差集合并。
 * 这样「加设置页」不会悄悄改掉老用户既有的续跑行为。
 */
function pickCodeSwitches(raw) {
  const present = CODE_OPTIONS.filter((option) => typeof raw?.[option.field] === 'boolean')
  if (present.length === 0) return undefined
  return {
    on: new Set(present.filter((option) => raw[option.field] === true).map((option) => option.code)),
    off: new Set(present.filter((option) => raw[option.field] === false).map((option) => option.code)),
  }
}

export function resolveConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  merged.maxConsecutive = Math.max(1, Math.min(100, Number(merged.maxConsecutive) || 3))
  merged.tailCloseMinChars = Math.max(1, Number(merged.tailCloseMinChars) || 80)
  merged.retryCodes = Array.isArray(merged.retryCodes) ? merged.retryCodes : DEFAULT_CONFIG.retryCodes
  merged.neverCodes = Array.isArray(merged.neverCodes) ? merged.neverCodes : DEFAULT_CONFIG.neverCodes
  // 开关只认显式 false：缺省、undefined、写错类型一律按「关闭重叠」处理。
  merged.skipHostRetriedCodes = merged.skipHostRetriedCodes !== false
  // THINKING 归位同理：只有显式 false 才算关（默认开，缺省不该悄悄失效）。
  merged.thinkingToReasoning = merged.thinkingToReasoning !== false
  // 代码围栏同理。
  merged.codeLeakFence = merged.codeLeakFence !== false
  // DSML 整段调用包围栏同理（只有显式 false 才回到「整段删掉」的旧行为）。
  merged.dsmlToFence = merged.dsmlToFence !== false

  const switches = pickCodeSwitches(merged)
  if (switches === undefined) {
    merged.disabledCodes = []
    merged.forceCodes = []
  } else {
    const kept = merged.retryCodes.filter((code) => !switches.off.has(code))
    const added = [...switches.on].filter((code) => !kept.includes(code))
    merged.retryCodes = [...kept, ...added]
    /**
     * 显式勾选的码 = 用户要求「这一条我要插件也接手」。
     *
     * 它必须能越过 `HOST_RETRIED_CODES` 那道豁免：那四个码（EMPTY_RESPONSE /
     * SERVER / TIMEOUT / TRANSPORT）默认交给宿主 llm-retry，若插件此时再补一条
     * 就是同一份请求打两遍。但设置页里给它们留了勾选框，勾上就代表用户明确要求
     * 叠加一层兜底 —— 否则勾选框形同装饰。所以「显式勾选」只放开宿主豁免，
     * 不放宽 neverCodes（配额、鉴权这类永远不发）。
     */
    merged.forceCodes = [...switches.on]
    // 显式关掉的码要能被 decideContinue 提前拦下：光把它从 retryCodes 里拿掉还不够，
    // MISCLASSIFIED_CODES 那段会按报文把它重新判成「可续」。
    merged.disabledCodes = [...switches.off]
  }
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

  // 单次回复输出 token 到顶（finish_reason=max_tokens）：上游把答案截断了，
  // 发「继续」能接着写。与「上下文总体超限」(CONTEXT_WINDOW_EXCEEDED / HTTP_413)
  // 是不同的东西 —— 后者发继续只会再报一次 prompt is too long。
  // asar 实证：turn/end.reason = {kind:'max-tokens'}，无 error 对象，本机 7 次。
  if (reason?.kind === 'max-tokens') {
    if (disabled(cfg, 'MAX_TOKENS') || cfg.neverCodes.includes('MAX_TOKENS')) {
      return { retry: false, why: 'MAX_TOKENS 被配置成不续' }
    }
    return { retry: true, why: '单次回复输出 token 到顶，继续能接着写' }
  }

  if (reason?.kind === 'error') {
    const code = String(reason.error?.code ?? '')
    const message = String(reason.error?.message ?? '')

    // 设置页上被明确取消勾选的类型：无条件不续。
    // 必须放在 MISCLASSIFIED 报文判定之前 —— 否则「关掉 TIMEOUT」会被报文里的
    // `timed out` 重新判成可续，勾选框等于失效。
    if (disabled(cfg, code)) {
      return { retry: false, why: `${code} 已在设置里被取消勾选` }
    }

    /**
     * 与 DSH 自带「重试策略」重叠的四个码：只要宿主这一轮**确实在重试**，就不叠加「继续」。
     *
     * 用户要求（m00691）：勾上重叠码时不能无条件放行，要先检测 DSH 自带重试是否在生效；
     * 生效则勾了也不续，并提示「取消 DSH 自带重试后本选项才生效」。
     *
     * 「是否在生效」的判据是**运行时事实** `hostRetryActive(state)`（本轮出现过 `llm/retry`
     * 事件），不是 provider 配置：配置里写着要重试 ≠ 这次真重试了，而用户要的是后者。
     */
    if (cfg.skipHostRetriedCodes !== false && HOST_RETRIED_CODES.has(code)) {
      if (hostRetryActive(state)) {
        return {
          retry: false,
          why: forced(cfg, code)
            ? `${code} 已在设置里勾选，但 DSH 自带重试此刻仍在生效；取消 DSH 自带的「重试策略」后本选项才生效`
            : `${code} 已由宿主的重试策略在 step 内处理`,
        }
      }
      // 宿主这一轮没重试（没装 llm-retry、provider 没配 retryPolicy、或该码不在
      // retryableCodes 里）⇒ 重叠码处于「无人兜底」状态，勾了就由插件接手。
      if (forced(cfg, code)) {
        return { retry: true, why: `${code} 已勾选，且 DSH 自带重试本轮未生效，由插件续跑` }
      }
      // 没勾选：重叠码一律交给宿主这条通道，不走下面的 retryCodes —— 它们默认就在
      // retryCodes 里，穿透下去会把「默认交给宿主」翻成「插件补发」，那是 0.1.4 之前的行为。
      return { retry: false, why: `${code} 属于 DSH 自带重试覆盖的类型，插件默认不叠加` }
    }

    // 明确的永久错误（余额/额度/上下文/体积/鉴权）按码否决，信任码本身，
    // 不被报文里的网络措辞带偏 —— 保留用户已验收的「上下文总体超限不续」。
    // `forceable` 的两个码（AUTH / INVALID_REQUEST）勾上后放行，见 `forceable()`。
    if (cfg.neverCodes.includes(code) && !MISCLASSIFIED_CODES.has(code) && !forceable(cfg, code)) {
      return { retry: false, why: `${code} 发继续也会照样报错` }
    }
    // 兜底 / 易误分类的码（UNKNOWN / PI_AI_ERROR / INVALID_REQUEST …）：用报文细分。
    // 这类码上游什么都往里塞，需要按实际报文判断「继续能否真正解决」。
    if (MISCLASSIFIED_CODES.has(code) || code === '') {
      if (looksPermanent(message)) {
        return { retry: false, why: `${code || '未知码'} 报文是凭据/配置类永久错误` }
      }
      if (looksTransient(message)) {
        return { retry: true, why: `${code || '未知码'} 报文是本机/上游网络波动，续跑有意义` }
      }
    }
    if (cfg.neverCodes.includes(code) && !forceable(cfg, code)) {
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

/**
 * 「连续失败」语义的纯函数：把计数、上限、清零集中在一处，便于单测。
 *
 * 规则（用户 m00002 的精确定义）：
 *   · 需要续跑的失败 → 计数 +1；累计达到 maxConsecutive 后不再发送；
 *   · 出现一次「正常回复」→ 把连续计数清零，重新开始算；
 *   · 不续跑的永久错误（上下文超限、余额…）→ 发继续也没用，但**不打断连续失败**，
 *     计数保持不变（既不清零也不累加）；
 *   · 人为取消 / 打断（aborted / interrupted）→ 同样不算正常回复、不打断连续性。
 *
 * 「正常回复」的判定：reason 缺失 / 为空 / kind 缺失 / kind==='completed' 且 verdict 不续跑。
 * 注意 reason 缺失是本机实测的正常完成形态（ac-probe 注释亦指出），不能漏清零。
 * max-tokens 不在这里：它是「回复被截断」的失败而非正常回复，默认会续跑；即便被配成
 * 不续，也应保持连续计数不动，落到下面「不续跑的失败不打断连续链」分支。
 *
 * @returns {{send:boolean, consecutive:number, reset:boolean, why:string, limited:boolean}}
 */
export function decideSend(verdict, reason, consecutive, cfg = DEFAULT_CONFIG) {
  const kind = reason?.kind
  const count = Number(consecutive) || 0

  // 正常回复打断连续性：清零，且这一轮不发送、不重置本轮形态统计之外的东西。
  // verdict.retry===false 且（没有 reason，或 reason 是 completed 这类正常收尾）。
  const normalReply =
    !verdict.retry &&
    (reason === undefined ||
      reason === null ||
      kind === undefined ||
      kind === 'completed')

  if (normalReply) {
    return { send: false, consecutive: 0, reset: true, why: verdict.why, limited: false }
  }

  // 不续跑的失败（永久错误 / 人为取消）：不发送，也不打断连续失败链。
  if (!verdict.retry) {
    return {
      send: false,
      consecutive: count,
      reset: false,
      why: verdict.why,
      limited: false,
    }
  }

  // 需要续跑，但已达上限：不发送，计数停在 cap。
  if (count >= cfg.maxConsecutive) {
    return {
      send: false,
      consecutive: count,
      reset: false,
      why: `连续续跑已达上限 ${cfg.maxConsecutive}（${verdict.why}）`,
      limited: true,
    }
  }

  return {
    send: true,
    consecutive: count + 1,
    reset: false,
    why: verdict.why,
    limited: false,
  }
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
  /**
   * 配置快照。volatile 字段被设置页改动时**不会重启插件**，所以这里必须重新读，
   * 不能像 0.1.4 那样在 apply 开头算一次就锁死 —— 否则用户勾了复选框要重启才生效。
   * `rawConfig` 里的字段是 schemastery 的 ref（有 `.get()`），`readConfigSource` 负责取值。
   */
  let cfg = resolveConfig(readConfigSource(rawConfig))

  // 设置页写入 → loader 广播 volatile 变更 → 这里重建快照。
  // 不重建的话，所有 ctx.on 回调闭包捕获的都是旧 cfg，UI 改了等于没改。
  let refreshConfig = () => {
    cfg = resolveConfig(readConfigSource(rawConfig))
  }
  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', () => refreshConfig())
    return () => {
      if (typeof off === 'function') off()
    }
  })

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
        // 本轮里 DSH 自带重试是否真的动过（见 hostRetryActive 的注释）
        hostRetry: false,
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
      // 三个清洗功能各自独立：DSML 抹标记（sanitize）、THINKING 搬块（thinkingToReasoning）、
      // 代码泄露包围栏（codeLeakFence）。都关掉时原样透传，零开销。
      if (!cfg.enabled) return stream
      if (!cfg.sanitize && !cfg.thinkingToReasoning && !cfg.codeLeakFence) return stream

      return (async function* guard() {
        const sessionId = options?.sessionId
        const state = sessionId === undefined ? null : stateOf(sessionId)
        const track = { leak: false, block: false, tailClose: false, proseChars: 0 }
        const sanitizer = createStreamSanitizer({
          track,
          // 0.1.9：整段 DSML 工具调用漏进正文时不删内容，包进围栏留在正文。
          fenceMarkers: cfg.dsmlToFence !== false,
        })
        /** THINKING 闸门：只在本轮开启时才建，关掉时走原路径、零额外开销。 */
        const gate = cfg.thinkingToReasoning ? createThinkingGate() : null
        let toolCalls = 0
        /** 每个 text block 已经发出去的正文（用于把 block-end 的全文拉回一致）。 */
        const emitted = new Map()
        /** 重排后新增块的序号：宿主按 push 顺序排块，所以只要不小于已有 index 即可。 */
        let extraIndex = 0
        const nextExtraIndex = () => {
          extraIndex += 1
          return 100000 + extraIndex
        }
        /** 把一段片段表落成块（第一段沿用原 index，其余新建）。 */
        const emitSegments = function* (segments, baseIndex) {
          let first = true
          for (const segment of segments) {
            if (segment.text === '') continue
            const index = first ? baseIndex : nextExtraIndex()
            first = false
            const block =
              segment.kind === 'thinking'
                ? { type: 'reasoning', text: segment.text }
                : { type: 'text', text: segment.text }
            // 新块补一条 block-start，保持「start → end」的完整形状（客户端 block-start 会把
            // 该 index 重置成空块，所以只给新建的 index 补，原 index 不能碰）。
            if (index !== baseIndex) yield { type: 'block-start', index, blockType: block.type }
            yield { type: 'block-end', index, block }
          }
        }

        for await (const chunk of stream) {
          if (chunk?.type === 'block-start') {
            if (gate !== null) gate.at(chunk.index)
            yield chunk
            continue
          }
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            const cleaned = sanitizer.push(chunk.text)
            // 思考段先被闸门截下，不以正文形式闪一下；放行的才是正文。
            const visible = gate === null ? cleaned : gate.push(cleaned)
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
              // 先结算闸门，丢掉跨块的残留状态（思考内容以 segments 为准重算）。
              if (gate !== null) gate.settle(chunk.index)
              /**
               * THINKING 泄露：按标签把这一块切成「正文 / 思考」片段，各成一块。
               * 未闭合的按「到块尾都是思考」处理 —— 上游被截断时就是这个形态。
               *
               * 归一化后的全文才是历史该写的：block.text 是上游原始全文（含 DSML 标记、
               * 含 thinking 标签），而 sanitizeText 的产物和 text-delta 逐段放行的结果
               * 未必一致（分片边界不同，围栏/半截标记的处理会有差别）。以全文重算一次，
               * 既避免屏幕与历史不一致，也避免「闸门压住内容后 emitted 为空、退回脏全文」。
               */
              // 历史里写的必须是「加了围栏的版本」：DSML 整段调用在原文里，重算时要带着
              // fenceMarkers，否则 block-end 会退回没围栏的原文，屏幕与历史又不一致。
              const base = cfg.sanitize
                ? sanitizeText(block.text, { fenceMarkers: cfg.dsmlToFence !== false }).text
                : block.text
              const rawSegments = cfg.thinkingToReasoning
                ? splitThinkingSegments(base)
                : [{ kind: 'text', text: base }]
              /**
               * 代码泄露：这一段文字其实是「模型要执行的命令 / 补丁」，只是被念进了正文。
               * 内容一字不动，只给它包一层代码围栏，让它渲染成代码块。判据与理由见
               * `detectCodeLeak` 上面的长注释。
               *
               * 只能在 block-end 做：判定需要看整段文字（开头 `$var=` + 后面有 `&`/`foreach`），
               * 流式分片里看到前几个字符时还判断不了。好在宿主拿 block-end 的 block 全文
               * 覆盖该块（客户端 `case 'block-end': blocks[chunk.index] = toAssistantBlock(...)`），
               * 所以屏幕上最终呈现的就是加了围栏的版本，与写入历史的一致。
               */
              const segments =
                cfg.codeLeakFence === false
                  ? rawSegments
                  : rawSegments.map((segment) => {
                      // 思考块里也可能整段是命令（真实样本 seq=3141 的 reasoning 是干的，
                      // 但不排除上游把命令写进 thinking），一样包围栏，kind 保持不变。
                      const lang = detectCodeLeak(segment.text)
                      if (lang === null) return segment
                      return { kind: segment.kind, text: fenceizeCode(segment.text, lang) }
                    })
              if (segments.some((segment) => segment.kind === 'thinking')) {
                yield* emitSegments(segments, chunk.index)
                continue
              }
              const cleanedText = segments.map((segment) => segment.text).join('')
              const sent = emitted.get(chunk.index) ?? ''
              // 闸门可能把块尾一段正文压着没发（怕是半截标签）。既然整块已收口、
              // 判定就是正文，就把这段补发出去 —— 否则屏幕少一截、历史多一截。
              // 只有「已发的是全文前缀」时才补发；围栏化会让已发内容不再是前缀
              // （前面多了 ``` 那几行），那种情况交给下面的 block-end 整块覆盖。
              if (cleanedText !== sent && cleanedText.startsWith(sent)) {
                const rest = cleanedText.slice(sent.length)
                emitted.set(chunk.index, cleanedText)
                yield { type: 'text-delta', index: chunk.index, text: rest }
              }
              // 历史写的是 block-end 的全文，所以只要全文与上游原文不同就整体替换：
              // 客户端 `case 'block-end'` 会用它覆盖该 index 的块内容，屏幕随之对齐。
              if (cleanedText !== block.text) {
                yield { ...chunk, block: { ...block, text: cleanedText } }
                continue
              }
            }
            yield chunk
            continue
          }

          if (chunk?.type === 'finish') {
            const tail = sanitizer.flush()
            if (tail !== '') {
              const visibleTail = gate === null ? tail : gate.push(tail)
              if (visibleTail !== '') {
                // 尾巴也要算进「已发送」，否则最后一个 block 的 block-end 会对不上
                const index = chunk.index ?? 0
                emitted.set(index, (emitted.get(index) ?? '') + visibleTail)
                yield { type: 'text-delta', index, text: visibleTail }
              }
            }
            // 流结束时闸门里可能还压着半截思考（上游正好在标签中途断流）
            if (gate !== null) {
              const leftover = gate.settle(chunk.index ?? 0)
              const thinking = leftover
                .filter((segment) => segment.kind === 'thinking')
                .map((segment) => segment.text)
                .join('')
              if (thinking !== '') {
                const index = nextExtraIndex()
                yield { type: 'block-start', index, blockType: 'reasoning' }
                yield { type: 'block-end', index, block: { type: 'reasoning', text: thinking } }
              }
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
        // 新一轮用户输入也意味着「上一轮宿主有没有重试」的证据过期了
        state.hostRetry = false
        return
      }

      // DSH 自带的 llm-retry 每次决定重试都会 append 这个事件（带 provider/policyKey/
      // retry/delayMs）。它出现 = 宿主真的接管了这个错误码，而不是「配置里写着要重试」。
      if (event.type === 'llm/retry') {
        state.hostRetry = true
        return
      }

      if (event.type !== 'turn/end') return

      const reason = event.data?.reason
      const verdict = decideContinue(reason, state, cfg)
      // 证据只对本轮有效：判完立刻失效，避免上一轮的 llm/retry 影响下一轮的判断
      state.hostRetry = false
      // 「连续」语义集中在纯函数 decideSend 里：正常回复清零、永久错误不打断、
      // 达上限停发。把算出来的计数写回会话状态。
      const decision = decideSend(verdict, reason, state.consecutive, cfg)
      state.consecutive = decision.consecutive
      if (decision.reset) resetTurn(state)

      if (decision.limited) {
        ctx.logger?.warn?.(
          `dsml-guard: 连续续跑已达上限 ${cfg.maxConsecutive}，停止自动继续（${verdict.why}）`,
        )
        return
      }
      if (!decision.send) return

      const attempt = decision.consecutive
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

// 注意：`Config` 必须同时挂在 default 导出里。
// 宿主 Loader 的 unwrapExports 是 `exports = exports.default ?? exports`，
// 有 default 时命名导出一律被丢弃 —— 只写 `export const Config` 的话
// 宿主拿到的 plugin.Config 是 undefined，settings.describe() 就会跳过本插件，
// 设置页命名空间永远不注册（0.1.5 之前就是这样，设置页一直不出现）。
export default { apply, inject, name, Config }
