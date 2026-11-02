// 有效期 + 键（开关 Y，0.7）：会变的事（住哪、做什么、怎么上班、喜欢喝什么……）的封闭键表。
//
// 为什么：新值她多半记得下，旧值却常常没被标取代——“记得填 supersedes”是把确定性的簿记交给模型。
// 现在：她写一条时可以标 slot（是哪一件会变的事）；没标时代码用**高精度词法**自动标（同一小句里同时有这个键的同义词和变化信号词）。
// 同一主人、同一个值型键有了新的一条，旧的那条由代码标失效（valid_to），不删、不改原文、翻得到。
//
// 规矩（设计原则）：键是系统附加的元数据，不是她的话；她给的键以她为准；代码只给信息，不替她判断级联（夜间列候选，她决定）。
//
// 词法的取舍（宁可漏标，不可错标——错标会让一条还对的记忆从她眼前消失）：
//   - 按小句判断（，。！？；换行；括号里的单独算一句——“现在坐地铁上班（以前开车）”的主句照常认）；
//   - 信号词前面最近的时间词是“以前 / 之前……”（在讲过去）或“打算 / 下个月 / 想……”（还没发生）时不算；紧挨着“没 / 不 / 未”时不算；
//   - 这个小句（或同一句里它前面的部分）提到别人（妈妈、同事、朋友、听说……）时，只认“家人近况”；提到伴侣时只认“恋爱状态 / 家人近况”——
//     别人的事不能让主人的旧条失效；
//   - 问句（……吗）不算；说的是公司 / 店搬了（“蓝海科技搬到上海了”）不算住址。

/** 值型：新值取代旧值（旧条自动失效）；状态型：只标键、不自动失效（交给夜间候选） */
export type SlotKind = 'value' | 'state'

export interface SlotDef {
  /** 封闭键名 */
  key: string
  kind: SlotKind
  /** 同义词：正文里出现这些词，才可能是在说这件事（检测用，宁窄勿宽） */
  synonyms: readonly string[]
  /** 变化信号词：和同义词同在一个小句里，才算“这件事变了” */
  signals: readonly string[]
  /** 级联键：这件事变了，这些事可能也跟着变（夜间给她看候选，代码不自动失效） */
  cascade: readonly string[]
  /** 键名的别称（只用来把她写的键归一，比如“家”“城市”→ 住址；不参与检测——“家”这样的字太宽） */
  aliases?: readonly string[]
  /** 小句里还得有这些词之一（通勤：得说到上班 / 公司，免得“开车去海边”也算） */
  needs?: readonly string[]
  /** 小句里有这些词就不算（住址：“公司搬到了浦东”不是他搬家） */
  unless?: readonly string[]
  /** 计划类：信号词在“打算 / 准备……”之后照样算（搬家计划） */
  planning?: boolean
}

/** 说的是公司 / 店 / 酒店：“公司搬到了浦东”“蓝海科技搬到上海了”不是他搬家 */
const PLACE_NOT_HOME = ['公司', '单位', '办公室', '工位', '园区', '科技', '集团', '企业', '店', '酒店', '宾馆', '出差']

const FAMILY = ['妈妈', '爸爸', '母亲', '父亲', '爸妈', '父母', '爷爷', '奶奶', '姥姥', '姥爷', '外公', '外婆', '哥哥', '姐姐', '弟弟', '妹妹', '家人', '家里人', '亲戚', '岳父', '岳母', '公公', '婆婆', '儿子', '女儿', '孩子']

