# 清平文坊 · 管理员手册（拿到服务器后 30 分钟上线）

> 面向没有运维经验的人。每一步都给可以直接抄的命令。
> 系统假设：阿里云轻量服务器·香港，Linux（Debian/Ubuntu）。买的时候选 **Debian 12** 最省事。
> 【未验证】部分 = 本机没条件实测、明早按此执行时留意的步骤。

## 明早你要做的事（按顺序，约 10 分钟）
1. **抢服务器**：阿里云轻量·香港，选 2核4G 最长可领时长，系统选 Debian 12。
2. **充值模型账户**：⚠ 必做，当前上游账户余额是**负数**，内测用户会全程调不动模型。充值地址在管理员知道的上游后台（充值后余额 > 0 即可）。
3. **把服务器 IP 和 root 密码发给我**（或者你自己按下面步骤贴命令）。
4. （可选）把宣传片发朋友：成片在 `memory/promo-video/out/promo-v2.mp4`。
5. （可选）有域名就一起给我，可以开 HTTPS；没有就先用 `http://IP` 明文跑内测。

## 第 1 步：登录服务器（2 分钟）
阿里云控制台 → 轻量应用服务器 → 远程连接（网页终端就行），或者本地 PowerShell：
```
ssh root@<服务器IP>
```

## 第 2 步：上传代码（5 分钟）
【未验证】两种方式任选：
- 阿里云网页终端上方有「上传文件」，把打包好的 `workshop.zip` 传上去再解压；
- 本地 PowerShell 跑：`scp workshop.zip root@<服务器IP>:/opt/`

服务器上执行：
```
mkdir -p /opt/qingping && cd /opt/qingping
apt-get update && apt-get install -y unzip
unzip /opt/workshop.zip -d /opt/qingping/
# 结果应该是 /opt/qingping/workshop/{server.mjs,lib,ui,deploy,...}
```

## 第 3 步：一键安装（5 分钟）
```
bash /opt/qingping/workshop/deploy/install-linux.sh
```
它会装 Node 和 Caddy、建目录、装 systemd 模板。最后会提醒你两件事，照做：
1. **填档位映射**：`nano /opt/qingping/workshop/deploy/admin-tiers.json`（模板见 deploy/README.md；模型名和上游地址问我要，别发到群里）
2. **填模型密钥**：`nano /opt/qingping/workshop/projects/.env`，格式就是 `变量名=密钥`，一行一个。填完 `chmod 600` 那个文件。

## 第 4 步：开第一个用户（3 分钟）
```
cd /opt/qingping/workshop/deploy
node add-user.mjs zhangsan --budget 3 --days 7
```
屏幕上会打印一张**账号卡**（地址/用户名/密码），密码只显示这一次——直接截图发给朋友。
发出去之前自己先测一遍：把账号卡里的地址换成 `http://<服务器IP>/zhangsan/`，浏览器登录，随便输一句话点「帮我出 3 个开书方案」，能出方案就通了。

## 第 5 步：启动与访问（3 分钟）
```
node gen-caddy.mjs            # 生成登录配置（每用户一个专属地址+密码）
cp Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
for u in env/*.env; do n=$(basename $u .env); systemctl enable --now qingping@$n; done
```
以后每个朋友都是同一套：`node add-user.mjs <名字>` → `node gen-caddy.mjs && systemctl reload caddy` → `systemctl enable --now qingping@<名字>` → 把账号卡发给他。

## 日常三件事
**看谁花了多少：**
```
node status-all.mjs                      # 进程、额度、到期一眼看全
node reconcile.mjs --csv 对账.csv        # 每人成本与建议应收（成本×1.3）
```
**换模型映射（只有你能改，用户看不到）：**
```
nano admin-tiers.json                    # 改档位对应的真实模型
for u in env/*.env; do systemctl restart qingping@$(basename $u .env); done   # 生效（改映射不需重装；systemctl 不支持通配符，所以逐个重启）
```
**停用某人 / 调额度 / 续期：**
```
node ctl-user.mjs zhangsan --disable     # 停用
node ctl-user.mjs zhangsan --budget 5    # 改额度（改完重启该用户进程）
node ctl-user.mjs zhangsan --days 30     # 续期
node ctl-user.mjs zhangsan --reset-pw    # 重置密码（只显示一次）
```

## 出问题怎么回滚
- 代码改坏了：`git -C /opt/qingping checkout -- .` 回到上一次提交；没提交过就先从本机把仓库重新上传，再跑第 5 步。
- 某个用户进程死了：`systemctl restart qingping@<名字>`。
- Caddy 挂了整站进不去：`journalctl -u caddy -n 50` 看报错；改错 Caddyfile 就把 `/etc/caddy/Caddyfile` 恢复成 `node gen-caddy.mjs` 刚生成的那份。

## 已知限制（对朋友不用讲，你自己知道就行）
1. **上游账户余额不足时所有 AI 动作都会失败**——页面会显示人话报错，稿件不丢。这是明早必充值的原因。
2. **封面在 Linux 上只出生图原图，不压书名/笔名**：压字用的是 Windows 的图形库，Linux 上自动降级（原图照常生成并可下载，页面不报错，封面记录里标了「未压字」）。以后用 Node 图形库补（P2）。
   榜单参照库和爆款语料库只在本机有：服务器上缺失时自动降级（包装编辑少了「对标爆款」参照，写章少了风格范例），功能不报错。
6. **智能代理（Beta）**：每个用户在「写正文」页自己打开开关，默认关；代理只在用户确认计划后才跑，随时可暂停/中止/引导，做完自动停，受用户自己的额度约束。
3. **没有域名 = http 明文**，密码在传输中可见。内测、熟人可接受；正式对外前买个域名（几十块/年），把 `node gen-caddy.mjs example.com` 生成的配置换上就自动 HTTPS。
4. 【未验证】scp/网页上传、阿里云 Debian 上的 apt 源、systemd 模板加载——本机是 Windows，这三步没在真机跑过，出问题把报错发我。
5. 一个人一个进程，实测常驻内存约 65MB，4G 机器开 10-20 个账号没问题。

## 账号安全
- `admin-tiers.json` 和 `projects/.env` 权限 600，只有 root 能读。
- 用户只能看到自己的书（已测试隔离）；模型页、模型接口对用户一律 403（已测试）。
- 用户看到的所有页面和报错都不会出现模型和供应商名（已测试 0 命中）。
