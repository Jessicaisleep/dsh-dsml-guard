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
} from '../lib/index.js'

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

test('上游抖动类错误 → 续跑', () => {
  for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER']) {
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
  assert.equal(resolveConfig({ maxConsecutive: 0 }).maxConsecutive, 5)
  assert.equal(resolveConfig({ maxConsecutive: 999 }).maxConsecutive, 100)
  assert.equal(resolveConfig({ maxConsecutive: 3 }).maxConsecutive, 3)
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
