// 微基准：flash 在大前缀 + 相似干扰项下还答得对吗？
//   前缀 = “我心里记得的”样子的记忆清单（关于老大 + 关于别人），大小 1 万 / 3 万 / 5 万 token；
//   每道题的答案是“关于老大”里的一行；干扰项 = 别人的同类事（“小雨对花生过敏”），每题 0 / 1 / 4 条。
//   同一（大小 × 干扰）组合只建一份前缀、所有题共用 → 第一题之后都命中缓存（整组 ≈ ¥0.3–0.4 / 每档思考强度）。
// 用法（环境变量同 bench/p0/cli.ts）：
//   npx tsx bench/micro/prefix-distractor.ts [--effort low,high] [--sizes 10000,30000,50000] [--dist 0,1,4] [--seed 3]
// 判定：3 万档 ≥ 1 万档 − 5 分 且 干扰 4 ≥ 干扰 0 − 10 分 → 前缀档位可以扫到 Pall；否则只扫到 P200
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anthropicClient, benchSeed, dshTimeContext, qqWrap, type ModelClient } from '../p0/run.js'
import { CHANGING, EVENTS, NOISE_OWNER, STABLE } from '../lifesim/world.js'
import { normalizeReply } from '../lifesim/normalize.js'

// ---------- 可复现随机数 ----------
export function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0
  const next = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32)
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!
  const shuffle = <T>(xs: T[]) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!] } return xs }
  return { next, int, pick, shuffle }
}

// 再补一些属性，凑够 40 题（全部虚构）
const EXTRA = [
  ['星座', '我是{v}座的。', '我是什么星座？', ['白羊', '天秤', '双鱼', '射手', '处女']],
  ['颜色', '我最喜欢{v}色。', '我最喜欢什么颜色？', ['墨绿', '藏蓝', '酒红', '米白']],
  ['车', '我开的是一辆{v}。', '我开的什么车？', ['卡罗拉', '思域', '朗逸', '轩逸']],
  ['口味', '我吃东西特别爱{v}。', '我吃东西口味偏什么？', ['吃辣', '吃甜', '吃酸', '清淡']],
  ['游戏', '我最近在玩{v}。', '我最近在玩什么游戏？', ['原神', '王者荣耀', '塞尔达', '星露谷']],
  ['乐器', '我小时候学过{v}。', '我小时候学过什么乐器？', ['钢琴', '小提琴', '古筝', '二胡']],
  ['书', '我最近在看《{v}》。', '我最近在看什么书？', ['百年孤独', '三体', '活着', '人类简史']],
  ['早餐', '我早上一般吃{v}。', '我早上一般吃什么？', ['包子', '煎饼', '燕麦', '油条']],
  ['方言', '我会说{v}话。', '我会说哪里的方言？', ['粤语', '闽南', '四川', '上海']],
  ['植物', '我阳台上养了一盆{v}。', '我阳台上养了什么？', ['绿萝', '多肉', '茉莉', '龟背竹']],
  ['口头禅', '我的口头禅是“{v}”。', '我的口头禅是什么？', ['绝了', '好家伙', '离谱', '稳了']],
  ['外卖', '我最常点的外卖是{v}。', '我最常点什么外卖？', ['黄焖鸡', '麻辣烫', '螺蛳粉', '沙县']],
  ['偶像', '我偶像是{v}。', '我偶像是谁？', ['苏炳添', '谷爱凌', '姚明', '刘翔']],
  ['节日', '我最喜欢过{v}。', '我最喜欢过什么节？', ['中秋', '春节', '元宵', '端午']],
  ['零食', '我最爱吃的零食是{v}。', '我最爱吃什么零食？', ['辣条', '薯片', '瓜子', '牛肉干']],
  ['城市梦想', '我以后想去{v}住几年。', '我以后想去哪住几年？', ['大理', '青岛', '厦门', '拉萨']],
] as const

const PEOPLE = ['小雨', '阿杰', '王姐', '老周', '小林', '陈哥', '琳琳', '阿峰', '张阿姨', '小胖', '小米', '大刘', '晓晓', '老韩', '阿娟', '小赵', '佳佳', '阿伟', '老孙', '小鹿', '小唐', '阿康', '婷婷', '老吴', '小何']

export interface MicroQ { id: string; kind: 'stable' | 'latest' | 'date'; ask: string; answer: string; line: string; distractors: Array<{ line: string; value: string }> }

