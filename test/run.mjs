/**
 * dsh-dsml-guard 回放测试。
 *
 * 夹具按**本机会话真实捕获的形态**构造（2026-10-22～10-24，beichen / beichen-ds / aiaaa，
 * deepseek-v4.1-flash）：双全角竖线 ｜｜DSML｜｜，标签名后带一个空格。
 * 这里刻意用代码拼出标记，而不是把标记原文贴进源码 —— 源码里出现裸标记会让
 * 编辑器/工具链把它当成真的调用块。
 *
 * 跑法：node test/run.mjs   （退出码 0 = 全绿）
 */
import assert from 'node:assert/strict'
import {
  createStreamSanitizer,
  sanitizeText,
  detectLeak,
  decideContinue,
  resolveConfig,
  apply,
} from '../lib/index.js'
// 命名空间引用：新增的 decideSend 在 RED 阶段还不存在，用 guard.decideSend 访问
// 不会让整个 ESM 模块加载失败，能正常看到用例 FAIL。
import * as guard from '../lib/index.js'

let passed = 0
let failed = 0
const lines = []
/** 异步用例：test() 里返回 Promise 时进入这个队列，打印汇总前统一 await。 */
const pending = []
function test(label, fn) {
  try {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      pending.push(
        result.then(
          () => {
            passed++
            lines.push(`  ok   ${label}`)
          },
          (error) => {
            failed++
            lines.push(`  FAIL ${label} :: ${String(error.message).split('\n')[0]}`)
          },
        ),
      )
      return
    }
    passed++
    lines.push(`  ok   ${label}`)
  } catch (error) {
    failed++
    lines.push(`  FAIL ${label} :: ${String(error.message).split('\n')[0]}`)
  }
}

// ── 标记构造器（双全角竖线 + 名字前一个空格，与真实捕获一致）─────────────
const BAR = '\uFF5C'
const B2 = BAR + BAR
const tag = (name, { closing = false, attrs = '' } = {}) =>
  `<${closing ? '/' : ''}${B2}DSML${B2} ${name}${attrs}>`

const CFG = resolveConfig({})

// ── ① 清洗：三种竖线写法都要生效 ─────────────────────────────────────
test('双竖线：结尾三连闭合标签被清掉，正文保留', () => {
  const input = `素，说明切边仍存在。${tag('parameter', { closing: true })}`
  const { text, track } = sanitizeText(input)
  assert.equal(text, '素，说明切边仍存在。')
  assert.equal(track.leak, true)
  assert.equal(track.tailClose, true)
})

test('双竖线：整段 invoke 块被包进围栏留在正文（0.1.9 起；旧行为是整段删掉）', () => {
  const block =
    `<${B2}DSML${B2} invoke name="read">` +
    tag('parameter', { attrs: ' name="file_path" string="true"' }) +
    `D:\\x.ts` +
    tag('parameter', { closing: true }) +
    tag('invoke', { closing: true })
  // 真实形态：上游先吐一个被截断的 `<`，再吐完整标记。那个游离 `<` 是标记残渣，
  // 留着会让围栏落在行中、markdown 认不出代码块，所以被丢掉。
  const { text, track } = sanitizeText(`<${block}`, { fenceMarkers: true })
  assert.equal(text, '```text\n' + block + '\n```')
  assert.equal(track.block, true)
  assert.equal(track.tailClose, false)
})

test('dsmlToFence=false：回到整段删掉的旧行为', () => {
  const block =
    `<${B2}DSML${B2} invoke name="read">` +
    tag('parameter', { attrs: ' name="file_path" string="true"' }) +
    `D:\\x.ts` +
    tag('parameter', { closing: true }) +
    tag('invoke', { closing: true })
  const { text, track } = sanitizeText(`<${block}`, { fenceMarkers: false })
  assert.equal(text, '')
  assert.equal(track.block, true)
})

test('单竖线（插件自带文档那套）同样生效', () => {
  const single = `</${BAR}DSML${BAR} parameter> </${BAR}DSML${BAR} invoke> </${BAR}DSML${BAR} tool_calls>`
  const { text, track } = sanitizeText(`任务完成。\n${single}`)
  assert.equal(text.trimEnd(), '任务完成。')
  assert.equal(track.leak, true)
})

test('ASCII 双竖线 ||DSML|| 也认', () => {
  const ascii = '</||DSML|| parameter>'
  const { text } = sanitizeText(`done${ascii}`)
  assert.equal(text, 'done')
})

test('代码围栏里的标记一律不动（那是人在讨论语法）', () => {
  const body = '示例：\n```\n' + tag('tool_calls') + '\n' + tag('tool_calls', { closing: true }) + '\n```\n结束'
  const { text, track } = sanitizeText(body)
  assert.equal(text, body)
  assert.equal(track.leak, false)
})

