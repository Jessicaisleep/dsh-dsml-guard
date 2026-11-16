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
function test(label, fn) {
  try {
    fn()
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

test('双竖线：整段 invoke 块被整块摘掉（真实形态：正文只有 1 个 "<"）', () => {
  const block =
    `<${B2}DSML${B2} invoke name="read">` +
    tag('parameter', { attrs: ' name="file_path" string="true"' }) +
    `D:\\x.ts` +
    tag('parameter', { closing: true }) +
    tag('invoke', { closing: true })
  const { text, track } = sanitizeText(`<${block}`)
  assert.equal(text, '<')
  assert.equal(track.block, true)
  assert.equal(track.tailClose, false)
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

test('账号/额度/上下文类错误 → 一律不续', () => {
  for (const code of ['QUOTA', 'QUOTA_EXCEEDED', 'AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'MISSING_CREDENTIAL']) {
    const verdict = decideContinue({ kind: 'error', error: { code, message: code } }, {}, CFG)
    assert.equal(verdict.retry, false, `${code} 不该续跑`)
  }
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
