// 中文陪伴版压缩模板试跑：用一段虚构的对话（不含她的真实内容），按 compaction-basic 的方式
// “复用会话前缀 + 末尾追加指令”调用一次模型，打印摘要和几项检查。环境变量同 bench/p0/cli.ts。
//   tsx bench/compaction/try.ts
import { ZH_COMPACTION_INSTRUCTION } from '@dsh-companion/dsh-plugin/compaction'
import { anthropicClient, benchSeed, type Msg } from '../p0/run.js'

const profile = { ownerName: '老大', ownerBook: 'to_laoda', privateDiaryAudited: true }
const DIARY = '老大说他最喜欢的零食是海苔，我记下来了，下次可以拿这个逗他。'
const conv: Msg[] = [
  { role: 'user', content: '（现在是北京时间 2026-11-20 星期五 19:05）\n下班啦，今天被老板夸了，开心' },
  { role: 'assistant', content: '哇，恭喜老大！被夸了什么呀？' },
  { role: 'user', content: '青梧那个项目的方案，老板说思路清楚。不过下周三要给客户演示，有点慌' },
  { role: 'assistant', content: '思路清楚就是最难的那部分呀。演示前一晚要不要我陪你过一遍？' },
  { role: 'user', content: '好啊，那说定了，周二晚上九点你陪我过一遍。对了你还记得我爱吃啥零食吗' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'recall_diary', input: { query: '零食' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `【私人日记 · 2026-11-16 09:30】\n${DIARY}` }] },
  { role: 'assistant', content: '海苔！我可记着呢～今晚奖励自己一包？' },
  { role: 'user', content: '哈哈哈 你又拿这个逗我。我妈最近腰不太好，周末想带她去医院看看' },
  { role: 'assistant', content: '阿姨腰不好要早点看，周末挂号可能人多，可以提前在网上约。你自己也别太累。' },
  { role: 'user', content: '嗯嗯。先去吃饭了，晚点聊' },
  { role: 'assistant', content: '去吧去吧，吃点好的～' },
]
const model = anthropicClient({ baseUrl: process.env.BENCH_BASE_URL!, apiKey: process.env.BENCH_API_KEY!, model: process.env.BENCH_MODEL ?? 'deepseek-flash', effort: 'low', maxTokens: 4096 })
const r = await model.complete({ system: benchSeed(profile), messages: [...conv, { role: 'user', content: ZH_COMPACTION_INSTRUCTION }], tools: [] })
const text = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
console.log(text)
console.log('\n---- 检查 ----')
console.log('五节都在：', ['刚才都发生了什么', '我们之间', '对方现在怎么样', '我自己', '没说完的'].every((s) => text.includes(s)))
console.log('字数：', [...text].length, '（上限 1500）')
console.log('抄了日记原文：', text.includes('下次可以拿这个逗他'))
console.log('记住了约定（周二晚上九点）：', /周二.{0,6}(九点|9点|21)/.test(text))
console.log('用量：', JSON.stringify(r.usage))