test('行内反引号里的说明文字不触发泄漏判定', () => {
  const body = '这个 `' + B2 + 'DSML' + B2 + '` 是模型漏出来的标记'
  assert.equal(detectLeak(body), false)
})

test('分片切在标记中间也能拼回来', () => {
  const full = `收尾。${tag('parameter', { closing: true })}${tag('invoke', { closing: true })}`
  const cuts = [0, 3, 9, 10, 14, 20, full.length]
  const track = { leak: false, block: false, tailClose: false, proseChars: 0 }
  const sanitizer = createStreamSanitizer({ track })
  let out = ''
  for (let i = 0; i < cuts.length - 1; i++) out += sanitizer.push(full.slice(cuts[i], cuts[i + 1]))
  out += sanitizer.flush()
  assert.equal(out, '收尾。')
  assert.equal(track.leak, true)
})

test('普通正文里的 < 不被当成标记吃掉', () => {
  const body = '比较 a < b 且 c > d，还有 <div> 标签'
  const { text, track } = sanitizeText(body)
  assert.equal(text, body)
  assert.equal(track.leak, false)
})

test('没有标记的正文逐字节不改', () => {
  const body = '完全正常的回答。\n\n第二段，含 **markdown** 与 `code`。'
  const { text } = sanitizeText(body)
  assert.equal(text, body)
})

test('光头标记 <｜｜DSML｜｜>（无标签名）也被抹掉', () => {
  // 真实形态（beichen 2026-10-22）：块的 openers 被摘掉，只剩这层壳
  const input = `<${B2}DSML${B2}> 当前字节下 FAIL`
  const { text, track } = sanitizeText(input)
  assert.equal(text, ' 当前字节下 FAIL')
  assert.equal(track.leak, true)
})

test('孤立的外层包裹残片 <｜｜DSML｜｜ calls> 也被抹掉', () => {
  const input = `${tag('calls')}\n\n正文继续`
  const { text, track } = sanitizeText(input)
  assert.equal(text.trim(), '正文继续')
  assert.equal(track.leak, true)
})

// ── ② 续跑判据 ───────────────────────────────────────────────────────
test('invoke-block + 没发出 tool-call → 续跑', () => {
  const verdict = decideContinue(
    { kind: 'completed' },
    { leak: true, block: true, tailClose: false, hadToolCall: false, proseChars: 1 },
    CFG,
  )
  assert.equal(verdict.retry, true)
})

test('invoke-block 但这一轮真发过 tool-call → 不续（调用没丢）', () => {
  const verdict = decideContinue(
    { kind: 'completed' },
    { leak: true, block: true, tailClose: false, hadToolCall: true, proseChars: 5 },
    CFG,
  )
  assert.equal(verdict.retry, false)
})

test('tail-close + 正文完整 → 只清标记、不续跑', () => {
  const verdict = decideContinue(
    { kind: 'completed' },
    { leak: true, block: false, tailClose: true, hadToolCall: false, proseChars: 755 },
    CFG,
  )
  assert.equal(verdict.retry, false)
})

test('tail-close + 正文极短 → 续跑', () => {
  const verdict = decideContinue(
    { kind: 'completed' },
    { leak: true, block: false, tailClose: true, hadToolCall: false, proseChars: 20 },
    CFG,
  )
  assert.equal(verdict.retry, true)
})

// ★ 0.1.4：与宿主重试策略重叠的四个码默认交给宿主（DSH ≥0.2.2 的 llm-retry 在 step 内
//   已带退避重试过），插件不再叠加一条「继续」。开关是 cfg.skipHostRetriedCodes。
test('宿主已重试的码：默认交给宿主，不叠加「继续」', () => {
  for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, CFG)
    assert.equal(verdict.retry, false, `${code} 应当交给宿主重试策略`)
  }
})

test('重叠码集合 = 宿主默认可重试集 ∩ 本插件 retryCodes', () => {
  const overlap = CFG.retryCodes.filter((code) => guard.HOST_RETRIED_CODES.has(code)).sort()
  assert.deepEqual(overlap, ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  // RATE_LIMIT 不在重叠面里：插件本来就不续它
  assert.equal(guard.HOST_RETRIED_CODES.has('RATE_LIMIT'), false)
})

test('skipHostRetriedCodes 默认 true，只有显式 false 才关', () => {
  assert.equal(resolveConfig({}).skipHostRetriedCodes, true)
  assert.equal(resolveConfig({ skipHostRetriedCodes: true }).skipHostRetriedCodes, true)
  assert.equal(resolveConfig({ skipHostRetriedCodes: false }).skipHostRetriedCodes, false)
  // 写错类型不炸，也不误开
  assert.equal(resolveConfig({ skipHostRetriedCodes: 'no' }).skipHostRetriedCodes, true)
})

test('skipHostRetriedCodes=false：恢复旧行为，宿主重试耗尽后仍补一条继续', () => {
  const legacy = resolveConfig({ skipHostRetriedCodes: false })
  for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, legacy)
    assert.equal(verdict.retry, true, `${code} 应当续跑`)
  }
})

