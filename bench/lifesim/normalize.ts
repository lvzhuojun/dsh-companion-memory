// 判分前的归一：完整档里她说话更自然，日期常用中文数字（“八月二十五号”“十月十一号”），
// 学校常说简称（“浙大”）——标准答案只认“8月25日”“浙江大学”，判成了错（种子 1 完整档 L1-052 / 049 / 011 / 030）。
// 判分错就是对所有系统不公平：在判分前把中文数字换成阿拉伯数字，并认常见的简称。

const DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 一到九十九的中文数字 → 数字；不是就返回 undefined */
export function cnNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? DIGIT[m[1]]! : 1) * 10 + (m[2] ? DIGIT[m[2]]! : 0)
  if (s.length === 1 && DIGIT[s] !== undefined) return DIGIT[s]
  return undefined
}

const CN = '[〇零一二两三四五六七八九十]{1,3}'

/** “十月十一号”→“10月11号”、“八月二十五日”→“8月25日”、“一月二十七”→“1月27” */
export function normalizeDates(text: string): string {
  return text.replace(new RegExp(`(${CN}|\\d{1,2})月(${CN}|\\d{1,2})(号|日)?`, 'g'), (all, mo: string, d: string, suf: string | undefined) => {
    const a = cnNumber(mo)
    const b = cnNumber(d)
    return a !== undefined && b !== undefined && a >= 1 && a <= 12 && b >= 1 && b <= 31 ? `${a}月${b}${suf ?? ''}` : all
  })
}

/** 常见简称 → 全称（只用于判分：回答里出现简称，也算提到了全称） */
const ALIAS: Record<string, string[]> = {
  浙江大学: ['浙大'], 武汉大学: ['武大'], 四川大学: ['川大'], 中南大学: ['中南'],
}

export function normalizeReply(text: string): string {
  let t = normalizeDates(text)
  // “1月27号”也算提到了“1月27日”（标准答案有的只写了“日”：种子 1 快速档 L1-028 / 029 生日题被判错）
  for (const m of t.matchAll(/(\d{1,2})月(\d{1,2})号/g)) if (!t.includes(`${m[1]}月${m[2]}日`)) t += `（${m[1]}月${m[2]}日）`
  for (const [full, shorts] of Object.entries(ALIAS)) for (const s of shorts) if (t.includes(s) && !t.includes(full)) t += `（${full}）`
  return t
}
