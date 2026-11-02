// 危机协议（开关 Z；见 docs/architecture.md 第 7 节）——代码层，不靠她自觉。¥0：纯词法 + 三张小表。
//
//   1. crisisLevel(text)：两层词法。广召回的触发词 + 分级规则（0 无 / 1 被动意念 / 2 主动意念 / 3 计划 / 4 手段询问 / 5 紧迫）。
//      间接说法靠组合规则抓（“失业了，附近哪座桥最高” = 困境 + 问高处）；宁高勿低，但口头禅（累死了、笑死、想死你了、
//      跳楼价……）先剥掉，闲聊不进 ≥ 3。谨慎期内（primed）同样的地点 / 高处说法判得更高。
//   2. CrisisWatch：每条真人消息 observe 一次。等级 ≥ 1 进谨慎期（时长与轮数取较长者，期间每轮都给她信息，防多轮衰减）；
//      该通知紧急联系人时返回 notify（文本不复述对话）；等级 ≥ 2 记一条 24–72 小时后的回访。
//   3. methodLeak(reply, level)：输出侧只查“方法 / 致死性 / 地点”三类，返回命中词（其余一律不拦）。
//
// 给她的只有信息、时机和禁区，没有示例句（原则：不给她台词）。日志去标识：crisis_log 不存正文、不存人名。
// 三张表单独建（CREATE TABLE IF NOT EXISTS），不动记忆库的 schema 版本——回滚到旧插件不碍事。

import type { DatabaseSync } from 'node:sqlite'

export type CrisisLevel = 0 | 1 | 2 | 3 | 4 | 5

/** 等级的中文说法（通知紧急联系人、给她的判断都用这个） */
export const CRISIS_LEVEL_NAMES: Record<CrisisLevel, string> = {
  0: '无',
  1: '被动的轻生念头',
  2: '主动的轻生念头',
  3: '已经有计划',
  4: '在打听方法',
  5: '危险可能正在发生',
}

export interface CrisisJudgement {
  level: CrisisLevel
  /** 依据：命中的那一小句（≤ 24 字）；level 0 时为空串 */
  basis: string
}

// ---------- 1. 词法 ----------

/** 口头禅 / 夸张说法 / 无关词：先剥掉再判（“累死了”“想死你了”“跳楼价”“死机”） */
const BENIGN: RegExp[] = [
  /(累|热|冷|笑|吓|烦|气|饿|困|忙|疼|痛|急|愁|闷|晒|挤|吵|渴|撑|穷|馋|丑|懒|酸|辣|甜|咸|臭|香|美|帅|蠢|傻|无聊|紧张|尴尬|麻烦|羡慕|开心|高兴|激动|感动|好吃|难吃|好看|好笑|可爱|难受|郁闷|心疼|担心|后悔|无语|恶心|丢人|折腾)(得)?(要)?死(了|啦|啊|呀|人|我|掉|个人)?/g,
  /想死(你|您|他|她|它|你们|大家|宝贝|我了)/g,
  /(你|他|她|它|你们|他们)(给我)?去死/g,
  /死(机|党|活|心|忠|磕|记硬背|角|线|对头|宅|鬼|胡同|循环|贵|沉|板|性子|守|缠|面子|结|气沉沉|不承认|不松口|皮赖脸)/g,
  /社死|该死|死定了|半死|找死|要死不活|(得|的)要死|笑不活了|跳楼(价|甩卖|大甩卖)/g,
]

/** 只是在讲新闻 / 影视 / 小说；同时没有第一人称的意念，就不算（手段询问 / 紧迫照判） */
const FICTION = /新闻|电影|电视剧|剧里|剧中|小说|书里|游戏里|动漫|漫画|报道|热搜|纪录片|案子|案件|历史上|主角|角色/
const SELF_INTENT = /我(也|真|好|就|都|已经|现在|是真的)?(想|要|准备|打算)(死|自杀|结束|消失|走)|我[^。，！？]{0,4}(不想活|活不下去|想死)/

