// ulib.mjs —— 部署脚本共享工具（零依赖）。users.json 是唯一台账。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

export const DEPLOY = path.dirname(fileURLToPath(import.meta.url))
export const WORKSHOP = process.env.QP_WORKSHOP || path.resolve(DEPLOY, '..') // 测试时可覆盖指向真实 workshop
export const USERS_JSON = path.join(DEPLOY, 'users.json')
export const ENV_DIR = path.join(DEPLOY, 'env')

export function loadUsers() {
  if (!fs.existsSync(USERS_JSON)) return { portBase: 4601, usersDir: 'users', users: {} }
  return JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'))
}
export function saveUsers(db) {
  fs.writeFileSync(USERS_JSON + '.tmp', JSON.stringify(db, null, 2), 'utf8')
  fs.renameSync(USERS_JSON + '.tmp', USERS_JSON)
}
export const userDir = (db, name) => path.join(DEPLOY, db.usersDir || 'users', name)

/** 不含易混字符（0/O、1/l/I）的强随机密码 */
export function genPassword(len = 12) {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789'
  const b = crypto.randomBytes(len)
  return Array.from(b, (x) => A[x % A.length]).join('')
}

/** Caddy basic_auth 用 bcrypt；有 caddy 就用它的 hash-password（服务器上一定有），没有就退回明文并标记 */
export function hashPassword(pw) {
  for (const args of [['hash-password', '--plaintext', pw], ['hash-password', '-p', pw]]) {
    const r = spawnSync('caddy', args, { encoding: 'utf8' }) // 不用 shell：避免拼接注入告警（DEP0190）
    if (r.status === 0 && (r.stdout || '').trim().startsWith('$2')) return r.stdout.trim()
  }
  return 'plain:' + pw // 回退：Caddyfile 生成时会提醒替换成哈希
}

/** 每用户一份 env 文件（systemd EnvironmentFile 与 start-all.mjs 共用） */
export function writeEnvFile(name, env) {
  fs.mkdirSync(ENV_DIR, { recursive: true })
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  fs.writeFileSync(path.join(ENV_DIR, name + '.env'), body, 'utf8')
}
export function readEnvFile(name) {
  const f = path.join(ENV_DIR, name + '.env')
  if (!fs.existsSync(f)) return {}
  const env = {}
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

export const isRunning = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
