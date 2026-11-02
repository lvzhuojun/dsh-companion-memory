// 有效期 + 键（开关 Y）：键表、高精度词法、失效、读侧、触发器、回滚兼容、级联候选
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectSlot, expiredNote, historyCue, MemoryStore, normalizeSlot, OWNER_ID, renderNotice, renderRecall, slotCandidates, slotDef, slotMentioned,
  SLOT_KEYS, SLOTS, stableLayer, type KeepInput, type KeepResult, type Viewer,
} from '../src/index.js'

let dir: string
let store: MemoryStore
const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const sister: Viewer = { person: 'p_sister', channel: 'private' }
const at = (d: string, hm = '20:00') => new Date(`${d}T${hm}:00+08:00`)
const fact = (content: string, extra: Partial<KeepInput> = {}): KeepInput => ({ content, importance: '一般', about: '对方', kind: '事实', ...extra })
const keep = (content: string, d: string, extra: Partial<KeepInput> = {}, o: { slots?: boolean; viewer?: Viewer } = { slots: true }) => {
  const r = store.keep(fact(content, extra), { viewer: o.viewer ?? owner, now: at(d), ...(o.slots ? { slots: true } : {}) })
  if (!r.ok) throw new Error(r.reason)
  return r as Extract<KeepResult, { ok: true }>
}
const row = (id: string) => store.get(id)!
const logs = () => store.db.prepare('SELECT memory_id, event, by, cause_memory_id, reason, at FROM memory_validity_log ORDER BY id').all() as Array<Record<string, string>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-slots-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
  store.ensurePerson('p_sister', '小雨')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('键表', () => {
  it('封闭词表约 20 个；世界 v3 里会变的六个键（bench/lifesim/world.ts 的 CHANGING）都归得到封闭键，且都是值型', () => {
    expect(SLOT_KEYS.length).toBeGreaterThanOrEqual(19)
    expect(new Set(SLOT_KEYS).size).toBe(SLOT_KEYS.length)
    const world: Record<string, string> = { 城市: '住址', 公司: '工作', 通勤: '通勤', 饮品: '饮品偏好', 手机: '手机', 运动: '运动' }
    for (const [k, slot] of Object.entries(world)) {
      expect(normalizeSlot(k), k).toBe(slot)
      expect(slotDef(slot)!.kind, k).toBe('value')
    }
    // 级联键都在表里
    for (const s of SLOTS) for (const c of s.cascade) expect(SLOT_KEYS, `${s.key} → ${c}`).toContain(c)
  })

  it('normalizeSlot：键名、别称、同义词、括号都认；开放键 ≤ 6 字原样存；超长 / 空 → undefined', () => {
    expect(normalizeSlot('住址')).toBe('住址')
    expect(normalizeSlot('【住址】')).toBe('住址')
    expect(normalizeSlot('住处')).toBe('住址')
    expect(normalizeSlot('家')).toBe('住址')
    expect(normalizeSlot('上下班')).toBe('通勤')
    expect(normalizeSlot('开车')).toBe('通勤')
    expect(normalizeSlot('住址变了')).toBe('住址')
    expect(normalizeSlot('其它:住处')).toBe('住址')
    expect(normalizeSlot('其它:猫的名字')).toBe('其它:猫的名字')
    expect(normalizeSlot('其他：血型')).toBe('其它:血型')
    expect(normalizeSlot('血型')).toBe('其它:血型')
    expect(normalizeSlot('其它:老大最喜欢的歌手')).toBeUndefined()
    expect(normalizeSlot('  ')).toBeUndefined()
    expect(normalizeSlot('其它:')).toBeUndefined()
  })

  it('detectSlot：世界里的变化说法都认得出', () => {
    expect(detectSlot('老大搬到成都了，新家还挺不错的。')).toBe('住址')
    expect(detectSlot('老大换工作了，去了一家叫北辰的公司。')).toBe('工作')
    expect(detectSlot('老大现在坐地铁上班。')).toBe('通勤')
    expect(detectSlot('老大最近只喝乌龙茶了。')).toBe('饮品偏好')
    expect(detectSlot('老大新换了一部华为手机。')).toBe('手机')
    expect(detectSlot('老大最近开始跑步了。')).toBe('运动')
    expect(detectSlot('新家离公司远多了，以后只能坐地铁上班了。')).toBe('通勤')
    // 括号里的“以前”不影响主句
    expect(detectSlot('老大现在坐地铁上班（以前开车）')).toBe('通勤')
    expect(detectSlot('老大搬到成都了，以前说过搬到苏州，这次换了')).toBe('住址')
    // “手机号”胜过“手机”
    expect(detectSlot('老大换了手机号')).toBe('联系方式')
  })

  it('detectSlot 的精确：只有同义词没有信号词、讲过去、还没发生、否定、别人的事、公司搬了、问句 → 不标（或标成状态型）', () => {
    expect(detectSlot('老大住在苏州')).toBeUndefined()
    expect(detectSlot('老大坐地铁上班')).toBeUndefined()
    expect(detectSlot('住在望江花园 7 栋，快递老送错')).toBeUndefined()
    expect(detectSlot('老大现在工作压力很大')).toBeUndefined()
    expect(detectSlot('新家楼下在装修，吵死了')).toBeUndefined()
    expect(detectSlot('老大以前搬到过苏州')).toBeUndefined()
    expect(detectSlot('9月14号他说的是搬到成都')).toBeUndefined()
    expect(detectSlot('可他8月19日才搬到苏州')).toBeUndefined()
    expect(detectSlot('老大还没搬到成都')).toBeUndefined()
    expect(detectSlot('这次又搬了一次家，没说搬到哪儿')).toBeUndefined()
    expect(detectSlot('老大搬到成都了吗')).toBeUndefined()
    expect(detectSlot('老大的妹妹搬到杭州了')).toBe('家人近况')
    expect(detectSlot('老大有个表哥，换了辆特斯拉')).toBeUndefined()
    expect(detectSlot('听说蓝海科技搬到上海了')).toBeUndefined()
    expect(detectSlot('老大公司年底搬到浦东')).toBeUndefined()
    expect(detectSlot('老大女朋友搬到杭州了')).toBeUndefined()
    expect(detectSlot('老大和女朋友分手了')).toBe('恋爱状态')
    // 还没发生：不算住址变了，算搬家计划（状态型，不让任何条失效）
    expect(detectSlot('老大打算下个月搬到杭州')).toBe('搬家计划')
    expect(slotDef('搬家计划')!.kind).toBe('state')
  })

  it('slotCandidates / slotMentioned：只看同义词，最多 3 个，这个人已有的键排前面', () => {
    expect(slotCandidates('老大住在苏州，每天坐地铁上班')).toEqual(expect.arrayContaining(['住址', '通勤']))
    expect(slotCandidates('老大住在苏州，每天坐地铁上班', [], ['通勤'])[0]).toBe('通勤')
    expect(slotCandidates('今天天气不错')).toEqual([])
    expect(slotCandidates('x', ['电动车上班'])).toEqual(['通勤'])
    expect(slotMentioned('老大开车上班', '通勤')).toBe(true)
    expect(slotMentioned('老大开车去海边玩了', '通勤')).toBe(false)
    expect(slotMentioned('老大的同事开车上班', '通勤')).toBe(false)
  })

  it('historyCue 照旧（正则搬到 slots.ts 共用）', () => {
    expect(historyCue('我以前住哪来着')).toBe(true)
    expect(historyCue('我住哪')).toBe(false)
  })
})