test('宿主不管的码仍然由插件续跑（开关只关重叠面）', () => {
  for (const code of ['MALFORMED_RESPONSE', 'PI_AI_ERROR', 'STREAM_CLOSED', 'NETWORK_ERROR', 'UNKNOWN']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, CFG)
    assert.equal(verdict.retry, true, `${code} 应当续跑`)
  }
})

// ★ m00691：勾上重叠码不等于无条件放行 —— 要先检测 DSH 自带重试是否在生效。
//   「在生效」的判据是运行时事实 state.hostRetry（本轮出现过 llm/retry 事件），
//   不是 provider 的 retryPolicy 配置。
const FORCED_TIMEOUT = resolveConfig({ retryTimeout: true })

test('勾选重叠码 + 宿主重试在生效 → 仍不续，并提示取消 DSH 自带重试后才生效', () => {
  assert.deepEqual(FORCED_TIMEOUT.forceCodes, ['TIMEOUT'], '前置：勾选 TIMEOUT 应进 forceCodes')
  const verdict = decideContinue(
    { kind: 'error', error: { code: 'TIMEOUT', message: 'Request timed out.' } },
    { hostRetry: true },
    FORCED_TIMEOUT,
  )
  assert.equal(verdict.retry, false, '宿主仍在重试时，勾了也不该叠加「继续」')
  assert.match(verdict.why, /取消 DSH 自带/, `why 应引导用户去关 DSH 自带重试，实际：${verdict.why}`)
})

test('勾选重叠码 + 宿主本轮没重试 → 由插件接手续跑', () => {
  const verdict = decideContinue(
    { kind: 'error', error: { code: 'TIMEOUT', message: 'Request timed out.' } },
    { hostRetry: false },
    FORCED_TIMEOUT,
  )
  assert.equal(verdict.retry, true, '宿主没接手时，勾选应当真的生效')
})

test('未勾选重叠码 + 宿主本轮没重试 → 仍然不续（默认交给宿主，不因宿主静默而翻成补发）', () => {
  for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']) {
    const verdict = decideContinue(
      { kind: 'error', error: { code, message: code } },
      { hostRetry: false },
      CFG,
    )
    assert.equal(verdict.retry, false, `${code} 未勾选时不该被 retryCodes 兜成可续`)
  }
})

