#!/usr/bin/env bash
# 视图自检用的数据种子：往隔离数据目录里灌一批「够把网格画满」的事项与习惯。
# 覆盖：跨天条（同周内 / 跨周）、单天多条（触发「还有 N 个任务」）、重叠时间段（触发并排分栏）、
# 时间点、每天一次的习惯、每周 1/3/5 的习惯、以及「已打卡事项 + 已完成习惯」各一条。
#
# 日期全部相对今天算（以前写死 2026-11-xx，隔一天整套脚本就满屏红，红的还是脚本不是应用）：
#   · MON = 本周星期一，m N = MON+N；d N = 今天+N。
#   · 单天多条放在本周内（m 5）：月视图网格恒包含当前整周，边界月（月末/月初）也不会画漏。
#   · 带时刻的三条放在下周（m 7）：周视图断言点「下一周」才看得到，日视图同理。
#   · 已打卡样本放在昨天（d -1）：内核不给未来补打卡，也不能回溯超过 backfill 天数。
# 用法：bash scripts/seed-view.sh [数据目录]   （默认 tmp/vdata，需先跑 verify-restart.sh 建好库）
set -e
cd "$(dirname "$0")/.."
DIR="${1:-C:\\Users\\Public\\project\\plan-for-do\\tmp\\vdata}"
BIN=bin/plando-verify.exe
[ -f "$BIN" ] || go build -o "$BIN" ./cmd/plando
run() { PLANDO_DATA_DIR="$DIR" "$BIN" "$@" >/dev/null; }
PY="import datetime as D;T=D.date.today()"
d() { python -c "$PY;print(T+D.timedelta(days=$1))"; }
m() { python -c "$PY;M=T-D.timedelta(days=T.weekday());print(M+D.timedelta(days=$1))"; }

run add "跨天出差·上海" --day "$(m 1)" --span "$(m 4)"
run add "季度复盘" --day "$(m 11)" --span "$(m 16)"
run add "学习算法" --day "$(d 0)"
run add "早会" --day "$(m 7)" --time 09:00-09:30
run add "评审" --day "$(m 7)" --time 09:15-10:45
run add "写周报" --day "$(m 7)" --time 15:00
for t in 背单词 晨跑 整理桌面 浇花 读一页书; do run add "$t" --day "$(m 5)"; done
for t in 周报草稿 回邮件 整理桌面昨 复盘D; do run add "$t" --day "$(d -1)"; done
# 习惯要早点开始：默认 start=今天，那样昨天的格子里根本不会有习惯，两个显示开关测不出差异
run habit "喝水" --freq daily --mode multi --target 8 --per 1 --unit unit-cup --backfill 7 --start "$(d -40)"
run habit "早睡" --freq "weekly:1,3,5" --start "$(d -40)"
# 「设置 → 显示已打卡清单/习惯」两个开关的可对比样本
run clock "复盘D" --day "$(d -1)"
run habit-clock "喝水" --amount 8 --day "$(d -1)"
echo "已灌入视图自检数据：本周 $(m 0) ~ $(m 6)，下周 $(m 7) ~ $(m 13)，昨天 $(d -1)"
