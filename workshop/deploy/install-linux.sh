#!/usr/bin/env bash
# install-linux.sh —— 清平文坊 Linux 一键安装（Debian/Ubuntu 假设；Alibaba Cloud Linux 需把 apt 换成 dnf，未验证）
# 用法：上传整个 workshop 目录到 /opt/qingping/workshop 后执行：
#   sudo bash /opt/qingping/workshop/deploy/install-linux.sh
set -euo pipefail

echo "1/6 安装 Node.js（已有则跳过）"
if ! command -v node >/dev/null; then
  apt-get update && apt-get install -y nodejs npm || { echo "apt 装 node 失败；请手动装 Node 18+"; exit 1; }
fi
node -v
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node 版本太旧（$(node -v)），需要 18 或更高。请先升级 Node 再重新运行本脚本"; exit 1; fi

echo "2/6 安装 Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update && apt-get install -y caddy
fi
caddy version

echo "3/6 目录与权限"
mkdir -p /opt/qingping/workshop/deploy/env /opt/qingping/workshop/deploy/users
chmod 700 /opt/qingping/workshop/deploy/env
# 管理员档位配置（真实模型映射，权限收紧）
if [ ! -f /opt/qingping/workshop/deploy/admin-tiers.json ]; then
  cp /opt/qingping/workshop/deploy/admin-tiers.example.json /opt/qingping/workshop/deploy/admin-tiers.json 2>/dev/null || true
  echo "⚠ 请编辑 /opt/qingping/workshop/deploy/admin-tiers.json 填入真实档位映射（模型/baseUrl/keyEnv）"
fi
chmod 600 /opt/qingping/workshop/deploy/admin-tiers.json 2>/dev/null || true

echo "4/6 密钥环境变量"
echo "把上游 API Key 写进 /opt/qingping/workshop/projects/.env（格式 KEY=value），chmod 600"
chmod 600 /opt/qingping/workshop/projects/.env 2>/dev/null || true

echo "5/6 systemd 单元"
cp /opt/qingping/workshop/deploy/qingping@.service /etc/systemd/system/
systemctl daemon-reload

echo "6/6 完成。接下来："
echo "  node /opt/qingping/workshop/deploy/add-user.mjs <用户名>   # 开户"
echo "  node /opt/qingping/workshop/deploy/gen-caddy.mjs          # 生成 Caddyfile"
echo "  cp /opt/qingping/workshop/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy"
echo "  for u in /opt/qingping/workshop/deploy/env/*.env; do n=\$(basename \$u .env); systemctl enable --now qingping@\$n; done"
