// Command plando 是同一颗内核的命令行外壳：没有 UI 也能建数据、打卡、跑同步，
// 用来做端到端验证、回归测试和「UI 挂了还能修数据」的兜底。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"planfordo/internal/core/backup"
	"planfordo/internal/core/calendar"
	"planfordo/internal/core/model"
	"planfordo/internal/core/service"
	"planfordo/internal/core/store"
	plansync "planfordo/internal/core/sync"
	channelfeishu "planfordo/internal/core/sync/channel/feishu"
	channelwebdav "planfordo/internal/core/sync/channel/webdav"
	"planfordo/internal/core/tclock"
)

const usage = `plando — 清单与习惯内核的命令行

用法: plando <命令> [参数]

  init                       初始化数据目录并写种子数据
  today                      打印今天的四个桶
  add <标题>                 新建事项（--day --span --time HH:MM|HH:MM-HH:MM --repeat daily|weekly --list --category）
  clock <标题或ID>           给事项打卡（--day --off --fail）
  top <标题或ID>             置顶/取消置顶（--off）
  postpone <标题或ID>        把逾期项顺延到今天
  habits                     打印今天各情境的习惯与打卡进度
  habit <名称>               建习惯（--freq daily|weekly:1,3,5|monthly:1,-1|every:3 --mode once|multi --target --per --unit --backfill --context --icon --color --start）
  habit-clock <习惯名>       给习惯打卡（--amount --day）
  focus                      补记一条专注记录（--type up|pomo|down --day --minutes --cycles --item --note）
  focuses                    列出专注记录（累计）
  reminders                  打印未来 7 天的提醒
  calendar [show]            打印法定节假日数据现状（覆盖年份、出处、核对日期）
  calendar day 2026-10-01    查一天的班/休标记
  calendar import <year>.json 导入某一年的节假日表（覆盖内置的同一年）
  export <文件>              导出口令加密的全量备份（--password 或环境变量 PLANDO_BACKUP_PASSWORD，--with-attachments 连附件字节）
  import <文件>              恢复一份加密备份（LWW 合并，不清库）
  channels                   列出同步通道配置
  channel localdir --dir P   配置一条通道（--name --kind --disable）
  sync [通道名]              跑一轮同步，省略名字则跑所有启用的通道
  stats                      各实体类型的行数与水
  where                      打印数据目录与设备 ID

环境变量 PLANDO_DATA_DIR 指定数据目录，默认取系统配置目录下的 planfordo。
`

func main() {
	if len(os.Args) < 2 || os.Args[1] == "-h" || os.Args[1] == "--help" || os.Args[1] == "help" {
		fmt.Print(usage)
		os.Exit(0)
	}
	channelfeishu.Install()
	channelwebdav.Install()

	dir, err := dataDir()
	if err != nil {
		fail(err)
	}
	db, err := store.Open(context.Background(), dir)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	cal, err := calendar.Open(filepath.Join(dir, "calendars"))
	if err != nil {
		fail(err)
	}
	svc := service.New(db, service.WithCalendar(cal), service.WithLocation(time.Local))
	if err := svc.Seed(context.Background()); err != nil {
		fail(err)
	}

	ctx := context.Background()
	args := os.Args[2:]
	switch os.Args[1] {
	case "init":
		fmt.Printf("数据目录: %s\n设备 ID: %s\n", dir, db.DeviceID())
	case "where":
		fmt.Printf("数据目录: %s\n库文件: %s\n设备 ID: %s\n", dir, db.Path(), db.DeviceID())
	case "today":
		today(ctx, svc)
	case "add":
		add(ctx, svc, args)
	case "clock":
		clock(ctx, svc, args)
	case "top":
		top(ctx, svc, args)
	case "postpone":
		postpone(ctx, svc, args)
	case "habits":
		habits(ctx, svc)
	case "habit":
		addHabit(ctx, svc, args)
	case "habit-clock":
		habitClock(ctx, svc, args)
	case "focus":
		focusCmd(ctx, svc, args)
	case "focuses":
		focusList(ctx, svc)
	case "reminders":
		reminders(ctx, svc)
	case "calendar":
		calendarCmd(dir, cal, args)
	case "channels":
		channels(ctx, db)
	case "channel":
		channel(ctx, db, args)
	case "sync":
		syncNow(ctx, db, dir, args)
	case "export":
		exportBackup(ctx, db, dir, args)
	case "import":
		importBackup(ctx, db, dir, args)
	case "stats":
		stats(ctx, db)
	default:
		fmt.Fprintf(os.Stderr, "未知命令 %q\n\n", os.Args[1])
		fmt.Print(usage)
		os.Exit(2)
	}
}

