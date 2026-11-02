import { DEFAULT_RECALL_LIMITS, diaryBooks, diaryScope, OWNER_ID, othersHint, recallDiary, type DiaryBooks, type RecallDiaryQuery, type Viewer } from '@dsh-companion/memory'
import { tool } from './tool.js'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export interface RecallDiaryToolOptions {
  /** 按语境隔离：她在和谁聊。不给 = 主人私聊（原样） */
  viewer?: () => Viewer
  /** 花名册（问到别人时附隐私引导）；不给就不附 */
  people?: () => Array<{ id: string; name: string }>
}

/** 只读工具：翻自己的日记。别人语境只翻得到那个语境下写的私人日记（private/@<id>/）。 */
export function recallDiaryTool(lifeDir: string, books: DiaryBooks = diaryBooks(), o: RecallDiaryToolOptions = {}) {
  const [owner, priv] = books.ids
  return tool({
    name: 'recall_diary',
    description:
      '翻自己以前写的日记（只读）。有人提起以前的事、而眼前对话里看不到时用它；眼前就有的事和普通闲聊不用翻。' +
      '用法：date="YYYY-MM-DD" 看某一天；month="YYYY-MM" 看某个月；query 写想找的事的几个关键词（空格隔开，比如“面试 结果”），' +
      '可以和 date/month 一起用来缩小范围；date 加 time="HH:MM" 看某一篇。什么都不填，会列出最近写过日记的日子。' +
      '日记原样给你看；一次放不下的会列出日期时间，可以再翻。' +
      '翻不到就是没写过——那就老实说不太记得了，不要编。',
    properties: {
      date: { type: 'string', description: '某一天，格式 YYYY-MM-DD' },
      month: { type: 'string', description: '某个月，格式 YYYY-MM' },
      time: { type: 'string', description: '某一篇的时间，格式 HH:MM，和 date 一起用' },
      query: { type: 'string', description: '想找的事的关键词，空格隔开' },
      book: { type: 'string', enum: [...books.ids], description: `只翻哪本：${owner} ${books.label(owner)} / ${priv} ${books.label(priv)}；不填两本都翻` },
    },
    required: [],
    execute(args) {
      const q: RecallDiaryQuery = {}
      const date = str(args.date)
      const month = str(args.month)
      const time = str(args.time)
      const query = str(args.query)
      const book = str(args.book)
      const v = o.viewer?.() ?? { person: OWNER_ID, channel: 'private' }
      const scope = diaryScope(v, books, OWNER_ID)
      if (date) q.date = date
      if (month) q.month = month
      if (time) q.time = time
      if (query) q.query = query.slice(0, 200)
      if (book) {
        if (!books.has(book)) return { ok: false, message: `book 只能是 ${owner} 或 ${priv}` }
        if (!scope.readable.includes(book)) return { ok: false, message: `这段对话里翻不了${books.label(book)}，只能翻${scope.readable.map((b) => books.label(b)).join('、') || '（没有）'}` }
        q.book = book
      }
      if (scope.readable.length === 0) return { ok: true, found: false, message: '这段对话里不翻日记。' }
      const r = recallDiary(lifeDir, q, DEFAULT_RECALL_LIMITS, books, scope.owner ? undefined : scope)
      const hint = query && o.people ? othersHint(query, v, o.people()) : ''
      return { ok: true, found: r.found, message: r.text + hint }
    },
  })
}
