# deploy/ —— 清平文坊内测部署包（2026-10-02）

> 架构：一人一进程。每个用户一个工坊 Node 进程（各自沙箱目录、各自额度），前面 Caddy 做登录（basic_auth）与按用户转发。
> 没有域名时用 IP+端口 http；有域名后 Caddy 自动 HTTPS。
> 全部脚本零 npm 依赖（Node 内置模块），服务器上只需 Node 18+ 与 Caddy。

## 文件清单
| 文件 | 用途 |
|---|---|
| `users.json` | 用户清单（add-user.mjs 维护；含端口/额度/到期/密码哈希） |
| `add-user.mjs` | 开户：建沙箱、分端口、设额度和到期、生成随机密码（只显示一次）、输出发给用户的账号卡 |
| `ctl-user.mjs` | 停用/启用/调额度/续期：`node ctl-user.mjs <用户名> --disable\|--enable\|--budget 5\|--days 30` |
| `start-all.mjs` / `stop-all.mjs` / `status-all.mjs` | 批量起停与状态（Windows/Linux 通用） |
| `gen-caddy.mjs` | 从 users.json 生成 Caddyfile |
| `reconcile.mjs` | 对账：各用户 calls.ndjson → 消耗与建议应收（系数可配） |
| `qingping@.service` | systemd 模板（Linux） |
| `install-linux.sh` | Linux 一键安装（Node/Caddy/目录/权限），未在真机验证的步骤在 README 里标了「未验证」 |
| `start-all.cmd` / `stop-all.cmd` | Windows 起停 |
| `README-管理员.md` | 白话手册：拿到服务器 IP 后 30 分钟上线 |

## 服务端进程接口（与 workshop 代码约定，勿改名）
`WORKSHOP_SANDBOX`（沙箱目录）`WORKSHOP_PORT`（端口）`WORKSHOP_BUDGET`（额度元）`WORKSHOP_EXPIRES`（ISO 到期）`WORKSHOP_MODE=customer`（用户模式）`WORKSHOP_ADMIN_CONFIG`（档位映射 JSON，用户沙箱之外，权限 600）。

## 档位映射模板（服务器上的 admin-tiers.json 示例，密钥只写环境变量名）
```json
{
  "priceFactor": 1.3,
  "tiers": {
    "fast":   { "label": "快写档", "model": "<便宜档模型>", "baseUrl": "<上游地址>", "keyEnv": "LMUAI_CUST_CN_API_KEY",    "priceIn": 1,  "priceOut": 2,   "enabled": true },
    "refine": { "label": "精修档", "model": "<中档模型>",   "baseUrl": "<上游地址>", "keyEnv": "LMUAI_CUST_CLAUDE_API_KEY", "priceIn": 21, "priceOut": 105, "enabled": true },
    "master": { "label": "大师档", "model": "<旗舰模型>",   "baseUrl": "<上游地址>", "keyEnv": "LMUAI_CUST_CLAUDE_API_KEY", "priceIn": 21, "priceOut": 105, "enabled": false }
  }
}
```
真实 baseUrl/模型名是管理端秘密，不在交付文档里出现；服务器上填一次即可。
