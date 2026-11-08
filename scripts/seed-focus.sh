#!/usr/bin/env bash
# 专注自检用的数据种子：铺一批「补记」记录，让数据页一打开就有趋势、热图与排行可看。
#
# 为什么用补记而不是真跑计时：真跑一轮番茄要 25 分钟，自检脚本不能等；
# 而沉浸页那条路（开始→暂停→结束保存）由 check-focus.mjs 自己真点，两种来源都能测到。
# 补记按内核语义没有真实起止时刻，所以它进不了「时段 × 星期」矩阵——
# 矩阵里的格子只可能来自 check-focus.mjs 真跑的那几次，脚本也照这个断言。
#
# 日期全部相对今天（见 scripts/lib/d.mjs 的同一套口径），跑在哪一天都一样。
# 用法：bash scripts/seed-focus.sh [数据目录]   （默认 tmp/vdata，需先跑 verify-restart.sh 建好库）
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd -W 2>/dev/null || pwd)
DIR="${1:-${PLANDO_VDATA:-$ROOT/tmp/vdata}}"
BIN=bin/plando-verify.exe
[ -f "$BIN" ] || go build -o "$BIN" ./cmd/plando
run() { PLANDO_DATA_DIR="$DIR" "$BIN" "$@" >/dev/null; }
PY="import datetime as D;T=D.date.today()"
d() { python -c "$PY;print(T+D.timedelta(days=$1))"; }

# 关联任务用的三条事项 + 一个习惯（习惯打卡页签要有东西）
run add "写周报" --day "$(d 0)"
run add "评审方案" --day "$(d 0)"
run add "读一页书" --day "$(d 0)"
run habit "晨跑" --freq daily --mode once --backfill 400 --start "$(d -60)"

# 近 40 天：越近越密，三种类型轮着来，部分挂任务
for off in 38 35 31 28 24 21 17 14 12 10 9 8 7 6 5 4 3 2 1; do
  case $((off % 3)) in
    0) run focus --type up --day "$(d -$off)" --minutes $((15 + off % 4 * 10)) --item "写周报" ;;
    1) run focus --type down --day "$(d -$off)" --minutes $((20 + off % 3 * 5)) --item "评审方案" ;;
    2) run focus --type pomo --day "$(d -$off)" --minutes 25 --cycles $((1 + off % 4)) ;;
  esac
done

# 今天两条带心得的补记（结算页与详情页的心得编辑要用到）
run focus --type up --day "$(d 0)" --minutes 40 --item "写周报" --note "一口气写完，中途没看手机"
run focus --type pomo --day "$(d 0)" --minutes 25 --cycles 2 --note "两个番茄，第三个被打断"

# 去年冬天两条，年热图与「点左箭头换到去年」才有东西可对
run focus --type down --day "$(d -400)" --minutes 30 --item "读一页书"
run focus --type up --day "$(d -410)" --minutes 55

echo "已灌入专注数据：今天 $(d 0)，回溯到 $(d -410)，共 23 条补记"