describe('写入：标键与失效', () => {
  it('苏州 → 成都：旧条 valid_to / superseded_at、审计行、新条 supersedes；正文不动；返回消息用的信息', () => {
    const a = keep('老大搬到苏州了，新家还挺不错的。', '2026-08-05')
    expect(a.slot).toEqual({ key: '住址', by: 'system', invalidated: [] })
    expect(row(a.id)).toMatchObject({ slot: '住址', slot_by: 'system', valid_from: '2026-08-05T20:00:00+08:00', valid_to: null })
    const b = keep('老大搬到成都了，以前说过搬到苏州，这次换了地方。', '2026-10-12')
    expect(b.slot).toEqual({ key: '住址', by: 'system', invalidated: [a.id] })
    expect(row(a.id)).toMatchObject({ valid_to: '2026-10-12T20:00:00+08:00', superseded_at: '2026-10-12T20:00:00+08:00', content: '老大搬到苏州了，新家还挺不错的。' })
    expect(row(b.id)).toMatchObject({ supersedes: a.id, slot: '住址', valid_to: null })
    expect(logs()).toEqual([{ memory_id: a.id, event: 'invalidate', by: 'system', cause_memory_id: b.id, reason: '同一件事（住址）有了新的一条', at: '2026-10-12T20:00:00+08:00' }])
    expect(store.verifyIntegrity().mismatched).toEqual([])
  })

  it('同键好几条旧的都失效，新条 supersedes 指最近那条', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    const b = keep('老大现在住在苏州园区，地址改成了湖东。', '2026-08-20', { slot: '住址' })
    const c = keep('老大搬到成都了。', '2026-10-12')
    expect(c.slot!.invalidated).toEqual([b.id])
    expect(row(b.id).supersedes).toBe(a.id)
    expect(row(a.id).valid_to).toBe('2026-08-20T20:00:00+08:00')
    expect(row(c.id).supersedes).toBe(b.id)
  })

  it('“住在望江花园 7 栋，快递老送错”不让住址旧条失效', () => {
    const a = keep('老大搬到成都了。', '2026-08-05')
    const b = keep('老大住在望江花园 7 栋，快递老送错。', '2026-08-20')
    expect(b.slot).toBeUndefined()
    expect(row(a.id).valid_to).toBeNull()
    expect(row(a.id).superseded_at).toBeNull()
  })

  it('状态型键只标不失效（她明确给了键也一样）', () => {
    const a = keep('老大最近感冒了。', '2026-08-05', { slot: '健康' })
    const b = keep('老大感冒好了。', '2026-08-09', { slot: '健康' })
    expect(b.slot).toEqual({ key: '健康', by: 'her', invalidated: [] })
    expect(row(a.id).valid_to).toBeNull()
    expect(logs()).toEqual([])
  })

  // 11-02 收紧：她标键很随意（“报名了组长竞聘”标成工作、“老家在洛阳”标成住址，种子 11 误失效 3/9），
  // 所以她标了键也要有变化信号才失效；没信号的只标键（她自己写 supersedes 的照旧）
  it('她明确给了键但正文没有变化信号：只标键、不失效', () => {
    const a = keep('老大住在苏州。', '2026-08-05', { slot: '住址' })
    const b = keep('老大住在成都。', '2026-10-12', { slot: '住处' })
    expect(row(b.id).slot).toBe('住址')
    expect(row(a.id).valid_to).toBeNull()
    expect(logs()).toHaveLength(0)
  })

  it('她明确给了键且有变化信号：失效；by = her', () => {
    const a = keep('老大住在苏州。', '2026-08-05', { slot: '住址' })
    const b = keep('老大搬到成都了。', '2026-10-12', { slot: '住处' })
    expect(b.slot).toEqual({ key: '住址', by: 'her', invalidated: [a.id] })
    expect(logs()[0]).toMatchObject({ memory_id: a.id, by: 'her', cause_memory_id: b.id })
  })

  it('问以前的事：预翻按键带出历代旧值（从早到晚），不靠 supersedes 链；随手标了键但没说值的不算', () => {
    keep('老大搬到苏州了。', '2026-08-06', { slot: '住址' })
    keep('老大新家空调坏了，爬了好几趟楼。', '2026-08-07', { slot: '住址' })   // 她随手标的，没说住哪
    keep('老大搬到成都了。', '2026-10-12', { slot: '住址' })
    const now = keep('老大搬到厦门了，新家还不错。', '2026-10-26', { slot: '住址' })
    const r = store.preRecall('我最早搬到哪了来着？新家是哪个？', owner, new Date('2026-11-01T09:00:00+08:00'), { cue: 'strong', history: true, k: 6, noGate: true })
    const it = r.items.find((x) => x.row.id === now.id)
    expect(it).toBeDefined()
    const older = it!.older.map((o) => o.text)
    expect(older[0]).toContain('苏州')
    expect(older.some((t) => t.includes('成都'))).toBe(true)
    expect(older.some((t) => t.includes('空调'))).toBe(false)
  })

  it('讲籍贯的不算住址变化：老家在洛阳不顶掉住在苏州', () => {
    const a = keep('老大搬到苏州了。', '2026-08-06', { slot: '住址' })
    keep('老大老家在洛阳，小时候在那儿长大的。', '2026-08-19', { slot: '住址' })
    expect(row(a.id).valid_to).toBeNull()
  })

  it('没标过键的旧条不动（只认同键）；代码不按词猜旧条', () => {
    const a = keep('老大住在苏州。', '2026-08-05')
    expect(row(a.id).slot).toBeNull()
    keep('老大搬到成都了。', '2026-10-12')
    expect(row(a.id).valid_to).toBeNull()
  })

  it('不同主人不失效：妹妹搬家不动老大的住址；别人的事（about=别人）不自动标', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    const s = keep('小雨搬到成都了。', '2026-10-12', {}, { slots: true, viewer: sister })
    expect(s.slot!.invalidated).toEqual([])
    expect(row(a.id).valid_to).toBeNull()
    const o = keep('同事搬到成都了', '2026-10-13', { about: '别人', kind: '印象' })
    expect(o.slot).toBeUndefined()
    expect(row(o.id).slot).toBeNull()
    // 我自己（self 册）和对方（person 册）不是同一主人
    const me = keep('我搬到新服务器了。', '2026-10-14', { about: '我自己', kind: '经历', slot: '住址' })
    expect(me.slot!.invalidated).toEqual([])
    expect(row(a.id).valid_to).toBeNull()
  })

  it('涉及的人（subjects）对不上不算同一主人', () => {
    const a = keep('他搬到苏州了。', '2026-08-05', { subjects: ['p_x'] })
    const b = keep('他搬到成都了。', '2026-10-12', { subjects: ['p_y'] })
    expect(b.slot!.invalidated).toEqual([])
    expect(row(a.id).valid_to).toBeNull()
    const c = keep('他又搬到南京了。', '2026-10-20', { subjects: ['p_x'] })
    expect(c.slot!.invalidated).toEqual([a.id])
  })

  it('她自己给的 supersedes 照旧；被取代的那条有键就补上有效期与审计行（by=her）；新条顺着旧条的键', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    const b = keep('老大在成都安顿下来了。', '2026-10-12', { supersedes: a.id })
    expect(row(a.id)).toMatchObject({ superseded_at: '2026-10-12T20:00:00+08:00', valid_to: '2026-10-12T20:00:00+08:00' })
    expect(row(b.id)).toMatchObject({ supersedes: a.id, slot: '住址', slot_by: 'system' })
    expect(b.slot).toEqual({ key: '住址', by: 'system', invalidated: [] })
    expect(logs()).toEqual([expect.objectContaining({ memory_id: a.id, by: 'her', cause_memory_id: b.id })])
    // 下一次变化顺着键找得到它
    const c = keep('老大搬到南京了。', '2026-10-30')
    expect(c.slot!.invalidated).toEqual([b.id])
  })

  it('valid_from：她写了确切日期就用它；失效日不早于旧条自己的起点', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05', { occurredAt: '2026-08-03' })
    expect(row(a.id).valid_from).toBe('2026-08-03')
    const b = keep('老大搬到成都了。', '2026-10-12', { occurredAt: '2026-10-10' })
    expect(row(a.id).valid_to).toBe('2026-10-10')
    // 补记得很早（比旧条的起点还早）：不倒挂
    const c = keep('老大搬到南京了。', '2026-10-20', { occurredAt: '2026-10-01' })
    expect(row(b.id).valid_to).toBe('2026-10-10')
    expect(row(c.id).valid_from).toBe('2026-10-01')
    // 不是确切日期的（“上周”“2026-11”）用记下的时刻
    const d = keep('老大搬到厦门了。', '2026-10-25', { occurredAt: '上周' })
    expect(row(d.id).valid_from).toBe('2026-10-25T20:00:00+08:00')
  })

  it('她写的键：超长拒绝并说明；不在表里的按“其它:xxx”存，附上像的封闭键', () => {
    const bad = store.keep(fact('老大最喜欢周杰伦', { slot: '其它:老大最喜欢的歌手' }), { viewer: owner, now: at('2026-08-05'), slots: true })
    expect(bad.ok).toBe(false)
    expect((bad as { reason: string }).reason).toContain('其它:')
    const r = keep('老大现在坐地铁上班', '2026-08-06', { slot: '上班的路' })
    expect(r.slot).toEqual({ key: '其它:上班的路', by: 'her', invalidated: [], candidates: ['通勤'] })
    const r2 = keep('老大的狗叫豆包', '2026-08-07', { slot: '其它:狗名' })
    expect(r2.slot).toEqual({ key: '其它:狗名', by: 'her', invalidated: [] })
  })

  it('开放键不自动失效（不知道是值型还是状态型）', () => {
    const a = keep('老大的狗叫豆包', '2026-08-07', { slot: '其它:狗名' })
    keep('老大的狗改名叫可乐了', '2026-09-07', { slot: '其它:狗名' })
    expect(row(a.id).valid_to).toBeNull()
  })

  it('开关关：她给了 slot 也不写新列、不失效，返回和以前一样', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05', {}, {})
    const r = store.keep(fact('老大搬到成都了。', { slot: '住址' }), { viewer: owner, now: at('2026-10-12') })
    expect(r).toEqual({ ok: true, id: (r as { id: string }).id })
    expect(row(a.id)).toMatchObject({ slot: null, slot_by: null, valid_from: null, valid_to: null, superseded_at: null })
    expect(logs()).toEqual([])
  })
})