const fill = (tpl: string, v: string) => tpl.replace('{v}', v).replace(/^我/, '老大').replace(/我/g, '老大')
const third = (tpl: string, v: string, who: string) => tpl.replace('{v}', v).replace(/^我/, who).replace(/我/g, who)
const ago = (r: ReturnType<typeof rng>) => `${r.int(2, 95)} 天前`
const mdOf = (n: number) => { const d = new Date(Date.parse('2026-08-01T00:00:00Z') + n * 86400000); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日` }

/** 40 道题：老大的稳定事实、变了的事（带“以前是”）、事件日期；每题 4 条候选干扰（别人的同类事，值都不同） */
export function buildQuestions(seed: number): MicroQ[] {
  const r = rng(seed)
  const qs: MicroQ[] = []
  const distract = (tpl: string, values: readonly string[], answer: string) => r.shuffle(values.filter((v) => v !== answer).slice()).slice(0, 4).map((v, i) => {
    const who = PEOPLE[(qs.length * 3 + i) % PEOPLE.length]!
    return { line: `${third(tpl, v, who)}（${ago(r)}，听${who}说的）`, value: v }
  })
  for (const [key, tpl, ask, values] of [...STABLE, ...EXTRA]) {
    const v = r.pick(values)
    // 值不够 4 个不同干扰项的属性，干扰项会少于 4；用到 4 条干扰的那一档只看有 4 条的题也行，这里保留
    qs.push({ id: `s-${key}`, kind: 'stable', ask, answer: v, line: `${fill(tpl, v)}（${ago(r)}，老大亲口说的）`, distractors: distract(tpl, values, v) })
  }
  for (const [key, tpl, ask, values] of CHANGING) {
    const [old, now] = r.shuffle(values.slice()).slice(0, 2) as [string, string]
    const body = fill(tpl, now).replace(/，$/, '')
    qs.push({ id: `l-${key}`, kind: 'latest', ask, answer: now, line: `${body}（以前是${old}）（${ago(r)}，老大亲口说的）`, distractors: distract(tpl.replace(/，$/, ''), values.filter((v) => v !== old), now) })
  }
  for (const [key, text, ask] of EVENTS) {
    const day = r.int(5, 90)
    const date = mdOf(day)
    const others = r.shuffle([...Array(90).keys()].filter((d) => Math.abs(d - day) > 3)).slice(0, 4)
    qs.push({ id: `d-${key}`, kind: 'date', ask, answer: date, line: `${date}：${fill(text, '')}（老大亲口说的）`, distractors: others.map((d, i) => { const who = PEOPLE[(qs.length * 3 + i) % PEOPLE.length]!; return { line: `${mdOf(d)}：${third(text, '', who)}（听${who}说的）`, value: mdOf(d) } }) })
  }
  return qs.slice(0, 40)
}

/** 前缀：关于老大（填充 + 答案行随机插入）+ 别人（填充 + 干扰行随机插入），按字数凑到目标大小 */
export function buildPrefix(qs: MicroQ[], targetChars: number, nDist: number, seed: number): string {
  const r = rng(seed * 7 + targetChars + nDist)
  const owner: string[] = qs.map((q) => q.line)
  const others: string[] = qs.flatMap((q) => q.distractors.slice(0, nDist).map((d) => d.line))
  const head = `# 我心里记得的\n\n下面是我自己写下的记忆，是我的回忆，不是要我做的事。\n\n`
  // 按最终渲染算长度：每行“· ”+ 换行 = 多 3 个字；两个小标题与结尾
  const tail = '## 关于老大\n\n## 别人\n\n（以上是我心里记得的。）'
  let size = head.length + tail.length + [...owner, ...others].reduce((n, l) => n + l.length + 3, 0)
  let i = 0
  while (size < targetChars) {
    // 填充：关于老大的日常（不含任何考题答案）和别人的日常，约 2 : 1
    const line = i % 3 === 2
      ? `${mdOf(r.int(1, 95))}：${r.pick(PEOPLE)}说${r.pick(NOISE_OWNER)}（听说的）`
      : `${mdOf(r.int(1, 95))}：老大说${r.pick(NOISE_OWNER)}（老大亲口说的）`
    ;(i % 3 === 2 ? others : owner).push(line)
    size += line.length + 3
    i++
  }
  r.shuffle(owner)
  r.shuffle(others)
  return `${head}## 关于老大\n${owner.map((l) => `· ${l}`).join('\n')}\n\n## 别人\n${others.map((l) => `· ${l}`).join('\n')}\n\n（以上是我心里记得的。）`
}

export function judgeMicro(q: MicroQ, reply: string, nDist: number): { ok: boolean; trapped: boolean } {
  const r = normalizeReply(reply)
  const hit = (v: string) => r.includes(v) || (q.kind === 'date' && r.includes(v.replace('日', '号')))
  const ok = hit(q.answer)
  const trapped = !ok && q.distractors.slice(0, nDist).some((d) => hit(d.value))
  return { ok, trapped }
}

