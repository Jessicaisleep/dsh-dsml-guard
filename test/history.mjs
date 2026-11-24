/**
 * 端到端：走真实 chunk 序列（block-start → text-delta… → block-end → finish），
 * 断言三件事必须同时成立：
 *   ① 屏幕与历史一致（text-delta 之和 === block-end 全文），否则下一轮又喂回去；
 *   ② 漏进正文的整段工具调用被包进代码围栏（0.1.9 起；旧行为是整段删掉）；
 *   ③ 标记只出现在围栏**内部** —— 围栏外的散文里一个标记都不许有。
 *
 * 为什么不再要求「显示层没有标记」（旧 0.1.8 的断言）：
 * 用户实测（m02746）整段删掉会让那一轮白跑（agent-loop 见 toolCalls.length === 0
 * 就 completed，既没工具可执行也没正文可看）。改成包围栏后内容保留、`track.block`
 * 仍为 true，补发「继续」的兜底照旧生效。围栏内的标记是人能读懂的代码块内容，
 * 且 sanitizer 自己在围栏内不解析标记，不会二次触发。
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const BAR = '\uFF5C'
const B = BAR + BAR
const tag = (name, closing = false, attrs = '') =>
  `<${closing ? '/' : ''}${B}DSML${B} ${name}${attrs}>`

const dirty =
  '<' +
  `<${B}DSML${B} tool_calls>` +
  tag('invoke', false, ' name="pwsh"') +
  tag('parameter', false, ' name="command" string="true"') +
  'Get-Location' +
  tag('parameter', true) +
  tag('invoke', true) +
  tag('calls', true)

const MARK = /[｜|]{1,2}DSML[｜|]{1,2}/u

let handler = null
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  on: (name, fn) => {
    if (name === 'llm/stream') handler = fn
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} },
  agents: { get: () => null },
}

apply(ctx, {})

const chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: dirty.slice(0, 60) },
  { type: 'text-delta', index: 0, text: dirty.slice(60) },
  { type: 'block-end', index: 0, block: { type: 'text', text: dirty } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const source = (async function* () { for (const c of chunks) yield c })()
const wrapped = handler({ sessionId: 's1' }, () => source)

let visible = ''
let blockEndText = ''
let blocks = 0
for await (const chunk of wrapped) {
  if (chunk.type === 'text-delta') visible += chunk.text
  if (chunk.type === 'block-end') blockEndText = chunk.block.text
  if (chunk.type === 'block-end') blocks++
}

console.log('原文长度              :', dirty.length)
console.log('显示出来（text-delta）:', JSON.stringify(visible), `共 ${visible.length} 字符`)
console.log('历史里（block-end）   :', JSON.stringify(blockEndText), `共 ${blockEndText.length} 字符`)

assert.equal(blockEndText, visible, '历史必须等于用户实际看到的，否则下一轮又喂回去')
assert.equal(blocks, 1)

// ② 整段工具调用被包进围栏
assert.match(visible, /^```text\n/, '漏进正文的整段调用必须以 ```text 围栏开头')
assert.match(visible, /\n```$/, '围栏必须收尾')

// ③ 围栏外的散文里不许有标记：剥掉围栏行与围栏块内容再查
const outsideFence = visible
  .replace(/```[\s\S]*?```/g, '') // 去掉所有围栏块（含内容）
  .replace(/^```.*$/gm, '')
assert.equal(MARK.test(outsideFence), false, '围栏外的正文不该有标记')

// 围栏内的内容必须原样保留（除上游那个被截断的游离 `<` 残渣 —— 它不是内容，留在
// 围栏里会让行首多一个字符、markdown 认不出代码块，所以实现里把它当标记残渣丢了）
const inner = visible.replace(/^```text\n/, '').replace(/\n```$/, '')
assert.equal(inner, dirty.slice(1), '围栏内的原始调用必须一字不动地保留（只去掉游离的 `<`）')

console.log('\nPASS：整段调用被包进围栏留在正文，历史 = 屏幕内容，内容零丢失')