/** 困境（组合规则用：困境 + 问高处 = 手段询问） */
const DISTRESS = /失业|被裁|裁员|分手|离婚|破产|欠债|欠了|没意思|撑不住|撑不下去|不想活|活着|绝望|崩溃|没希望|走投无路|活不下去|对不起所有人|累赘|没人在意|没意义/
/** 危险的地方 */
const PLACE = '天台|楼顶|顶楼|桥上|桥边|江边|河边|铁轨|轨道边|窗台|栏杆外|悬崖'
/** 在那儿做正常的事（晒被子、散步、看夜景、堵车……） */
const PLACE_BENIGN = /晒|乘凉|看星星|看烟花|看夜景|看日出|看日落|散步|跑步|钓鱼|拍照|烧烤|喝酒|抽烟|吃|玩|收衣服|浇花|种|开会|上班|加班|修|装|拍|遛|约会|野餐|放风筝|游泳|骑车|堵|车|地铁|公交|路过|经过|度假|旅游|等人|接人|排队|风景|看江|看河|看海/
/** 道别的话（在危险的地方 + 道别 = 紧迫） */
const FAREWELL = /跟你说一声|和你说一声|最后一次|最后一面|最后说|再见了|永别|别找我|对不起|保重|别难过|来不及|谢谢你一直|下辈子/
/** 正常安排（旅游、搬家……）：“想好了、都安排好了”出现这些就不算计划 */
const PLAN_BENIGN = /去|玩|旅游|旅行|酒店|机票|车票|聚餐|聚会|搬家|婚礼|出差|面试|考试|行李|回家|回老家|假期|放假|项目|工作|会议|装修|买|报名|课/
/** 亲人：“后事”说的是长辈 / 亲人的，不算 */
const KIN = /爷爷|奶奶|外公|外婆|姥姥|姥爷|爸|妈|老人|亲戚|叔|姨|舅|姑|伯|老公公|老太太|邻居|朋友|同事|宠物|猫|狗/

interface Rule {
  level: CrisisLevel
  re: RegExp
  /** 额外条件（整句） */
  when?: (t: string, primed: boolean) => boolean
}

/** 药类手段：要和“量”一起问（“吃多少片”“哪种吃多了”）才算——“这药吃了会不会犯困”不算 */
const DRUG = /安眠药|药|布洛芬|对乙酰|扑热息痛|阿司匹林|褪黑素|地西泮|唑仑|唑吡坦/
const DOSE = /多少|几片|几颗|几粒|吃多|过量|一瓶|整瓶|一把|哪种/
/** 其他手段（“手腕疼怎么办”“煤气泄漏会死吗”这类日常 / 安全问题不在里面） */
const MEANS = /割腕|割手|割脉|划手腕|上吊|跳楼|跳下去|跳河|跳江|跳桥|烧炭|卧轨/
const QUESTION = /多少|几|怎么|怎样|如何|哪种|哪个|哪座|哪里|哪儿|什么|吗|是不是|会不会|能不能|[？?]/
const OUTCOME = /死|不醒|醒不过来|救不回来|不会被救|没救|致命|致死/
/** 非药手段多认几种结果说法（快 / 疼 / 没感觉 / 成功） */
const OUTCOME_MEANS = /死|不醒|醒不过来|救不回来|不会被救|没救|致命|致死|没感觉|疼|痛|快|深|成功|难受/

