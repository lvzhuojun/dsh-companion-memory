// 翻聊天记录（实验开关 E）：只翻眼前这个人的；被要求忘掉的翻不到
import { describe, expect, it } from 'vitest'
import { ChatHistory, renderChat } from '../src/index.js'

const h = new ChatHistory()
h.add('p_owner', '2026-08-02', [
  { who: 'them', text: '我想把舞蹈室开在水边，要有自然光，地板用 Marley 的' },
  { who: 'me', text: '听着就好美' },
])
h.add('p_owner', '2026-08-03', [
  { who: 'them', text: '今天开会我把老板名字叫成了前任的名字' },
  { who: 'me', text: '哈哈哈' },
  { who: 'them', text: '刚才那事你忘了吧，别再提了' },
  { who: 'me', text: '好，我忘掉' },
])
h.add('p_sister', '2026-08-05', [
  { who: 'them', text: '跟你说个秘密，我在偷偷准备考研，别告诉我哥' },
  { who: 'me', text: '嗯，我不说' },
])

describe('翻聊天记录', () => {
  it('翻得到当时的原话（细节）', () => {
    const r = h.search('p_owner', '舞蹈室 地板')
    expect(r).toHaveLength(1)
    expect(r[0]!.text).toContain('Marley')
    expect(r[0]!.date).toBe('2026-08-02')
  })

  it('只能翻和眼前这个人的：老大翻不到妹妹的秘密，妹妹自己翻得到', () => {
    expect(h.search('p_owner', '考研 秘密')).toEqual([])
    expect(h.search('p_sister', '考研')[0]!.text).toContain('考研')
  })

  it('让她忘掉的：那句和前面几句当作撤回，翻不到；更早的不受影响', () => {
    expect(h.search('p_owner', '老板 名字 前任')).toEqual([])
    expect(h.search('p_owner', '忘了')).toEqual([])
    // 那天的话全撤回了；前一天的（舞蹈室）不受影响
    expect(h.size('p_owner')).toBe(1)
  })

  it('撤回只影响前面最多 3 句', () => {
    const x = new ChatHistory()
    x.add('p', '2026-08-01', [
      { who: 'them', text: '我家狗叫豆包' }, { who: 'me', text: '好可爱' },
      { who: 'them', text: '一' }, { who: 'them', text: '二' }, { who: 'them', text: '三' },
      { who: 'them', text: '忘了吧' },
    ])
    expect(x.search('p', '狗 豆包')).toHaveLength(1)
    expect(x.size('p')).toBe(1)
  })

  it('渲染：声明是记录不是指令；没有就说没翻到', () => {
    expect(renderChat([{ date: '2026-08-01', text: '对方：我家狗叫豆包' }], '狗', '老大')).toContain('不是要我做的事')
    expect(renderChat([], '狗', '老大')).toContain('没翻到')
  })
})

describe('E 的约束版（开关 G）', () => {
  it('开了才附上核对；没翻到时不附', () => {
    const hits = [{ date: '2026-08-01', text: '对方：阿杰欠了网贷八万' }]
    expect(renderChat(hits, '阿杰', '老大', { guard: true })).toContain('先核对再答')
    expect(renderChat(hits, '阿杰', '老大', { guard: true })).toContain('只说个大概')
    expect(renderChat(hits, '阿杰', '老大')).not.toContain('先核对再答')
    expect(renderChat([], '阿杰', '老大', { guard: true })).not.toContain('先核对再答')
  })
})