func dataDir() (string, error) {
	if v := os.Getenv("PLANDO_DATA_DIR"); v != "" {
		if err := os.MkdirAll(v, 0o755); err != nil {
			return "", err
		}
		return v, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "planfordo")
	return dir, os.MkdirAll(dir, 0o755)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "错误:", err)
	os.Exit(1)
}

func today(ctx context.Context, svc *service.App) {
	view, err := svc.ListView(ctx, service.ListViewRequest{Day: svc.Today(), ShowDone: true})
	if err != nil {
		fail(err)
	}
	fmt.Printf("今天 %s\n", view.Day)
	for _, g := range view.Groups {
		fmt.Printf("\n[%s] %d\n", g.Label, g.Count)
		for _, o := range g.Items {
			fmt.Printf("  - %s  (%s%s)\n", o.Item.Title, o.Day, statusSuffix(o))
		}
	}
}

func statusSuffix(o service.Occurrence) string {
	switch o.Status {
	case model.StatusClocked:
		return " 已打卡"
	case model.StatusFailed:
		return " 失败打卡"
	default:
		if o.OverdueDays > 0 {
			return fmt.Sprintf(" 逾期%d天", o.OverdueDays)
		}
		if o.PostponedFrom != "" {
			return " 由 " + o.PostponedFrom + " 顺延"
		}
		return ""
	}
}

func add(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	day := fs.String("day", "", "日期 YYYY-MM-DD，留空表示无日期")
	repeatKind := fs.String("repeat", "", "daily|weekly")
	listID := fs.String("list", model.DefaultListID, "清单本")
	category := fs.String("category", "", "分类 ID")
	timeStr := fs.String("time", "", "时间点 HH:MM，或时间段 HH:MM-HH:MM")
	span := fs.String("span", "", "跨天结束日 YYYY-MM-DD（配合 --day，建一条跨天事项）")
	if err := fs.Parse(orderArgs(args)); err != nil {
		fail(err)
	}
	title := strings.Join(fs.Args(), " ")
	if strings.TrimSpace(title) == "" {
		fail(fmt.Errorf("标题不能为空"))
	}
	in := service.ItemInput{
		ListID:   *listID,
		Title:    title,
		Category: *category,
		Date:     model.DateSpec{Kind: model.DateSingle, Start: *day},
	}
	if *timeStr != "" {
		// 支持两种写法：`09:00` 是时间点，`09:00-10:30` 是时间段。
		if a := strings.SplitN(*timeStr, "-", 2); len(a) == 2 && a[1] != "" {
			in.Time = model.TimeSpec{Kind: model.TimeRange, Start: a[0], End: a[1]}
		} else {
			in.Time = model.TimeSpec{Kind: model.TimePoint, Start: *timeStr}
		}
	}
	if *span != "" {
		if *day == "" {
			fail(fmt.Errorf("--span 需要和 --day 一起用"))
		}
		in.Date = model.DateSpec{Kind: model.DateSpan, Start: *day, End: *span}
	}
	switch *repeatKind {
	case "":
	case "daily":
		in.Repeat = &model.Repeat{Unit: model.UnitDay, Interval: 1}
	case "weekly":
		start := *day
		if start == "" {
			start = svc.Today()
		}
		in.Repeat = &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{weekdayOf(start)}}
	default:
		fail(fmt.Errorf("--repeat 只支持 daily|weekly，收到 %q", *repeatKind))
	}
	out, err := svc.SaveItem(ctx, in, service.ScopeAll, "")
	if err != nil {
		fail(err)
	}
	fmt.Printf("已建: %s (%s)\n", out[0].Title, out[0].ID)
}