test('账号/额度/上下文类错误 → 一律不续（勾选框也不能越过）', () => {
  for (const code of ['QUOTA', 'QUOTA_EXCEEDED', 'AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'MISSING_CREDENTIAL']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, CFG)
    assert.equal(verdict.retry, false, `${code} 不该续跑`)
  }
})

// ★ m02082（第一项）：按本机 459 个会话的实测续跑有效性重排可选项。
//   判据：turn/end error → 下一条 user/message 正文恰为「继续」→ 该轮是否产出内容/跑完。
//   AUTH 44 次里 13 次续跑、7 次跑完整轮；INVALID_REQUEST 89 次里 54 次续跑、20 次跑完整轮。
//   两者本来都在 neverCodes（默认不续），现在留成可勾选项，勾上才越过 neverCodes。
test('AUTH 默认不续；显式勾选后越过 neverCodes 续跑（换密钥后发继续有效）', () => {
  const off = resolveConfig({})
  assert.equal(decideContinue({ kind: 'error', error: { code: 'AUTH', message: '403 insufficient balance' } }, {}, off).retry, false)

  const on = resolveConfig({ retryAuth: true })
  assert.deepEqual(on.forceCodes, ['AUTH'], '前置：勾选 AUTH 应进 forceCodes')
  assert.equal(on.neverCodes.includes('AUTH'), true, '前置：AUTH 仍留在 neverCodes 里（默认不续）')
  const verdict = decideContinue({ kind: 'error', error: { code: 'AUTH', message: 'API 密钥无效。' } }, {}, on)
  assert.equal(verdict.retry, true, '显式勾选后 AUTH 应当续跑')
})

test('INVALID_REQUEST 默认不续；显式勾选后越过 neverCodes 续跑', () => {
  const off = resolveConfig({})
  const bad = { kind: 'error', error: { code: 'INVALID_REQUEST', message: '400: {"message":"openai_error","type":"invalid_request_error"}' } }
  assert.equal(decideContinue(bad, {}, off).retry, false)

  const on = resolveConfig({ retryInvalidRequest: true })
  assert.deepEqual(on.forceCodes, ['INVALID_REQUEST'])
  assert.equal(decideContinue(bad, {}, on).retry, true, '勾选后应当续跑')
})

test('没有 forceable 标记的 neverCodes 码，勾了也不越过（配额/上下文超限）', () => {
  // QUOTA 在 CODE_OPTIONS 里有勾选框，但没标 forceable —— 续跑只会再报一次。
  const on = resolveConfig({ retryQuota: true })
  assert.deepEqual(on.forceCodes, ['QUOTA'])
  const verdict = decideContinue({ kind: 'error', error: { code: 'QUOTA', message: 'quota exhausted' } }, {}, on)
  assert.equal(verdict.retry, false, 'QUOTA 没有 forceable 标记，勾了也必须被 neverCodes 拦下')
})

test('被用户取消/打断的一轮不替用户续', () => {
  for (const kind of ['aborted', 'interrupted']) {
    const verdict = decideContinue({ kind }, {}, CFG)
    assert.equal(verdict.retry, false)
  }
})

test('完全正常的一轮不续', () => {
  const verdict = decideContinue({ kind: 'completed' }, { leak: false, proseChars: 900 }, CFG)
  assert.equal(verdict.retry, false)
})

test('连续失败上限可配且被夹在 1..100', () => {
  assert.equal(resolveConfig({ maxConsecutive: 0 }).maxConsecutive, 3)
  assert.equal(resolveConfig({ maxConsecutive: 999 }).maxConsecutive, 100)
  assert.equal(resolveConfig({ maxConsecutive: 3 }).maxConsecutive, 3)
})

// ── ③ 连续次数上限 + 触发场景（对比市场同类插件后补充）────────────────
// 依据（本机 317 个 error 轮 + asar 类型定义 + 市场插件对比）：
//   · max-tokens(kind) = 单次回复输出 token 到顶，继续能接着写  → 该续
//   · CONTEXT_WINDOW_EXCEEDED / HTTP_413 = 上下文/体积总体超限，发继续也是报错 → 不续
//   · INVALID_REQUEST 里大量是 `read tcp ... i/o timeout`（本机网络波动误分类）→ 该续
test('默认连续续跑上限为 3', () => {
  assert.equal(resolveConfig({}).maxConsecutive, 3)
})

test('单次回复 token 到顶（max-tokens）→ 续跑', () => {
  const verdict = decideContinue({ kind: 'max-tokens' }, {}, CFG)
  assert.equal(verdict.retry, true)
})

test('流中断 / 网络错误 → 续跑（宿主不管的分类盲区）', () => {
  for (const code of ['STREAM_CLOSED', 'NETWORK_ERROR']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, CFG)
    assert.equal(verdict.retry, true, `${code} 应当续跑`)
  }
})

test('上下文总体超限 / 体积过大 → 不续（发继续也是再报错）', () => {
  const msg = '400: {"message":"prompt is too long: 1955535 tokens > 1048576 maximum"}'
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'HTTP_413', 'CLIENT_ERROR']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: msg } }, {}, CFG)
    assert.equal(verdict.retry, false, `${code} 不该续跑`)
  }
})

test('INVALID_REQUEST 报文是本机网络 i/o timeout → 续跑（顶层码误分类）', () => {
  const verdict = decideContinue(
    {
      kind: 'error',
      error: {
        code: 'INVALID_REQUEST',
        message: '400: read body: read tcp 127.0.0.1:7863->127.0.0.1:39828: i/o timeout',
      },
    },
    {},
    CFG,
  )
  assert.equal(verdict.retry, true)
})

test('INVALID_REQUEST 是真正的坏请求 → 不续', () => {
  const verdict = decideContinue(
    {
      kind: 'error',
      error: { code: 'INVALID_REQUEST', message: '400: {"message":"openai_error","type":"invalid_request_error"}' },
    },
    {},
    CFG,
  )
  assert.equal(verdict.retry, false)
})

// ── ④ decideSend：把「连续」语义抽成可单测的纯函数 ────────────────────
test('需要导出 decideSend 纯函数', () => {
  assert.equal(typeof guard.decideSend, 'function', 'decideSend 必须导出')
})

test('decideSend：连续 3 次失败后第 4 次不再发送', () => {
  const v = { retry: true, why: 'TIMEOUT' }
  const err = { kind: 'error', error: { code: 'TIMEOUT' } }
  let n = 0
  const sends = []
  for (let i = 0; i < 4; i++) {
    const d = guard.decideSend(v, err, n, CFG)
    sends.push(d.send)
    n = d.consecutive
  }
  assert.deepEqual(sends, [true, true, true, false])
})