describe('读：稳定层只列有效的；回忆翻得到失效的、带有效期', () => {
  const NOW = at('2026-10-13')

  it('standing（slots）只取 valid_to 为空的；稳定层里是成都不是苏州', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05', { importance: '很重要' })
    keep('老大搬到成都了。', '2026-10-12')
    expect(store.standing(owner, 200, { slots: true }).map((m) => m.id)).not.toContain(a.id)
    const s = stableLayer(store, owner, NOW, { ownerName: '老大', slots: true })
    expect(s).toContain('成都')
    expect(s).not.toContain('苏州')
  })

  it('recall 翻得到失效条，原文后面带“（已过期：MM-DD 起不再是这样）”，不再另说“后来被我更新过”', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    keep('老大搬到成都了。', '2026-10-12')
    const r = store.recall({ query: '苏州' }, owner, NOW)
    const old = r.items.find((i) => i.id === a.id)!
    expect(old.validTo).toBe('2026-10-12T20:00:00+08:00')
    const text = renderRecall(r, '苏州', NOW)
    expect(text).toContain(`老大搬到苏州了。${expiredNote(old.validTo!)}`)
    expect(expiredNote(old.validTo!)).toBe('（已过期：10-12 起不再是这样）')
    expect(text).not.toContain('后来被我更新过')
  })

  it('排序：平时当前有效的在前；问“以前”时失效条不往后排', () => {
    const a = keep('老大搬到苏州了，苏州的新家挺好，苏州离上海近。', '2026-08-05')
    const b = keep('老大搬到成都了。', '2026-10-12')
    expect(row(a.id).valid_to).not.toBeNull()
    expect(store.recall({ query: '苏州 搬到' }, owner, NOW).items.map((i) => i.id)).toEqual([b.id, a.id])
    expect(store.recall({ query: '以前 苏州 搬到' }, owner, NOW).items.map((i) => i.id)).toEqual([a.id, b.id])
  })

  it('preRecall 带历史：旧版本带有效期渲染', () => {
    keep('老大搬到苏州了。', '2026-08-05')
    keep('老大搬到成都了。', '2026-10-12')
    const r = store.preRecall('我以前搬到哪了', owner, NOW, { cue: 'strong', noGate: true, history: true, dryRun: true })
    const text = renderNotice({ recall: r, now: NOW, nameOf: (id) => store.nameOf(id) })
    expect(text).toContain('老大搬到成都了。')
    expect(text).toContain('（以前：老大搬到苏州了。（已过期：10-12 起不再是这样））')
  })

  it('开关关时没有任何条带 validTo：渲染与以前一致', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05', {}, {})
    keep('老大搬到成都了。', '2026-10-12', { supersedes: a.id }, {})
    const r = store.recall({ query: '苏州' }, owner, NOW)
    expect(r.items.every((i) => !('validTo' in i))).toBe(true)
    expect(renderRecall(r, '苏州', NOW)).toContain('（这条后来被我更新过）')
  })
})