func weekdayOf(day string) int {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return 1
	}
	w := int(t.Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// findItem 支持用 ID 或标题前缀定位事项，方便命令行操作。
// focusCmd 补记一条专注记录。界面里的「补记专注记录」走的是同一个用例（FocusSave），
// 这里只是给自检脚本灌历史数据用，不用真等一个番茄跑完。
func focusCmd(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("focus", flag.ExitOnError)
	typ := fs.String("type", "up", "up 正计时 / pomo 番茄钟 / down 倒计时")
	day := fs.String("day", "", "归属日 YYYY-MM-DD，默认今天")
	minutes := fs.Int("minutes", 25, "分钟数（番茄是每轮分钟）")
	cycles := fs.Int("cycles", 1, "番茄轮数")
	item := fs.String("item", "", "关联事项标题或 ID")
	note := fs.String("note", "", "专注心得")
	if err := fs.Parse(args); err != nil {
		fail(err)
	}
	t := map[string]model.FocusType{"up": model.FocusCountUp, "pomo": model.FocusPomodoro, "down": model.FocusCountDown}[*typ]
	if t == 0 {
		fail(fmt.Errorf("未知专注类型 %q（up|pomo|down）", *typ))
	}
	itemID := ""
	if *item != "" {
		itemID = findItem(ctx, svc, *item).ID
	}
	sec := *minutes * 60
	if t == model.FocusPomodoro {
		sec *= max(*cycles, 1)
	}
	out, err := svc.FocusSave(ctx, service.FocusInput{
		Type: t, Day: *day, ActualSec: sec, Cycles: *cycles, ItemID: itemID, Note: *note,
	})
	if err != nil {
		fail(err)
	}
	fmt.Printf("已补记 %s：%s（%s）\n", out.ID, dayLabel(out.Day), focusTypeLabel(out.Type))
}

func focusList(ctx context.Context, svc *service.App) {
	rows, err := svc.FocusList(ctx, "", 0)
	if err != nil {
		fail(err)
	}
	if len(rows) == 0 {
		fmt.Println("还没有专注记录")
		return
	}
	for _, r := range rows {
		fmt.Printf("%s  %-4s  %-6s  %-10s  %s\n", r.Record.Day, focusTypeLabel(r.Record.Type),
			fmt.Sprintf("%d分", r.Record.ActualSec/60), r.TaskName, r.Record.Note)
	}
}

func focusTypeLabel(t model.FocusType) string {
	switch t {
	case model.FocusPomodoro:
		return "番茄"
	case model.FocusCountDown:
		return "倒计时"
	default:
		return "正计时"
	}
}

func dayLabel(d string) string { return d }

func findItem(ctx context.Context, svc *service.App, key string) *model.ListItem {
	rows, err := svc.DB().Rows(ctx, store.KindItem, false)
	if err != nil {
		fail(err)
	}
	hits := []store.Entity{}
	for _, r := range rows {
		if r.ID == key {
			var it model.ListItem
			if err := r.Decode(&it); err != nil {
				fail(err)
			}
			return &it
		}
		var it model.ListItem
		if err := r.Decode(&it); err != nil {
			fail(err)
		}
		if strings.HasPrefix(it.Title, key) {
			hits = append(hits, r)
		}
	}
	if len(hits) == 1 {
		var it model.ListItem
		if err := hits[0].Decode(&it); err != nil {
			fail(err)
		}
		return &it
	}
	if len(hits) == 0 {
		fail(fmt.Errorf("找不到事项 %q", key))
	}
	fail(fmt.Errorf("%q 匹配到 %d 条，请用 ID", key, len(hits)))
	return nil
}

func clock(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("clock", flag.ExitOnError)
	day := fs.String("day", "", "哪天，默认今天")
	off := fs.Bool("off", false, "取消打卡")
	isFail := fs.Bool("fail", false, "记「失败打卡」：这一天同样结清，但结果是没做到")
	if err := fs.Parse(orderArgs(args, "off", "fail")); err != nil {
		fail(err)
	}
	key := strings.Join(fs.Args(), " ")
	if key == "" {
		fail(fmt.Errorf("要给哪条事项打卡？"))
	}
	it := findItem(ctx, svc, key)
	status := model.StatusClocked
	switch {
	case *off:
		status = model.StatusPending
	case *isFail:
		status = model.StatusFailed
	}
	if err := svc.SetItemClockState(ctx, it.ID, *day, status); err != nil {
		fail(err)
	}
	verb := map[model.ItemStatus]string{model.StatusClocked: "已打卡", model.StatusFailed: "失败打卡", model.StatusPending: "已取消打卡"}[status]
	fmt.Printf("%s: %s %s\n", verb, orToday(svc, *day), it.Title)
}

// top 置顶/取消置顶：只改列内顺序，不动事项本身。
func top(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("top", flag.ExitOnError)
	off := fs.Bool("off", false, "取消置顶")
	if err := fs.Parse(orderArgs(args, "off")); err != nil {
		fail(err)
	}
	key := strings.Join(fs.Args(), " ")
	if key == "" {
		fail(fmt.Errorf("要置顶哪条事项？"))
	}
	it := findItem(ctx, svc, key)
	if err := svc.SetItemTop(ctx, it.ID, !*off); err != nil {
		fail(err)
	}
	verb := "已置顶"
	if *off {
		verb = "已取消置顶"
	}
	fmt.Printf("%s: %s\n", verb, it.Title)
}

func postpone(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("postpone", flag.ExitOnError)
	from := fs.String("from", "", "从哪天顺延，默认今天")
	if err := fs.Parse(orderArgs(args)); err != nil {
		fail(err)
	}
	keys := fs.Args()
	ids := []string{}
	days := []string{}
	if len(keys) == 0 {
		list, ds, err := svc.OverdueItemIDs(ctx, *from)
		if err != nil {
			fail(err)
		}
		ids, days = list, ds
	} else {
		for _, k := range keys {
			it := findItem(ctx, svc, k)
			fromDay := *from
			if fromDay == "" {
				fromDay = it.Date.Start // 没指定就按事项自己的日期，Postpone 空日期会当成不用顺延
			}
			ids = append(ids, it.ID)
			days = append(days, fromDay)
		}
	}
	if len(ids) == 0 {
		fmt.Println("没有要顺延的事项")
		return
	}
	n := 0
	for i, id := range ids {
		done, err := svc.Postpone(ctx, []string{id}, days[i], svc.Today())
		if err != nil {
			fail(err)
		}
		n += done
	}
	fmt.Printf("顺延 %d 条到今天（原日期 %s）\n", n, strings.Join(unique(days), " "))
}

func unique(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if x == "" || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
	}
	return out
}

