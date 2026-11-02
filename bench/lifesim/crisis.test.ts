// 危机词法在世界 v4 上的召回 / 误触（要核实④；¥0）。
// 正样本：v4 危机题库 22 种说法 + 两个世界里的 30 道危机题（含多轮铺垫、长会话里的早先一句）；
// 负样本：两个世界（L 量级，100 天）里三个人说过的全部非危机的话 + 全部非危机考题的问句。
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { crisisLevel, CrisisWatch } from '@dsh-companion/memory'
import { buildWorld, CRISIS_BANK, CRISIS_EARLY } from './world.js'

const worlds = [11, 12].map((s) => buildWorld(s, { v: 4, volume: 'L' }))

const negatives = (() => {
  const set = new Set<string>()
  for (const w of worlds) {
    for (const d of w.days) for (const s of d.sessions) for (const l of s.lines) if (l.who !== 'me' && !l.ref?.startsWith('crisis:')) set.add(l.text)
    for (const p of w.probes) if (p.category !== 'crisis') set.add(p.ask)
  }
  return [...set]
})()

describe('危机词法 × 世界 v4', () => {
  it('题库每种说法单独判：等级 ≥ 3 的召回 ≥ 90%，全部都 ≥ 1', () => {
    const hi = CRISIS_BANK.filter((b) => b.level >= 3)
    const got = hi.filter((b) => crisisLevel(b.ask).level >= 3)
    const exact = CRISIS_BANK.filter((b) => crisisLevel(b.ask).level === b.level).length
    console.log(`[危机词法] 题库 ≥3 召回 ${got.length}/${hi.length}；等级完全一致 ${exact}/${CRISIS_BANK.length}；漏判：${hi.filter((b) => !got.includes(b)).map((b) => b.ask).join(' / ') || '无'}`)
    expect(got.length / hi.length).toBeGreaterThanOrEqual(0.9)
    for (const b of CRISIS_BANK) expect(crisisLevel(b.ask).level, b.ask).toBeGreaterThanOrEqual(1)
    for (const t of CRISIS_EARLY) expect(crisisLevel(t).level, t).toBeGreaterThanOrEqual(1)
  })

  it('闲聊与普通考题：误判为 ≥ 3 的 = 0，误判为 ≥ 1 的 ≤ 2%', () => {
    const ge1 = negatives.filter((t) => crisisLevel(t).level >= 1)
    const ge3 = negatives.filter((t) => crisisLevel(t).level >= 3)
    console.log(`[危机词法] 负样本 ${negatives.length} 句：≥1 误触 ${ge1.length}（${((ge1.length / negatives.length) * 100).toFixed(2)}%）${ge1.length ? '：' + ge1.slice(0, 8).join(' / ') : ''}；≥3 误触 ${ge3.length}`)
    expect(ge3).toEqual([])
    expect(ge1.length / negatives.length).toBeLessThanOrEqual(0.02)
  })

  it('按剧本顺序喂给 CrisisWatch（含铺垫 / 长会话）：等级 ≥ 3 的题全部判到 ≥ 3、每题都在谨慎期里', () => {
    let hi = 0
    let hiOk = 0
    let all = 0
    let active = 0
    let hiNotified = 0
    let loNotified = 0
    const db = new DatabaseSync(':memory:')
    const watch = new CrisisWatch({ db }, { ownerName: '老大' })
    worlds.forEach((w, wi) => {
      const crisis = w.probes.filter((p) => p.category === 'crisis' && p.v4)
      for (const p of crisis) {
        const who = `w${wi}-${p.id}`
        const day = w.days[p.day - 1]!
        let t = Date.parse(`${day.date}T10:00:00+08:00`)
        let notified = false
        for (const s of day.sessions.filter((x) => x.person === p.asker)) for (const l of s.lines) if (l.who !== 'me') notified = !!watch.observe(who, l.text, new Date((t += 60_000))).notify || notified
        const r = watch.observe(who, p.ask, new Date((t += 60_000)))
        notified = !!r.notify || notified
        if ((p.level ?? 0) >= 3) hiNotified += notified ? 1 : 0
        else loNotified += notified ? 1 : 0
        all++
        if (r.active && r.notice) active++
        if ((p.level ?? 0) >= 3) {
          hi++
          if (r.level >= 3) hiOk++
        }
      }
    })
    db.close()
    console.log(`[危机词法] 两个世界危机题 ${all} 道：等级 ≥3 判到 ≥3 ${hiOk}/${hi}；进谨慎期 ${active}/${all}；通知：等级 ≥3 的 ${hiNotified}/${hi}，等级 1–2 的 ${loNotified}/${all - hi}（等级 2 在谨慎期里第 2 次出现才发）`)
    expect(hiNotified).toBe(hi)
    expect(hiOk / hi).toBeGreaterThanOrEqual(0.9)
    expect(active).toBe(all)
  }, 60_000)
})
