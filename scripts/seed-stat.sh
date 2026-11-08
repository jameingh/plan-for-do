#!/usr/bin/env bash
# 习惯统计自检用的数据种子：造出四种排期（每天一次 / 每天多次 / 每周一三五 / 每周配额），
# 并往过去若干天打卡，保证日/周/月/年四个页签都有可核对的格子。
# 打卡只能打今天及以前（内核拒绝未来），过去天数靠 --backfill 放开。
# 用法：bash scripts/seed-stat.sh [数据目录]   （默认 tmp/vdata，需先跑 verify-restart.sh 建好库）
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd -W 2>/dev/null || pwd)
DIR="${1:-${PLANDO_VDATA:-$ROOT/tmp/vdata}}"
BIN=bin/plando-verify.exe
[ -f "$BIN" ] || go build -o "$BIN" ./cmd/plando
run() { PLANDO_DATA_DIR="$DIR" "$BIN" "$@" >/dev/null; }
# 相对今天的天数（内核不接受未来打卡，也拒绝超过 backfill 的过去）
d() { python -c "import datetime,sys;print((datetime.date.today()+datetime.timedelta(days=$1)).isoformat())"; }

run habit "早睡" --freq daily --mode once --backfill 400 --start "$(d -70)"
run habit "喝水" --freq daily --mode multi --target 8 --per 1 --unit unit-cup --backfill 400 --start "$(d -70)"
run habit "健身" --freq "weekly:1,3,5" --backfill 400 --start "$(d -70)"
run habit "跑步" --freq "weekly:2" --mode once --backfill 400 --start "$(d -70)"

# 今天：早睡打满、喝水只打了 3/8（半量算「打了卡」不算「打满」）
run habit-clock "早睡" --day "$(d 0)"
for i in 1 2 3; do run habit-clock "喝水" --amount 1 --day "$(d 0)"; done
run habit-clock "健身" --day "$(d -1)"
run habit-clock "早睡" --day "$(d -1)"
run habit-clock "喝水" --amount 8 --day "$(d -1)"
run habit-clock "跑步" --day "$(d -2)"
run habit-clock "早睡" --day "$(d -3)"
run habit-clock "健身" --day "$(d -6)"
run habit-clock "早睡" --day "$(d -7)"
run habit-clock "喝水" --amount 8 --day "$(d -7)"
run habit-clock "跑步" --day "$(d -9)"
run habit-clock "早睡" --day "$(d -14)"
run habit-clock "健身" --day "$(d -21)"
echo "已灌入习惯统计数据（覆盖今天起 400 天回溯）"