test('decideSend：正常回复（completed）清零后重算', () => {
  const retry = { retry: true, why: 'SERVER' }
  const err = { kind: 'error', error: { code: 'SERVER' } }
  let n = 0
  n = guard.decideSend(retry, err, n, CFG).consecutive
  n = guard.decideSend(retry, err, n, CFG).consecutive
  n = guard.decideSend({ retry: false, why: '正常结束' }, { kind: 'completed' }, n, CFG).consecutive
  const d = guard.decideSend(retry, err, n, CFG)
  assert.equal(d.consecutive, 1)
  assert.equal(d.send, true)
})

test('decideSend：reason 为空的正常完成轮也清零（修复漏清零）', () => {
  const d = guard.decideSend({ retry: false, why: '正常结束' }, undefined, 2, CFG)
  assert.equal(d.consecutive, 0)
  assert.equal(d.reset, true)
})

test('decideSend：不续跑的永久性错误不清零（仍算连续失败）', () => {
  const d = guard.decideSend(
    { retry: false, why: '发继续也会报错' },
    { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    2,
    CFG,
  )
  assert.equal(d.consecutive, 2)
  assert.equal(d.reset, false)
})

test('decideSend：max-tokens 被配成不续时也不清零（不是正常回复）', () => {
  const d = guard.decideSend(
    { retry: false, why: 'MAX_TOKENS 被配置成不续' },
    { kind: 'max-tokens' },
    2,
    CFG,
  )
  assert.equal(d.consecutive, 2)
  assert.equal(d.reset, false)
  assert.equal(d.send, false)
})

// ── ⑤ apply 端到端：真正数 agent.followup 的调用次数 ──────────────────
function makeHarness(cfg = {}) {
  const handlers = new Map()
  const followups = []
  const agent = { followup: (msg) => followups.push(msg) }
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
    agents: { get: () => agent },
  }
  apply(ctx, cfg)
  return {
    emit: (session, event) => {
      for (const h of handlers.get('session/event') ?? []) h(session, event)
    },
    /** 调插件注册的 llm/stream 处理器：next 即下游 provider 的流。 */
    stream: (options, next) => {
      const list = handlers.get('llm/stream') ?? []
      assert.ok(list.length > 0, '插件必须注册 llm/stream 处理器')
      return list[0](options, next)
    },
    followups,
  }
}

function withImmediateTimers(fn) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (cb) => {
    cb()
    return 0
  }
  globalThis.clearTimeout = () => {}
  try {
    return fn()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// 用一个**宿主不管**的码做端到端夹具（MALFORMED_RESPONSE 不在 llm-retry 的可重试集里，
// 默认配置下插件仍然会续跑）。宿主已覆盖的 TIMEOUT 见下面专门的两条用例。
const FAIL_EVENT = {
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'malformed response' } } },
}

const TIMEOUT_EVENT = {
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } } },
}

test('apply：默认配置下 失败-继续×4，第 4 次失败不再补发（共 3 次）', () => {
  const h = makeHarness()
  withImmediateTimers(() => {
    for (let i = 0; i < 4; i++) h.emit({ id: 's1' }, FAIL_EVENT)
  })
  assert.equal(h.followups.length, 3)
})

test('apply：中间有正常回复（reason 为空）则清零，后续仍可再发', () => {
  const h = makeHarness({ maxConsecutive: 3 })
  const normal = { type: 'turn/end', data: { reason: undefined } }
  withImmediateTimers(() => {
    h.emit({ id: 's1' }, FAIL_EVENT) // 1
    h.emit({ id: 's1' }, normal) // 清零
    h.emit({ id: 's1' }, FAIL_EVENT) // 1
    h.emit({ id: 's1' }, FAIL_EVENT) // 2
    h.emit({ id: 's1' }, FAIL_EVENT) // 3（"到这里是两次，所以继续发送"）
  })
  assert.equal(h.followups.length, 4)
})

test('apply：上下文总体超限不补发继续', () => {
  const h = makeHarness()
  const ctxErr = {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long' } } },
  }
  withImmediateTimers(() => {
    h.emit({ id: 's1' }, ctxErr)
  })
  assert.equal(h.followups.length, 0)
})

test('apply：宿主已覆盖的 TIMEOUT 默认一次也不补发', () => {
  const h = makeHarness()
  withImmediateTimers(() => {
    for (let i = 0; i < 4; i++) h.emit({ id: 's1' }, TIMEOUT_EVENT)
  })
  assert.equal(h.followups.length, 0)
})

test('apply：skipHostRetriedCodes=false 时 TIMEOUT 恢复补发（旧兜底）', () => {
  const h = makeHarness({ skipHostRetriedCodes: false })
  withImmediateTimers(() => {
    for (let i = 0; i < 4; i++) h.emit({ id: 's1' }, TIMEOUT_EVENT)
  })
  assert.equal(h.followups.length, 3)
})