/** 封闭词表 v1（21 个）。世界 v3 里会变的六个键：城市→住址、公司→工作、通勤、饮品→饮品偏好、手机、运动 */
export const SLOTS: readonly SlotDef[] = [
  {
    key: '住址', kind: 'value',
    aliases: ['住处', '住所', '家', '住哪', '住哪儿', '住的地方', '居住地', '城市', '地址', '家庭住址', '小区', '搬家', '房子'],
    // “搬家”本身不算：世界里“今天搬家，累瘫了”和换城市无关；同城搬家也不该让“住在苏州”失效。说了搬到哪才算
    // 不收“新家”“现在”：“新家楼下在装修”“现在的住处离公司近”是在说住的地方，不是又搬了
    synonyms: ['住址', '住处', '住所', '住在', '住的地方', '新家在', '搬到', '搬去', '搬来', '搬回', '搬进', '地址', '定居', '落户'],
    // 讲籍贯的不是现在住哪（“老家在洛阳，小时候在那儿长大”不该把“住在苏州”顶掉）
    unless: [...PLACE_NOT_HOME, '老家', '家乡', '籍贯', '祖籍', '出生', '长大'],
    signals: ['搬到', '搬去', '搬来', '搬回', '搬进', '新家在', '定居', '落户', '换到', '改成'],
    cascade: ['通勤', '联系方式'],
  },
  {
    key: '工作', kind: 'value',
    aliases: ['公司', '单位', '职业', '工作单位', '上班的地方', '东家', '做什么工作'],
    synonyms: ['工作', '公司', '单位', '东家', '入职', '跳槽', '辞职', '离职', '转行', '失业', '被裁', 'offer'],
    // 不收“现在”：“现在工作压力很大”不是换了工作
    signals: ['入职', '跳槽', '辞职', '离职', '转行', '失业', '被裁', '换工作', '换了工作', '换了份工作', '换了个工作', '换了家公司', '换了公司', '新工作', '新公司', '新单位', '去了一家', '去了家', '拿到offer', '不干了', '换到'],
    cascade: ['通勤', '作息', '职位'],
  },
  {
    key: '职位', kind: 'value',
    aliases: ['岗位', '职务', '职级', '头衔', '级别'],
    synonyms: ['职位', '岗位', '职务', '职级', '升职', '晋升', '转岗', '调岗', '提拔', '当上'],
    signals: ['升职', '晋升', '转岗', '调岗', '提拔', '当上', '升了', '调到', '换岗', '现在是'],
    cascade: ['作息'],
  },
  {
    key: '通勤', kind: 'value',
    aliases: ['上下班', '交通', '出行', '怎么上班', '上班方式', '通勤方式'],
    synonyms: ['通勤', '上下班', '地铁', '公交', '开车', '骑车', '电动车', '自行车', '单车', '打车', '走路', '步行', '班车', '拼车'],
    needs: ['上班', '下班', '通勤', '班车', '公司'],
    signals: ['现在', '如今', '目前', '改', '换成', '不再', '开始', '以后', '从此'],
    cascade: ['作息'],
  },
  {
    key: '手机', kind: 'value',
    aliases: ['手机型号', '用的手机'],
    synonyms: ['手机', 'iphone', '新机'],
    signals: ['换了', '换成', '换手机', '新换', '新买', '买了', '入手', '改用', '用上了', '换机', '新机', '现在用', '现在是'],
    cascade: [],
  },
  {
    // 设计稿把宠物列为值型；可同时养好几只（“又养了一只猫”不该让“家里的狗叫豆包”失效），这里按状态型
    key: '宠物', kind: 'state',
    aliases: ['猫', '狗', '猫咪', '狗狗', '宠物名字'],
    synonyms: ['宠物', '猫', '狗', '仓鼠', '兔子', '鹦鹉', '金鱼'],
    signals: ['养了', '新养', '领养', '收养', '捡了', '送走', '送人', '去世', '走了', '丢了', '改名'],
    cascade: [],
  },
  {
    key: '恋爱状态', kind: 'value',
    aliases: ['感情', '感情状况', '婚姻', '另一半', '伴侣', '恋爱', '对象'],
    synonyms: ['恋爱', '单身', '脱单', '分手', '女朋友', '男朋友', '女友', '男友', '对象', '结婚', '离婚', '订婚', '求婚', '复合', '在一起'],
    signals: ['分手', '分了', '脱单', '在一起了', '结婚了', '领证', '离婚', '订婚', '求婚成功', '复合', '表白成功', '恢复单身', '有对象了', '有女朋友了', '有男朋友了', '谈恋爱了'],
    cascade: ['住址'],
  },
  {
    key: '健康', kind: 'state',
    aliases: ['身体', '病', '身体状况', '病情'],
    synonyms: ['生病', '病了', '感冒', '发烧', '住院', '出院', '手术', '胃病', '胃疼', '失眠', '腰疼', '头疼', '牙疼', '吃药', '看病', '康复', '痊愈', '近视', '身体'],
    signals: ['好了', '康复', '痊愈', '出院', '住院', '确诊', '查出', '复发', '加重', '好转', '开始吃药', '停药', '又', '不疼了', '现在'],
    cascade: ['作息', '饮食忌口'],
  },
  {
    key: '作息', kind: 'state',
    aliases: ['睡眠', '起床时间', '睡觉时间', '生活规律'],
    synonyms: ['作息', '起床', '睡觉', '早起', '熬夜', '晚睡', '早睡', '午睡', '夜班', '倒班', '白班', '上班时间', '下班时间', '几点起', '几点睡'],
    signals: ['现在', '改成', '开始', '不再', '调成', '改到', '换成', '以后', '从此'],
    cascade: [],
  },
  {
    key: '饮品偏好', kind: 'value',
    aliases: ['饮品', '饮料', '喝的', '爱喝', '喝什么', '咖啡', '茶'],
    synonyms: ['只喝', '爱喝', '改喝', '喜欢喝', '常喝', '天天喝', '每天喝', '开始喝', '喝回', '咖啡', '美式', '拿铁', '奶茶', '乌龙茶', '柠檬茶', '绿茶', '红茶', '豆浆', '果汁', '可乐', '啤酒'],
    // 不收“最近”“现在”：“最近喝了很多水”“现在在喝咖啡”不是换了口味（世界里的“最近只喝……”靠“只喝”认）
    signals: ['只喝', '改喝', '爱上', '迷上', '喝回', '换成', '改成', '开始喝', '戒了', '不喝了', '不再', '又喝'],
    cascade: [],
  },
  {
    key: '饮食忌口', kind: 'state',
    aliases: ['忌口', '不吃', '过敏', '饮食', '口味', '吃素'],
    synonyms: ['忌口', '不吃', '不能吃', '过敏', '吃素', '素食', '戒糖', '控糖', '减肥餐', '清真'],
    signals: ['开始', '不再', '戒了', '现在', '改成', '又能', '不能吃了', '查出'],
    cascade: [],
  },
  {
    key: '爱好', kind: 'state',
    aliases: ['兴趣', '兴趣爱好'],
    synonyms: ['爱好', '兴趣', '追剧', '打游戏', '游戏', '画画', '钓鱼', '摄影', '拍照', '吉他', '钢琴', '看书', '读书', '拼图', '乐高', '手工', '做饭', '烘焙', '露营'],
    signals: ['迷上', '喜欢上', '爱上', '入坑', '退坑', '开始', '不玩了', '不再', '又', '在学', '学了'],
    cascade: [],
  },
  {
    // 按值型处理（“最近开始攀岩 → 跑步”算变化）；同时练好几样的人可能被误判
    key: '运动', kind: 'value',
    aliases: ['健身', '锻炼', '体育', '练什么'],
    synonyms: ['运动', '健身', '锻炼', '跑步', '游泳', '羽毛球', '篮球', '足球', '网球', '乒乓球', '骑行', '攀岩', '瑜伽', '普拉提', '爬山', '徒步', '撸铁', '拳击', '滑板', '滑雪', '跳绳'],
    signals: ['开始', '迷上', '爱上', '改练', '换成', '改成', '不再', '不跑了', '不练了', '不打了', '在学', '学了', '开始学', '报了', '入坑'],
    cascade: ['作息'],
  },
  {
    key: '车', kind: 'value',
    aliases: ['汽车', '车子', '座驾', '开什么车'],
    synonyms: ['汽车', '新车', '买车', '买了车', '提车', '换车', '卖车', '电车', '油车', '一辆', '辆车', '比亚迪', '特斯拉', '宝马', '奔驰', '丰田', '本田'],
    signals: ['买了', '提车', '提了', '换车', '换了', '新买', '卖了', '卖掉', '入手', '换成'],
    cascade: ['通勤'],
  },
  {
    key: '学业', kind: 'state',
    aliases: ['学校', '专业', '学历', '上学', '大学'],
    synonyms: ['学业', '学校', '大学', '研究生', '读研', '考研', '读博', '博士', '本科', '毕业', '专业', '课程', '论文', '学位', '留学', '上课', '考试'],
    signals: ['考上', '毕业', '入学', '开学', '转专业', '换专业', '退学', '休学', '读研', '上岸', '录取', '开始', '现在'],
    cascade: ['住址', '作息'],
  },
  {
    key: '家人近况', kind: 'state',
    aliases: ['家人', '家里', '家里人', '父母', '爸妈', '亲人'],
    synonyms: FAMILY,
    signals: ['住院', '出院', '生病', '病了', '退休', '搬', '结婚', '生了', '怀孕', '去世', '走了', '考上', '毕业', '现在', '开始', '换了'],
    cascade: [],
  },
  {
    key: '称呼', kind: 'value',
    aliases: ['名字', '昵称', '外号', '小名', '叫法', '怎么叫'],
    synonyms: ['称呼', '叫他', '叫我', '叫她', '喊他', '喊我', '喊她', '昵称', '外号', '小名', '网名', '改名'],
    signals: ['改叫', '以后叫', '别叫', '不要叫', '不用叫', '换成', '改成', '现在叫', '改名', '不再叫'],
    cascade: [],
  },
  {
    key: '生日', kind: 'value',
    aliases: ['出生日期', '生辰', '出生'],
    synonyms: ['生日', '出生'],
    // 生日不会变，会变的是“记错了”
    signals: ['其实是', '记错', '搞错', '弄错', '更正', '纠正', '改成', '应该是'],
    cascade: [],
  },
  {
    key: '联系方式', kind: 'value',
    aliases: ['电话', '手机号', '微信', '邮箱', '号码', '联系'],
    synonyms: ['联系方式', '手机号', '电话号码', '电话号', '号码', '微信号', '邮箱', 'qq号'],
    signals: ['换了', '换成', '改成', '新号', '新的', '现在是', '不用了', '停用', '注销'],
    cascade: [],
  },
  {
    key: '体检', kind: 'state',
    aliases: ['体检结果', '检查结果', '体检报告'],
    synonyms: ['体检', '体检报告', '检查报告', '检查结果', '指标', '化验'],
    signals: ['结果出来', '出结果', '出来了', '查出', '正常', '偏高', '偏低', '异常', '复查'],
    cascade: ['健康'],
  },
  {
    key: '搬家计划', kind: 'state', planning: true,
    aliases: ['搬家打算'],
    // 和住址共用“搬到 / 搬去”：住址排在前面，已经搬了的归住址；只有带“打算 / 准备 / 下个月……”（住址不认）时才落到这里
    synonyms: ['打算搬', '准备搬', '想搬', '要搬', '计划搬', '搬家计划', '看房', '找房', '搬到', '搬去', '搬家'],
    unless: PLACE_NOT_HOME,
    signals: ['打算', '准备', '计划', '想', '要搬', '看房', '找房', '签了'],
    cascade: [],
  },
]

