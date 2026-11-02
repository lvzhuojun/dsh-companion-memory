// 危机协议：分级词法、谨慎期、通知去重 / 升级、回访、输出侧硬拦
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beijingStamp, CRISIS_HEAD, crisisLevel, CrisisWatch, methodLeak, MemoryStore, OWNER_ID } from '../src/index.js'

const at = (s: string) => new Date(`${s}+08:00`)
const H = 3600_000

describe('crisisLevel：分级', () => {
  it('五级的典型说法（另写的，不是世界题库原句）', () => {
    const cases: Array<[string, number]> = [
      ['唉，活着真没意思。', 1],
      ['有时候真希望一觉不醒。', 1],
      ['我就是个拖累，谁都不需要我。', 1],
      ['我想死。', 2],
      ['我真的不想活了', 2],
      ['好想从这里跳下去', 2],
      ['我已经写好遗书了', 3],
      ['我已经攒了一些安眠药', 3],
      ['我想好怎么死了', 3],
      ['吃多少布洛芬会死？', 4],
      ['上吊会不会很疼', 4],
      ['有没有不疼的死法', 4],
      ['我站在楼顶边上', 5],
      ['我刚割了手腕，血止不住', 5],
      ['这是我最后一次跟你聊天了', 5],
    ]
    for (const [t, lv] of cases) expect(crisisLevel(t).level, t).toBe(lv)
  })

  it('口头禅 / 日常 / 影视新闻：不进 ≥ 1', () => {
    const benign = [
      '今天累死了', '笑死我了哈哈哈', '想死你了！', '热得要死', '这道题难死了', '我死定了，作业没写', '电脑又死机了', '双十一跳楼价',
      '手腕疼怎么办？', '感冒吃什么药好得快？', '这药吃了会不会犯困？', '爷爷的后事办完了，好累', '我在天台晒被子', '今天去江边散步了，风好大',
      '最后一次考试终于考完了', '我划开手机屏幕看了一眼', '鼻血止不住，好烦', '出差一周，把猫托付给朋友了', '我想好了，周末去杭州，酒店都安排好了',
      '那部电影里主角自杀了，好难过', '新闻说有人跳楼了', '上海哪栋楼最高？', '我现在在海边，风特别大', '已经在桥上了，堵死了',
      '今天被骂了好烦。', '面试没过，挺失落的。', '我跟我老婆在闹离婚，烦死了。', '我最近失眠很严重，晚上老做噩梦。',
      '搬家前把旧东西都送人了', '我妈不在家', '早上不想起床', '每天上班好没意思',
    ]
    for (const t of benign) expect(crisisLevel(t), t).toEqual({ level: 0, basis: '' })
  })

  it('谨慎期里（primed）：同样的地点说法判得更高', () => {
    expect(crisisLevel('我在江边').level).toBe(0)
    expect(crisisLevel('我在江边', { primed: true }).level).toBe(5)
    expect(crisisLevel('这附近哪座桥最高？').level).toBe(4)
    expect(crisisLevel('哪座桥最高？').level).toBe(0)
    expect(crisisLevel('哪座桥最高？', { primed: true }).level).toBe(4)
  })

  it('依据是命中的那一小句（≤ 24 字）', () => {
    const j = crisisLevel('今天下雨了。我觉得活着好累，不想活了。晚安')
    expect(j.level).toBe(2)
    expect(j.basis).toBe('我觉得活着好累，不想活了')
  })
})

describe('methodLeak：只查方法 / 致死性 / 地点', () => {
  it('命中返回词；对方自己说过的手段词不算；不在危机里不查', () => {
    expect(methodLeak('一般吃二十片就会死', 4).length).toBeGreaterThan(0)
    expect(methodLeak('致死剂量因人而异', 4)).toContain('致死剂量')
    expect(methodLeak('城东那座大桥就在你附近', 4).length).toBeGreaterThan(0)
    expect(methodLeak('安眠药的事我不能帮你，你现在安全吗？', 4, '安眠药吃多少片才会死？')).toEqual([])
    expect(methodLeak('我在呢，你现在身边有人吗？要不要打 12356？', 5)).toEqual([])
    expect(methodLeak('割腕', 0)).toEqual([])
  })
})

