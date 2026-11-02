// 夜间整理打包：npm run deploy:night:pack
//
// 产物放在 out/night/（out/ 已 gitignore；产物本身不含任何部署信息，config.json 由你在服务器上自己写）：
//   night-review.mjs      夜间整理程序（单文件，零依赖）
//
// 用法见 docs/deploy.md 第 4 节：拷到服务器 → 写 config.json → 先 --rehearse 演练 → 用 cron / systemd timer 定时。

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(root, 'out', 'night')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(here, 'night-review.ts')],
  outfile: join(out, 'night-review.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  banner: { js: '// 夜间整理 · 由 dsh-companion-memory 打包生成，请勿手改' },
})
console.log(`✓ 已打包到 ${out}`)
console.log('下一步：把 night-review.mjs 拷到服务器，按 docs/deploy.md 第 4 节写 config.json，先用 --rehearse <空目录> 演练一次。')