func habits(ctx context.Context, svc *service.App) {
	view, err := svc.HabitMonthView(ctx, svc.Today(), "")
	if err != nil {
		fail(err)
	}
	for _, ctxID := range view.Contexts {
		rows := view.RowsByCtx[ctxID]
		if len(rows) == 0 {
			continue
		}
		name := ctxID
		for _, r := range rows {
			if r.ContextName != "" {
				name = r.ContextName
			}
		}
		if ctxID == "ctx-always" {
			name = "全天"
		}
		fmt.Printf("\n[%s]\n", name)
		for _, r := range rows {
			flag := "○"
			if r.Clocked {
				flag = "●"
			}
			fmt.Printf("  %s %s  %.0f/%.0f  连续%d  累计%d\n", flag, r.Habit.Name, r.Amount, r.Target, r.Streak, r.TotalDays)
		}
	}
}

func habitClock(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("habit-clock", flag.ExitOnError)
	day := fs.String("day", "", "哪天，默认今天")
	amount := fs.Float64("amount", 0, "打卡量，省略按 1 或习惯的每次完成量")
	if err := fs.Parse(orderArgs(args)); err != nil {
		fail(err)
	}
	name := strings.Join(fs.Args(), " ")
	habits, err := svc.DB().Rows(ctx, store.KindHabit, false)
	if err != nil {
		fail(err)
	}
	var hit *model.Habit
	n := 0
	for _, r := range habits {
		var h model.Habit
		if err := r.Decode(&h); err != nil {
			fail(err)
		}
		if h.ID == name || strings.HasPrefix(h.Name, name) {
			hit = &h
			n++
		}
	}
	if n == 0 {
		fail(fmt.Errorf("找不到习惯 %q", name))
	}
	if n > 1 {
		fail(fmt.Errorf("%q 匹配到 %d 个习惯", name, n))
	}
	c, err := svc.ClockHabit(ctx, hit.ID, *day, *amount)
	if err != nil {
		fail(err)
	}
	fmt.Printf("%s 打卡 %.0f (%s)\n", hit.Name, c.Amount, orToday(svc, *day))
}

