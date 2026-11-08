package service

import (
	"testing"
	"time"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
)

// statDay 从统计结果里取某个习惯某一格。
func statDay(t *testing.T, s HabitStat, habitID, day string) HabitStatDay {
	t.Helper()
	for _, h := range s.Habits {
		if h.HabitID != habitID {
			continue
		}
		for _, c := range h.Days {
			if c.Day == day {
				return c
			}
		}
		t.Fatalf("习惯 %s 的区间里没有 %s", habitID, day)
	}
	t.Fatalf("统计里没有习惯 %s", habitID)
	return HabitStatDay{}
}

func TestHabitStatDailyStates(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	h, err := a.SaveHabit(ctx, HabitInput{Name: "跑步", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: repeat.AddDays(today, -6), BackfillDays: 7})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	// 前天打满、昨天只打了一半（多次习惯）、今天没打
	multi, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Freq: model.Frequency{Kind: model.FreqDaily},
		Mode: model.HabitMultiPerDay, DailyTarget: 8, PerClock: 1, StartDay: repeat.AddDays(today, -6), BackfillDays: 7})
	if err != nil {
		t.Fatalf("SaveHabit multi: %v", err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, -2), 0); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	if _, err := a.ClockHabit(ctx, multi.ID, repeat.AddDays(today, -2), 3); err != nil {
		t.Fatalf("半量打卡: %v", err)
	}

	start := repeat.AddDays(today, -6)
	st, err := a.HabitStat(ctx, HabitStatRequest{Start: start, End: today})
	if err != nil {
		t.Fatalf("HabitStat: %v", err)
	}
	if len(st.Days) != 7 {
		t.Fatalf("区间应出 7 天，实得 %d", len(st.Days))
	}
	if got := statDay(t, st, h.ID, repeat.AddDays(today, -2)).State; got != "done" {
		t.Errorf("前天应 done，实得 %s", got)
	}
	m2 := statDay(t, st, multi.ID, repeat.AddDays(today, -2))
	if m2.State != "partial" || m2.Amount != 3 || m2.Target != 8 {
		t.Errorf("多次习惯半量应 partial 3/8，实得 %s %v/%v", m2.State, m2.Amount, m2.Target)
	}
	if got := statDay(t, st, h.ID, today).State; got != "pending" {
		t.Errorf("今天没打应 pending（不能说错过），实得 %s", got)
	}
	if got := statDay(t, st, h.ID, repeat.AddDays(today, -5)).State; got != "missed" {
		t.Errorf("大前天没打应 missed，实得 %s", got)
	}
	// 汇总：只有前天有打卡
	if st.Summary.Checkins != 2 {
		t.Errorf("打卡总数应为 2（两个习惯各一天），实得 %d", st.Summary.Checkins)
	}
	if st.Summary.LongestStreak != 1 {
		t.Errorf("最长连续应为 1 天，实得 %d", st.Summary.LongestStreak)
	}
	// 完美打卡：前天「跑步打满 + 喝水只打 3/8」→ 不算完美
	if st.Summary.PerfectDays != 0 {
		t.Errorf("半量那天不该算完美打卡，实得 %d", st.Summary.PerfectDays)
	}
	if st.Summary.ScheduledDays != 7 {
		t.Errorf("7 天都该有排期，实得 %d", st.Summary.ScheduledDays)
	}
}

