// 记忆库 0.7 迁移：有效期 + 键（开关 Y；数据模型见 docs/architecture.md 第 2 节）。服务器上手动跑一次。
//
//   node --no-warnings 0.7.mjs <memory.db> [--dry-run]
//
// 用运行 DSH 的系统用户跑（库文件只有它能读写），最好先停 DSH（在线备份不怕并发，但回填和插件写入会抢锁）。
// 本机打成单文件（产物放 out/，已 gitignore）：
//   npx tsc -b
//   npx esbuild deploy/migrate/0.7.mjs --bundle --platform=node --format=esm --target=node22 --outfile=out/migrate-0.7.mjs
//
// 做四件事：
//   1. 在线备份到同目录 <库名>.pre-0.7-<北京时间>（node:sqlite 的 backup），备份后核对条数与 integrity_check；
//   2. 用 0.7 引擎打开（ensure 加列 slot / slot_by / valid_from / valid_to、建 memory_validity_log、加触发器；不回填数据）；
//   3. 对还没有键的条目跑 detectSlot（高精度词法）回填 slot（slot_by='system'）——只打标：不让任何旧条失效、不写有效期；
//      别人的事（about=别人）不标（和 keep 一致）；
//   4. 完整性检查（正文哈希逐条核对 + sqlite integrity_check）。
// 只打印条数、键名和备份文件名，不打印任何一条的内容。--dry-run：只读打开，只数会标多少条，不备份、不写。
// 退出码：0 做完；1 出错（库没动，或已回滚）；2 用法不对；3 做完了但完整性检查不一致（备份在，先别启动）。

import { chmodSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { detectSlot, MemoryStore } from '@dsh-companion/memory'

const say = (s) => console.log(`[migrate-0.7] ${s}`)
/** 北京时间 YYYYMMDD-HHMMSS */
const stamp = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
const tally = (rows) => {
  const bySlot = {}
  for (const r of rows) {
    if (r.about === '别人') continue
    const s = detectSlot(r.content)
    if (s) bySlot[s] = (bySlot[s] ?? 0) + 1
  }
  return bySlot
}
const sum = (o) => Object.values(o).reduce((n, x) => n + x, 0)

/** 迁移一个库；返回只含数字和键名的报告 */
export async function migrate07(path, o = {}) {
  if (!existsSync(path)) throw new Error('库文件不存在（这个脚本不建新库）')
  if (o.dryRun) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(memory)').all().map((c) => c.name))
      const rows = db.prepare(`SELECT content, about FROM memory${cols.has('slot') ? ' WHERE slot IS NULL' : ''}`).all()
      const bySlot = tally(rows)
      return { dryRun: true, total: db.prepare('SELECT count(*) AS n FROM memory').get().n, hasColumns: cols.has('slot'), wouldTag: sum(bySlot), bySlot }
    } finally {
      db.close()
    }
  }

  // 1. 在线备份 + 核对
  const dest = join(dirname(path), `${basename(path)}.pre-0.7-${stamp(o.now ?? new Date())}`)
  if (existsSync(dest)) throw new Error(`备份文件已存在：${basename(dest)}`)
  const src = new DatabaseSync(path, { readOnly: true })
  let before
  try {
    before = src.prepare('SELECT count(*) AS n FROM memory').get().n
    await backup(src, dest)
  } finally {
    src.close()
  }
  try { chmodSync(dest, 0o600) } catch { /* Windows 上忽略 */ }
  const chk = new DatabaseSync(dest, { readOnly: true })
  const backupRows = chk.prepare('SELECT count(*) AS n FROM memory').get().n
  const backupCheck = chk.prepare('PRAGMA integrity_check').get().integrity_check
  chk.close()
  if (backupRows !== before || backupCheck !== 'ok') throw new Error(`备份核对不过（条数 ${backupRows}/${before}，sqlite ${backupCheck}），库没动`)

  // 2. 打开（ensure 加列 / 建表 / 触发器）
  const store = MemoryStore.open(path, { ownerName: '主人' })
  try {
    // 3. 回填键（一个事务；只写 slot / slot_by，触发器保证只从空写一次）
    const rows = store.db.prepare('SELECT id, content, about FROM memory WHERE slot IS NULL').all()
    const set = store.db.prepare("UPDATE memory SET slot = ?, slot_by = 'system' WHERE id = ? AND slot IS NULL")
    const bySlot = {}
    store.db.exec('BEGIN')
    try {
      for (const r of rows) {
        if (r.about === '别人') continue
        const s = detectSlot(r.content)
        if (!s) continue
        set.run(s, r.id)
        bySlot[s] = (bySlot[s] ?? 0) + 1
      }
      store.db.exec('COMMIT')
    } catch (e) {
      store.db.exec('ROLLBACK')
      throw e
    }
    // 4. 完整性
    const iv = store.verifyIntegrity()
    const invalid = store.db.prepare('SELECT count(*) AS n FROM memory WHERE valid_to IS NOT NULL').get().n
    return { dryRun: false, backup: basename(dest), backupRows, total: iv.total, tagged: sum(bySlot), bySlot, invalid, mismatched: iv.mismatched.length, sqlite: iv.sqlite }
  } finally {
    store.close()
  }
}

if (process.argv[1] && /0\.7\.mjs$/.test(process.argv[1])) {
  const [path, ...flags] = process.argv.slice(2)
  if (!path || path.startsWith('--')) {
    console.error('用法：node --no-warnings 0.7.mjs <memory.db> [--dry-run]')
    process.exit(2)
  }
  const keys = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join('，') || '无'
  try {
    const r = await migrate07(path, { dryRun: flags.includes('--dry-run') })
    if (r.dryRun) {
      say(`只看不写：${r.total} 条 · 0.7 的列${r.hasColumns ? '已经有了' : '还没有'} · 会标键 ${r.wouldTag} 条（${keys(r.bySlot)}）`)
    } else {
      say(`备份：${r.backup}（${r.backupRows} 条，sqlite ok）`)
      say(`回填键：${r.tagged} 条（${keys(r.bySlot)}）· 已失效 ${r.invalid} 条（迁移不让任何条失效）`)
      say(`完整性：${r.total} 条 · 正文校验 ${r.mismatched === 0 ? '一致' : `${r.mismatched} 条不一致`} · sqlite ${r.sqlite}`)
      if (r.mismatched !== 0 || r.sqlite !== 'ok') process.exitCode = 3
    }
  } catch (e) {
    say(`出错：${e instanceof Error ? e.message.slice(0, 160) : '未知'}`)
    process.exitCode = 1
  }
}
