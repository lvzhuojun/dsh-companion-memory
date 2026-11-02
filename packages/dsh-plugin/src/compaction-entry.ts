// 预设里用 name: 'dsh-her-life/compaction' 加载的入口（替换 @deepseek-ai/dsh-compaction-basic，配置项完全相同）。
// 拿不到 DSH 的 BasicCompactionEngine 时不接管：导出一个只打警告的空插件，插件绝不崩溃。
// 正常部署下这里拿得到，不应走到兜底；上线前可以在影子会话里确认一次。

import { loadCompactionDeps, makeCompanionEngine } from './compaction.js'

const deps = await loadCompactionDeps()

const Unavailable = {
  name: 'her-compaction-unavailable',
  apply() {
    console.error('[her-compaction] 找不到 DSH 的 compaction-basic，中文压缩没有生效（这个会话暂时不会自动压缩）。请把预设里的 dsh-her-life/compaction 改回 @deepseek-ai/dsh-compaction-basic。')
  },
}

if (deps) console.error(`[her-compaction] 中文陪伴版压缩已就绪（来源：${deps.via}）`)

export default deps ? makeCompanionEngine(deps) : Unavailable