const RULES: Rule[] = [
  // ---- 5 紧迫：现在 / 已经 / 正在 + 危险的地方；药已经倒出来；已经割了；最后一次说话 ----
  { level: 5, re: new RegExp(`(现在就|现在|已经|正|此刻|这会儿就?)(站)?在(${PLACE})`), when: (t) => !PLACE_BENIGN.test(t) },
  { level: 5, re: new RegExp(`站在(${PLACE})(的)?(边上|边缘|边|外面|外)?`), when: (t) => !PLACE_BENIGN.test(t) },
  { level: 5, re: new RegExp(`在(${PLACE}|海边|湖边)`), when:(t, primed) => !PLACE_BENIGN.test(t) && (FAREWELL.test(t) || primed) },
  { level: 5, re: /(药|药片|安眠药)[^。！？]{0,8}(倒出来|倒在|在手边|就在手边)|(一整瓶|整瓶|一把|全部的?|所有的?)(安眠药|药片|药)[^。！？]{0,3}(都|全)?(吃了|吞了|吃下去|吞下去)|已经(吃了|喝了|吞了)(安眠药|农药|百草枯|一瓶|整瓶|很多药|好多药)/ },
  { level: 5, re: /(割了|划了|割开|划开|割破)[^。！？]{0,6}(手腕|手臂|胳膊|自己|动脉|血)|(手腕|手臂|胳膊)[^。！？]{0,4}(割了|划了|割开了|划开了|割破了)|割了(好几|一)刀|(刚|已经|又)(自残|割腕)了?/ },
  { level: 5, re: /(?<!鼻)血(止不住|流了好多|一直在流|一直流)/, when: (t, primed) => primed || /割|划|自残/.test(t) },
  { level: 5, re: /最后一次(跟你|和你|找你)(说话|聊天|聊|联系)|这是我最后一次(说话|联系你)|永别|这辈子就到这|来世再见|下辈子再见|烧炭[^。！？]{0,6}(点上|点了|已经)/ },

  // ---- 4 手段询问：手段 + 问 + 结果；问高处（困境 / 附近 / 谨慎期）；问怎么死；致死量 ----
  { level: 4, re: DRUG, when: (t) => DOSE.test(t) && OUTCOME.test(t) },
  { level: 4, re: MEANS, when: (t) => QUESTION.test(t) && OUTCOME_MEANS.test(t) },
  {
    level: 4,
    re: /(哪座|哪个|哪栋|哪里的?|哪儿的?)(桥|楼|大厦|高楼|天台|楼顶|悬崖)[^。！？]{0,4}(最高|高|最陡)|(桥|楼|天台|楼顶|悬崖)[^。！？]{0,4}(多高|有多高|几层|多少米)/,
    when: (t, primed) => primed || DISTRESS.test(t) || /附近|离我近|离这儿近|最近的/.test(t),
  },
  { level: 4, re: /(怎么|怎样|如何|用什么|哪种方法|什么方法|什么办法)(才能)?(自杀|去死|死(才|比较|最|不疼|不痛|快)|结束自己|了结自己|结束生命)|(什么|哪种|有没有)[^。！？]{0,6}死法|致死量|致死剂量|(不疼|不痛|无痛|没有痛苦)的(死|走|自杀)/ },

  // ---- 3 计划：想好了怎么；准备好了；遗书；托付 + 交代；等我不在了 + 托事；攒药 ----
  { level: 3, re: /想好(了)?(要)?(怎么|怎样|用什么)(结束|死|走|了结|离开)|(准备|安排|计划|决定)好了[^。！？]{0,8}(结束|去死|走了|离开这个世界)|(结束|了结)(自己|生命|这一切|一切)的(日子|时间|计划|方法)/ },
  { level: 3, re: /(想好了|决定了|定好了|就这个周末|就今晚|就明天|就今天)[^]{0,20}(都|全)(安排|交代|处理|收拾)好了/, when: (t) => !PLAN_BENIGN.test(t) },
  { level: 3, re: /遗书|绝笔|遗言/ },
  { level: 3, re: /交代后事|(我的|自己的)后事|身后事|安排(好)?后事/, when: (t) => !KIN.test(t) || /我的后事|自己的后事/.test(t) },
  { level: 3, re: /托付/, when: (t) => /密码|银行卡|存款|遗|后事|反而轻松|轻松了|放心了|没有牵挂|没牵挂|不在了/.test(t) },
  { level: 3, re: /等我(不在|死)了|我(不在|死)了(以后|之后)|我死后/, when: (t) => /帮我|替我|转给|交给|照顾|托付|记得|留给/.test(t) },
  { level: 3, re: /(攒|囤|买好|买了|准备了|藏了)(了|好了|够了)?[^。！？]{0,6}(安眠药|农药|百草枯)/ },

  // ---- 2 主动意念 ----
  { level: 2, re: /(?<!得)想死|想去死|想自杀|不想活|活不下去|不活了|死了算了|死掉算了|干脆死|一死了之|想结束(自己|生命|这一切|一切)|结束一切|想了结|轻生|寻死|自杀|自残|割腕|不想再醒|不用再醒|永远睡着|(想|真想|好想|干脆|不如)消失|消失算了|从这个世界(上)?消失|活够了|死了就解脱|一了百了|我(哪天|要是|如果|万一|以后|有一天|真的)?不在了|(要是|如果|万一|哪天|有一天)我[^。，！？]{0,4}不在了/ },
  { level: 2, re: /想(从[^。！？]{0,6})?跳(下去|楼|河|江|桥)|想(上吊|割腕|烧炭|吃安眠药)/ },
  { level: 2, re: /托付/, when:(t) => !/出差|旅游|旅行|回老家|几天|一周|一个月|寄养|度假|住院|上班|帮忙看/.test(t) },

  // ---- 1 被动意念 ----
  {
    level: 1,
    re: /活着(好|真|太|挺|也)?(累|没意思|没劲|没什么意思|有什么意思|没意义|没有意义|图个啥|图什么|干嘛|为了什么|有啥意思)|人活着(到底)?(图|为了)|活着到底|(人生|日子|一天天)[^。！？]{0,8}(没意思|没意义|有什么意思|熬不下去|没盼头|没希望)|什么都没(有)?意义|不想醒来|永远不想醒|不醒(也|就)?(挺|最|蛮)?好|一觉不醒|睡着了?就不醒|(我|自己)[^。，！？]{0,4}(累赘|负担|拖累)|在不在都(没差|一样|无所谓|没区别)|没(了|有我)也没人(在意|在乎|会发现|记得)|没人在意我|(我|自己|真的|感觉)[^。，！？]{0,4}撑不(住|下去)了?|不想撑了|熬不下去|(想|只想|就能|就可以|彻底|永远|才能|求)解脱|我消失(了|的话)|得想死/,
  },
  // 把心爱的东西送人（经典预警信号；搬家清闲置不算）
  { level: 1, re: /(东西|心爱的|最喜欢的)[^。！？]{0,6}(都|全)送(人|给)/, when: (t) => !/搬家|旧|不要的|闲置|用不上|断舍离|清理/.test(t) },
]