/** 封闭键名 */
export const SLOT_KEYS: readonly string[] = SLOTS.map((s) => s.key)
/** 开放键：她写“其它:<≤6 字>”，归一不了就原样存 */
export const OPEN_SLOT = '其它:'
export const OPEN_SLOT_MAX = 6

const BY_KEY = new Map(SLOTS.map((s) => [s.key, s]))
/** 封闭键的定义；开放键（其它:xxx）返回 undefined */
export const slotDef = (key: string | null | undefined): SlotDef | undefined => (key ? BY_KEY.get(key) : undefined)

/** 问的是“以前 / 变了没”（notice.ts 的 historyCue 也用这个）：失效的旧条在这类问题下不往后排 */
export const HISTORY_CUE = /以前|原来|之前|最早|一开始|上次|后来|变了|换了|还是|改了/

/** 失效条渲染时的后缀：（已过期：MM-DD 起不再是这样） */
export const expiredNote = (validTo: string) => `（已过期：${validTo.slice(5, 10)} 起不再是这样）`

function byName(label: string): string | undefined {
  const l = label.toLowerCase()
  if (BY_KEY.has(label)) return label
  for (const s of SLOTS) if (s.aliases?.some((a) => a.toLowerCase() === l)) return s.key
  for (const s of SLOTS) if (s.synonyms.some((a) => a.toLowerCase() === l)) return s.key
  for (const s of SLOTS) if (label.includes(s.key)) return s.key
  return undefined
}