test('apply：max-tokens 续跑不受开关影响（开关只关错误码重叠面）', () => {
  const h = makeHarness()
  withImmediateTimers(() => {
    h.emit({ id: 's2' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  })
  assert.equal(h.followups.length, 1)
})

// ── ⑥ THINKING 泄露：把标签文字搬进 reasoning 块 ─────────────────────
// 真实形态（本机 135 例）：117 例标签在块首、18 例在中间；86 例成对闭合、42 例没有闭合。
test('splitThinkingSegments：成对闭合 → 思考在前、正文在后', () => {
  assert.deepEqual(guard.splitThinkingSegments('<thinking>**a**</thinking>正文'), [
    { kind: 'thinking', text: '**a**' },
    { kind: 'text', text: '正文' },
  ])
})

test('splitThinkingSegments：没有闭合标签 → 到块尾都算思考（上游被截断的形态）', () => {
  assert.deepEqual(guard.splitThinkingSegments('<thinking>**Build still running**'), [
    { kind: 'thinking', text: '**Build still running**' },
  ])
})

test('splitThinkingSegments：孤立多出来的闭合标签不进正文（真实样本 1 例）', () => {
  const text = '<thinking>**Repairing**</thinking>\n\n正文**诊断**</thinking>'
  assert.deepEqual(guard.splitThinkingSegments(text), [
    { kind: 'thinking', text: '**Repairing**' },
    { kind: 'text', text: '\n正文**诊断**' },
  ])
  assert.equal(guard.hasOrphanThinkClose(text), true)
  assert.equal(guard.hasOrphanThinkClose('<thinking>a</thinking>正文'), false)
})

test('splitThinkingSegments：多段交替保持顺序', () => {  assert.deepEqual(guard.splitThinkingSegments('前言<thinking>x</thinking>后文<thinking>y</thinking>尾'), [
    { kind: 'text', text: '前言' },
    { kind: 'thinking', text: 'x' },
    { kind: 'text', text: '后文' },
    { kind: 'thinking', text: 'y' },
    { kind: 'text', text: '尾' },
  ])
})

test('splitThinkingSegments：<think>/<reasoning> 别名与属性都认', () => {
  assert.equal(guard.detectThinkingLeak('<Think type="x">a</Think>'), true)
  assert.equal(guard.detectThinkingLeak('<reasoning>a</reasoning>'), true)
})

test('splitThinkingSegments：没有标签的正文逐字节不改（不误伤）', () => {
  assert.deepEqual(guard.splitThinkingSegments('普通回复。'), [{ kind: 'text', text: '普通回复。' }])
  assert.equal(guard.detectThinkingLeak('普通回复。'), false)
})

// 真实误伤样本：正文里讨论/引用 <think> 这个标签本身（不是泄露）。
// 旧逻辑会把标签后面的正文整段搬进 reasoning 块（seq=738 误搬 2083 字、seq=164 误搬 2616 字）。
test('splitThinkingSegments：代码围栏里讨论的 `<think>` 不归位（真实误伤样本）', () => {
  const text = '看这段：\n```\na stray 8-byte `<think>` discards a completed generation\n```\n后面正文。'
  assert.deepEqual(guard.splitThinkingSegments(text), [{ kind: 'text', text }])
  assert.equal(guard.detectThinkingLeak(text), false)
})

test('splitThinkingSegments：行内反引号里的 `<think>` 不归位', () => {
  const text = 'a stray 8-byte `<think>` discards a generation, 后面正文。'
  assert.deepEqual(guard.splitThinkingSegments(text), [{ kind: 'text', text }])
})

test('splitThinkingSegments：空行断开后不再当代码区（跨段落不配对）', () => {
  const text = '段一 `<think>`\n\n段二 结束。'
  assert.deepEqual(guard.splitThinkingSegments(text), [{ kind: 'text', text }])
})

test('splitThinkingSegments：代码区保护不放过真实泄露', () => {
  assert.deepEqual(guard.splitThinkingSegments('<thinking>**Running red test**</thinking>正文。'), [
    { kind: 'thinking', text: '**Running red test**' },
    { kind: 'text', text: '正文。' },
  ])
})

test('createThinkingGate：代码围栏里的 `<think>` 照常外发，不被截成思考', () => {
  const gate = guard.createThinkingGate()
  gate.at(0)
  const out = gate.push('看：\n```\n<think> x\n```\n正文')
  assert.equal(out, '看：\n```\n<think> x\n```\n正文')
  assert.deepEqual(gate.settle(0), [])
})

test('createThinkingGate：半截标签先压住，放行前面的正文', () => {
  const gate = guard.createThinkingGate()
  gate.at(0)
  assert.equal(gate.push('正常开头 <thi'), '正常开头 ')
  // 标签补齐后整段思考被截下，不再外发
  assert.equal(gate.push('nking>隐藏内容'), '')
  assert.deepEqual(gate.settle(0), [{ kind: 'thinking', text: '隐藏内容' }])
})

test('thinkingToReasoning：默认开，只有显式 false 才关', () => {
  assert.equal(resolveConfig({}).thinkingToReasoning, true)
  assert.equal(resolveConfig({ thinkingToReasoning: false }).thinkingToReasoning, false)
  // 写错类型不该悄悄关掉功能
  assert.equal(resolveConfig({ thinkingToReasoning: 'no' }).thinkingToReasoning, true)
})

test('createThinkingGate：闭合后恢复外发正文', () => {
  const gate = guard.createThinkingGate()
  gate.at(0)
  gate.push('<thinking>想完了</thinking>')
  assert.equal(gate.push('正文开始'), '正文开始')
})

/** 跑一遍 llm/stream：把 chunks 喂给插件注册的生成器，收集它 yield 出来的 chunk。 */
async function runStream(cfg, chunks) {
  const h = makeHarness(cfg)
  assert.equal(typeof h.stream, 'function', 'harness 必须暴露 llm/stream 处理器')
  const wrapped = h.stream({}, () =>
    (async function* source() {
      for (const chunk of chunks) yield chunk
    })(),
  )
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  return out
}

test('llm/stream：带 thinking 的 text 块被拆成 reasoning + text 两块', async () => {
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>**build running**</thinking>\n正文第一段。' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: '<thinking>**build running**</thinking>\n正文第一段。' },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  const reasoning = ends.filter((chunk) => chunk.block?.type === 'reasoning')
  const texts = ends.filter((chunk) => chunk.block?.type === 'text')
  assert.equal(reasoning.length, 1)
  assert.match(reasoning[0].block.text, /build running/)
  assert.equal(texts.length, 1)
  assert.match(texts[0].block.text, /正文第一段/)
  // 思考不能以正文形式先闪一下
  const deltas = out
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.ok(!deltas.includes('build running'), '思考内容不得作为 text-delta 外发')
})

test('llm/stream：未闭合的 thinking 整块转 reasoning', async () => {
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>**waiting**' } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.type, 'reasoning')
  assert.equal(ends[0].block.text, '**waiting**')
})

test('llm/stream：关掉 thinkingToReasoning 后保持原样（不拆块）', async () => {
  const out = await runStream({ thinkingToReasoning: false }, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>**a**</thinking>正文' } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.type, 'text')
})

test('llm/stream：普通回复不被误改', async () => {
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '普通回复。' } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.type, 'text')
  assert.equal(ends[0].block.text, '普通回复。')
})

// ── ⑦ 代码泄露：念进正文的命令/补丁包进代码围栏 ────────────────────────
// 真实样本来自问题会话 session-26470037…（seq=3141 / 3316 / 2675），详见 detectCodeLeak 的注释。
const CMD_LEAK =
  "$ffmpeg='D:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'; $dir='E:\\DSHWORK\\芭蕾\\s01'; " +
  "foreach($f in @('S01_remade_1080p.mp4','S02_1080p.mp4')){ $p=Join-Path $dir $f; " +
  'if(Test-Path -LiteralPath $p){ & $ffmpeg -v error -i $p -f null - } }'

const PATCH_LEAK = "*** Begin Patch\n*** Add File: motion_v02.py\n+import bpy\n+print(1)\n*** End Patch"

test('detectCodeLeak：念进正文的 PowerShell 命令命中', () => {
  assert.equal(guard.detectCodeLeak(CMD_LEAK), 'powershell')
})

test('detectCodeLeak：整段 *** Begin Patch 命中 diff', () => {
  assert.equal(guard.detectCodeLeak(PATCH_LEAK), 'diff')
})

test('detectCodeLeak：普通正文与正常 markdown 围栏都不误伤', () => {
  assert.equal(guard.detectCodeLeak('普通回复，提到一个 $变量 而已。'), null)
  assert.equal(guard.detectCodeLeak('```powershell\nGet-Location\n```'), null)
  assert.equal(guard.detectCodeLeak('+ 这是列表项，不是补丁'), null)
  // 只有 Begin 没有 End 不算（可能是在解释语法）
  assert.equal(guard.detectCodeLeak('*** Begin Patch\n*** Add File: a.py'), null)
})

test('fenceizeCode：只加围栏，正文一字不改', () => {
  assert.equal(guard.fenceizeCode('Get-Location', 'powershell'), '```powershell\nGet-Location\n```')
  // 前后空行被裁掉，内部缩进保留
  assert.equal(guard.fenceizeCode('\n  a\n  b\n\n', 'diff'), '```diff\n  a\n  b\n```')
})

test('fenceizeCode：内容里已含 ``` 时围栏自动加长，避免把后面整篇吞进代码块', () => {
  // CommonMark：关闭围栏的反引号数必须 ≥ 开启围栏。内容里有三个反引号，
  // 用三个包围就会被它提前关掉，所以至少要四个。
  const out = guard.fenceizeCode('$x=1; & $exe\n```\ncode\n```', 'powershell')
  const lines = out.split('\n')
  assert.equal(lines[0], '````powershell')
  assert.equal(lines[lines.length - 1], '````')
  // 内容一字不动地夹在中间
  assert.equal(lines.slice(1, -1).join('\n'), '$x=1; & $exe\n```\ncode\n```')
})

test('codeLeakFence：默认开，只有显式 false 才关', () => {
  assert.equal(resolveConfig({}).codeLeakFence, true)
  assert.equal(resolveConfig({ codeLeakFence: false }).codeLeakFence, false)
  assert.equal(resolveConfig({ codeLeakFence: 'no' }).codeLeakFence, true)
})

test('llm/stream：念出来的命令被包进围栏，历史里也是围栏版', async () => {
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: CMD_LEAK },
    { type: 'block-end', index: 0, block: { type: 'text', text: CMD_LEAK } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1, '只该有一个块（不拆块）')
  assert.equal(ends[0].block.type, 'text')
  assert.match(ends[0].block.text, /^```powershell\n/, '历史里的块必须带围栏开头')
  assert.match(ends[0].block.text, /\$ffmpeg=/)
  assert.match(ends[0].block.text, /\n```$/)
  // 内容不丢：去掉围栏行后应与原文一致
  assert.equal(ends[0].block.text.replace(/^```powershell\n/, '').replace(/\n```$/, ''), CMD_LEAK)
})

