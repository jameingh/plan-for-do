#!/usr/bin/env bash
# 自检用的「重建 + 重启隔离实例」：界面改完一条命令就能拿到可点的新进程。
# 隔离 = 独立数据目录 + 独立 WebView2 profile（WebView2 会按 profile 复用已活的浏览器进程，
# profile 不换新就会忽略 --remote-debugging-port，CDP 口连不上）。
set -e
cd "$(dirname "$0")/.."
# 路径一律从仓库根算：CI 的 runner 在 D:\a\<repo>\<repo>，写死本机路径的话自检根本起不来。
# 要指到别处用 PLANDO_VDATA / PLANDO_VPROFILE 覆盖（CI 与 snapshot-real 共用同一套变量名）。
ROOT=$(pwd -W 2>/dev/null || pwd)
DATA_DIR="${PLANDO_VDATA:-$ROOT/tmp/vdata}"
PROFILE_DIR="${PLANDO_VPROFILE:-$ROOT/tmp/vprofile}"
PORT="${1:-9255}"
TAB="${2:-list}"

(cd frontend && npm run build >/dev/null)
CGO_ENABLED=0 go build -o bin/planfordo-verify.exe .

# 先把上一个自检实例彻底杀掉再删数据目录：进程还活着时 SQLite 文件是锁着的，
# rm 会失败，而 set -e 让脚本在这里退出——偏偏管道把这条错误吞掉了，
# 结果是「种子往旧库里再灌一遍」，条数类断言全成假的（2026-11-08 就这么被骗过一次）。
powershell -NoProfile -Command "Get-Process planfordo-verify -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null || true
for i in $(seq 1 12); do
  pgps=$(tasklist //FI "IMAGENAME eq planfordo-verify.exe" 2>/dev/null | grep -c planfordo-verify.exe || true)
  [ "$pgps" = "0" ] && break
  sleep 1
done
if ! rm -rf "$DATA_DIR" "$PROFILE_DIR" 2>/dev/null; then
  echo "删不掉 $DATA_DIR：还有进程占着数据目录（tasklist 看 planfordo-verify.exe），先手动结束再跑" >&2
  exit 1
fi
mkdir -p "$DATA_DIR" "$PROFILE_DIR"
PLANDO_DATA_DIR="$DATA_DIR" PLANDO_WEBVIEW_PROFILE="$PROFILE_DIR" \
PLANDO_CDP_PORT="$PORT" PLANDO_START_TAB="$TAB" \
  ./bin/planfordo-verify.exe > tmp/verify-run.log 2>&1 &

for i in $(seq 1 25); do
  sleep 1
  if curl -s "http://127.0.0.1:$PORT/json/list" 2>/dev/null | grep -q "wails.localhost"; then
    # CDP 口通了不等于界面已经跑完 boot：立刻开点会偶发「找不到元素」，多等两秒再交活
    sleep 2
    echo "verify 实例已就绪：端口 $PORT"
    exit 0
  fi
done
echo "启动超时，看 tmp/verify-run.log" >&2
exit 1
