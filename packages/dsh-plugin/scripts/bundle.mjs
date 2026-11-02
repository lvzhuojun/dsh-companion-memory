// 打包成 DSH 可直接加载的单文件插件：bundle/lib/index.js + bundle/lib/compaction.js + bundle/package.json。
// 包名是 dsh-her-life（预设里按这个名字加载）。
// 预设（cordis.patch.yml）含部署路径，由使用者提供：
//   node scripts/bundle.mjs --patch <你的 cordis.patch.yml>
// 会把它拷成 bundle/cordis.patch.yml；不带 --patch 时请手动放进 bundle/。
// 模板见仓库根目录 templates/cordis.patch.example.yml。

import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'bundle')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
let patchFile = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--patch') patchFile = args[++i] ?? null
  else if (a.startsWith('--patch=')) patchFile = a.slice('--patch='.length)
  else {
    console.error(`未知参数：${a}\n用法：node scripts/bundle.mjs [--patch <cordis.patch.yml>]`)
    process.exit(64)
  }
}
if (args.includes('--patch') && !patchFile) {
  console.error('--patch 后面要跟预设文件路径')
  process.exit(64)
}
if (patchFile) {
  // 相对路径按调用时的工作目录解析（npm -w 下是包目录，建议传绝对路径）
  patchFile = resolve(process.env.INIT_CWD ?? process.cwd(), patchFile)
  if (!existsSync(patchFile)) {
    console.error(`找不到预设文件：${patchFile}`)
    process.exit(64)
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'lib'), { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(out, 'lib', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  banner: { js: `// dsh-her-life ${pkg.bundleVersion} · 由 dsh-companion-memory 打包生成，请勿手改` },
})

// 中文陪伴版压缩：单独一个入口，预设里用 name: 'dsh-her-life/compaction' 加载；DSH 的包运行时再解析，不打进来
await build({
  entryPoints: [join(root, 'src', 'compaction-entry.ts')],
  outfile: join(out, 'lib', 'compaction.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  external: ['@deepseek-ai/*'],
  banner: { js: `// dsh-her-life/compaction ${pkg.bundleVersion} · 由 dsh-companion-memory 打包生成，请勿手改` },
})

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'dsh-her-life',
  version: pkg.bundleVersion,
  description: 'Long-term memory plugin for DeepSeek Harness companion sessions: seed / self / memory prompt variables, memory rules and stable layer, diary and memory tools, crisis protocol, Chinese companion compaction.',
  license: 'Apache-2.0',
  private: true,
  type: 'module',
  main: 'lib/index.js',
  exports: { '.': './lib/index.js', './compaction': './lib/compaction.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n')

if (patchFile) copyFileSync(patchFile, join(out, 'cordis.patch.yml'))

console.log(`✓ bundle/ 已生成（dsh-her-life ${pkg.bundleVersion}）`)
console.log(patchFile
  ? '✓ 预设已拷入 bundle/cordis.patch.yml'
  : '· 还没有预设：把你的 cordis.patch.yml 放进 bundle/，或用 --patch <文件> 重新打包')