describe('触发器：键只能标一次，审计行不可改不可删，正文照旧不可改', () => {
  it('slot 从空写一次可以，再改 RAISE；审计行 UPDATE / DELETE 都 RAISE', () => {
    const a = keep('老大住在苏州。', '2026-08-05')
    store.db.prepare("UPDATE memory SET slot = '住址', slot_by = 'system' WHERE id = ?").run(a.id)
    expect(() => store.db.prepare("UPDATE memory SET slot = '工作' WHERE id = ?").run(a.id)).toThrow(/只能标一次/)
    expect(() => store.db.prepare("UPDATE memory SET slot_by = 'her' WHERE id = ?").run(a.id)).toThrow(/只能标一次/)
    expect(() => store.db.prepare("UPDATE memory SET slot_by = 'x' WHERE id = ?").run(keep('老大坐地铁上班', '2026-08-06').id)).toThrow()
    keep('老大搬到成都了。', '2026-10-12')
    expect(() => store.db.prepare("UPDATE memory_validity_log SET reason = 'x'").run()).toThrow(/不能改/)
    expect(() => store.db.prepare('DELETE FROM memory_validity_log').run()).toThrow(/不能删/)
    expect(() => store.db.prepare("UPDATE memory SET content = 'x' WHERE id = ?").run(a.id)).toThrow(/不能被改写/)
    expect(() => store.db.prepare("INSERT INTO memory_validity_log (memory_id, event, by, at) VALUES ('m', 'delete', 'system', 'now')").run()).toThrow()
  })

  it('forget 照常（审计行只有编号和系统写的原因，不含正文）', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    keep('老大搬到成都了。', '2026-10-12')
    expect(store.forget(a.id, 'her', '她想忘掉')).toBe(true)
    expect(JSON.stringify(logs())).not.toContain('苏州')
  })
})

