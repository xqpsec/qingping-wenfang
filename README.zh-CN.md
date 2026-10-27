# Qingping Wenfang · 清平文坊

[![ci](https://github.com/xqpsec/qingping-wenfang/actions/workflows/ci.yml/badge.svg)](https://github.com/xqpsec/qingping-wenfang/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**本地运行的 AI 长篇小说生产线：多模型分工、多候选稿择优、自评改稿、一键导出。**

一句话：你给一个想法，它出开书方案 → 设定集 → 章纲 → 每章写 2~4 个候选版本 → 让另一个模型
成对比较挑出更好的 → 按 10 项指标打分 → 你决定改还是留 → 导出 TXT。

全部跑在你自己机器上，接你自己的模型接口。无账号、无云端、无遥测。

> English: [README.md](README.md) · 使用手册: [docs/使用指南.md](docs/使用指南.md)

---

## 它到底做了什么

```text
想法 ──► 3 个开书方案 ──► 你选一个
                              │
                    设定集 ◄──┘
                    前 N 章章纲
                              │
                ┌─────────────┴──────────────┐
                ▼                            │
      候选稿 1..4（可指派不同模型）           │
                │                            │
      成对择优（前后换位各判一次）            │
                │                            │
      逻辑硬伤自检 + 10 项评分 + 前情伏笔     │
                │                            │
      按意见改写 ──► 润色 ──► 导出 TXT ◄─────┘
```

- **多候选稿**：一章可以由 1~4 个 agent 各写一版，再比较。
- **成对择优**：两版并排给评审模型，换位置再判一次；两次一致才算赢，不一致时退回文体相似度。
- **10 项评分**：开篇抓力、冲突、爽点、脑洞、主角、节奏、对白、网文味、逻辑、章末钩子。
  分数只用于排序和提示，**不代表签约或爆款**。
- **逐环节模型路由**：流水线共 19 个会调模型的环节（开书方案、设定集、章纲、节拍、
  候选稿 1~4、成对评审、逻辑自检、评分、前情摘要、改写、润色、包装……），每个环节可以单独
  指定用哪个模型，便宜活给便宜模型。
- **连续性**：每章结束生成前情摘要与未回收伏笔，带进下一章，避免写着写着忘了自己埋的线。
- **零第三方依赖**：只用 Node 内置模块，没有 `node_modules`、没有构建步骤。
- **本地优先**：只监听 `127.0.0.1`，数据是磁盘上的纯文本，密钥不出本机。

## 环境要求

- Node.js **>= 20**（实测 Node 24）
- 一个或多个 OpenAI 兼容 / Anthropic 兼容的对话接口
  （本地 llama.cpp / vLLM / Ollama 都行）

## 三步开始

```bash
git clone <你的仓库地址> qingping-wenfang
cd qingping-wenfang
node workshop/server.mjs
# 浏览器打开 http://127.0.0.1:4580
```

Windows 也可以直接双击 `start.cmd`；Linux/macOS 用 `./start.sh`。

首次使用，在网页里：

1. 进 **模型配置**：填接口地址和 API Key，点 **测试**，能列出模型就算通。
2. 给 agent 分配模型（最少三个：主笔 writer、便宜档 cheap、评审 judge）。
3. 先建一本小书、只写 2~3 章，读完再决定是否批量。

还没配模型也能启动，网页能打开，只是所有调模型的按钮会报错。

## 配置

### 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `WORKSHOP_PORT` | `4580` | 端口（始终绑定 `127.0.0.1`） |
| `WORKSHOP_ADMIN_TOKEN` | — | 设置后启用管理接口与管理台 |
| `WORKSHOP_ENV_FILE` | `<根>/projects/.env` | `keyEnv` 引用的密钥文件路径 |
| `WORKSHOP_SANDBOX` | — | 切到沙箱目录（测试套件用，零成本） |
| `WORKSHOP_BUDGET` | — | 单次会话花费上限 |
| `WORKSHOP_STREAM_FIRST_MS` / `_IDLE_MS` / `_TOTAL_MS` | `60000` / `60000` / `480000` | 流式看门狗阈值 |
| `WORKSHOP_FORCE_AGENT` | — | 强制所有环节用同一个 agent（排查用） |

### 它会生成哪些文件

```text
workshop/data/agents.json     agent 配置（含 API Key，已 gitignore）
workshop/data/calls.ndjson    调用与用量流水（只追加，已 gitignore）
projects/.env                 可选密钥文件（已 gitignore）
projects/workshop-books/<书名>/
    bible.md  outline.md
    chapters/0001.txt         定稿
    work/0001/                候选稿、场景节拍、评分明细
    history/                  每次修改前的旧版本
projects/genres/<题材>.md     题材规则（可改，下一章生效）
```

`workshop/lib/agents.mjs` 把仓库根解析为 `workshop/..`，所以**移动目录时请保留
`workshop/` 这一层**。

### 可选数据（不放也能跑）

下面这些都不随仓库发布（第三方文本、个人语料），读取处全部有守卫，缺文件只是关掉对应功能：

```text
projects/genres/cards/<风格>.md    额外风格卡 → 出现在风格选择器里
data/knowledge/rank/               爆款库（打包环节用）
data/knowledge/chapters/           离线基线基准脚本用的语料
data/intel/                        短篇流水线用的榜单快照
short/oh-story/                    短篇模块依赖的 oh-story 技能包
```

短篇模块（`workshop/short/`）走独立通道：它读
`<仓库根>/short/oh-story/story-short-write/references/*.md`，并执行该技能包自带的检查脚本。
缺这个包时，相关测试与提示词会打印「未放入 oh-story 技能包」并跳过，不会报错中断。
锚点样本（`WORKSHOP_SHORT_ANCHORS`）同样是可选的：不提供就做无锚点评分。

## 仓库结构

```text
workshop/
  server.mjs          HTTP 服务与 JSON 接口（API 版本 19）
  cli.mjs             无浏览器的命令行流水线
  launcher.mjs        一键启动器
  lib/                流水线、agent、评审、存储、提示词、打包……
  ui/                 index.html（工作台）· admin.html · customer-lab.html
  deploy/             可选的多用户 Linux 部署（systemd / Caddy 模板）
  test*.mjs           测试套件，一个子系统一个文件
  short/              短篇通道（依赖上面的 oh-story 技能包）
scripts/
  ops/humanize.mjs        规则去 AI 味（零模型调用）
  ops/humanize-llm.mjs    模型改写 + 检测器反馈
  tms-aigc.mjs            检测器适配（AIGC 探针）
  tms-robust.mjs          检测器的重试/退避封装
  orca-aigc.mjs           第二个检测器适配（可选）
projects/             你的书（已忽略）
docs/                 使用手册
```

## 命令行

```bash
node workshop/cli.mjs --help        # 不开网页也能跑流水线
node workshop/test.mjs              # 全量测试
node workshop/ui-smoke.mjs          # 无头 UI 冒烟
node workshop/leak-scan.mjs         # 检查产出里是否漏出模型名/供应商名
```

## 多用户部署（可选）

`workshop/deploy/` 里是一套「每个用户一个实例」的模板（systemd 模板服务 + Caddy + 邀请卡 +
按档位计额）。**默认不用**，用之前先读 `workshop/deploy/README.md`，并且清楚自己在什么主机上做。
主程序本身没有登录鉴权，信任本机回环；不要把端口直接暴露到公网。

## 没有随仓库提供的东西

- **语料**：文体相似度基线要用 `workshop/build-baseline.mjs` 从你自己的语料生成，本仓库不含任何第三方文本。
- **密钥**：接口和 Key 自带。
- **发布自动化**：导出就是一个文件，上传/投稿由你自己决定。

## 许可证

MIT，见 [LICENSE](LICENSE)。
