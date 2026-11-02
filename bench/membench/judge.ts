// LLM 评委。两种口径都报：
//   lenient：仿 mem0 论文的 J 分评委思路（“和标准答案说的是同一件事 / 同一个时间就算对”）——为了和别人发表的数字对得上；
//            措辞是按其公开思路重写的，**不是逐字复制**（待和 mem0 仓库的原提示逐字核对后再标“同口径”）
//   strict：必须包含标准答案的关键信息（精度不能低于标准答案），且没有与之矛盾的内容；说“不记得”、含糊、给多个选项算错。
//           （第一版还要求“不编造标准答案之外的细节”——评委看不到聊天记录，把真实的补充细节也判成编造，试跑里单跳题宽松 100%、严格 0%，2026-10-29 改）
// 对抗题（LoCoMo 第 5 类，不可回答）：不用评委，单独判“有没有拒答 / 没有顺着编”。
import type { ModelClient } from '../p0/run.js'

export type JudgeMode = 'lenient' | 'strict'

const LENIENT = `你要判断一个回答对不对，只输出 CORRECT 或 WRONG。
给你：(1) 一个问题（一个人问另一个人关于他们以前聊过的事）；(2) 标准答案；(3) 待判的回答。
标准答案通常很短。待判的回答可能更长、换了说法，只要它说的和标准答案是同一件事，就算 CORRECT。
时间类问题：只要指向的是同一个日期 / 月份 / 年份 / 时间段（哪怕用了“上周二”这类相对说法，按对话时间换算后一致），就算 CORRECT。
先用一句话说理由，最后一行只写 CORRECT 或 WRONG。`

const STRICT = `你要严格判断一个回答对不对，只输出 CORRECT 或 WRONG。
给你：(1) 一个问题；(2) 标准答案；(3) 待判的回答。
CORRECT 必须同时满足：回答里明确包含标准答案的关键信息（时间题要具体到标准答案的精度：标准答案是某一天，回答只说到月份就不够）；回答里没有与标准答案矛盾的内容。
回答多说了一些别的细节没关系（你看不到聊天记录，判断不了那些细节真假，不因此判错）；回答换了语言、换了说法也没关系。
回答说“不记得 / 不知道”、含糊其辞（“大概是一月吧”而标准答案是具体某天）、或者给了好几个可能让人去选，都算 WRONG。
先用一句话说理由，最后一行只写 CORRECT 或 WRONG。`

export async function judge(model: ModelClient, mode: JudgeMode, q: { ask: string; gold: string; reply: string }): Promise<boolean> {
  const r = await model.complete({
    system: mode === 'lenient' ? LENIENT : STRICT,
    messages: [{ role: 'user', content: `问题：${q.ask}\n标准答案：${q.gold}\n待判的回答：${q.reply}` }],
    tools: [],
  })
  const text = r.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('').trim()
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  return /CORRECT/.test(last) && !/WRONG/.test(last)
}

/** 对抗题（不可回答）：拒答 / 指出没提过就算对；给了具体答案算顺着编 */
const REFUSE = /不知道|不记得|不太记得|没(有)?(提|说|聊)(过|到)|没印象|不清楚|不确定|无法确定|not (mentioned|sure)|don'?t (know|recall|remember)|no (information|mention)/i
export const refused = (reply: string) => REFUSE.test(reply)
