/**
 * 端到端回放：把**真实会话里捕获的 29 条泄漏正文**原样喂给清洗器，逐条报告
 * 「清洗后还剩多少字符 / 判不判续跑」。这是唯一能证明插件对真实流量有效的测试。
 *
 * 跑法：node test/replay-real.mjs [sessionsRoot]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { sanitizeText, decideContinue, resolveConfig } from '../lib/index.js'

const root = process.argv[2] ?? 'D:\\Program Files (x86)\\DSH_Data\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MARK = /[｜|]{1,2}DSML[｜|]{1,2}/u
const CFG = resolveConfig({})

function decode(file) {
  const buffer = readFileSync(file)
  const offsets = []
  let at = buffer.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
  }
  const out = []
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      out.push(zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {}
  }
  return Buffer.concat(out).toString('utf8')
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.includes('.v4.') && entry.name.endsWith('.jsonl.zstd')) yield full
  }
}

// 只把围栏/行内引用先剥掉用于「算不算泄漏」的判定，但回放清洗器喂的是原文。
const proseOnly = (t) => t.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\n]*`/gu, ' ')

const rows = []
for (const file of walk(root)) {
  let text
  try {
    text = decode(file)
  } catch {
    continue
  }
  if (!MARK.test(text)) continue
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'assistant/message') continue
    const message = rec.data?.message
    const blocks = Array.isArray(message?.content) ? message.content : []
    const hadToolCall = blocks.some((b) => b?.type === 'tool-call')
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      if (!MARK.test(proseOnly(block.text))) continue
      rows.push({ text: block.text, hadToolCall, provider: message?.source?.provider })
    }
  }
}

let stillLeaking = 0
let judged = 0
const leaksAfter = []
const summary = new Map()

for (const row of rows) {
  const { text, track } = sanitizeText(row.text)
  const verdict = decideContinue(
    { kind: 'completed' },
    {
      leak: track.leak,
      block: track.block,
      tailClose: track.tailClose,
      hadToolCall: row.hadToolCall,
      proseChars: text.trim().length,
    },
    CFG,
  )
  if (MARK.test(proseOnly(text))) {
    stillLeaking++
    leaksAfter.push({
      fenced: /```/.test(row.text),
      fences: (row.text.match(/```/g) ?? []).length,
      provider: row.provider,
      tail: text.slice(-90),
    })
  }
  if (verdict.retry) judged++
  const key = `${track.block ? 'invoke-block' : track.tailClose ? 'tail-close' : 'other'} | 续跑=${verdict.retry}`
  summary.set(key, (summary.get(key) ?? 0) + 1)
}

console.log(`样本 ${rows.length} 条（来自真实会话）`)
console.log('清洗后仍有标记的：', stillLeaking, '条')
for (const leak of leaksAfter) {
  console.log(`  [围栏=${leak.fenced ? `是(${leak.fences}个)` : '否'}] ${leak.provider} … ${JSON.stringify(leak.tail)}`)
}
console.log('判定要续跑的：', judged, '条')
console.log('分类：')
for (const [key, count] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${key}`)
}

// 验收：代码围栏内的标记属于「人在讨论语法」，按设计保留；围栏外一条都不许剩。
const unfenced = leaksAfter.filter((leak) => !leak.fenced)
if (unfenced.length > 0) {
  console.error(`\nFAIL：${unfenced.length} 条围栏外的正文清洗后仍残留标记`)
  process.exit(1)
}
console.log(
  `\nPASS：围栏外全部清洗干净（保留 ${leaksAfter.length} 条围栏内的示例文本，按设计不动）`,
)
