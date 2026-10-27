// launcher.mjs —— 托管 server.mjs：工坊代码更新后自动换成新版本，用户不用关黑色窗口重开
// 「start.cmd」启动的是它。server.mjs 发现代码更新、且没有任务在跑时以退出码 75 退出，这里立刻重新拉起。
// 页面每 2 秒轮询状态，后台换版本的几秒内会显示「正在切换到新版本」，换好后自动刷新页面。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESTART_CODE = 75
let crashes = []

function start() {
  const p = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: 'inherit', windowsHide: true, env: { ...process.env, WORKSHOP_SUPERVISED: '1' } })
  p.on('exit', (code) => {
    if (code === RESTART_CODE) return setTimeout(start, 500)
    if (code === 0 || code === null) process.exit(code ?? 0)
    // 新代码有语法错误等：1 分钟内崩 3 次就停下，避免无限重启刷屏
    crashes = [...crashes.filter((t) => Date.now() - t < 60000), Date.now()]
    if (crashes.length >= 3) { console.log('\n工坊后台 1 分钟内连续出错 3 次，已停止自动重启。把上面的报错发给技术负责人。'); process.exit(code) }
    console.log(`\n工坊后台异常退出（代码 ${code}），5 秒后自动重启…`)
    setTimeout(start, 5000)
  })
}
start()