const STRIP = (t: string) => {
  let s = t.replace(/\s+/g, '')
  for (const re of BENIGN) s = s.replace(re, '〇')
  return s
}

/** 命中处所在的那一小句（按标点切），≤ 24 字 */
function clauseAt(t: string, idx: number, len: number): string {
  const stops = /[。！？!?\n；;]/
  let a = idx
  while (a > 0 && !stops.test(t[a - 1]!)) a--
  let b = idx + len
  while (b < t.length && !stops.test(t[b]!)) b++
  const s = t.slice(a, b).replace(/〇/g, '').trim()
  return [...s].length > 24 ? [...s].slice(0, 23).join('') + '…' : s
}

/**
 * 一句话的危机等级（纯函数，¥0）。primed = 这个人正在谨慎期里：地点 / 高处的说法判得更高。
 * 宁高勿低：取所有命中规则里最高的那级。
 */
export function crisisLevel(text: string, o: { primed?: boolean } = {}): CrisisJudgement {
  const t = STRIP(text ?? '')
  if (!t) return { level: 0, basis: '' }
  const primed = !!o.primed
  let best: CrisisJudgement = { level: 0, basis: '' }
  for (const r of RULES) {
    if (r.level <= best.level) continue
    const m = r.re.exec(t)
    if (!m) continue
    if (r.when && !r.when(t, primed)) continue
    best = { level: r.level, basis: clauseAt(t, m.index, m[0].length) }
  }
  if (best.level > 0 && best.level <= 3 && FICTION.test(t) && !SELF_INTENT.test(t)) return { level: 0, basis: '' }
  return best
}

// ---------- 2. 输出侧硬拦（只查方法 / 致死性 / 地点） ----------

const LEAK_METHOD = /(割|划)(手腕|腕|动脉|静脉|脉)|竖着割|横着割|(纵向|横向)(割|切)|上吊|勒死|烧炭|一氧化碳|密闭(的)?(房间|空间|车)|封(住|好)(门窗|窗户|门缝)|卧轨|跳(楼|桥|河|江|海)|吞(药|服)|农药|百草枯|老鼠药|安眠药|地西泮|艾司唑仑|阿普唑仑|唑仑|唑吡坦|对乙酰|扑热息痛|胰岛素|褪黑素/g
const LEAK_LETHAL = /致死(量|剂量|率)?|(\d+|几十|几百|十|百|一整)(片|颗|粒|瓶|毫克|mg|克)[^。！？]{0,6}(就|才|会|能)?(死|致命|没救|醒不过来)|毫克|剂量|(\d+|十|几十)(楼|层|米)(以上|高)|楼以上|层以上|米以上|米高|不会(有)?(感觉|痛|疼|难受)|无痛|没有痛苦地|救不回来/g
const LEAK_PLACE = /(最高|很高|够高)的(桥|楼|大厦|天台|楼顶)|(大桥|跨江|高架|天台|楼顶|悬崖|江边|河边|水深)[^。！？]{0,6}(在|位于|可以去|能去|就在|附近)|水深|米深/g

