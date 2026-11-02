// 微基准：同一段上下文 low → high → low，切换思考强度会不会打断 DeepSeek 的前缀缓存？
//   BENCH_BASE_URL=… BENCH_API_KEY=… npx tsx bench/micro/effort-cache.ts
// 看每次的 cache_read_input_tokens：第 2、3 次都接近前缀长度 = 不打断；第 2 次 ≈ 0 = 打断。约 ¥0.02。
import { anthropicClient } from '../p0/run.js'
import { buildPrefix, buildQuestions } from './prefix-distractor.js'

const baseUrl = process.env.BENCH_BASE_URL
const apiKey = process.env.BENCH_API_KEY
if (!baseUrl || !apiKey) { console.error('缺少 BENCH_BASE_URL / BENCH_API_KEY'); process.exit(2) }
const model = process.env.BENCH_MODEL ?? 'deepseek-flash'
// 每次运行用不同的前缀（带时间戳），避免吃到以前跑过的缓存
const system = `运行 ${new Date().toISOString()}\n\n${buildPrefix(buildQuestions(11), 7500, 0, 11)}`
const seq = ['low', 'high', 'low', 'high'] as const
console.log(`== 7-1 · 前缀约 ${system.length} 字 · 依次 ${seq.join(' → ')} ==`)
for (const [i, effort] of seq.entries()) {
  const m = anthropicClient({ baseUrl, apiKey, model, effort, maxTokens: 256 })
  const r = await m.complete({ system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: `第 ${i + 1} 次：老大最喜欢什么颜色？一句话回答。` }] }] })
  const u = r.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined
  console.log(`  第 ${i + 1} 次 ${effort.padEnd(4)}：未命中 ${u?.input_tokens ?? '?'} · 命中 ${u?.cache_read_input_tokens ?? '?'} · 输出 ${u?.output_tokens ?? '?'}`)
  await new Promise((res) => setTimeout(res, 1500))
}
console.log('\n读法：第 2 次（换成 high）命中 ≈ 第 2 次以前的前缀长度 → 不打断；≈ 0 → 打断。')
