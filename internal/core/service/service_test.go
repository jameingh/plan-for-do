package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

func newApp(t *testing.T, opts ...Option) (*App, context.Context) {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	a := New(db, append([]Option{WithLocation(time.Local)}, opts...)...)
	if err := a.Seed(context.Background()); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	return a, context.Background()
}

func findGroup(v ListView, key string) *GroupView {
	for i := range v.Groups {
		if v.Groups[i].Key == key {
			return &v.Groups[i]
		}
	}
	return nil
}

func TestSeedIsIdempotentAndFixedIDs(t *testing.T) {
	a, ctx := newApp(t)
	if err := a.Seed(ctx); err != nil {
		t.Fatalf("重复 Seed: %v", err)
	}
	lists, err := a.Lists(ctx)
	if err != nil || len(lists) != 1 || lists[0].ID != model.DefaultListID {
		t.Fatalf("清单本 = %+v err=%v", lists, err)
	}
	cats, err := a.HabitContexts(ctx)
	if err != nil || len(cats) != 4 {
		t.Fatalf("情境数 = %d err=%v", len(cats), err)
	}
	units, err := a.HabitUnits(ctx)
	if err != nil || len(units) != 7 {
		t.Fatalf("单位数 = %d err=%v", len(units), err)
	}
}

func TestListViewBucketsClockAndUndo(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	overdue := repeat.AddDays(today, -3)

	if _, err := a.SaveItem(ctx, ItemInput{Title: "今日项", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	late, err := a.SaveItem(ctx, ItemInput{Title: "逾期项", Date: model.DateSpec{Kind: model.DateSingle, Start: overdue}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}

	view, err := a.ListView(ctx, ListViewRequest{Day: today})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if g := findGroup(view, "today"); g == nil || g.Count != 1 {
		t.Fatalf("今日桶 = %+v", g)
	}
	g := findGroup(view, "overdue")
	if g == nil || g.Count != 1 || g.Items[0].OverdueDays != 3 {
		t.Fatalf("逾期桶 = %+v", g)
	}

	if err := a.SetItemClock(ctx, late[0].ID, overdue, true); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	view, err = a.ListView(ctx, ListViewRequest{Day: today, ShowDone: true})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if findGroup(view, "overdue").Count != 0 {
		t.Error("打过卡的逾期项不该还留在逾期桶")
	}
	if findGroup(view, "done").Count != 1 {
		t.Error("打过卡的项目没进已打卡桶")
	}

	if err := a.SetItemClock(ctx, late[0].ID, overdue, false); err != nil {
		t.Fatalf("取消打卡: %v", err)
	}
	view, _ = a.ListView(ctx, ListViewRequest{Day: today})
	if findGroup(view, "overdue").Count != 1 {
		t.Error("取消打卡后应回到逾期桶")
	}
}

func TestRecurringClockOnlyAffectsOneDay(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	weekly := []int{repeat.Weekday(today)}
	created, err := a.SaveItem(ctx, ItemInput{
		Title:  "每周例会",
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: weekly},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	item := created[0]

	days := repeat.Occurrences(item, today, repeat.AddDays(today, 27), nil)
	if len(days) != 4 {
		t.Fatalf("四周内应命中 4 次，得到 %v", days)
	}
	if err := a.SetItemClock(ctx, item.ID, days[1], true); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: today, ShowDone: true})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	// 同一条事项在每个桶里只出现一次，所以 later 是 1 而不是剩下的 2 次。
	if g := findGroup(view, "today"); g == nil || g.Count != 1 {
		t.Errorf("今天这一次仍未打卡：%+v", g)
	}
	if g := findGroup(view, "later"); g == nil || g.Count != 1 {
		t.Errorf("待办桶 = %+v", g)
	}
	if g := findGroup(view, "done"); g == nil || g.Count != 1 {
		t.Errorf("已打卡桶 = %+v", g)
	}
}

func TestPostponeMovesOccurrenceToToday(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	overdue := repeat.AddDays(today, -5)
	created, err := a.SaveItem(ctx, ItemInput{Title: "顺延我", Date: model.DateSpec{Kind: model.DateSingle, Start: overdue}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	n, err := a.Postpone(ctx, []string{created[0].ID}, overdue, today)
	if err != nil || n != 1 {
		t.Fatalf("Postpone n=%d err=%v", n, err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: today})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if g := findGroup(view, "overdue"); g.Count != 0 {
		t.Errorf("顺延后逾期桶应清空：%+v", g)
	}
	g := findGroup(view, "today")
	if g == nil || g.Count != 1 || g.Items[0].PostponedFrom != overdue {
		t.Fatalf("顺延项没回到今日桶：%+v", g)
	}
	// 本体日期不能被顺延改掉，否则同步到另一台设备会看到被改过的原日期。
	back, found, err := a.DB().Get(ctx, store.KindItem, created[0].ID)
	if err != nil || !found {
		t.Fatalf("Get found=%v err=%v", found, err)
	}
	var it model.ListItem
	if err := back.Decode(&it); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if it.Date.Start != overdue {
		t.Errorf("顺延改了本体日期：%q → %q", overdue, it.Date.Start)
	}
}

func TestSaveItemScopeThisDaySplitsSeries(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	created, err := a.SaveItem(ctx, ItemInput{
		Title:  "每日站会",
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1, End: model.EndSpec{Mode: model.EndByDate, Date: repeat.AddDays(today, 6)}},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	origin := created[0]

	changed, err := a.SaveItem(ctx, ItemInput{
		ID:    origin.ID,
		Title: "只改今天",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: today},
	}, ScopeThisDay, today)
	if err != nil {
		t.Fatalf("ScopeThisDay: %v", err)
	}
	if len(changed) != 3 {
		t.Fatalf("应产出 截断本体 + 当日新项 + 续接序列 三条，得到 %d 条", len(changed))
	}
	var truncated, todayItem, forward *model.ListItem
	for _, c := range changed {
		switch {
		case c.ID == origin.ID:
			truncated = c
		case c.Repeat == nil:
			todayItem = c
		default:
			forward = c
		}
	}
	if truncated == nil || truncated.Repeat == nil || truncated.Repeat.End.Mode != model.EndByDate ||
		truncated.Repeat.End.Date != repeat.AddDays(today, -1) {
		t.Fatalf("原序列没有截断到昨天：%+v", truncated)
	}
	if todayItem == nil || todayItem.Title != "只改今天" || todayItem.Date.Start != today {
		t.Fatalf("当日事项不符：%+v", todayItem)
	}
	if forward == nil || forward.Title != "每日站会" || forward.Date.Start != repeat.AddDays(today, 1) {
		t.Fatalf("续接序列不符：%+v", forward)
	}
	// 续接的序列不能把今天也算回去。
	if days := repeat.Occurrences(forward, today, repeat.AddDays(today, 3), nil); len(days) != 3 || days[0] != repeat.AddDays(today, 1) {
		t.Errorf("续接序列命中日 = %v", days)
	}
	// 今天这一条只出现一次。
	view, err := a.ListView(ctx, ListViewRequest{Day: today})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if g := findGroup(view, "today"); g == nil || g.Count != 1 || g.Items[0].Item.Title != "只改今天" {
		t.Errorf("今日桶 = %+v", g)
	}
}

func TestSaveItemScopeOnwardKeepsHistory(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	past := repeat.AddDays(today, -10)
	created, err := a.SaveItem(ctx, ItemInput{
		Title:  "旧规则",
		Date:   model.DateSpec{Kind: model.DateSingle, Start: past},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	changed, err := a.SaveItem(ctx, ItemInput{
		ID:     created[0].ID,
		Title:  "新规则",
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{repeat.Weekday(today)}},
	}, ScopeOnward, today)
	if err != nil {
		t.Fatalf("ScopeOnward: %v", err)
	}
	if len(changed) != 2 {
		t.Fatalf("应产出 截断 + 新序列 两条，得到 %d", len(changed))
	}
	var oldItem, newItem *model.ListItem
	for _, c := range changed {
		if c.Title == "旧规则" {
			oldItem = c
		} else {
			newItem = c
		}
	}
	if oldItem.Repeat.End.Date != repeat.AddDays(today, -1) {
		t.Errorf("旧序列没截断到昨天：%+v", oldItem.Repeat.End)
	}
	// 历史仍在：昨天之前照样有实例。
	if days := repeat.Occurrences(oldItem, past, repeat.AddDays(today, -1), nil); len(days) != 10 {
		t.Errorf("旧序列历史实例数 = %d, want 10", len(days))
	}
	// 未来按新规则：本周只剩今天这一次。
	view, err := a.ListView(ctx, ListViewRequest{Day: today, HorizonDays: 7})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	total := 0
	for _, g := range view.Groups {
		for _, o := range g.Items {
			if o.Item.ID == newItem.ID {
				total++
			}
		}
	}
	if total != 2 { // 今天 + 一周后（在 6 天窗口内）
		t.Errorf("新规则实例数 = %d, want 2", total)
	}
}

func TestHabitClockStreakAndBackfill(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	h, err := a.SaveHabit(ctx, HabitInput{Name: "跑步", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: repeat.AddDays(today, -4)})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, today, 0); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	view, err := a.HabitMonthView(ctx, today, "")
	if err != nil {
		t.Fatalf("HabitMonthView: %v", err)
	}
	rows := view.RowsByCtx["ctx-always"]
	if len(rows) != 1 {
		t.Fatalf("习惯没落到「全天」情境：%+v", rows)
	}
	row := rows[0]
	if !row.Clocked || row.Streak != 1 || row.Target != 1 {
		t.Errorf("行状态不符：%+v", row)
	}

	// 补打卡：默认 BackfillDays=0 时昨天的也不能补。
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, -1), 0); err == nil {
		t.Error("默认不允许补打卡时必须拒绝")
	}
	if _, err := a.SaveHabit(ctx, HabitInput{ID: h.ID, Name: "跑步", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: repeat.AddDays(today, -4), BackfillDays: 2}); err != nil {
		t.Fatalf("改习惯: %v", err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, -2), 0); err != nil {
		t.Errorf("可回溯 2 天时应允许补打卡: %v", err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, -4), 0); err == nil {
		t.Error("超出可回溯范围必须拒绝")
	}
	if _, err := a.ClockHabit(ctx, h.ID, repeat.AddDays(today, 1), 0); err == nil {
		t.Error("不能提前打卡")
	}

	// 两台设备同一天各打一次「每天一次」，确定性主键让它只留一条。
	first, err := a.ClockHabit(ctx, h.ID, today, 0)
	if err != nil {
		t.Fatalf("重复打卡: %v", err)
	}
	if _, err := a.ClockHabit(ctx, h.ID, today, 0); err != nil {
		t.Fatalf("同天主键冲突应覆盖而不是报错: %v", err)
	}
	rows2, err := a.db.Rows(ctx, store.KindHabitClock, false)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	n := 0
	for _, r := range rows2 {
		var c model.HabitClock
		if err := r.Decode(&c); err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if c.Day == today {
			n++
		}
	}
	if n != 1 {
		t.Errorf("今天应有且只有 1 条打卡，得到 %d（首条 ID=%s）", n, first.ID)
	}

	// 取消打卡要能传播：留 tombstone 而不是物理删除。
	if got, err := a.CancelHabitClock(ctx, h.ID, today); err != nil || got != 1 {
		t.Fatalf("CancelHabitClock got=%d err=%v", got, err)
	}
	view, _ = a.HabitMonthView(ctx, today, "")
	if row := view.RowsByCtx["ctx-always"][0]; row.Clocked {
		t.Error("取消打卡后仍显示已打卡")
	}
}

// cellOn 取月切片里某天的格子；没有这天就返回零值（State 为空串，测试会失败）。
func cellOn(cells []HabitCell, day string) HabitCell {
	for _, c := range cells {
		if c.Day == day {
			return c
		}
	}
	return HabitCell{Day: day}
}

func TestHabitMultiPerDayAndStats(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	h, err := a.SaveHabit(ctx, HabitInput{
		Name: "喝水", Mode: model.HabitMultiPerDay, DailyTarget: 4, PerClock: 1,
		UnitID: "unit-cup", Freq: model.Frequency{Kind: model.FreqDaily},
		StartDay: repeat.AddDays(today, -3),
	})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := a.ClockHabit(ctx, h.ID, today, 1); err != nil {
			t.Fatalf("打卡 %d: %v", i, err)
		}
	}
	view, err := a.HabitMonthView(ctx, today, "")
	if err != nil {
		t.Fatalf("HabitMonthView: %v", err)
	}
	row := view.RowsByCtx["ctx-always"][0]
	if row.Amount != 3 || row.Clocked || row.Target != 4 {
		t.Fatalf("量化习惯进度不符：%+v", row)
	}

	// 统计只算到今天：未来几天还没发生，不该进「计划打卡」。
	// 计划数按「本月一号与起始日较晚者 → 今天」算，避免测试跟着日期漂移。
	monthStart := today[:7] + "-01"
	windowStart := monthStart
	if repeat.DiffDays(windowStart, repeat.AddDays(today, -3)) > 0 {
		windowStart = repeat.AddDays(today, -3)
	}
	wantPlanned := repeat.DiffDays(windowStart, today) + 1

	st, err := a.HabitStats(ctx, h.ID, today[:7])
	if err != nil {
		t.Fatalf("HabitStats: %v", err)
	}
	if st.StartDay != repeat.AddDays(today, -3) || st.DaysSince != 3 {
		t.Errorf("起始日/距今不符：%+v", st)
	}
	if st.Planned != wantPlanned {
		t.Errorf("计划打卡 = %d, want %d（%s → %s）：%+v", st.Planned, wantPlanned, windowStart, today, st)
	}
	if st.Actual != 0 || st.TotalDays != 1 {
		t.Errorf("3/4 还没达标，实际打卡数应为 0，有打卡的天数应为 1：%+v", st)
	}
	// 今天还没过完，不能算「错过」：它单独进 pending。
	if st.Pending != 1 || st.Missed != wantPlanned-1 {
		t.Errorf("今天不该算错过：pending = %d, missed = %d, want pending=1 missed=%d：%+v", st.Pending, st.Missed, wantPlanned-1, st)
	}
	if todayCell := cellOn(row.Month, today); todayCell.State != "partial" {
		t.Errorf("今天 3/4 的格子状态 = %s, want partial（部分完成不算错过）", todayCell.State)
	}
	// 一次型习惯今天还没打卡：同样是 pending，不是 missed。
	once, err := a.SaveHabit(ctx, HabitInput{
		Name: "背书", Mode: model.HabitOncePerDay,
		Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: today,
	})
	if err != nil {
		t.Fatalf("SaveHabit 背书: %v", err)
	}
	view, err = a.HabitMonthView(ctx, today, "")
	if err != nil {
		t.Fatalf("HabitMonthView 2: %v", err)
	}
	var onceRow *HabitRow
	for i := range view.RowsByCtx["ctx-always"] {
		if view.RowsByCtx["ctx-always"][i].Habit.ID == once.ID {
			onceRow = &view.RowsByCtx["ctx-always"][i]
		}
	}
	if onceRow == nil {
		t.Fatalf("视图里没有背书：%+v", view.RowsByCtx["ctx-always"])
	}
	if c := cellOn(onceRow.Month, today); c.State != "pending" {
		t.Errorf("今天未打卡的格子状态 = %s, want pending", c.State)
	}
	onceStats, err := a.HabitStats(ctx, once.ID, today[:7])
	if err != nil {
		t.Fatalf("HabitStats 背书: %v", err)
	}
	if onceStats.Missed != 0 || onceStats.Pending != 1 {
		t.Errorf("背书今天未打卡不该计错过：missed = %d pending = %d", onceStats.Missed, onceStats.Pending)
	}
	if _, err := a.ClockHabit(ctx, h.ID, today, 1); err != nil {
		t.Fatalf("补满: %v", err)
	}
	st, err = a.HabitStats(ctx, h.ID, today[:7])
	if err != nil {
		t.Fatalf("HabitStats 2: %v", err)
	}
	if st.Actual != 1 || st.LongestStreak != 1 {
		t.Errorf("打满 4 次后应计 1 天达标、连续 1 天：%+v", st)
	}
	if st.Pending != 0 {
		t.Errorf("达标后 pending 应归 0：%+v", st)
	}
	if st.Ratio != 100/wantPlanned {
		t.Errorf("月进度 = %d, want %d：%+v", st.Ratio, 100/wantPlanned, st)
	}
}

func TestDeleteCategorySemantics(t *testing.T) {
	a, ctx := newApp(t)
	cat, err := a.SaveCategory(ctx, CategoryInput{Name: "工作", Color: "#337"})
	if err != nil {
		t.Fatalf("SaveCategory: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{Title: "开会", Category: cat.ID, Date: model.DateSpec{Kind: model.DateSingle, Start: a.Today()}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	kept, err := a.DeleteCategory(ctx, cat.ID, false)
	if err != nil || kept != 1 {
		t.Fatalf("保留事项删分类 kept=%d err=%v", kept, err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: a.Today()})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if g := findGroup(view, "today"); g == nil || g.Count != 1 {
		t.Fatalf("事项不该跟着分类一起消失：%+v", g)
	}

	cat2, _ := a.SaveCategory(ctx, CategoryInput{Name: "作废"})
	a.SaveItem(ctx, ItemInput{Title: "陪葬", Category: cat2.ID}, ScopeAll, "")
	dropped, err := a.DeleteCategory(ctx, cat2.ID, true)
	if err != nil || dropped != 1 {
		t.Fatalf("连事项一起删 dropped=%d err=%v", dropped, err)
	}
	if _, err := a.getItem(ctx, "nope"); err == nil {
		t.Error("getItem 对不存在的 ID 必须报错")
	}
}

func TestUpcomingRemindersUsesLocalWallClock(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	tomorrow := repeat.AddDays(today, 1)
	_, err := a.SaveItem(ctx, ItemInput{
		Title:     "交周报",
		Date:      model.DateSpec{Kind: model.DateSingle, Start: tomorrow},
		Time:      model.TimeSpec{Kind: model.TimePoint, Start: "15:00"},
		Reminders: []model.Reminder{{Offset: model.ReminderOffset{Hours: 1}}},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	fires, err := a.UpcomingReminders(ctx, today, repeat.AddDays(today, 3))
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	if len(fires) != 1 {
		t.Fatalf("提醒数 = %d, want 1（%+v）", len(fires), fires)
	}
	at, ok := tclock.Parse(fires[0].At)
	if !ok {
		t.Fatalf("提醒时刻解析不了：%q", fires[0].At)
	}
	local := at.In(time.Local)
	if local.Format("2006-01-02") != tomorrow || local.Hour() != 14 {
		t.Errorf("提前 1 小时应落在 %s 14:00，实得 %s", tomorrow, local.Format(time.RFC3339))
	}

	// 已打卡的事项不再提醒。
	view, err := a.ListView(ctx, ListViewRequest{Day: tomorrow})
	if err != nil || findGroup(view, "later") == nil {
		t.Fatalf("明日事项没出现在待办：%+v err=%v", view.Groups, err)
	}
	if err := a.SetItemClock(ctx, fires[0].ItemID, tomorrow, true); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	fires, err = a.UpcomingReminders(ctx, today, repeat.AddDays(today, 3))
	if err != nil || len(fires) != 0 {
		t.Errorf("已打卡后仍产生提醒：%+v err=%v", fires, err)
	}
}

// TestAbsoluteReminderFires 对应界面上的「自定义提醒时间」：参考站把它存成
// remindType=2（一个绝对时刻，提前量为 0），不是「提前 N 天 M 时」。
// 内核要按那个绝对时刻报一次，且重复事项每天展开实例时不能把它算成 N 次。
func TestAbsoluteReminderFires(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	future := repeat.AddDays(today, 20)

	saved, err := a.SaveItem(ctx, ItemInput{
		Title: "线下读书会",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: today},
		Reminders: []model.Reminder{
			{Offset: model.ReminderOffset{}, AtDay: future, AtTime: "09:30"},
		},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	if len(saved[0].Reminders) != 1 || saved[0].Reminders[0].AtDay != future {
		t.Fatalf("AtDay 没落库：%+v", saved[0].Reminders)
	}

	fires, err := a.UpcomingReminders(ctx, today, repeat.AddDays(today, 30))
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	if len(fires) != 1 {
		t.Fatalf("绝对提醒应只报 1 次，实得 %d：%+v", len(fires), fires)
	}
	if fires[0].Day != future {
		t.Errorf("提醒日期应挂在提醒日本身，实得 %s（want %s）", fires[0].Day, future)
	}
	at, ok := tclock.Parse(fires[0].At)
	if !ok {
		t.Fatalf("提醒时刻解析不了：%q", fires[0].At)
	}
	if local := at.In(time.Local); local.Format("2006-01-02 15:04") != future+" 09:30" {
		t.Errorf("绝对提醒时刻 = %s, want %s 09:30", local.Format("2006-01-02 15:04"), future)
	}

	// 重复事项：实例每天展开，绝对提醒仍然只报一次。
	if _, err := a.SaveItem(ctx, ItemInput{
		Title:     "打卡晨跑",
		Date:      model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat:    &model.Repeat{Unit: model.UnitDay, Interval: 1},
		Reminders: []model.Reminder{{AtDay: future, AtTime: "19:00"}},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 重复事项: %v", err)
	}
	fires, err = a.UpcomingReminders(ctx, today, repeat.AddDays(today, 25))
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	n := 0
	for _, f := range fires {
		if f.Title == "打卡晨跑" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("重复事项的绝对提醒被算了 %d 次，want 1：%+v", n, fires)
	}

	// 事项没日期时也要响：自定义提醒写的是它自己那一天，不该跟着事项日期一起消失。
	if _, err := a.SaveItem(ctx, ItemInput{
		Title:     "还信用卡",
		Reminders: []model.Reminder{{AtDay: future, AtTime: "10:15"}},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 无日期事项: %v", err)
	}
	fires, err = a.UpcomingReminders(ctx, today, repeat.AddDays(today, 25))
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	var hit *ReminderFire
	for i := range fires {
		if fires[i].Title == "还信用卡" {
			hit = &fires[i]
		}
	}
	if hit == nil {
		t.Fatalf("无日期事项的自定义提醒没算出来：%+v", fires)
	}
	if hit.Day != future {
		t.Errorf("无日期事项的自定义提醒日期 = %s, want %s", hit.Day, future)
	}
	if at, ok := tclock.Parse(hit.At); !ok || at.In(time.Local).Format("15:04") != "10:15" {
		t.Errorf("无日期事项的自定义提醒时刻 = %v, want 10:15", hit.At)
	}
}

// TestRemindersCoexist 确认多条提醒（提前量 + 当天固定时刻 + 绝对时刻）互不覆盖：
// 参考站的提醒列表本来就是多选，之前我们只留最后一条，看着就像「自定义不生效」。
func TestRemindersCoexist(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	d2 := repeat.AddDays(today, 2)
	future := repeat.AddDays(today, 20)

	saved, err := a.SaveItem(ctx, ItemInput{
		Title: "年度体检",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: d2},
		Time:  model.TimeSpec{Kind: model.TimePoint, Start: "23:30"},
		Reminders: []model.Reminder{
			{Offset: model.ReminderOffset{Days: 1}},
			{Offset: model.ReminderOffset{}, AtTime: "09:00"},
			{Offset: model.ReminderOffset{}, AtDay: future, AtTime: "09:30"},
		},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	if len(saved[0].Reminders) != 3 {
		t.Fatalf("三条提醒应都落库，实得 %+v", saved[0].Reminders)
	}
	fires, err := a.UpcomingReminders(ctx, today, repeat.AddDays(today, 30))
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	seen := map[string]bool{}
	for _, f := range fires {
		seen[f.At] = true
	}
	if len(seen) != 3 {
		t.Fatalf("三个提醒时刻都该算出来，实得 %+v（%+v）", seen, fires)
	}
	// 提前 1 天 → d2 前一天 23:30；当天(09:00) → d2 09:00；绝对 → 提醒日 09:30。
	for _, want := range []string{
		tclock.Format(mustLocal(t, repeat.AddDays(d2, -1), 23, 30)),
		tclock.Format(mustLocal(t, d2, 9, 0)),
		tclock.Format(mustLocal(t, future, 9, 30)),
	} {
		if !seen[want] {
			t.Errorf("少了 %s 这次提醒，实得 %v", want, seen)
		}
	}
}

func mustLocal(t *testing.T, day model.Day, hh, mm int) time.Time {
	t.Helper()
	d, ok := repeat.ParseDay(day)
	if !ok {
		t.Fatalf("日期串 %q 解析不了", day)
	}
	return time.Date(d.Year(), d.Month(), d.Day(), hh, mm, 0, 0, time.Local)
}

func TestClockRejectsDaysWithoutOccurrence(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today() // 今天是什么星期都行，下面按它自己算命中日

	weekly, err := a.SaveItem(ctx, ItemInput{
		Title:  "周一例会",
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{repeat.Weekday(today)}},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	offDay := repeat.AddDays(today, 2) // 同星期 +2 天必定不命中
	if err := a.SetItemClock(ctx, weekly[0].ID, offDay, true); err == nil {
		t.Error("打卡到重复未命中的日子必须报错，否则会留下渲染不出来的孤儿 override")
	}

	undated, err := a.SaveItem(ctx, ItemInput{Title: "无日期"}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem undated: %v", err)
	}
	if err := a.SetItemClock(ctx, undated[0].ID, today, true); err == nil {
		t.Error("无日期事项没有「某一天」，打卡必须拒绝")
	}
	if _, err := a.Postpone(ctx, []string{undated[0].ID}, repeat.AddDays(today, -1), today); err == nil {
		t.Error("顺延一个不存在的实例必须报错")
	}

	// 顺延来的那一天虽然不在重复序列上，但已有 override，打卡要放行。
	later, err := a.SaveItem(ctx, ItemInput{Title: "会被顺延",
		Date: model.DateSpec{Kind: model.DateSingle, Start: repeat.AddDays(today, -4)}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	if n, err := a.Postpone(ctx, []string{later[0].ID}, repeat.AddDays(today, -4), today); err != nil || n != 1 {
		t.Fatalf("Postpone n=%d err=%v", n, err)
	}
	if err := a.SetItemClock(ctx, later[0].ID, today, true); err != nil {
		t.Errorf("顺延到今天的实例应可以打卡: %v", err)
	}
}

func TestListViewAlternateGroupings(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()

	cats, err := a.Categories(ctx)
	if err != nil || len(cats) != 0 {
		t.Fatalf("初始分类应为空：%v err=%v", cats, err)
	}
	work, err := a.SaveCategory(ctx, CategoryInput{Name: "工作", Color: "#36c"})
	if err != nil {
		t.Fatalf("SaveCategory: %v", err)
	}
	for i, p := range []model.Priority{
		model.QuadrantImportantUrgent, model.QuadrantImportant,
		model.QuadrantUrgent, model.QuadrantNone,
	} {
		if _, err := a.SaveItem(ctx, ItemInput{
			Title:    fmt.Sprintf("象限%d", i+1),
			Priority: p,
			Category: work.ID,
			Date:     model.DateSpec{Kind: model.DateSingle, Start: today},
		}, ScopeAll, ""); err != nil {
			t.Fatalf("SaveItem %d: %v", i, err)
		}
	}
	// 未设置优先级（0）与无日期事项都要能落到某个组，不能凭空消失。
	if _, err := a.SaveItem(ctx, ItemInput{Title: "默认优先级"}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem undated: %v", err)
	}
	// 重复事项在每个组里也只该出现一次。
	if _, err := a.SaveItem(ctx, ItemInput{
		Title:    "每日复盘",
		Priority: model.QuadrantImportant,
		Date:     model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat:   &model.Repeat{Unit: model.UnitDay, Interval: 1},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem recurring: %v", err)
	}

	total := 0
	for _, groupBy := range []string{"date", "category", "quadrants"} {
		view, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: groupBy, ShowDone: true})
		if err != nil {
			t.Fatalf("%s 分组报错: %v", groupBy, err)
		}
		// 前端直接 `g.items.length`，所以 items 绝不能是 null；空分组也必须给出空数组。
		raw, err := json.Marshal(view)
		if err != nil {
			t.Fatalf("%s 序列化: %v", groupBy, err)
		}
		if strings.Contains(string(raw), "null") {
			t.Errorf("%s 分组结果里有 null，前端会崩：%s", groupBy, raw)
		}
		count := 0
		for _, g := range view.Groups {
			if g.Key == "" || g.Label == "" {
				t.Errorf("%s 分组有空的 Key/Label：%+v", groupBy, g)
			}
			if g.Count != len(g.Items) {
				t.Errorf("%s 组 %s 计数 %d 与实际 %d 不符", groupBy, g.Key, g.Count, len(g.Items))
			}
			seen := map[string]bool{}
			for _, o := range g.Items {
				if seen[o.Item.ID] {
					t.Errorf("%s 组 %s 里同一条事项出现了两次：%s", groupBy, g.Key, o.Item.ID)
				}
				seen[o.Item.ID] = true
				count++
			}
		}
		// 日期分组按桶展示，重复事项在「今天」和「待办」各算一次实例；
		// 分类与四象限按事项折叠，6 条就是 6 条。
		want := 6
		if groupBy == "date" {
			want = 7
		}
		if count != want {
			t.Errorf("%s 分组共 %d 条，want %d", groupBy, count, want)
		}
		if groupBy == "quadrants" {
			total = count
		}
	}
	if total != 6 {
		t.Fatalf("四象限分组漏条目：%d", total)
	}

	// 未知分组方式要报错，而不是静默返回空屏。
	if _, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: "nonsense"}); err == nil {
		t.Error("未知分组方式必须报错")
	}

	// 四象限里优先级 0 必须归到「不重要不紧急」，与新建时的默认值一致。
	view, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: "quadrants"})
	if err != nil {
		t.Fatalf("quadrants: %v", err)
	}
	q4 := findGroup(view, "q4")
	if q4 == nil {
		t.Fatalf("四象限分组结果 = %+v", view.Groups)
	}
	foundDefault, foundUndated := false, false
	for _, o := range q4.Items {
		if o.Item.Title == "默认优先级" {
			foundDefault = true
			foundUndated = o.Day == ""
		}
	}
	if !foundDefault {
		t.Errorf("优先级 0 的事项没归进第四象限：%+v", q4.Items)
	}
	if !foundUndated {
		t.Error("无日期事项在四象限里应保留空日期标记")
	}

	// 打过卡的事项必须在四象限里作为「已打卡」出现（参考站的象限卡就是这么排的），
	// 关掉「显示已打卡」时又得整体消失。
	dateView, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: "date"})
	if err != nil {
		t.Fatalf("date: %v", err)
	}
	var target Occurrence
	for _, g := range dateView.Groups {
		for _, o := range g.Items {
			if o.Item.Title == "象限1" {
				target = o
			}
		}
	}
	if target.Item.ID == "" {
		t.Fatal("找不到象限1")
	}
	if err := a.SetItemClock(ctx, target.Item.ID, target.Day, true); err != nil {
		t.Fatalf("SetItemClock: %v", err)
	}
	q, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: "quadrants", ShowDone: true})
	if err != nil {
		t.Fatalf("quadrants showDone: %v", err)
	}
	clocked := 0
	for _, g := range q.Groups {
		for _, o := range g.Items {
			if o.Item.ID == target.Item.ID && o.Status == model.StatusClocked {
				clocked++
			}
		}
	}
	if clocked == 0 {
		t.Error("四象限分组里拿不到已打卡事项，界面上的「已打卡」子组永远是空的")
	}
	hidden, err := a.ListView(ctx, ListViewRequest{Day: today, GroupBy: "quadrants"})
	if err != nil {
		t.Fatalf("quadrants hideDone: %v", err)
	}
	for _, g := range hidden.Groups {
		for _, o := range g.Items {
			if o.Status == model.StatusClocked {
				t.Errorf("关掉「显示已打卡」后四象限里仍有已打卡项：%s", o.Item.Title)
			}
		}
	}
}

func TestUndatedItemStaysInTodo(t *testing.T) {
	a, ctx := newApp(t)
	if _, err := a.SaveItem(ctx, ItemInput{Title: "随时可做", Date: model.DateSpec{Kind: model.DateSingle}}, ScopeAll, ""); err != nil {
		t.Fatalf("无日期事项建不出来: %v", err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: a.Today()})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	g := findGroup(view, "later")
	if g == nil || g.Count != 1 {
		t.Fatalf("无日期事项应恒在待办：%+v", g)
	}
}

func TestLabelDedupeAndCap(t *testing.T) {
	a, ctx := newApp(t)
	first, err := a.SaveLabel(ctx, LabelInput{Name: "加班"})
	if err != nil {
		t.Fatalf("SaveLabel: %v", err)
	}
	second, err := a.SaveLabel(ctx, LabelInput{Name: " 加班 "})
	if err != nil {
		t.Fatalf("重名 SaveLabel: %v", err)
	}
	if first.ID != second.ID {
		t.Errorf("同名标签应复用： %s vs %s", first.ID, second.ID)
	}
	many := make([]string, 0, model.MaxLabelsPerItem+1)
	for i := 0; i <= model.MaxLabelsPerItem; i++ {
		many = append(many, second.ID)
	}
	if _, err := a.SaveItem(ctx, ItemInput{Title: "标签超上限", LabelIDs: many}, ScopeAll, ""); err == nil {
		t.Error("超过 MaxLabelsPerItem 必须报错")
	}
}

// 失败打卡是一等状态：这一天算结清（离开未打卡/逾期），但记号与成功不同。
func TestClockFailedSettlesTheDay(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	it, err := a.SaveItem(ctx, ItemInput{Title: "晨跑", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	if err := a.SetItemClockState(ctx, it[0].ID, today, model.StatusFailed); err != nil {
		t.Fatalf("失败打卡: %v", err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: today, ShowDone: true})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if findGroup(view, "today").Count != 0 {
		t.Error("失败打卡后不该还留在未打卡")
	}
	done := findGroup(view, "done")
	if done.Count != 1 || done.Items[0].Status != model.StatusFailed {
		t.Errorf("已打卡桶 = %+v，应含一条 StatusFailed", done)
	}
	if done.Count == 1 && done.Items[0].ClockedAt == "" {
		t.Error("失败打卡也要留打卡时间，否则两设备无法判定谁更新")
	}
	// 取消 → 回到未打卡
	if err := a.SetItemClockState(ctx, it[0].ID, today, model.StatusPending); err != nil {
		t.Fatalf("取消: %v", err)
	}
	view, _ = a.ListView(ctx, ListViewRequest{Day: today, ShowDone: true})
	if findGroup(view, "today").Count != 1 {
		t.Error("取消打卡后应回到未打卡")
	}
	// 非法状态要挡住，不能静默写进库
	if err := a.SetItemClockState(ctx, it[0].ID, today, model.StatusSkipped); err == nil {
		t.Error("Skipped 不该能由打卡入口写入")
	}
}

// 置顶只改顺序，不改内容与时间。
func TestSetItemTopPinsFirst(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	if _, err := a.SaveItem(ctx, ItemInput{Title: "A 最早", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem A: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{Title: "B 后来", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem B: %v", err)
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: today})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	g := findGroup(view, "today")
	if g.Count != 2 || g.Items[0].Item.Title != "A 最早" {
		t.Fatalf("默认顺序 = %+v", g.Items)
	}

	if err := a.SetItemTop(ctx, g.Items[1].Item.ID, true); err != nil {
		t.Fatalf("置顶: %v", err)
	}
	view, _ = a.ListView(ctx, ListViewRequest{Day: today})
	g = findGroup(view, "today")
	if g.Items[0].Item.Title != "B 后来" || !g.Items[0].Item.IsTop {
		t.Errorf("置顶项没排到最前：%+v", g.Items)
	}

	before := g.Items[0].Item.UpdatedAt
	if err := a.SetItemTop(ctx, g.Items[0].Item.ID, true); err != nil { // 重复置顶
		t.Fatalf("重复置顶: %v", err)
	}
	view, _ = a.ListView(ctx, ListViewRequest{Day: today})
	if got := findGroup(view, "today").Items[0].Item.UpdatedAt; got != before {
		t.Errorf("重复置顶把 updated_at 推进了（%s → %s），同步会误判成新版本", before, got)
	}

	if err := a.SetItemTop(ctx, g.Items[0].Item.ID, false); err != nil {
		t.Fatalf("取消置顶: %v", err)
	}
	view, _ = a.ListView(ctx, ListViewRequest{Day: today})
	if got := findGroup(view, "today").Items[0].Item.Title; got != "A 最早" {
		t.Errorf("取消置顶后应回到原顺序，首位是 %q", got)
	}
}

// 回归：重复面板把当前已选中的规则再点一次，不该截断旧序列 + 新建一条同名事项。
// 用户报的就是这个——点几次多几条。
func TestSaveItemOnwardWithSameRuleDoesNotDuplicate(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	it, err := a.SaveItem(ctx, ItemInput{
		Title: "复习单词", Date: model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	id := it[0].ID

	in := ItemInput{ID: id, Title: "复习单词", Date: model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1}, Priority: model.QuadrantNone, LabelIDs: []string{}, Reminders: []model.Reminder{}}
	before := countItems(t, a, ctx)
	for i := 0; i < 3; i++ {
		out, err := a.SaveItem(ctx, in, ScopeOnward, today)
		if err != nil {
			t.Fatalf("第 %d 次重复提交: %v", i+1, err)
		}
		if len(out) != 1 || out[0].ID != id {
			t.Fatalf("无变化的提交不该换 ID，返回 %+v", out)
		}
	}
	if after := countItems(t, a, ctx); after != before {
		t.Errorf("同样规则提交 3 次后事项数 %d → %d，重复面板又在造新事项", before, after)
	}

	// 真改规则时仍要分段：这是「当日及未来」的既有语义，别把这条也一起挡掉
	in.Repeat = &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{3}}
	if _, err := a.SaveItem(ctx, in, ScopeOnward, today); err != nil {
		t.Fatalf("改规则: %v", err)
	}
	if after := countItems(t, a, ctx); after != before+1 {
		t.Errorf("真改规则应截断+新建（多 1 条），实际 %d → %d", before, after)
	}
}

func TestSaveItemAllScopeRewritesRule(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	out, err := a.SaveItem(ctx, ItemInput{
		Title: "喝水", ListID: model.DefaultListID,
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1, End: model.EndSpec{Mode: model.EndByCount, Count: 5}},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("建重复事项: %v", err)
	}
	id := out[0].ID
	before := countItems(t, a, ctx)

	// 界面上点「仅一次」= 作用范围选「全部清单」且 Repeat 传 nil。规则必须真的被清掉，
	// 否则详情里的「结束」行会一直赖着不走。
	if _, err := a.SaveItem(ctx, ItemInput{
		ID: id, Title: "喝水", ListID: model.DefaultListID,
		Date: model.DateSpec{Kind: model.DateSingle, Start: today}, Priority: model.QuadrantNone,
		LabelIDs: []string{}, Reminders: []model.Reminder{},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("清规则: %v", err)
	}
	got, err := a.getItem(ctx, id)
	if err != nil {
		t.Fatalf("读回: %v", err)
	}
	if got.Repeat != nil {
		t.Errorf("作用范围「全部清单」应能清掉重复规则，实际仍为 %+v", got.Repeat)
	}
	if after := countItems(t, a, ctx); after != before {
		t.Errorf("清规则不该新增事项：%d → %d", before, after)
	}

	// 反向：同一作用范围下也要能把规则装上并带上结束条件
	if _, err := a.SaveItem(ctx, ItemInput{
		ID: id, Title: "喝水", ListID: model.DefaultListID,
		Date:   model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{2}, End: model.EndSpec{Mode: model.EndByCount, Count: 8}},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("装规则: %v", err)
	}
	got, err = a.getItem(ctx, id)
	if err != nil {
		t.Fatalf("再读回: %v", err)
	}
	if got.Repeat == nil || got.Repeat.End.Mode != model.EndByCount || got.Repeat.End.Count != 8 {
		t.Errorf("结束条件没写进去，实际 %+v", got.Repeat)
	}
}

func countItems(t *testing.T, a *App, ctx context.Context) int {
	t.Helper()
	n, err := a.DB().CountByKind(ctx)
	if err != nil {
		t.Fatalf("CountByKind: %v", err)
	}
	return n[store.KindItem]
}

func TestHabitMonthlyQuotaStats(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	shift := func(n int) string {
		t, _ := repeat.ParseDay(today[:7] + "-01")
		return repeat.Format(t.AddDate(0, n, 0))
	}
	start := shift(-2) // 两个月前的月初开始，上一个整月才归这个习惯管
	if _, err := a.SaveHabit(ctx, HabitInput{Name: "复盘", Freq: model.Frequency{Kind: model.FreqMonthlyQuota, Plan: 2}, StartDay: start, BackfillDays: 400}); err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	h, err := a.habits(ctx)
	if err != nil || len(h) != 1 {
		t.Fatalf("habits: %v %d", err, len(h))
	}
	lastMonth := shift(-1)[:7]
	if _, err := a.ClockHabit(ctx, h[0].ID, lastMonth+"-05", 0); err != nil {
		t.Fatalf("ClockHabit: %v", err)
	}
	st, err := a.HabitStats(ctx, h[0].ID, lastMonth)
	if err != nil {
		t.Fatalf("HabitStats: %v", err)
	}
	if st.Planned != 2 || st.Actual != 1 || st.Missed != 1 {
		t.Errorf("上月配额应为 计划2/实际1/错过1，实得 计划%d/实际%d/错过%d", st.Planned, st.Actual, st.Missed)
	}
	// 本月只过了几天：配额算 1 份，没打满应记 pending 而不是 missed
	cur, err := a.HabitStats(ctx, h[0].ID, today[:7])
	if err != nil {
		t.Fatalf("HabitStats 本月: %v", err)
	}
	if cur.Planned != 2 || cur.Missed != 0 || cur.Pending != 1 {
		t.Errorf("本月应为 计划2/错过0/待打1，实得 计划%d/错过%d/待打%d", cur.Planned, cur.Missed, cur.Pending)
	}
}

func TestHabitRemindersAndPopMark(t *testing.T) {
	a, ctx := newApp(t)
	// 超过 2 条直接拒
	if _, err := a.SaveHabit(ctx, HabitInput{Name: "太多提醒", Reminders: []model.Reminder{
		{AtTime: "08:00"}, {AtTime: "09:00"}, {AtTime: "10:00"},
	}}); err == nil {
		t.Errorf("3 条提醒应该报错")
	}
	h, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Reminders: []model.Reminder{
		{AtTime: "20:00"}, {AtTime: "09:00"}, {AtTime: "09:00"},
	}})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	if len(h.Reminders) != 2 || h.Reminders[0].AtTime != "09:00" || h.Reminders[1].AtTime != "20:00" {
		t.Fatalf("提醒应去重并按时刻排序，实得 %+v", h.Reminders)
	}
	if !h.PopMark {
		t.Errorf("新建习惯默认应弹打卡心得")
	}
	off := false
	got, err := a.SaveHabit(ctx, HabitInput{ID: h.ID, Name: "喝水", PopMark: &off})
	if err != nil {
		t.Fatalf("关掉心得: %v", err)
	}
	if got.PopMark {
		t.Errorf("显式传 false 就该关掉")
	}
	// 不传 popMark 时保持原值，别把用户关掉的开关又打开
	again, err := a.SaveHabit(ctx, HabitInput{ID: h.ID, Name: "喝水改名"})
	if err != nil {
		t.Fatalf("改名: %v", err)
	}
	if again.PopMark {
		t.Errorf("没传 popMark 不该动它")
	}
}

func TestHabitUpcomingReminders(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	// 23:59 几乎永远是「还没到点」，用它保证测试不受运行时刻影响
	h, err := a.SaveHabit(ctx, HabitInput{Name: "睡前阅读", Reminders: []model.Reminder{{AtTime: "23:59"}}})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	fires, err := a.UpcomingReminders(ctx, today, today)
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	var hit *ReminderFire
	for i := range fires {
		if fires[i].Habit && fires[i].ItemID == h.ID {
			hit = &fires[i]
		}
	}
	if hit == nil {
		t.Fatalf("习惯提醒没进待触发列表：%+v", fires)
	}
	if hit.Day != today || hit.Title != "睡前阅读" {
		t.Errorf("提醒内容不对：%+v", hit)
	}
	// 打完这天就不该再提醒
	if _, err := a.ClockHabit(ctx, h.ID, today, 0); err != nil {
		t.Fatalf("ClockHabit: %v", err)
	}
	fires, err = a.UpcomingReminders(ctx, today, today)
	if err != nil {
		t.Fatalf("再查提醒: %v", err)
	}
	for _, f := range fires {
		if f.Habit && f.ItemID == h.ID {
			t.Errorf("已打卡的那天不该再提醒：%+v", f)
		}
	}
}

// 视图模块（日/周/月）按区间取数。清单页把实例折叠成四个桶，视图要的是逐日铺开，
// 所以下面几条都在钉这个差别：跨天事项每天都出现、折叠与排序规则、自定义视图的过滤。

func calendarCount(t *testing.T, v CalendarView, day model.Day) int {
	t.Helper()
	for _, d := range v.Days {
		if d.Day == day {
			return len(d.Items)
		}
	}
	t.Fatalf("区间里没有 %s 这天（%s → %s）", day, v.Start, v.End)
	return -1
}

func TestCalendarViewSpansAndOrder(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	d3 := repeat.AddDays(today, 3)

	if _, err := a.SaveItem(ctx, ItemInput{
		Title: "跨天出差",
		Date:  model.DateSpec{Kind: model.DateSpan, Start: today, End: d3},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 跨天: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{
		Title: "晚上开会",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: today},
		Time:  model.TimeSpec{Kind: model.TimePoint, Start: "20:00"},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 定时: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{
		Title: "没日期的事",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: ""},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 无日期: %v", err)
	}

	v, err := a.CalendarView(ctx, CalendarRequest{Start: today, End: repeat.AddDays(today, 6)})
	if err != nil {
		t.Fatalf("CalendarView: %v", err)
	}
	if len(v.Days) != 7 {
		t.Fatalf("应给出区间内 7 天，实得 %d", len(v.Days))
	}
	// 跨天事项每天都有一格，前端才连得出跨天条。今天另有一条定时事项。
	if n := calendarCount(t, v, today); n != 2 {
		t.Errorf("今天应有 跨天+定时 2 条，实得 %d", n)
	}
	for i := 1; i <= 3; i++ {
		if n := calendarCount(t, v, repeat.AddDays(today, i)); n != 1 {
			t.Errorf("第 %d 天应只有跨天事项 1 条，实得 %d", i, n)
		}
	}
	if n := calendarCount(t, v, repeat.AddDays(today, 4)); n != 0 {
		t.Errorf("跨天结束后不该再有实例，实得 %d", n)
	}
	// 无日期事项不进网格。
	for _, d := range v.Days {
		for _, o := range d.Items {
			if o.Item.Title == "没日期的事" {
				t.Errorf("无日期事项出现在 %s 的网格里", d.Day)
			}
		}
	}
	// 同一天：全天在前，其次按开始时刻。
	first := v.Days[0].Items
	if len(first) != 2 || first[0].Item.Title != "跨天出差" || first[1].Item.Title != "晚上开会" {
		t.Errorf("当天排序应为 全天→定时，实得 %+v", titlesOf(first))
	}

	// 跨天事项只结清其中一天，其余天仍要出现（ShowDone=false 时）。
	// 区间故意挑远一点（第 10~12 天），免得和上面那条「今天→第 3 天」的跨天事项混在一起。
	d10 := repeat.AddDays(today, 10)
	span, err := a.SaveItem(ctx, ItemInput{
		Title: "跨天装修",
		Date:  model.DateSpec{Kind: model.DateSpan, Start: d10, End: repeat.AddDays(d10, 2)},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem 装修: %v", err)
	}
	if err := a.SetItemClock(ctx, span[0].ID, d10, true); err != nil {
		t.Fatalf("打卡: %v", err)
	}
	v, err = a.CalendarView(ctx, CalendarRequest{Start: d10, End: repeat.AddDays(d10, 2), ShowDone: false})
	if err != nil {
		t.Fatalf("CalendarView 过滤已完成: %v", err)
	}
	if n := calendarCount(t, v, d10); n != 0 {
		t.Errorf("已打卡那天 ShowDone=false 不该出现，实得 %d", n)
	}
	if n := calendarCount(t, v, repeat.AddDays(d10, 1)); n != 1 {
		t.Errorf("跨天事项其余天仍要出现，实得 %d", n)
	}
	v, err = a.CalendarView(ctx, CalendarRequest{Start: d10, End: repeat.AddDays(d10, 2), ShowDone: true})
	if err != nil || calendarCount(t, v, d10) != 1 {
		t.Errorf("ShowDone=true 应把已打卡那天带回来：%d err=%v", calendarCount(t, v, d10), err)
	}
}

func TestCalendarViewFiltersAndHabits(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	end := repeat.AddDays(today, 6)

	cat, err := a.SaveCategory(ctx, CategoryInput{Name: "健身"})
	if err != nil {
		t.Fatalf("SaveCategory: %v", err)
	}
	label, err := a.SaveLabel(ctx, LabelInput{Name: "重要"})
	if err != nil {
		t.Fatalf("SaveLabel: %v", err)
	}
	got, err := a.SaveItem(ctx, ItemInput{
		Title: "跑步", Date: model.DateSpec{Kind: model.DateSingle, Start: today},
		Category: cat.ID, LabelIDs: []string{label.ID},
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	listID := got[0].ListID
	if _, err := a.SaveItem(ctx, ItemInput{
		Title: "周报", Date: model.DateSpec{Kind: model.DateSingle, Start: today},
	}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem 未分类: %v", err)
	}

	// 正向：只看某分类
	v, err := a.CalendarView(ctx, CalendarRequest{Start: today, End: end, CategoryIDs: []string{cat.ID}})
	if err != nil || calendarCount(t, v, today) != 1 || v.Days[0].Items[0].Item.Title != "跑步" {
		t.Errorf("按分类过滤失效：%+v err=%v", v.Days[0].Items, err)
	}
	// 反向：明确不看某分类（参考站的 viewMatterClassifyNotShow 就是这个语义）
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, HideCategoryIDs: []string{cat.ID}})
	if calendarCount(t, v, today) != 1 || v.Days[0].Items[0].Item.Title != "周报" {
		t.Errorf("反向过滤失效：%+v", v.Days[0].Items)
	}
	// "" 代表未分类，也能被反向列表挡住
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, HideCategoryIDs: []string{""}})
	if calendarCount(t, v, today) != 1 || v.Days[0].Items[0].Item.Title != "跑步" {
		t.Errorf("未分类过滤失效：%+v", v.Days[0].Items)
	}
	// 标签与清单本
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, LabelIDs: []string{label.ID}})
	if calendarCount(t, v, today) != 1 {
		t.Errorf("按标签过滤失效：%+v", v.Days[0].Items)
	}
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, ListIDs: []string{"不存在的本"}})
	if calendarCount(t, v, today) != 0 {
		t.Errorf("按清单本过滤失效：%+v", v.Days[0].Items)
	}
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, ListIDs: []string{listID}})
	if calendarCount(t, v, today) != 2 {
		t.Errorf("同一清单本应留 2 条，实得 %d", calendarCount(t, v, today))
	}

	// 习惯：每天一次只在排期日出现，打卡后状态变 done
	if _, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Freq: model.Frequency{Kind: model.FreqDaily}}); err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	v, err = a.CalendarView(ctx, CalendarRequest{Start: today, End: end, IncludeHabits: true})
	if err != nil {
		t.Fatalf("CalendarView 带习惯: %v", err)
	}
	if len(v.Days[0].Habits) != 1 || v.Days[0].Habits[0].State != "pending" {
		t.Errorf("习惯应出现在今天且未打卡：%+v", v.Days[0].Habits)
	}
	if len(v.Days[1].Habits) != 1 {
		t.Errorf("每天一次的习惯明天也该有格子：%+v", v.Days[1].Habits)
	}
	// 不带 IncludeHabits 时不该塞习惯
	v, _ = a.CalendarView(ctx, CalendarRequest{Start: today, End: end})
	if len(v.Days[0].Habits) != 0 {
		t.Errorf("没要习惯却返回了：%+v", v.Days[0].Habits)
	}
}

func TestCalendarViewRejectsBadRange(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	if _, err := a.CalendarView(ctx, CalendarRequest{Start: today, End: repeat.AddDays(today, -1)}); err == nil {
		t.Error("区间反了必须报错")
	}
	if _, err := a.CalendarView(ctx, CalendarRequest{Start: today, End: repeat.AddDays(today, calendarMaxDays)}); err == nil {
		t.Error("超上限必须报错")
	}
	v, err := a.CalendarView(ctx, CalendarRequest{})
	if err != nil || v.Start != today || len(v.Days) != 42 {
		t.Errorf("空请求应默认今天起 6 周：%+v err=%v", v, err)
	}
}

func titlesOf(xs []Occurrence) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		out = append(out, x.Item.Title)
	}
	return out
}
