/**
 * 端到端：走真实 chunk 序列（block-start → text-delta… → block-end → finish），
 * 断言两件事必须同时成立：
 *   ① 屏幕上看到的（text-delta 之和）没有标记；
 *   ② **写入历史的 block-end 全文也没有标记** —— 这一条才是「切断污染」的证据。
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

assert.equal(MARK.test(visible), false, '显示层不该有标记')
assert.equal(MARK.test(blockEndText), false, '写入历史的 block-end 也不该有标记')
assert.equal(blockEndText, visible, '历史必须等于用户实际看到的，否则下一轮又喂回去')
assert.equal(blocks, 1)

console.log('\nPASS：显示与历史都被清洗，历史 = 屏幕内容，污染链已切断')
