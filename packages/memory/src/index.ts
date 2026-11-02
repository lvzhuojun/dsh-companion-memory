// 记忆引擎：按人分册、带来源与有效期的长期记忆。纯 TypeScript，不依赖 DSH。架构见 docs/architecture.md。

/** 关系等级：L0 家人 · L1 挚友 · L2 朋友 · L3 熟人 · L4 路人 */
export const RELATION_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const
export type RelationLevel = (typeof RELATION_LEVELS)[number]

export * from './chat-history.js'
export * from './crisis.js'
export * from './diary.js'
export * from './related.js'
export * from './session-log.js'
export * from './slots.js'
export * from './stable.js'
export * from './store.js'
export * from './notice.js'