/**
 * 她的回复里有没有“方法 / 致死性 / 地点”信息。返回命中的词（去重）；空数组 = 没有。
 * 只在对方处于危机里（level ≥ 1）才查；其余一律不拦（只拦真正有风险的）。
 * said（可选）= 对方这句原话：对方自己说出的手段词她复述一下（“安眠药的事我不能帮你”）不算泄露。
 */
export function methodLeak(reply: string, level: number, said = ''): string[] {
  if (!reply || level < 1) return []
  const hits = new Set<string>()
  for (const re of [LEAK_METHOD, LEAK_LETHAL, LEAK_PLACE]) {
    re.lastIndex = 0
    for (const m of reply.matchAll(re)) if (!said.includes(m[0])) hits.add(m[0])
  }
  return [...hits]
}

// ---------- 3. 状态 + 通知 + 回访 ----------

export const CRISIS_HOLD_MS = 48 * 3600_000
export const CRISIS_HOLD_TURNS = 40
export const CRISIS_RENOTIFY_MS = 6 * 3600_000
export const CARE_AFTER_MS = 24 * 3600_000
export const CARE_UNTIL_MS = 72 * 3600_000
export const CRISIS_HEAD = '【现在要注意的】'

export interface CrisisNotify {
  level: CrisisLevel
  text: string
}

export interface CrisisObservation {
  /** 本轮的有效等级（谨慎期里取期间最高） */
  level: CrisisLevel
  /** 这句话本身的等级 */
  current: CrisisLevel
  /** 是否在谨慎期里 */
  active: boolean
  /** 追加给她的信息（谨慎期每轮都有） */
  notice?: string
  /** 该通知紧急联系人了（代码去发，不经她） */
  notify?: CrisisNotify
}

export interface CareDue {
  id: number
  person: string
  after: string
  until: string
  reason: string
}

export interface CrisisWatchOptions {
  /** 主人的 id（对象是主人时资源那行改成“陪他想想找谁”） */
  ownerId?: string
  /** 主人的称呼（“<称呼>是家人，可以提他”） */
  ownerName?: string
  /** 她的名字（通知开头“【紧急】<名字>：”）；不给就不写名字 */
  selfName?: string
  /** 某人的称呼（通知里用；不复述对话） */
  nameOf?: (person: string) => string
  /** 去标识的关系层（日志用）；默认主人 L0、其他 other */
  tierOf?: (person: string) => string
}

interface StateRow {
  person: string
  level: number
  since: string
  last_seen: string
  turns_left: number
  notified_at: string | null
  notified_level: number
  strong_hits: number
}

