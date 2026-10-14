#!/usr/bin/env bash
# 一键启动（Linux / macOS）。用法： ./start.sh   或   ./start.sh --console
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js，请先安装 Node 20 或更高版本： https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node 版本过低（$(node --version)），需要 20 或更高。"
  exit 1
fi

echo "✓ Node $(node --version)"
echo "  控制台： http://127.0.0.1:43121/"
echo "  按 Ctrl+C 停止"
echo
exec node src/main.js "$@"
