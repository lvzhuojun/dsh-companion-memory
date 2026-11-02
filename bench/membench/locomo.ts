// LoCoMo（Maharana et al. 2024，CC BY-NC 4.0）→ 记忆基准的原始对话。数据不随仓库分发：
// 自己下载，用环境变量 LOCOMO_PATH 指向本地文件。只用于评测。
//
// 角色映射：speaker_a 当作“和她聊天的人”（ownerName），speaker_b 的话当作“我”说的——这样每个系统都以 speaker_b 的身份
// 记住和 speaker_a 的对话（我们的系统本来就是“我和对方”的视角）。题目按代码里的类别编号（论文里的编号不一样）：
//   1 多跳 · 2 时间 · 3 开放域 · 4 单跳 · 5 对抗（不可回答；单独报，不计入总分——和 mem0 论文一致）

import type { Session, Transcript } from './transcript.js'

export interface LocomoQA {
  question: string
  answer?: string | number
  adversarial_answer?: string
  evidence?: string[]
  category: 1 | 2 | 3 | 4 | 5
}

export interface LocomoSample {
  sample_id: string
  conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string }
  qa: LocomoQA[]
}

export const LOCOMO_CATEGORY: Record<number, string> = { 1: 'multi_hop', 2: 'temporal', 3: 'open_domain', 4: 'single_hop', 5: 'adversarial' }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** “1:56 pm on 8 May, 2023” → { date: '2023-05-08', time: '13:56' } */
export function parseLocomoTime(s: string): { date: string; time: string } {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s*on\s*(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})/i.exec(s)
  if (!m) throw new Error(`看不懂的 LoCoMo 时间：${s}`)
  let h = Number(m[1]) % 12
  if (m[3]!.toLowerCase() === 'pm') h += 12
  const mon = MONTHS.indexOf(m[5]!.toLowerCase()) + 1
  if (mon <= 0) throw new Error(`看不懂的月份：${m[5]}`)
  return { date: `${m[6]}-${String(mon).padStart(2, '0')}-${String(Number(m[4])).padStart(2, '0')}`, time: `${String(h).padStart(2, '0')}:${m[2]}` }
}

export interface LocomoQuestion {
  id: string
  category: string
  ask: string
  gold: string
  adversarial: boolean
}

export interface LocomoSet {
  transcript: Transcript
  questions: LocomoQuestion[]
}

/** 一段 LoCoMo 对话 → 原始对话 + 题目。图片只留它的文字说明（blip_caption），和 mem0 的评测做法一致 */
export function fromLocomo(s: LocomoSample): LocomoSet {
  const c = s.conversation
  const keys = Object.keys(c).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]))
  const sessions: Session[] = keys.map((k) => {
    const { date, time } = parseLocomoTime(String(c[`${k}_date_time`]))
    const turns = (c[k] as Array<{ speaker: string; text: string; blip_caption?: string }>).map((u) => ({
      who: (u.speaker === c.speaker_a ? 'owner' : 'me') as 'owner' | 'me',
      text: u.text + (u.blip_caption ? ` [分享了一张图片：${u.blip_caption}]` : ''),
    }))
    return { date, time, turns }
  })
  const last = sessions[sessions.length - 1]!
  const now = new Date(Date.parse(`${last.date}T${last.time}:00+08:00`) + 86400000).toISOString()
  const questions = s.qa.map((q, i) => ({
    id: `${s.sample_id}-q${String(i + 1).padStart(3, '0')}`,
    category: LOCOMO_CATEGORY[q.category] ?? String(q.category),
    ask: q.question,
    gold: String(q.answer ?? q.adversarial_answer ?? ''),
    adversarial: q.category === 5,
  }))
  return { transcript: { version: `locomo10:${s.sample_id}`, ownerName: c.speaker_a, selfName: c.speaker_b, now, sessions, questions: [] }, questions }
}