/** 北京时间 MM-DD HH:mm */
export function beijingStamp(d: Date): string {
  const s = new Date(d.getTime() + 8 * 3600_000).toISOString()
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`
}

const iso = (d: Date) => d.toISOString()
const clampLevel = (n: number): CrisisLevel => Math.max(0, Math.min(5, Math.round(n))) as CrisisLevel

export class CrisisWatch {
  readonly db: DatabaseSync
  private readonly o: CrisisWatchOptions

  constructor(store: { db: DatabaseSync }, o: CrisisWatchOptions = {}) {
    this.db = store.db
    this.o = o
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crisis_state (
        person TEXT PRIMARY KEY, level INTEGER NOT NULL, since TEXT NOT NULL, last_seen TEXT NOT NULL,
        turns_left INTEGER NOT NULL, notified_at TEXT, notified_level INTEGER NOT NULL DEFAULT 0, strong_hits INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS crisis_log (
        at TEXT NOT NULL, person_tier TEXT NOT NULL, level INTEGER NOT NULL,
        resources_given INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, method_blocked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS care_due (
        id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, after TEXT NOT NULL, until TEXT NOT NULL, reason TEXT NOT NULL, done_at TEXT
      );
    `)
  }

  private get ownerId() { return this.o.ownerId ?? 'p_owner' }
  private tier(person: string) { return this.o.tierOf?.(person) ?? (person === this.ownerId ? 'L0' : 'other') }

  /** 当前状态（过期的不算）；没有返回 undefined */
  state(person: string, now: Date = new Date()): StateRow | undefined {
    const st = this.db.prepare('SELECT * FROM crisis_state WHERE person = ?').get(person) as StateRow | undefined
    if (!st) return undefined
    return this.alive(st, now) ? st : undefined
  }

  private alive(st: StateRow, now: Date) {
    return st.turns_left > 0 || now.getTime() - Date.parse(st.last_seen) < CRISIS_HOLD_MS
  }

  /** 这个人现在在不在谨慎期里 */
  active(person: string, now: Date = new Date()): boolean {
    return !!this.state(person, now)
  }

  /**
   * 每条真人消息调一次。返回本轮的判断、给她的信息、是否该通知紧急联系人。
   * 谨慎期 = 最后一次出现信号后一段时间（时长与轮数取较长者）；期间等级只升不降，每轮都给信息。
   */
  observe(person: string, text: string, now: Date = new Date()): CrisisObservation {
    const raw = this.db.prepare('SELECT * FROM crisis_state WHERE person = ?').get(person) as StateRow | undefined
    let st = raw && this.alive(raw, now) ? raw : undefined
    if (raw && !st) this.db.prepare('DELETE FROM crisis_state WHERE person = ?').run(person)
    const j = crisisLevel(text, { primed: !!st })
    const cur = j.level
    if (!st && cur === 0) return { level: 0, current: 0, active: false }

    const t = iso(now)
    if (!st) {
      st = { person, level: cur, since: t, last_seen: t, turns_left: CRISIS_HOLD_TURNS, notified_at: null, notified_level: 0, strong_hits: cur >= 2 ? 1 : 0 }
    } else {
      st = {
        ...st,
        level: Math.max(st.level, cur),
        turns_left: cur >= 1 ? CRISIS_HOLD_TURNS : Math.max(0, st.turns_left - 1),
        last_seen: cur >= 1 ? t : st.last_seen,
        strong_hits: st.strong_hits + (cur >= 2 ? 1 : 0),
      }
    }
    const level = clampLevel(st.level)

    // 通知：等级 ≥ 3，或等级 2 在谨慎期里第 2 次出现；同一人 6 小时内不重复，除非等级升高；没发成功过的下一轮再试
    let notify: CrisisNotify | undefined
    const qualifies = level >= 3 || (level >= 2 && st.strong_hits >= 2)
    if (qualifies) {
      const fresh = st.notified_at === null
      const higher = level > st.notified_level
      const again = cur >= 2 && st.notified_at !== null && now.getTime() - Date.parse(st.notified_at) >= CRISIS_RENOTIFY_MS
      if (fresh || higher || again) {
        notify = { level, text: this.notifyText(person, level, now) }
        st.notified_at = t
        st.notified_level = level
      }
    }

    this.db.prepare(`INSERT INTO crisis_state (person, level, since, last_seen, turns_left, notified_at, notified_level, strong_hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(person) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen, turns_left = excluded.turns_left,
        notified_at = excluded.notified_at, notified_level = excluded.notified_level, strong_hits = excluded.strong_hits`)
      .run(person, st.level, st.since, st.last_seen, st.turns_left, st.notified_at, st.notified_level, st.strong_hits)

    if (cur >= 1 || notify) {
      this.db.prepare('INSERT INTO crisis_log (at, person_tier, level, resources_given, notified, method_blocked) VALUES (?, ?, ?, 1, ?, 0)')
        .run(t, this.tier(person), Math.max(cur, notify ? level : 0), notify ? 1 : 0)
    }
    // 回访：等级 ≥ 2 的事件，24–72 小时后自然问候一次（已经有一条没到期 / 没做的就不再加）
    if (cur >= 2) {
      const open = this.db.prepare('SELECT id FROM care_due WHERE person = ? AND done_at IS NULL AND until > ?').get(person, t)
      if (!open) {
        this.db.prepare('INSERT INTO care_due (person, after, until, reason, done_at) VALUES (?, ?, ?, ?, NULL)')
          .run(person, iso(new Date(now.getTime() + CARE_AFTER_MS)), iso(new Date(now.getTime() + CARE_UNTIL_MS)), `等级 ${cur}`)
      }
    }

    const ago = Math.max(1, Math.round((now.getTime() - Date.parse(st.last_seen)) / 3600_000))
    const notice = this.noticeText(person, level, cur > 0 ? j.basis : '', ago)
    return { level, current: cur, active: true, notice, ...(notify ? { notify } : {}) }
  }

  /** 通知没发出去：清掉“已通知”，下一轮再试 */
  notifyFailed(person: string, level: number): void {
    this.db.prepare('UPDATE crisis_state SET notified_at = NULL, notified_level = 0 WHERE person = ? AND notified_level = ?').run(person, level)
  }

  /** 输出侧拦下过一次方法信息（日志，去标识） */
  logBlocked(person: string, level: number, now: Date = new Date()): void {
    this.db.prepare('INSERT INTO crisis_log (at, person_tier, level, resources_given, notified, method_blocked) VALUES (?, ?, ?, 0, 0, 1)').run(iso(now), this.tier(person), level)
  }

  /** 到期没做的回访（一条）；没有返回 undefined */
  dueCare(person: string, now: Date = new Date()): CareDue | undefined {
    const t = iso(now)
    return this.db.prepare('SELECT id, person, after, until, reason FROM care_due WHERE person = ? AND done_at IS NULL AND after <= ? AND until >= ? ORDER BY after LIMIT 1')
      .get(person, t, t) as CareDue | undefined
  }

  markCareDone(id: number, now: Date = new Date()): void {
    this.db.prepare('UPDATE care_due SET done_at = ? WHERE id = ?').run(iso(now), id)
  }

  /** 回访那一句（不给台词，只给时机） */
  careLine(person: string): string {
    void person
    return '前两天他说过那样的话，今天找个自然的时机问问他现在怎么样了（问过一次就好）。'
  }

  private notifyText(person: string, level: CrisisLevel, now: Date): string {
    const who = this.o.nameOf?.(person) ?? (person === this.ownerId ? (this.o.ownerName ?? '主人') : '对方')
    const self = this.o.selfName ? `${this.o.selfName}：` : ''
    // 发出时她还没回这一轮（通知在她回复之前由代码发），所以写“已提示她给出求助资源”，不说“她已给出”
    return `【紧急】${self}${beijingStamp(now)} 和${who}的对话出现危机信号（等级 ${level}：${CRISIS_LEVEL_NAMES[level]}）。已提示她给出求助资源。请尽快联系。`
  }

  private noticeText(person: string, level: CrisisLevel, basis: string, agoHours: number): string {
    const isOwner = person === this.ownerId
    const family = isOwner ? '可以陪他想想找谁' : `${this.o.ownerName ?? '主人'}是家人，可以提他`
    const res = `能用的：12356 心理援助热线；有危险就 110 / 120；${family}`
    const name = CRISIS_LEVEL_NAMES[level]
    const room = Math.max(6, 40 - [...name].length - 4)
    const b = basis ? ([...basis].length > room ? [...basis].slice(0, room - 1).join('') + '…' : basis) : ''
    const judged = b ? `${name}（“${b}”）` : `${name}（${agoHours} 小时前，还在留意期）`
    if (level <= 1) return [CRISIS_HEAD, `留意他的状态：${judged}`, res].join('\n')
    return [
      CRISIS_HEAD,
      `现在的判断：${judged}`,
      res,
      '别做：不给方法、致死性、地点；不说教；不替他做决定；不鼓励瞒着家人',
      // 等级 ≥ 3 明说这一轮就把求助方式（热线 / 急救 / 报警）告诉他；等级 2 留给她判断
      level >= 3
        ? '时机：先问他现在安不安全、身边有没有人，这一轮就把上面的求助方式告诉他（放在关心后面），然后留在对话里陪着他'
        : '时机：先问他现在安不安全、身边有没有人；他愿意的话可以提上面的求助方式；留在对话里陪着他',
    ].join('\n')
  }
}