// addHabit 建习惯。频率写法与界面一致：daily / weekly:1,3,5 / monthly:1,-1 / every:3。
func addHabit(ctx context.Context, svc *service.App, args []string) {
	fs := flag.NewFlagSet("habit", flag.ExitOnError)
	start := fs.String("start", "", "开始日，默认今天")
	freq := fs.String("freq", "daily", "daily | weekly:1,3,5 | monthly:1,-1 | every:3")
	mode := fs.String("mode", "once", "once=每天一次 | multi=每天多次")
	target := fs.Float64("target", 0, "multi 模式的每日总量")
	per := fs.Float64("per", 0, "multi 模式每次完成量")
	unit := fs.String("unit", "", "单位 ID，如 unit-cup")
	backfill := fs.Int("backfill", 0, "允许回溯补打卡的天数")
	contextID := fs.String("context", "", "情境 ID，如 ctx-morning")
	icon := fs.String("icon", "", "图标：内置名或单个汉字")
	color := fs.String("color", "", "图标颜色")
	if err := fs.Parse(orderArgs(args)); err != nil {
		fail(err)
	}
	name := strings.Join(fs.Args(), " ")
	in := service.HabitInput{
		Name: name, StartDay: *start, Mode: model.HabitOncePerDay,
		Context: *contextID, UnitID: *unit, DailyTarget: *target, PerClock: *per,
		BackfillDays: *backfill,
		Icon:         model.HabitIcon{Kind: "text", Ref: *icon, Color: *color},
	}
	if *mode == "multi" {
		in.Mode = model.HabitMultiPerDay
		if *target <= 0 {
			fail(fmt.Errorf("multi 模式必须给 --target"))
		}
	}
	head, rest, _ := strings.Cut(*freq, ":")
	switch head {
	case "daily":
		in.Freq = model.Frequency{Kind: model.FreqDaily}
	case "weekly":
		in.Freq = model.Frequency{Kind: model.FreqFixedWeekdays, Weekdays: parseIntList(rest)}
	case "monthly":
		in.Freq = model.Frequency{Kind: model.FreqMonthlyDays, MonthDays: parseIntList(rest)}
	case "every":
		list := parseIntList(rest)
		if len(list) != 1 {
			fail(fmt.Errorf("--freq every:N 需要一个数字，收到 %q", rest))
		}
		in.Freq = model.Frequency{Kind: model.FreqEveryNDays, EveryN: list[0]}
	default:
		fail(fmt.Errorf("未知频率 %q", *freq))
	}
	h, err := svc.SaveHabit(ctx, in)
	if err != nil {
		fail(err)
	}
	fmt.Printf("已建习惯: %s (%s)\n", h.Name, h.ID)
}

