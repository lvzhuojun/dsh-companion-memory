#!/usr/bin/env node
// 防泄露扫描：实例数据（日记、记忆库、种子、会话、密钥、服务器地址、账号等）永不入库。
//
//   node scripts/scan-instance.mjs --staged   只扫暂存区（pre-commit 钩子用）
//   node scripts/scan-instance.mjs --all      扫所有会入库的文件（CI、首次推送前用）
//
// 三类检查：
//   1. 路径：私有目录与她的文件（即使被 git add -f 强行加入也拦）
//   2. 通用模式：公网 IP、各类密钥、DSH 会话 id、QQ 号
//   3. 私有清单：private/instance-patterns.txt（不入库），每行一个字面量，如服务器 IP、QQ 号
//
// 只报 文件:行号 和规则名，**从不打印命中的内容**（诊断输出不得带出令牌）。
// 某行确属误报时，在该行加注释 `scan:allow` 放行。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const mode = process.argv.includes('--staged') ? 'staged' : 'all'

const BLOCKED_PATHS = [
  [/^private\//, '私有目录 private/'],
  [/(^|\/)(life|instance|sessions|storages)\//, '实例数据目录'],
  [/(^|\/)diary\//, '日记'],
  [/(^|\/)proposals\//, 'self.md 修改提案'],
  [/(^|\/)(self|seed)\.md$/, 'self.md / seed.md 实例'],
  [/\.(db|sqlite3?|jsonl|jsonl\.zst)$/, '数据库或会话日志'],
  [/(^|\/)\.env(\.|$)|\.(key|pem)$|(^|\/)\.?credentials/, '密钥文件'],
]

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^255\./]

const CONTENT_RULES = [
  ['公网 IPv4', /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g, (m) => {
    const ip = m[1]
    return ip.split('.').every((n) => Number(n) <= 255) && !PRIVATE_V4.some((r) => r.test(ip))
  }],
  ['API Key（sk-）', /\bsk-[A-Za-z0-9]{20,}/g],
  ['GitHub 令牌', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['腾讯云 SecretId', /\bAKID[A-Za-z0-9]{13,}/g],
  ['DSH 会话 id', /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g],
  ['QQ 号', /QQ\s*(号|号码)?\s*[:：=]?\s*[1-9]\d{4,10}(?!\d)/gi],
  ['URL 中的令牌', /[?&](token|access_token|key|secret)=[A-Za-z0-9._~%-]{12,}/gi],
]

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function listFiles() {
  const out = mode === 'staged'
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    : git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  return out.split('\0').filter(Boolean)
}

function readContent(file) {
  if (mode === 'staged') {
    return execFileSync('git', ['show', `:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  }
  const p = join(ROOT, file)
  return existsSync(p) ? readFileSync(p) : null
}

function loadPrivateLiterals() {
  const p = join(ROOT, 'private', 'instance-patterns.txt')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const literals = loadPrivateLiterals()
const findings = []

for (const file of listFiles()) {
  for (const [re, why] of BLOCKED_PATHS) {
    if (re.test(file)) findings.push(`${file}  [路径] ${why}`)
  }
  if (file === 'package-lock.json') continue
  const buf = readContent(file)
  if (!buf || buf.includes(0)) continue // 跳过二进制
  const lines = buf.toString('utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.includes('scan:allow')) return
    for (const [rule, re, accept] of CONTENT_RULES) {
      for (const m of line.matchAll(re)) {
        if (!accept || accept(m)) {
          findings.push(`${file}:${i + 1}  [内容] ${rule}`)
          break
        }
      }
    }
    if (literals) {
      for (let k = 0; k < literals.length; k++) {
        if (line.includes(literals[k])) findings.push(`${file}:${i + 1}  [私有清单] 第 ${k + 1} 条`)
      }
    }
  })
}

// 提交身份（作者/提交者邮箱）也会随仓库公开，同样检查
if (mode === 'staged') {
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = git(['var', v])
    if (CONTENT_RULES.some(([, re]) => new RegExp(re.source, re.flags).test(ident)) ||
        (literals && literals.some((l) => ident.includes(l)))) {
      findings.push(`git ${v}  [提交身份] 含实例信息，请为本仓库改用 GitHub noreply 邮箱`)
    }
  }
}

if (!literals) {
  console.error('提示：没有 private/instance-patterns.txt，只做了通用检查（CI 上属正常）。')
}

if (findings.length > 0) {
  console.error(`✗ 发现 ${findings.length} 处可能的实例信息/密钥（只列位置，不打印内容）：`)
  for (const f of findings) console.error('  ' + f)
  console.error('确认是误报的行，加注释 scan:allow 放行；否则请移除后再提交。')
  process.exit(1)
}
console.error(`✓ 扫描通过（${mode === 'staged' ? '暂存区' : '全部待入库文件'}）`)
