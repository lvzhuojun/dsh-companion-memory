// 0.7 迁移脚本：备份、加列、只打标不失效、不打印内容；--dry-run 不写
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, OWNER_ID } from '@dsh-companion/memory'

const script = join(dirname(fileURLToPath(import.meta.url)), '0.7.mjs')
const owner = { person: OWNER_ID, channel: 'private' }
let d: string
let db: string

/** 0.6 的库：新引擎建好、写几条，再把 0.7 加的东西删掉 */
function oldDb() {
  const s = MemoryStore.open(db, { ownerName: '老大' })
  const k = (content: string, about: '对方' | '别人' = '对方') => s.keep({ content, importance: '一般', about, kind: about === '别人' ? '印象' : '事实' }, { viewer: owner })
  k('老大搬到苏州了，新家还挺不错的。')
  k('老大现在开车上班。')
  k('老大喜欢吃辣。')
  k('同事搬到成都了', '别人')
  s.close()
  const raw = new DatabaseSync(db)
  raw.exec('DROP TRIGGER memory_slot_once; DROP TRIGGER memory_validity_log_immutable; DROP TRIGGER memory_validity_log_no_delete; DROP TABLE memory_validity_log;')
  for (const c of ['slot', 'slot_by', 'valid_from', 'valid_to']) raw.exec(`ALTER TABLE memory DROP COLUMN ${c}`)
  raw.close()
}
const run = (...args: string[]) => execFileSync(process.execPath, ['--no-warnings', script, ...args]).toString()

beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'migrate-07-'))
  db = join(d, 'memory.db')
})
afterEach(() => rmSync(d, { recursive: true, force: true }))

describe('deploy/migrate/0.7.mjs', () => {
  it('--dry-run：只数，不备份、不写', () => {
    oldDb()
    const out = run(db, '--dry-run')
    expect(out).toContain('只看不写：4 条 · 0.7 的列还没有 · 会标键 2 条（住址 1，通勤 1）')
    expect(readdirSync(d).filter((f) => f.includes('pre-0.7'))).toEqual([])
    const raw = new DatabaseSync(db, { readOnly: true })
    expect((raw.prepare('PRAGMA table_info(memory)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('slot')
    raw.close()
  })

  it('备份 → 加列 → 只打标（不失效）→ 完整性；不打印内容；再跑一次不重复标', () => {
    oldDb()
    const out = run(db)
    expect(out).toContain('回填键：2 条（住址 1，通勤 1）· 已失效 0 条')
    expect(out).toContain('完整性：4 条 · 正文校验 一致 · sqlite ok')
    expect(out).not.toMatch(/苏州|开车|吃辣|成都/)
    const backups = readdirSync(d).filter((f) => /^memory\.db\.pre-0\.7-\d{8}-\d{6}$/.test(f))
    expect(backups).toHaveLength(1)
    // 备份是迁移前的样子
    const b = new DatabaseSync(join(d, backups[0]!), { readOnly: true })
    expect((b.prepare('SELECT count(*) AS n FROM memory').get() as { n: number }).n).toBe(4)
    expect((b.prepare('PRAGMA table_info(memory)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('slot')
    b.close()
    const s = MemoryStore.open(db, { ownerName: '老大' })
    const rows = s.db.prepare('SELECT content, slot, slot_by, valid_from, valid_to, superseded_at FROM memory ORDER BY recorded_at, id').all() as Array<Record<string, string | null>>
    expect(rows.map((r) => [r.slot, r.slot_by])).toEqual([['住址', 'system'], ['通勤', 'system'], [null, null], [null, null]])
    expect(rows.every((r) => r.valid_to === null && r.valid_from === null && r.superseded_at === null)).toBe(true)
    expect(s.db.prepare('SELECT count(*) AS n FROM memory_validity_log').get()).toEqual({ n: 0 })
    s.close()
    // 再跑：已经标过的不动（新备份文件名按秒，等不到下一秒就跳过这一步的文件名检查）
    const again = run(db, '--dry-run')
    expect(again).toContain('0.7 的列已经有了 · 会标键 0 条')
  })

  it('库不存在：不建新库，退出码 1；没给路径：退出码 2', () => {
    const missing = join(d, 'nope.db')
    expect(() => execFileSync(process.execPath, ['--no-warnings', script, missing], { stdio: 'pipe' })).toThrow()
    expect(existsSync(missing)).toBe(false)
    let code = 0
    try { execFileSync(process.execPath, ['--no-warnings', script], { stdio: 'pipe' }) } catch (e) { code = (e as { status: number }).status }
    expect(code).toBe(2)
  })
})
