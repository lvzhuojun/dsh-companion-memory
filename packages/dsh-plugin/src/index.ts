// DSH 插件入口。部署时打包成单文件（npm run bundle），替换私有部署里的 dsh-her-life。

import type { HostCtx } from './host.js'
import { applyHerLife, type HerLifeConfig } from './her-life.js'

export const name = 'her-life'
export const inject = ['systemPrompt', 'tools']

export function apply(ctx: HostCtx, config: HerLifeConfig = {}) {
  applyHerLife(ctx, config)
}

export { memoryRules, trustLine, MEMORY_RULES_MARKER, type MemoryRulesOptions } from './rules.js'
export { recallDiaryTool } from './recall-diary.js'
export { writeDiaryTool, type WriteDiaryOptions } from './write-diary.js'
export { cacheKey, dailyCache, DEFAULTS, MEMORY_TOOLS, OWN_TOOLS, type HerLifeConfig } from './her-life.js'
export { followUpList, followUpTool, keepMemoryTool, PERSON_CARD_LINE, personCardTool, recallChatTool, recallMemoryTool } from './memory-tools.js'
export type { HostCtx, ToolDef } from './host.js'
export { cardSection, chunkLines, dayTranscript, DEFAULT_PRICES, estimateCost, inWindow, reviewDay, reviewPrompt, runNightReview, unwrapQQ } from './night-review.js'
export type { DayLine, NightReviewOptions, NightReviewReport, Prices, ReviewBlock, ReviewModel, ReviewMsg, ReviewStyle, ReviewUsage } from './night-review.js'
export { compactionCounter, loadCreateUserMessage, makeNoticer, personText, preStepHandler, PERSON_SOURCES, type ReadSideOptions } from './read-side.js'