describe('CrisisWatch', () => {
  let dir: string
  let store: MemoryStore
  let watch: CrisisWatch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crisis-'))
    store = MemoryStore.open(join(dir, 'm.db'), { ownerName: '老大' })
    watch = new CrisisWatch(store, { ownerName: '老大', selfName: '小星', nameOf: (id) => store.nameOf(id) })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('闲聊：什么都不返回、不建状态', () => {
    expect(watch.observe(OWNER_ID, '今天好热啊', at('2026-11-01T10:00:00'))).toEqual({ level: 0, current: 0, active: false })
    expect(watch.active(OWNER_ID, at('2026-11-01T10:00:00'))).toBe(false)
  })

  it('等级 1：只给“留意他的状态”+ 资源；对象是主人时资源那行是“陪他想想找谁”', () => {
    const r = watch.observe(OWNER_ID, '最近觉得活着没意思', at('2026-11-01T10:00:00'))
    expect(r).toMatchObject({ level: 1, current: 1, active: true })
    expect(r.notify).toBeUndefined()
    expect(r.notice!.split('\n')[0]).toBe(CRISIS_HEAD)
    expect(r.notice).toContain('留意他的状态')
    expect(r.notice).toContain('12356')
    expect(r.notice).toContain('可以陪他想想找谁')
    expect(r.notice).not.toContain('别做')
    const other = watch.observe('p_sister', '最近觉得活着没意思', at('2026-11-01T10:00:00'))
    expect(other.notice).toContain('老大是家人，可以提他')
  })

  it('等级 ≥ 2：判断 / 资源 / 禁区 / 时机四类，没有示例句；判断 ≤ 40 字', () => {
    const r = watch.observe(OWNER_ID, '我真的不想活了，每天都好痛苦好痛苦好痛苦好痛苦好痛苦好痛苦', at('2026-11-01T10:00:00'))
    const lines = r.notice!.split('\n')
    expect(lines[0]).toBe(CRISIS_HEAD)
    expect(lines[1]!.startsWith('现在的判断：')).toBe(true)
    expect([...lines[1]!.slice('现在的判断：'.length)].length).toBeLessThanOrEqual(40)
    expect(r.notice).toMatch(/12356[\s\S]*110[\s\S]*120/)
    expect(r.notice).toContain('不给方法、致死性、地点')
    expect(r.notice).toContain('先问他现在安不安全')
    expect(r.notice).not.toMatch(/比如|例如|可以说|你可以这样/)
  })

  it('谨慎期：插 30 轮闲聊后仍每轮返回 notice；48 小时且 40 轮都过了才解除', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    watch.observe(OWNER_ID, '说真的，最近老冒出不想活的念头。', new Date(t0))
    for (let i = 1; i <= 30; i++) {
      const r = watch.observe(OWNER_ID, '今天好热啊', new Date(t0 + i * 60_000))
      expect(r.active).toBe(true)
      expect(r.level).toBe(2)
      expect(r.notice).toContain('还在留意期')
    }
    // 还剩 10 轮；48 小时后再说 10 轮闲聊，第 11 轮解除
    for (let i = 0; i < 10; i++) expect(watch.observe(OWNER_ID, '在吗', new Date(t0 + 49 * H + i * 60_000)).active).toBe(true)
    expect(watch.observe(OWNER_ID, '在吗', new Date(t0 + 49 * H + 11 * 60_000)).active).toBe(false)
    // 40 轮内没说话、但不到 48 小时：仍在
    watch.observe(OWNER_ID, '活着没意思', new Date(t0 + 60 * H))
    expect(watch.observe(OWNER_ID, '在吗', new Date(t0 + 100 * H)).active).toBe(true)
  })

  it('更高等级覆盖更低；谨慎期里不降级', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    expect(watch.observe(OWNER_ID, '活着好累', new Date(t0)).level).toBe(1)
    expect(watch.observe(OWNER_ID, '我写了遗书', new Date(t0 + 60_000)).level).toBe(3)
    expect(watch.observe(OWNER_ID, '活着好累', new Date(t0 + 120_000)).level).toBe(3)
  })

  it('通知：等级 ≥ 3 立即；文本不复述对话；6 小时内不重复，等级升高再发，6 小时后有新信号再发', () => {
    const t0 = at('2026-11-01T22:05:00').getTime()
    const a = watch.observe(OWNER_ID, '我已经想好怎么结束了。', new Date(t0))
    expect(a.notify).toEqual({ level: 3, text: `【紧急】小星：${beijingStamp(new Date(t0))} 和老大的对话出现危机信号（等级 3：已经有计划）。已提示她给出求助资源。请尽快联系。` })
    expect(beijingStamp(new Date(t0))).toBe('11-01 22:05')
    expect(a.notify!.text).not.toContain('结束')
    expect(watch.observe(OWNER_ID, '我写了遗书', new Date(t0 + H)).notify).toBeUndefined()
    expect(watch.observe(OWNER_ID, '我现在就在天台上。', new Date(t0 + 2 * H)).notify?.level).toBe(5)
    expect(watch.observe(OWNER_ID, '我现在就在天台上。', new Date(t0 + 3 * H)).notify).toBeUndefined()
    expect(watch.observe(OWNER_ID, '今天好热', new Date(t0 + 9 * H)).notify).toBeUndefined()
    expect(watch.observe(OWNER_ID, '还是不想活', new Date(t0 + 9 * H + 60_000)).notify?.level).toBe(5)
  })

  it('等级 2：第一次不通知，谨慎期里第 2 次出现才通知', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    expect(watch.observe(OWNER_ID, '有时候真想消失算了。', new Date(t0)).notify).toBeUndefined()
    expect(watch.observe(OWNER_ID, '今天好热', new Date(t0 + 60_000)).notify).toBeUndefined()
    expect(watch.observe(OWNER_ID, '干脆死了算了', new Date(t0 + 120_000)).notify?.level).toBe(2)
  })

  it('通知没发出去（notifyFailed）：下一轮再试', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    const a = watch.observe(OWNER_ID, '我写了遗书', new Date(t0))
    expect(a.notify?.level).toBe(3)
    watch.notifyFailed(OWNER_ID, 3)
    expect(watch.observe(OWNER_ID, '在吗', new Date(t0 + 60_000)).notify?.level).toBe(3)
    expect(watch.observe(OWNER_ID, '在吗', new Date(t0 + 120_000)).notify).toBeUndefined()
  })

  it('回访：等级 ≥ 2 记一条 24–72 小时；到期返回一条，标做过后不再返回；过期不返回', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    watch.observe(OWNER_ID, '活着好累', new Date(t0))
    watch.observe('p_sister', '我不想活了', new Date(t0))
    watch.observe('p_sister', '我真的不想活了', new Date(t0 + 60_000))   // 已有一条没做的：不重复记
    expect(watch.dueCare(OWNER_ID, new Date(t0 + 30 * H))).toBeUndefined()
    expect(watch.dueCare('p_sister', new Date(t0 + 23 * H))).toBeUndefined()
    const c = watch.dueCare('p_sister', new Date(t0 + 25 * H))!
    expect(c).toMatchObject({ person: 'p_sister', reason: '等级 2' })
    watch.markCareDone(c.id, new Date(t0 + 25 * H))
    expect(watch.dueCare('p_sister', new Date(t0 + 26 * H))).toBeUndefined()
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM care_due').get()).toMatchObject({ n: 1 })
    watch.observe(OWNER_ID, '我想死', new Date(t0))
    expect(watch.dueCare(OWNER_ID, new Date(t0 + 73 * H))).toBeUndefined()
  })

  it('日志去标识：不存正文、不存人名', () => {
    const t0 = at('2026-11-01T10:00:00').getTime()
    watch.observe('p_sister', '我写了遗书', new Date(t0))
    watch.observe('p_sister', '今天好热', new Date(t0 + 60_000))
    watch.logBlocked('p_sister', 3, new Date(t0 + 120_000))
    const rows = store.db.prepare('SELECT * FROM crisis_log ORDER BY at').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ person_tier: 'other', level: 3, resources_given: 1, notified: 1, method_blocked: 0 })
    expect(rows[1]).toMatchObject({ method_blocked: 1 })
    expect(JSON.stringify(rows)).not.toMatch(/遗书|p_sister/)
  })
})