test('llm/stream：patch 整段被包进 diff 围栏', async () => {
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: PATCH_LEAK } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1)
  assert.match(ends[0].block.text, /^```diff\n/)
  assert.match(ends[0].block.text, /\*\*\* Begin Patch/)
})

test('llm/stream：关掉 codeLeakFence 后命令保持原样', async () => {
  const out = await runStream({ codeLeakFence: false }, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: CMD_LEAK } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.text, CMD_LEAK)
})

test('llm/stream：thinking 段里的命令也被包围栏，且仍归到 reasoning 块', async () => {
  const text = '<thinking>' + CMD_LEAK + '</thinking>\n正文'
  const out = await runStream({}, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ])
  const ends = out.filter((chunk) => chunk.type === 'block-end')
  const reasoning = ends.filter((chunk) => chunk.block?.type === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.match(reasoning[0].block.text, /^```powershell\n/)
})

// ★ 回归：宿主 Loader 的 unwrapExports 是 `exports = exports.default ?? exports`，
//   有 default 时命名导出全被丢弃。若 `Config` 只写 `export const Config` 而没挂进
//   default，宿主拿到的 plugin.Config 就是 undefined → settings.describe() 直接跳过本
//   entry → 设置页永远不出现，且全程无任何报错。这条用例把「宿主视角」固化下来。
test('default 导出必须带上 Config（否则宿主 unwrapExports 后设置页静默消失）', () => {
  const isNullable = (value) => value === undefined || value === null
  const unwrapExports = (exports) => {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
  const plugin = unwrapExports(guard)
  assert.ok('Config' in plugin, '宿主视角的 plugin 必须暴露 Config')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['agents', 'llm'])
  assert.equal(plugin.name, 'dsml-guard')
  // 离线环境（无 @deepseek-ai/schemastery）Config 为 undefined 是允许的降级，
  // 但键必须存在 —— 宿主正是靠这个键判断要不要产出设置页 descriptor。
  assert.ok(Object.prototype.hasOwnProperty.call(guard, 'Config'))
})

await Promise.all(pending)

console.log(lines.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)

// 端到端历史一致性：单独一个文件，跑成子进程，任一失败整体非 0
const { spawnSync } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
const historyPath = fileURLToPath(new URL('./history.mjs', import.meta.url))
const history = spawnSync(process.execPath, [historyPath], { encoding: 'utf8' })
if (history.status !== 0) {
  console.log('\n--- test/history.mjs (block-end 历史一致性) ---')
  console.log(history.stdout ?? '')
  console.log(history.stderr ?? '')
  console.log('history 用例失败')
  process.exit(1)
}
console.log('  ok   block-end 历史一致性（test/history.mjs）')

process.exit(failed === 0 ? 0 : 1)