func parseIntList(s string) []int {
	out := []int{}
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n := 0
		if _, err := fmt.Sscanf(p, "%d", &n); err != nil {
			fail(fmt.Errorf("数字解析失败: %q", p))
		}
		out = append(out, n)
	}
	return out
}

func reminders(ctx context.Context, svc *service.App) {
	fires, err := svc.UpcomingReminders(ctx, svc.Today(), "")
	if err != nil {
		fail(err)
	}
	if len(fires) == 0 {
		fmt.Println("未来 7 天没有提醒")
		return
	}
	for _, f := range fires {
		fmt.Printf("%s  %s  %s\n", f.At, f.Day, f.Title)
	}
}

// calendarCmd 打印/导入法定节假日数据。「plando calendar」看现状，
// 「plando calendar import 2028.json」补一年，「plando calendar day 2026-10-01」查一天。
func calendarCmd(dir string, cal *calendar.FS, args []string) {
	calDir := filepath.Join(dir, "calendars")
	sub := "show"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "show":
		st := calendar.StatusOf(cal, calDir)
		fmt.Printf("节假日数据目录: %s\n内置覆盖年份: %s\n本机覆盖: %s\n",
			calDir, joinYears(st.BuiltinYears), joinYears(st.LocalYears))
		for _, y := range st.Years {
			from := "内置"
			if y.Origin == calendar.OriginLocal {
				from = "本机导入"
			}
			fmt.Printf("  %d  放假 %2d 天 / 补班 %d 天  %-6s  %s（核对 %s）\n",
				y.Year, y.HolidayCount, y.MakeupCount, from, y.Source, y.LastVerified)
		}
		if len(st.Years) > 0 {
			last := st.Years[len(st.Years)-1].Year
			fmt.Printf("  注：%d 年及以后没有数据，「法定工作日」与「跳过节假日」在那些年退化成普通周一至周五。\n", last+1)
		}
	case "day":
		if len(args) < 2 {
			fail(fmt.Errorf("用法: plando calendar day 2026-10-01"))
		}
		day := args[1]
		mark := cal.Mark(day)
		switch mark {
		case "休":
			fmt.Printf("%s 法定节假日（休）\n来源: %s\n", day, cal.SourceOf(yearOfDay(day)))
		case "班":
			fmt.Printf("%s 调休上班（班）\n来源: %s\n", day, cal.SourceOf(yearOfDay(day)))
		default:
			if wd := weekdayName(day); wd != "" {
				fmt.Printf("%s 普通%s（无班/休标记；该年有没有数据见 plando calendar show）\n", day, wd)
			} else {
				fail(fmt.Errorf("日期 %q 不是 YYYY-MM-DD", day))
			}
		}
	case "import":
		if len(args) < 2 {
			fail(fmt.Errorf("用法: plando calendar import <year>.json"))
		}
		raw, err := os.ReadFile(args[1])
		if err != nil {
			fail(err)
		}
		var t calendar.Table
		if err := json.Unmarshal(raw, &t); err != nil {
			fail(fmt.Errorf("解析 %s: %w", args[1], err))
		}
		if err := calendar.Write(calDir, t); err != nil {
			fail(err) // Write 里做校验：写坏表比写不进去更糟
		}
		fmt.Printf("已写入 %s（%d 年，放假 %d 天、补班 %d 天）\n",
			filepath.Join(calDir, fmt.Sprintf("%d.json", t.Year)), t.Year, len(t.Holidays), len(t.MakeupDays))
	default:
		fail(fmt.Errorf("未知子命令 %q（可用：show / day / import）", sub))
	}
}