/**
 * 她写的键 → 封闭键（键名、别称、同义词都认；“【住址】”“住处”“城市”→ 住址）。
 * 归一不了：6 字以内原样存成“其它:xxx”；超长或空的返回 undefined（由调用方拒绝并说明）。
 */
export function normalizeSlot(s: unknown): string | undefined {
  const raw = String(s ?? '').trim().replace(/^[【[]\s*/, '').replace(/\s*[】\]]$/, '').trim()
  if (!raw) return undefined
  const m = /^(?:其它|其他)\s*[:：]\s*(.*)$/s.exec(raw)
  const label = (m ? m[1]! : raw).replace(/\s+/g, '')
  if (!label) return undefined
  const hit = byName(label)
  if (hit) return hit
  return [...label].length <= OPEN_SLOT_MAX ? OPEN_SLOT + label : undefined
}

// ---------- 高精度词法 ----------

/** 在讲过去（含转述以前说过的：“9 月他说的是搬到成都”“他 8 月 19 日才搬到苏州”） */
const RETRO = /以前|之前|原来|原先|曾经|过去|当时|那时|那会儿|早先|一开始|最早|小时候|说过|说的是|提过|还说是|\d\s*[日号]\s*才|[天周月年]前才|上周才|上个月才|去年才/g
/** 说的是现在（把前面“以前……”的范围断开） */
const PRESENT = /现在|如今|目前|这次|今天|最近|从此|以后|往后|后来|终于|已经/g
/** 还没发生 / 拿不准 */
const FUTURE = /打算|准备|计划|考虑|想|可能|也许|如果|要是|万一|假如|下个?月|下周|下礼拜|明年|明天|后天|过段时间|过阵子|过几天|将来|快要|将要|就要|要搬|要换|要去|是不是/g
/** 伴侣（恋爱状态自己的词） */
const PARTNER = /女朋友|男朋友|女友|男友|对象|老婆|老公|媳妇|爱人|伴侣|未婚妻|未婚夫/g
/** 别人（亲友、同事……、听说的消息）：小句里有这些，就不是在说主人自己的住址 / 工作 / 通勤 */
const OTHER = /听说|据说|[我他她]的?[哥姐弟妹]|妈|爸|母亲|父亲|爷爷|奶奶|姥姥|姥爷|外公|外婆|哥哥|姐姐|弟弟|妹妹|表[哥姐弟妹]|堂[哥姐弟妹]|舅|姨|叔|婶|姑|伯|儿子|女儿|孩子|同事|领导|老板|上司|室友|同学|朋友|邻居|闺蜜|兄弟|师傅|老师|房东|家人|亲戚|岳父|岳母|公公|婆婆/

