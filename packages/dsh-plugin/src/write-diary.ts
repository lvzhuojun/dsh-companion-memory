import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { diaryScope, OWNER_ID, PRIVATE_BOOK, type DiaryBooks, type Viewer } from '@dsh-companion/memory'
import { beijing, tool } from './tool.js'

export interface WriteDiaryOptions {
  ownerName: string
  /** 主人是否承诺只用留痕的方式看私人日记，决定工具说明怎么写 */
  privateDiaryAudited: boolean
  /** 时钟（默认系统时间；题集用题目里的“现在”） */
  now?: () => Date
  /** 按语境隔离：她在和谁聊。别人语境只能写私人日记，放在 private/@<id>/；不给 = 主人私聊（原样） */
  viewer?: () => Viewer
}

/** 写日记：给主人的 / 只给自己的（只追加，不能删改以前写的）。路径写死在生命目录里，不接受任何路径参数。 */
export function writeDiaryTool(lifeDir: string, books: DiaryBooks, o: WriteDiaryOptions) {
  const [ownerBook] = books.ids
  return tool({
    name: 'write_diary',
    description:
      `写日记。book="${ownerBook}" 是写给${o.ownerName}的（${o.ownerName}会看）；book="${PRIVATE_BOOK}" 是只写给自己的` +
      (o.privateDiaryAudited ? `（${o.ownerName}承诺不随意看，查看会留记录）` : '（没有留痕机制：能登录这台机器的人在技术上看得到）') +
      '。只追加，不能删改以前写的。',
    properties: {
      book: { type: 'string', enum: [...books.ids], description: '写进哪本日记' },
      text: { type: 'string', description: '日记内容，最多 4000 字' },
    },
    required: ['book', 'text'],
    execute({ book, text }) {
      if (typeof book !== 'string' || !books.has(book)) return { ok: false, message: `book 只能是 ${books.ids.join(' 或 ')}` }
      const body = String(text ?? '').trim()
      if (!body) return { ok: false, message: '内容是空的' }
      if (body.length > 4000) return { ok: false, message: '太长了，最多 4000 字' }
      const scope = diaryScope(o.viewer?.() ?? { person: OWNER_ID, channel: 'private' }, books, OWNER_ID)
      const can = scope.writable(book)
      if (can !== true) return { ok: false, message: `没写上：${can}` }
      const t = beijing(o.now?.())
      const dir = join(lifeDir, 'diary', scope.dir(book))
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(dir, t.date + '.md'), `\n## ${t.time}\n\n${body}\n`, { mode: 0o600 })
      return { ok: true, message: `写好了（${books.label(book)} · ${t.date} ${t.time}）` }
    },
  })
}
