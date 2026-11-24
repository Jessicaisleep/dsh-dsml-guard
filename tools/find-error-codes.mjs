// 诊断工具：在会话 jsonl.zstd 里定位某条报错，打印它对应的 turn/end reason 与错误码。
// 用法：node tools/find-error-codes.mjs <session.v4.jsonl.zstd> "<报错内容>"
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressAll(file) {
  const buf = fs.readFileSync(file)
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    // 跳过可选的 skippable frame（magic 0x184D2A5*, little endian 0x5*2A4D18）
    if (pos + 4 <= buf.length) {
      const m = buf.readUInt32LE(pos)
      if ((m & 0xfffffff0) === 0x184d2a50) {
        const size = buf.readUInt32LE(pos + 4)
        pos += 8 + size
        continue
      }
    }
    const at = buf.indexOf(MAGIC, pos)
    if (at < 0) break
    if (at > pos) {
      // 帧之间有换行分隔符，跳过
      pos = at
    }
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(pos))
      parts.push(out)
      // 找到下一个 magic 作为下一帧起点
      const next = buf.indexOf(MAGIC, pos + 4)
      pos = next < 0 ? buf.length : next
    } catch (err) {
      const next = buf.indexOf(MAGIC, pos + 4)
      if (next < 0) break
      pos = next
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const [file, needleArg] = process.argv.slice(2)
if (!file || !needleArg) {
  console.error('usage: node find-error-codes.mjs <file.jsonl.zstd> "<error text>"')
  process.exit(2)
}
const needle = needleArg.toLowerCase()
const text = decompressAll(file)
const lines = text.split('\n')
console.log(`# ${file}`)
console.log(`# decompressed ${text.length} chars, ${lines.length} lines`)

const hits = []
for (let i = 0; i < lines.length; i++) {
  if (!lines[i]) continue
  if (!lines[i].toLowerCase().includes(needle)) continue
  let rec
  try { rec = JSON.parse(lines[i]) } catch { continue }
  hits.push({ line: i, rec })
}

if (!hits.length) {
  console.log('no hit for needle (raw substring).')
}

for (const { line, rec } of hits) {
  const seq = rec.seq ?? rec.sequence ?? '?'
  const type = rec.type ?? rec.event?.type ?? '?'
  const data = rec.data ?? rec.event?.data ?? {}
  console.log(`\n--- line ${line} seq=${seq} type=${type} ---`)
  const brief = JSON.stringify(data)
  console.log(brief.length > 4000 ? brief.slice(0, 4000) + '…' : brief)
}

// 打印所有 turn/end 的错误码分布，便于对照
console.log('\n=== turn/end reasons ===')
for (let i = 0; i < lines.length; i++) {
  if (!lines[i] || !lines[i].includes('"turn/end"')) continue
  let rec
  try { rec = JSON.parse(lines[i]) } catch { continue }
  const data = rec.data ?? rec.event?.data ?? {}
  const reason = data.reason
  if (!reason) continue
  const code = reason.error?.code ?? reason.kind
  const msg = reason.error?.message ?? ''
  console.log(`line ${i} seq=${rec.seq ?? '?'} kind=${reason.kind} code=${code} msg=${String(msg).slice(0, 160)}`)
}