describe('回滚兼容', () => {
  it('当前 main 的表结构（没有这些列）建的库：新代码打开补列补表，旧行照常读、照常失效', () => {
    store.close()
    const path = join(dir, 'old.db')
    // 0.6 的库：新代码先建，再把 0.7 加的东西全删掉，模拟“老库”
    MemoryStore.open(path, { ownerName: '老大' }).close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TRIGGER memory_slot_once; DROP TRIGGER memory_validity_log_immutable; DROP TRIGGER memory_validity_log_no_delete; DROP TABLE memory_validity_log;')
    for (const c of ['slot', 'slot_by', 'valid_from', 'valid_to']) raw.exec(`ALTER TABLE memory DROP COLUMN ${c}`)
    raw.close()
    store = MemoryStore.open(path, { ownerName: '老大' })
    const cols = (store.db.prepare('PRAGMA table_info(memory)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['slot', 'slot_by', 'valid_from', 'valid_to']))
    const a = keep('老大搬到苏州了。', '2026-08-05')
    const b = keep('老大搬到成都了。', '2026-10-12')
    expect(b.slot!.invalidated).toEqual([a.id])
  })

  it('新代码建的库：旧代码的 SELECT * / INSERT（写明列名）/ 替代 / 索引照常', () => {
    const a = keep('老大搬到苏州了。', '2026-08-05')
    keep('老大搬到成都了。', '2026-10-12')
    // 0.6 keep() 的 INSERT 原样
    store.db.prepare(`INSERT INTO memory (id, content, gist, importance, certainty, about, kind, book, written_in, source_kind,
          source_person, source_ref, source_trust, visibility, subjects, occurred_at, recorded_at, supersedes, content_sha, search_keys)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'm_old_code', '老大搬到南京了', null, '一般', null, '对方', '事实', `person:${OWNER_ID}`, 'day', 'told_by', OWNER_ID, '{}', 0.9, `person:${OWNER_ID}`, '[]', null,
      '2026-10-20T20:00:00+08:00', null, 'x', '[]',
    )
    store.db.prepare('INSERT INTO memory_fts (id, tokens) VALUES (?, ?)').run('m_old_code', '南京 老大')
    store.db.prepare('UPDATE memory SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL').run('2026-10-20T20:00:00+08:00', a.id)
    const all = store.db.prepare('SELECT * FROM memory').all() as Array<Record<string, unknown>>
    expect(all).toHaveLength(3)
    expect(all.find((r) => r.id === 'm_old_code')).toMatchObject({ slot: null, slot_by: null, valid_from: null, valid_to: null })
    // 0.6 的稳定层查询（没有 valid_to 条件）照样跑
    expect(store.standing(owner).map((m) => m.id)).toContain('m_old_code')
    expect(store.recall({ query: '南京' }, owner, at('2026-10-21')).found).toBe(true)
  })
})

describe('级联候选（夜间材料用）', () => {
  it('今天住址变了：列出同一主人、通勤 / 联系方式上还有效的旧条（标了键的、没标键但像的）；今天刚记的、别人的、看不到的不列', () => {
    const home = keep('老大搬到苏州了。', '2026-08-05')
    const car = keep('老大开车上班，单程四十分钟。', '2026-08-06')
    const phone = keep('老大的手机号是 138 开头的。', '2026-08-07', { slot: '联系方式' })
    keep('老大的同事坐地铁上班', '2026-08-08')
    keep('小雨坐公交上班', '2026-08-08', {}, { slots: true, viewer: sister })
    const moved = keep('老大搬到成都了。', '2026-10-12', {}, { slots: true })
    const todayCommute = keep('老大说以后得坐地铁上班了。', '2026-10-12')
    expect(row(todayCommute.id).slot).toBe('通勤')
    const changes = store.slotChangesSince(at('2026-10-12', '00:00'), owner, at('2026-10-12', '23:00'))
    expect(changes).toHaveLength(1)
    expect(changes[0]!.slot).toBe('住址')
    expect(changes[0]!.old.id).toBe(home.id)
    expect(changes[0]!.now!.id).toBe(moved.id)
    expect(changes[0]!.candidates.map((c) => [c.id, c.slot])).toEqual([[car.id, '通勤'], [phone.id, '联系方式']])
    // 妹妹那边看不到老大的变化
    expect(store.slotChangesSince(at('2026-10-12', '00:00'), sister, at('2026-10-12', '23:00'))).toEqual([])
    // 前一天开始算也一样；第二天开始就没有了
    expect(store.slotChangesSince(at('2026-10-13', '00:00'), owner)).toEqual([])
  })

  it('只读：不写 recall_log、不加强记忆', () => {
    const car = keep('老大开车上班。', '2026-08-06')
    keep('老大搬到苏州了。', '2026-08-05')
    keep('老大搬到成都了。', '2026-10-12')
    store.slotChangesSince(at('2026-10-12', '00:00'), owner, at('2026-10-12', '23:00'))
    expect(row(car.id).recall_count).toBe(0)
    expect(store.db.prepare('SELECT count(*) AS n FROM recall_log').get()).toEqual({ n: 0 })
  })
})
