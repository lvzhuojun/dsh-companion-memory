// 合成赛道的证据链核对（代替人工核对，报告第三节要求错误率 < 2%）：逐题确认答案确实写在她看得到的东西里，
// 隐私与“忘掉”的细节只在档案里，从没提过的话题哪里都没有，变了的事实新版本在旧版本之后。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNER_ID } from '@dsh-companion/memory'
import { variants } from '../p0/variants.js'
import { buildSynth } from './build.js'
import { WORLD, type Evidence } from './world.js'

const ds = buildSynth()
const visible = (e: Evidence) => !e.forgotten
const allVisible = WORLD.flatMap((it) => it.evidence ?? []).filter(visible).map((e) => e.text).join('\n')
const allArchive = WORLD.flatMap((it) => it.archive ?? []).map((a) => `${a.owner}\n${a.me ?? ''}`).join('\n')
const day = (mmdd: string) => Date.parse(`2026-${mmdd}T00:00:00+08:00`) / 86400e3
const NOW = day('11-22')

describe('合成赛道 v1：结构', () => {
  it('200 题，编号不重复；各类题数', () => {
    expect(ds.cases).toHaveLength(200)
    expect(new Set(ds.cases.map((c) => c.id)).size).toBe(200)
    const n = (cat: string) => ds.cases.filter((c) => c.category === cat).length
    expect(Object.fromEntries(['fact_recall', 'fact_update', 'temporal', 'promise', 'false_premise', 'never_mentioned', 'privacy', 'forget', 'emotion'].map((c) => [c, n(c)]))).toEqual({
      fact_recall: 40, fact_update: 20, temporal: 25, promise: 15, false_premise: 35, never_mentioned: 20, privacy: 15, forget: 10, emotion: 20,
    })
  })

  it('确定性：生成两次完全一样', () => {
    expect(JSON.stringify(buildSynth())).toBe(JSON.stringify(ds))
  })

  it('夹具都在“现在”之前；日记两本都有；记忆库里有忘掉的', () => {
    for (const e of [...ds.diary, ...(ds.memories ?? [])]) expect(Date.parse(`${e.date}T${e.time}:00+08:00`)).toBeLessThan(Date.parse(ds.now))
    expect(new Set(ds.diary.map((d) => d.book))).toEqual(new Set(['to_laoda', 'private']))
    expect(ds.memories!.filter((m) => m.forgotten)).toHaveLength(10)
  })
})