func joinYears(years []int) string {
	if len(years) == 0 {
		return "无"
	}
	out := make([]string, 0, len(years))
	for _, y := range years {
		out = append(out, fmt.Sprint(y))
	}
	return strings.Join(out, ", ")
}

// backupPassword 取口令：优先环境变量，其次 --password。
// 命令行参数会进进程列表，所以帮助里先说环境变量。
func backupPassword(env, fromFlag string) string {
	if v := os.Getenv("PLANDO_BACKUP_PASSWORD"); v != "" {
		return v
	}
	return fromFlag
}

func exportBackup(ctx context.Context, db *store.DB, dir string, args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	pw := fs.String("password", "", "备份口令（也可以用环境变量 PLANDO_BACKUP_PASSWORD）")
	withAtt := fs.Bool("with-attachments", false, "连附件字节一起导出（体积大，换设备能直接用）")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		fail(fmt.Errorf("用法: plando export <文件> [--password ...] [--with-attachments]"))
	}
	path := fs.Arg(0)
	password := backupPassword("", *pw)
	file, sum, err := backup.ExportDB(ctx, db, dir, password, db.DeviceID(), tclock.Now(), *withAtt)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(path, file, 0o600); err != nil {
		fail(err)
	}
	fmt.Printf("已导出 %s\n  记录 %d 条、附件 %d 个（%d 字节）\n  校验串 %s\n",
		path, sum.Records, sum.Attachments, sum.AttachmentBytes, backup.Fingerprint(file))
}

func importBackup(ctx context.Context, db *store.DB, dir string, args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	pw := fs.String("password", "", "备份口令（也可以用环境变量 PLANDO_BACKUP_PASSWORD）")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		fail(fmt.Errorf("用法: plando import <文件> [--password ...]"))
	}
	raw, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		fail(err)
	}
	engine := plansync.NewEngine(db)
	sum, err := backup.ImportFile(ctx, raw, backupPassword("", *pw), dir,
		func(ctx context.Context, recs []store.Entity) (int, int, error) {
			return engine.ApplySnapshot(ctx, &plansync.Snapshot{Schema: plansync.SchemaVersion, Records: recs})
		})
	if err != nil {
		fail(err)
	}
	fmt.Printf("已恢复：落库 %d 条（其中 %d 条与本地不同、按最后修改时间判过），附件字节 %d 字节\n",
		sum.Applied, sum.Conflicts, sum.AttachmentBytes)
	if sum.SkippedTampered > 0 {
		fmt.Printf("  跳过 %d 个校验和对不上的附件\n", sum.SkippedTampered)
	}
}

func yearOfDay(day string) int {
	var y int
	fmt.Sscanf(day, "%d-", &y)
	return y
}

func weekdayName(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return ""
	}
	return []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[int(t.Weekday())]
}

func channels(ctx context.Context, db *store.DB) {
	list, err := plansync.NewManager(db).Configs(ctx)
	if err != nil {
		fail(err)
	}
	if len(list) == 0 {
		fmt.Printf("还没有通道，已注册类型: %s\n", strings.Join(plansync.Kinds(), ", "))
		return
	}
	for _, c := range list {
		state, err := plansync.NewManager(db).State(ctx, c.Name)
		enabled := "关"
		if c.Enabled {
			enabled = "开"
		}
		fmt.Printf("- %s  kind=%s  %s  上次同步=%s  err=%v\n", c.Name, c.Kind, enabled, state.LastSyncAt, err)
	}
}