func TestHabitStatPerfectDay(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	d0 := repeat.AddDays(today, -3)
	// 第一天两个都打满 → 完美；第二天只打一个 → 不完美
	jia, err := a.SaveHabit(ctx, HabitInput{Name: "甲", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: d0, BackfillDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	yi, err := a.SaveHabit(ctx, HabitInput{Name: "乙", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: d0, BackfillDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, jia.ID, d0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, yi.ID, d0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, jia.ID, repeat.AddDays(d0, 1), 0); err != nil {
		t.Fatal(err)
	}

	st, err := a.HabitStat(ctx, HabitStatRequest{Start: d0, End: today})
	if err != nil {
		t.Fatal(err)
	}
	if st.Summary.PerfectDays != 1 {
		t.Errorf("应恰好 1 个完美打卡日，实得 %d", st.Summary.PerfectDays)
	}
	if st.Days[0].Scheduled != 2 || st.Days[0].Done != 2 || !st.Days[0].Perfect {
		t.Errorf("第一天应 2/2 且 perfect，实得 %+v", st.Days[0])
	}
	if st.Days[1].Perfect {
		t.Errorf("第二天只打了一个，不该 perfect")
	}
	// 今天应打 2 个、打了 0 个：算应打日，但不算完美，也要把连击断掉
	if st.Summary.LongestStreak != 2 {
		t.Errorf("连续应为 2 天（第一、二天有打卡，第三天断了），实得 %d", st.Summary.LongestStreak)
	}
}

func TestHabitStatWeeklyGridHasRestCells(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	mon := repeat.AddDays(today, -(weekdayMonLocal(today) - 1))
	sun := repeat.AddDays(mon, 6)
	// 每周一三五：二四六应当是 rest（灰色空格子，不是「没打卡」）
	h, err := a.SaveHabit(ctx, HabitInput{Name: "周报", Freq: model.Frequency{Kind: model.FreqFixedWeekdays, Weekdays: []int{1, 3, 5}}, StartDay: repeat.AddDays(mon, -30), BackfillDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, mon, 0); err != nil {
		t.Fatal(err)
	}
	st, err := a.HabitStat(ctx, HabitStatRequest{Start: mon, End: sun})
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Habits[0].Days) != 7 {
		t.Fatalf("周统计必须给满 7 格，实得 %d", len(st.Habits[0].Days))
	}
	// 今天落在周中：一三五里只剩周一打了卡、周三周五是 missed，其余全是 rest
	rest, done, missed := 0, 0, 0
	for _, c := range st.Habits[0].Days {
		switch c.State {
		case "rest":
			rest++
		case "done":
			done++
		case "missed":
			missed++
		}
	}
	if done != 1 || missed != 2 || rest != 4 {
		t.Errorf("应 1 done + 2 missed + 4 rest，实得 done=%d missed=%d rest=%d 全部=%+v", done, missed, rest, st.Habits[0].Days)
	}
	if st.Habits[0].Scheduled != 3 {
		t.Errorf("本周应打 3 天（一三五），实得 %d", st.Habits[0].Scheduled)
	}
	if st.Habits[0].Checked != 1 {
		t.Errorf("打卡天数应为 1，实得 %d", st.Habits[0].Checked)
	}
}

func TestHabitStatYearRangeAndNotStarted(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	y0 := today[:4] + "-01-01"
	y1 := today[:4] + "-12-31"
	if _, err := a.SaveHabit(ctx, HabitInput{Name: "明年才开始", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: repeat.AddDays(today, 1)}); err != nil {
		t.Fatal(err)
	}
	st, err := a.HabitStat(ctx, HabitStatRequest{Start: y0, End: y1})
	if err != nil {
		t.Fatalf("整年区间应放行: %v", err)
	}
	if len(st.Days) < 365 {
		t.Fatalf("整年应铺满 365+ 格，实得 %d", len(st.Days))
	}
	for _, h := range st.Habits {
		for _, c := range h.Days {
			// 开始日之前是 rest（连「该打」都不成立），开始日之后还没到，只能是 future
			if c.State != "rest" && c.State != "future" {
				t.Fatalf("还没开始的习惯不该有打卡态，实得 %s", c.State)
			}
		}
		if h.Checked != 0 || h.Done != 0 {
			t.Errorf("未开始习惯的打卡计数应全 0，实得 %+v", h)
		}
	}
	// 区间校验
	if _, err := a.HabitStat(ctx, HabitStatRequest{Start: y1, End: y0}); err == nil {
		t.Error("区间反了要报错")
	}
	if _, err := a.HabitStat(ctx, HabitStatRequest{Start: y0, End: repeat.AddDays(y0, 400)}); err == nil {
		t.Error("超过一年要报错")
	}
	if _, err := a.HabitStat(ctx, HabitStatRequest{}); err == nil {
		t.Error("空区间要报错")
	}
}

func TestHabitStatPartialCountsAsChecked(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	h, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Freq: model.Frequency{Kind: model.FreqDaily},
		Mode: model.HabitMultiPerDay, DailyTarget: 8, PerClock: 1, StartDay: repeat.AddDays(today, -1), BackfillDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, -1), 2); err != nil {
		t.Fatal(err)
	}
	st, err := a.HabitStat(ctx, HabitStatRequest{Start: repeat.AddDays(today, -1), End: today})
	if err != nil {
		t.Fatal(err)
	}
	row := st.Habits[0]
	if row.Checked != 1 || row.Done != 0 {
		t.Errorf("半量应算「打了卡」但不算「打满」，实得 checked=%d done=%d", row.Checked, row.Done)
	}
	if st.Summary.Checkins != 1 {
		t.Errorf("打卡总数应 1，实得 %d", st.Summary.Checkins)
	}
	if st.Days[0].Checked != 1 || st.Days[0].Done != 0 || st.Days[0].Perfect {
		t.Errorf("横向汇总应 checked=1 done=0 不完美，实得 %+v", st.Days[0])
	}
}

// weekdayMonLocal：周一=1…周日=7，与内核排期用的口径一致（测试里自己算一遍，避免依赖界面层）。
func weekdayMonLocal(day string) int {
	t, err := time.ParseInLocation("2006-01-02", day, time.Local)
	if err != nil {
		panic(err)
	}
	w := int(t.Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// TestHabitStatOffScheduleClock 锁住一条容易画错的情形：
// 回溯额度允许往「没排期」的日子打卡，那天必须显示成打了卡，不能因为不在排期表里就画成休息。
func TestHabitStatOffScheduleClock(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	// 只在周一三五排期，今天若是这几天之一就往后挪一天
	mon := repeat.AddDays(today, -(weekdayMonLocal(today) - 1))
	tue := repeat.AddDays(mon, 1)
	h, err := a.SaveHabit(ctx, HabitInput{Name: "健身", Freq: model.Frequency{Kind: model.FreqFixedWeekdays, Weekdays: []int{1, 3, 5}}, StartDay: repeat.AddDays(mon, -10), BackfillDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, tue, 0); err != nil {
		t.Fatalf("周二补打卡: %v", err)
	}
	st, err := a.HabitStat(ctx, HabitStatRequest{Start: mon, End: repeat.AddDays(mon, 6)})
	if err != nil {
		t.Fatal(err)
	}
	row := st.Habits[0]
	var cell HabitStatDay
	for _, c := range row.Days {
		if c.Day == tue {
			cell = c
		}
	}
	if cell.State != "done" {
		t.Errorf("没排期但打了卡的那天应显示 done，实得 %s", cell.State)
	}
	if row.Checked != 1 {
		t.Errorf("打卡天数应算上这天，实得 %d", row.Checked)
	}
	if row.Scheduled != 3 {
		t.Errorf("应打天数仍只数一三五 3 天，实得 %d", row.Scheduled)
	}
	// 额外补打不该把「完美打卡」算成 Done>Scheduled 而永远不完美
	for _, d := range st.Days {
		if d.Done > d.Scheduled {
			t.Errorf("%s 的打满数(%d)超过了应打数(%d)", d.Day, d.Done, d.Scheduled)
		}
	}
}