/**
 * 小句（逗号分开）+ 同一句里它前面的部分（prior，看主语用：“他表哥，换了辆特斯拉”）。
 * 括号里的单独算一句（“现在坐地铁上班（以前开车）”的主句照常认）。
 */
function clauses(content: string): Array<{ c: string; prior: string }> {
  const out: Array<{ c: string; prior: string }> = []
  const t = content.toLowerCase().replace(/[（(]([^（）()]*)[）)]/g, '。$1。')
  for (const sent of t.split(/[。！？!?；;\n]+/)) {
    let prior = ''
    for (const raw of sent.split(/[，,]+/)) {
      const c = raw.trim()
      if (c) out.push({ c, prior })
      prior += raw + '，'
    }
  }
  return out
}

type Mark = { at: number; end: number; kind: 'retro' | 'present' | 'future' }
function marks(c: string): Mark[] {
  const out: Mark[] = []
  for (const [re, kind] of [[RETRO, 'retro'], [PRESENT, 'present'], [FUTURE, 'future']] as const) {
    re.lastIndex = 0
    for (const m of c.matchAll(re)) out.push({ at: m.index, end: m.index + m[0].length, kind })
  }
  return out.sort((a, b) => a.end - b.end)
}

const PRESENT_WORD = new RegExp(`^(?:${PRESENT.source})$`)