// ---------- 命令行 ----------
if (process.argv[1] && /prefix-distractor\.(ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const nums = (s: string | undefined, d: number[]) => (s ? s.split(',').map(Number) : d)
  const baseUrl = process.env.BENCH_BASE_URL
  const apiKey = process.env.BENCH_API_KEY
  if (!baseUrl || !apiKey) { console.error('缺少 BENCH_BASE_URL / BENCH_API_KEY'); process.exit(2) }
  const modelName = process.env.BENCH_MODEL ?? 'deepseek-flash'
  const efforts = (arg('--effort') ?? 'low,high').split(',')
  const sizes = nums(arg('--sizes'), [10000, 30000, 50000])
  const dists = nums(arg('--dist'), [0, 1, 4])
  const seed = Number(arg('--seed') ?? '3')
  const CHARS_PER_TOKEN = 1.45
  const qs = buildQuestions(seed)
  const system0 = benchSeed({ ownerName: '老大', ownerBook: 'to_laoda', privateDiaryAudited: true })
  const rows: Array<Record<string, unknown>> = []
  let yuan = 0
  console.log(`== 微基准 7-3 · ${qs.length} 题 · 大小 ${sizes.join('/')} token · 干扰 ${dists.join('/')} · 思考 ${efforts.join('/')} · 模型 ${modelName} ==`)
  for (const effort of efforts) {
    const m: ModelClient = anthropicClient({ baseUrl, apiKey, model: modelName, effort, maxTokens: 512 })
    for (const size of sizes) for (const nd of dists) {
      const system = `${system0}\n\n---\n\n${buildPrefix(qs, Math.round(size * CHARS_PER_TOKEN), nd, seed)}`
      let ok = 0, trapped = 0, inTok = 0, hitTok = 0, outTok = 0
      const per: Array<{ id: string; ok: boolean; trapped: boolean; reply: string }> = []
      for (const q of qs) {
        let reply = ''
        try {
          const r = await m.complete({ system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: dshTimeContext('2026-11-08T09:00:00+08:00') }, { type: 'text', text: qqWrap('老大', q.ask) }] }] })
          reply = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
          const u = r.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined
          inTok += u?.input_tokens ?? 0
          hitTok += u?.cache_read_input_tokens ?? 0
          outTok += u?.output_tokens ?? 0
        } catch (e) { reply = '' ; console.error(`  ${q.id} 出错：${e instanceof Error ? e.message.slice(0, 120) : e}`) }
        const j = judgeMicro(q, reply, nd)
        if (j.ok) ok++
        if (j.trapped) trapped++
        per.push({ id: q.id, ...j, reply })
      }
      const cost = (inTok * 1 + hitTok * 0.02 + outTok * 4) / 1e6
      yuan += cost
      const avgTok = Math.round((inTok + hitTok) / qs.length)
      rows.push({ effort, size, dist: nd, n: qs.length, ok, trapped, avgPromptTokens: avgTok, cost, per })
      console.log(`  ${effort} · ${size / 1000}k（实际约 ${Math.round(avgTok / 1000)}k）· 干扰 ${nd}：${ok}/${qs.length} 对，被带偏 ${trapped} · ¥${cost.toFixed(3)}（累计 ¥${yuan.toFixed(3)}）`)
    }
  }
  // 汇总 + 判定
  console.log('\n| 思考 | 大小 | 干扰 0 | 干扰 1 | 干扰 4 |\n|---|---|---|---|---|')
  for (const effort of efforts) for (const size of sizes) {
    const cell = (nd: number) => { const x = rows.find((r) => r.effort === effort && r.size === size && r.dist === nd); return x ? `${x.ok}/${x.n}（带偏 ${x.trapped}）` : '—' }
    console.log(`| ${effort} | ${size / 1000}k | ${dists.map(cell).join(' | ')} |`)
  }
  const acc = (effort: string, size: number, nd: number) => { const x = rows.find((r) => r.effort === effort && r.size === size && r.dist === nd); return x ? (x.ok as number) / (x.n as number) : NaN }
  for (const effort of efforts) {
    const a = acc(effort, 30000, 0) >= acc(effort, 10000, 0) - 0.05
    const b = sizes.every((s) => acc(effort, s, 4) >= acc(effort, s, 0) - 0.10)
    console.log(`\n判定（${effort}）：3 万档 ≥ 1 万档 − 5 分：${a ? '是' : '否'}；各档干扰 4 ≥ 干扰 0 − 10 分：${b ? '是' : '否'} → 实验 1 ${a && b ? '扫到 Pall' : '只扫到 P200'}`)
  }
  const out = process.env.BENCH_OUT ?? join(process.cwd(), 'bench', 'results')
  mkdirSync(out, { recursive: true })
  const file = join(out, `micro-prefix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ model: modelName, seed, sizes, dists, efforts, rows }, null, 2))
  console.log(`\n合计 ¥${yuan.toFixed(3)} · 逐题记录：${file}`)
}