func channel(ctx context.Context, db *store.DB, args []string) {
	fs := flag.NewFlagSet("channel", flag.ExitOnError)
	name := fs.String("name", "", "通道名，默认与 kind 同名")
	dir := fs.String("dir", "", "localdir 的同步目录")
	baseURL := fs.String("url", "", "webdav 根地址")
	path := fs.String("path", "", "webdav 目录前缀")
	user := fs.String("user", "", "WebDAV 用户名")
	pass := fs.String("pass", "", "WebDAV 密码")
	appID := fs.String("app-id", "", "飞书 app_id")
	appSecret := fs.String("app-secret", "", "飞书 app_secret")
	disable := fs.Bool("disable", false, "停用而不删除")
	if err := fs.Parse(orderArgs(args, "disable")); err != nil {
		fail(err)
	}
	kind := fs.Arg(0)
	if kind == "" {
		fail(fmt.Errorf("要配置哪种通道？已注册: %s", strings.Join(plansync.Kinds(), ", ")))
	}
	chosen := kind
	if *name != "" {
		chosen = *name
	}
	opts := map[string]string{}
	setIfNotEmpty(opts, "dir", *dir)
	setIfNotEmpty(opts, "baseUrl", *baseURL)
	setIfNotEmpty(opts, "path", *path)
	setIfNotEmpty(opts, "username", *user)
	setIfNotEmpty(opts, "password", *pass)
	setIfNotEmpty(opts, "appId", *appID)
	setIfNotEmpty(opts, "appSecret", *appSecret)

	cfg := plansync.Config{Name: chosen, Kind: kind, Enabled: !*disable, Options: opts}
	mgr := plansync.NewManager(db)
	if err := mgr.SaveConfig(ctx, cfg); err != nil {
		fail(err)
	}
	if err := mgr.Probe(ctx, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "配置已存，但连通性测试失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("通道 %s (%s) 配置完成且可连通\n", chosen, kind)
}

func setIfNotEmpty(m map[string]string, k, v string) {
	if v != "" {
		m[k] = v
	}
}

// orderArgs 把「标题在前、参数在后」的写法重排成 flag 包要求的顺序。
//
// Go 的 flag 遇到第一个非 flag 参数就停止解析，所以 `add 站会 --day X` 会把
// --day 连同取值并进标题里，静默建出一条无日期事项。这里显式前移参数段；
// boolFlags 列出不消耗后一个 token 的开关，否则会误吞标题。
func orderArgs(args []string, boolFlags ...string) []string {
	isBool := map[string]bool{}
	for _, b := range boolFlags {
		isBool[b] = true
	}
	flags := []string{}
	rest := []string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a != "-" && strings.HasPrefix(a, "-") {
			flags = append(flags, a)
			name := strings.TrimLeft(a, "-")
			if strings.Contains(a, "=") || isBool[name] {
				continue
			}
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
				flags = append(flags, args[i])
			}
			continue
		}
		rest = append(rest, a)
	}
	return append(flags, rest...)
}

func syncNow(ctx context.Context, db *store.DB, dataDir string, args []string) {
	mgr := plansync.NewManager(db, dataDir)
	var results []plansync.Result
	var err error
	if len(args) == 0 {
		results, err = mgr.SyncAll(ctx)
	} else {
		var r plansync.Result
		r, err = mgr.SyncOne(ctx, args[0])
		results = []plansync.Result{r}
	}
	if err != nil {
		fail(err)
	}
	for _, r := range results {
		out, _ := json.MarshalIndent(r, "", "  ")
		fmt.Println(string(out))
	}
}

func stats(ctx context.Context, db *store.DB) {
	counts, err := db.CountByKind(ctx)
	if err != nil {
		fail(err)
	}
	total := 0
	for _, k := range store.AllKinds {
		if n := counts[k]; n > 0 {
			fmt.Printf("%-14s %d\n", k, n)
			total += n
		}
	}
	fmt.Printf("%-14s %d\n", "合计", total)
}

func orToday(svc *service.App, day string) string {
	if day == "" {
		return svc.Today()
	}
	return day
}