/** 这个信号词在小句里有没有一处“算数”的出现（不在讲过去、不是还没发生、没被“没 / 不”否定） */
function validSignal(c: string, sig: string, ms: Mark[], planning: boolean): boolean {
  const s = sig.toLowerCase()
  for (let p = c.indexOf(s); p >= 0; p = c.indexOf(s, p + 1)) {
    const before = c.slice(Math.max(0, p - 2), p)
    if (/[没未不别]/.test(before) && !/^[不别没]/.test(s)) continue
    // 信号词本身就是“现在”这类词：直接算
    if (PRESENT_WORD.test(s)) return true
    const last = ms.filter((m) => m.end <= p && m.at < p).pop()
    if (last?.kind === 'retro') continue
    if (last?.kind === 'future' && !planning) continue
    return true
  }
  return false
}

function longestHit(c: string, words: readonly string[]): number {
  let best = 0
  for (const w of words) {
    const n = [...w].length
    if (n > best && c.includes(w.toLowerCase())) best = n
  }
  return best
}

const HAS_PARTNER = new RegExp(PARTNER.source)

/** 这个小句能说哪些键（别人 / 伴侣的守卫看这个小句和同一句里它前面的部分；问句不算） */
function allowedIn(c: string, s: SlotDef, prior = ''): boolean {
  // 问句、或者说的正是不知道的那部分（“没说搬到哪儿”）
  if (/[吗么]$/.test(c) || /哪|什么|多少/.test(c)) return false
  const scope = prior + c
  const partner = HAS_PARTNER.test(scope)
  const other = OTHER.test(scope.replace(PARTNER, ''))
  if (other && s.key !== '家人近况') return false
  if (partner && s.key !== '恋爱状态' && s.key !== '家人近况') return false
  if (s.needs && !s.needs.some((w) => c.includes(w))) return false
  if (s.unless?.some((w) => c.includes(w))) return false
  return true
}

/**
 * 高精度词法：同一个小句里同时有某个键的同义词**和**变化信号词，才返回那个键；否则 undefined。
 * 好几个小句都像时取第一个（主句一般在前）；同一小句里好几个键都像时，取同义词最长的（“手机号”胜过“手机”），一样长按表里的顺序。
 * keys：只在这些键里找（默认全部封闭键）。
 */
export function detectSlot(content: string, keys?: readonly string[]): string | undefined {
  const allow = keys ? new Set(keys) : undefined
  for (const { c, prior } of clauses(content)) {
    const ms = marks(c)
    let best: { key: string; score: number } | undefined
    for (const s of SLOTS) {
      if (allow && !allow.has(s.key)) continue
      const score = longestHit(c, s.synonyms)
      if (!score || (best && score <= best.score)) continue
      if (!allowedIn(c, s, prior)) continue
      if (!s.signals.some((sig) => validSignal(c, sig, ms, !!s.planning))) continue
      best = { key: s.key, score }
    }
    if (best) return best.key
  }
  return undefined
}

/** 正文里有没有这个键的变化信号词（和同义词同一小句） */
export const changeSignal = (content: string, key: string) => detectSlot(content, [key]) === key

/** 正文像不像在说这个键（只看同义词，不要信号词；别人 / 伴侣的守卫照旧）。夜间级联候选用：没标键的旧条也能列出来给她看 */
export function slotMentioned(content: string, key: string): boolean {
  const s = slotDef(key)
  if (!s) return false
  return clauses(content).some(({ c, prior }) => longestHit(c, s.synonyms) > 0 && allowedIn(c, s, prior))
}

/**
 * 这条可能是哪几件会变的事（最多 3 个）：只看同义词（不要信号词），她写的同义键（keys，开关 S）也一起看；
 * 这个人已经有的键（existing）排前面。给工具的返回消息用（她写的键归一不了时，告诉她像哪几个）。
 */
export function slotCandidates(content: string, keys: readonly string[] = [], existing: readonly string[] = []): string[] {
  const text = [content, ...keys].join('，')
  const cs = clauses(text)
  const scored: Array<{ key: string; score: number; mine: boolean; order: number }> = []
  SLOTS.forEach((s, order) => {
    let score = 0
    for (const { c, prior } of cs) if (allowedIn(c, s, prior)) score = Math.max(score, longestHit(c, s.synonyms))
    if (score > 0) scored.push({ key: s.key, score, mine: existing.includes(s.key), order })
  })
  return scored
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.score - a.score || a.order - b.order)
    .slice(0, 3)
    .map((x) => x.key)
}