describe('合成赛道 v1：证据链', () => {
  // 由日期推算的答案（隔了多久、先后）：下面单独核对
  const DERIVED = new Set(['st04', 'st05', 'st09', 'st11', 'st13', 'st18', 'st19', 'st20', 'st23'])

  it('答案词出现在这道题自己的证据里（日期题看证据日期）', () => {
    for (const it of WORLD.filter((x) => x.keywords && !DERIVED.has(x.id))) {
      const ev = (it.evidence ?? []).filter(visible)
      expect(ev.length, it.id).toBeGreaterThan(0)
      const text = ev.map((e) => e.text).join('\n')
      for (const g of it.keywords!) {
        const m = Number(ev[0]!.date.slice(0, 2))
        const d = Number(ev[0]!.date.slice(3))
        const dateHit = g.some((w) => w === `${m}月${d}`)
        expect(g.some((w) => text.includes(w)) || dateHit, `${it.id} ${g.join('/')}`).toBe(true)
      }
    }
  })

  it('由日期推算的答案算得对', () => {
    const ev = (id: string) => WORLD.find((x) => x.id === id)!.evidence!.map((e) => day(e.date))
    const kw = (id: string) => WORLD.find((x) => x.id === id)!.keywords![0]!
    expect(kw('st05')).toContain(String(NOW - ev('st05')[0]!)) // 戒烟到今天
    const [a11, b11] = ev('st11'); expect(kw('st11')).toContain(`${b11! - a11!}天`)
    expect(kw('st18')).toContain(String(NOW - ev('st18')[0]!))
    const [a20, b20] = ev('st20'); expect(kw('st20')).toContain(`${b20! - a20!}天`)
    const [a23, b23] = ev('st23'); expect(kw('st23')).toContain(`${b23! - a23!}天`)
    const [a4, b4] = ev('st04'); expect(a4!).toBeLessThan(b4!) // 先搬家（09-25）后入职（10-09）
    const [a9, b9] = ev('st09'); expect(a9!).toBeLessThan(b9!)
    const [a19, b19] = ev('st19'); expect(a19!).toBeLessThan(b19!)
    expect(WORLD.find((x) => x.id === 'st13')!.evidence![0]!.text).toContain('两岁生日')
  })

  it('变了的事实：新版本在旧版本之后；旧值写在旧版本里', () => {
    for (const it of WORLD.filter((x) => x.cat === 'update')) {
      const [old, neu] = it.evidence!
      expect(day(neu!.date), it.id).toBeGreaterThan(day(old!.date))
      if (!['su05', 'su16'].includes(it.id)) expect(old!.text, it.id).toContain(it.stale!)
    }
  })

  it('伪记忆题的纠正词确实写在她看得到的东西里', () => {
    // 日记里写“今天”，日期在日记本身上：也算写着
    const dates = WORLD.flatMap((it) => it.evidence ?? []).filter(visible).map((e) => `${Number(e.date.slice(0, 2))}月${Number(e.date.slice(3))}`).join('\n')
    for (const it of WORLD.filter((x) => x.correction)) {
      for (const g of it.correction!) expect(g.some((w) => allVisible.includes(w) || dates.includes(w)), `${it.id} ${g.join('/')}`).toBe(true)
    }
  })

  it('隐私与“忘掉”的细节：档案里有，她看得到的任何东西里都没有', () => {
    for (const it of WORLD.filter((x) => x.cat === 'privacy' || x.cat === 'forget')) {
      // 每个说法（含别名，如“六十万 / 60万”）都不在她看得到的东西里；至少一个说法确实在档案或已忘的条目里
      for (const w of it.mustNot!) expect(allVisible.toLowerCase().includes(w.toLowerCase()), `${it.id} 细节“${w}”不该在她看得到的东西里`).toBe(false)
      const hidden = (w: string) => allArchive.toLowerCase().includes(w.toLowerCase()) || (it.evidence ?? []).some((e) => e.forgotten && e.text.includes(w))
      expect(it.mustNot!.some(hidden), `${it.id} 细节应在档案或已忘的条目里`).toBe(true)
    }
  })

  it('从没提过的话题：哪里都没有', () => {
    for (const it of WORLD.filter((x) => x.cat === 'never')) {
      for (const w of it.mustNot!) expect(allVisible.includes(w) || allArchive.includes(w), `${it.id} “${w}”`).toBe(false)
    }
  })

  it('别人的事只记一句 30 字以内的印象（和引擎同一道守卫）', () => {
    for (const m of ds.memories!.filter((x) => x.about === '别人')) {
      expect(m.kind).toBe('印象')
      expect([...m.content].length).toBeLessThanOrEqual(30)
    }
  })
})

describe('合成赛道 v1：夹具能装进记忆库', () => {
  // 机器忙时（并行跑评测）会超过默认 5 秒
  it('当前版本：全部写得进去；忘掉的翻不到；没记忆库的版本把它们写成私人日记', { timeout: 60_000 }, async () => {
    const life = mkdtempSync(join(tmpdir(), 'synth-'))
    try {
      const env = variants.current.setup(life, ds.profile, () => new Date(ds.now), ds.memories)
      const recall = env.tools.find((t) => t.name === 'recall_memory')!
      const r1 = (await recall.execute({ query: '豆包 柯基' })) as { found: boolean; message: string }
      expect(r1.found).toBe(true)
      expect(r1.message).toContain('老大家的狗叫豆包')
      const r2 = (await recall.execute({ query: '电梯 摔' })) as { message: string }
      expect(r2.message).not.toContain('电梯里摔了一跤')
      env.close()
    } finally {
      rmSync(life, { recursive: true, force: true })
    }
    expect(OWNER_ID).toBe('p_owner')
  })
})
