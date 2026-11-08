// Package e2e 用真实内核跑一条完整链路：种子数据 → 清单与习惯 → 重复展开 →
// 经本地文件夹通道在两台设备之间同步并收敛。
//
// 它是「UI 挂了也能确认内核没坏」的那道防线，也是改模型或改同步协议时的回归网。
package e2e

import (
	"context"
	"testing"
	"time"

	"planfordo/internal/core/model"
	"planfordo/internal/core/service"
	"planfordo/internal/core/store"
	plansync "planfordo/internal/core/sync"
)

type node struct {
	name string
	db   *store.DB
	svc  *service.App
	mgr  *plansync.Manager
}

// newNode 起一台设备：独立数据目录，共用同一个同步目录。
func newNode(t *testing.T, shared string) *node {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	svc := service.New(db, service.WithLocation(time.Local))
	if err := svc.Seed(context.Background()); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	mgr := plansync.NewManager(db)
	if err := mgr.SaveConfig(context.Background(), plansync.Config{
		Name: "shared", Kind: "localdir", Enabled: true,
		Options: map[string]string{"dir": shared},
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	return &node{db: db, svc: svc, mgr: mgr, name: db.DeviceID()}
}

func (n *node) sync(t *testing.T) plansync.Result {
	t.Helper()
	res, err := n.mgr.SyncOne(context.Background(), "shared")
	if err != nil {
		t.Fatalf("sync %s: %v", n.name, err)
	}
	return res
}

// TestFullLoop 覆盖：建事项、重复打卡、建习惯并打卡、双向同步后两端视图一致。
func TestFullLoop(t *testing.T) {
	shared := t.TempDir()
	a, b := newNode(t, shared), newNode(t, shared)
	ctx := context.Background()

	today := a.svc.Today()

	// A 建一条每日站会与一条每周例会。
	daily, err := a.svc.SaveItem(ctx, service.ItemInput{
		Title: "每日站会",
		Date:  model.DateSpec{Kind: model.DateSingle, Start: today},
		Repeat: &model.Repeat{Unit: model.UnitDay, Interval: 1,
			End: model.EndSpec{Mode: model.EndByDate, Date: a.svc.Today()}},
	}, service.ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem daily: %v", err)
	}
	if _, err := a.svc.SaveItem(ctx, service.ItemInput{
		Title: "写周报", Remark: "周五前",
		Date:      model.DateSpec{Kind: model.DateSingle, Start: today},
		Time:      model.TimeSpec{Kind: model.TimePoint, Start: "16:00"},
		Reminders: []model.Reminder{{Offset: model.ReminderOffset{Hours: 1}}},
	}, service.ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem once: %v", err)
	}
	if err := a.svc.SetItemClock(ctx, daily[0].ID, today, true); err != nil {
		t.Fatalf("SetItemClock: %v", err)
	}
	// 子任务：完成 1/2，父项在视图里要带进度。
	child, err := a.svc.SaveChild(ctx, service.ChildInput{ItemID: daily[0].ID, Title: "同步阻塞点"})
	if err != nil {
		t.Fatalf("SaveChild: %v", err)
	}
	if _, err := a.svc.SaveChild(ctx, service.ChildInput{ItemID: daily[0].ID, Title: "更新排期"}); err != nil {
		t.Fatalf("SaveChild 2: %v", err)
	}
	if err := a.svc.SetChildDone(ctx, child.ID, true); err != nil {
		t.Fatalf("SetChildDone: %v", err)
	}

	// A 建一个「每天一次」习惯并打卡。
	habit, err := a.svc.SaveHabit(ctx, service.HabitInput{
		Name: "跑步", Mode: model.HabitOncePerDay,
		Freq:     model.Frequency{Kind: model.FreqDaily},
		StartDay: today,
	})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	if _, err := a.svc.ClockHabit(ctx, habit.ID, today, 0); err != nil {
		t.Fatalf("ClockHabit: %v", err)
	}

	if res := a.sync(t); res.Pushed == 0 {
		t.Fatalf("A 首轮应把数据推上去：%+v", res)
	}
	resB := b.sync(t)
	if resB.Applied == 0 {
		t.Fatalf("B 应拉到数据：%+v", resB)
	}

	// B 的今日视图：站会已打卡，周报在未打卡桶，习惯算已坚持。
	viewB, err := b.svc.ListView(ctx, service.ListViewRequest{Day: today, ShowDone: true})
	if err != nil {
		t.Fatalf("B ListView: %v", err)
	}
	assertGroups(t, viewB, map[string]int{"overdue": 0, "today": 1, "later": 0, "done": 1})
	var dailyOcc service.Occurrence
	for _, g := range viewB.Groups {
		for _, o := range g.Items {
			if o.Item.Title == "每日站会" {
				dailyOcc = o
			}
		}
	}
	if dailyOcc.ChildTotal != 2 || dailyOcc.ChildDone != 1 {
		t.Errorf("同步过来的子任务进度不符：total=%d done=%d", dailyOcc.ChildTotal, dailyOcc.ChildDone)
	}

	habitB, err := b.svc.HabitMonthView(ctx, today, "")
	if err != nil {
		t.Fatalf("B HabitMonthView: %v", err)
	}
	rows := habitB.RowsByCtx["ctx-always"]
	if len(rows) != 1 || !rows[0].Clocked || rows[0].Streak != 1 {
		t.Fatalf("B 端习惯状态不符：%+v", rows)
	}

	// B 在自己设备上给「写周报」补一条标签，再回灌给 A。
	labels, err := b.svc.SaveLabel(ctx, service.LabelInput{Name: "重要"})
	if err != nil {
		t.Fatalf("SaveLabel: %v", err)
	}
	var weekly *model.ListItem
	items, err := b.svc.ListView(ctx, service.ListViewRequest{Day: today})
	if err != nil {
		t.Fatalf("B ListView 2: %v", err)
	}
	for _, g := range items.Groups {
		for _, o := range g.Items {
			if o.Item.Title == "写周报" {
				pinned := o.Item
				weekly = &pinned
			}
		}
	}
	if weekly == nil {
		t.Fatal("B 端找不到写周报")
	}
	if _, err := b.svc.SaveItem(ctx, service.ItemInput{ID: weekly.ID, Title: weekly.Title,
		LabelIDs: []string{labels.ID}, Date: weekly.Date, Time: weekly.Time}, service.ScopeAll, ""); err != nil {
		t.Fatalf("B SaveItem: %v", err)
	}
	b.sync(t)
	resA := a.sync(t)
	if resA.Applied == 0 {
		t.Errorf("A 应收到 B 的改动：%+v", resA)
	}

	// 两端最终必须看到同一条记录的同一份内容。
	waitConvergence(t, a, b)
	for _, n := range []*node{a, b} {
		row, found, err := n.db.Get(ctx, store.KindItem, weekly.ID)
		if err != nil || !found {
			t.Fatalf("%s 取不到周报: found=%v err=%v", n.name, found, err)
		}
		var it model.ListItem
		if err := row.Decode(&it); err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(it.LabelIDs) != 1 {
			t.Errorf("%s 端标签没同步过来：%+v", n.name, it.LabelIDs)
		}
	}
}

// TestRemindersSurviveSync 确认提醒配置跟着事项走，另一台设备也能算出同一时刻。
func TestRemindersSurviveSync(t *testing.T) {
	shared := t.TempDir()
	a, b := newNode(t, shared), newNode(t, shared)
	ctx := context.Background()

	tomorrow := addDay(t, a.svc.Today(), 1)
	if _, err := a.svc.SaveItem(ctx, service.ItemInput{
		Title:     "交周报",
		Date:      model.DateSpec{Kind: model.DateSingle, Start: tomorrow},
		Time:      model.TimeSpec{Kind: model.TimePoint, Start: "15:00"},
		Reminders: []model.Reminder{{Offset: model.ReminderOffset{Minutes: 30}}},
	}, service.ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	a.sync(t)
	b.sync(t)

	firesA, err := a.svc.UpcomingReminders(ctx, a.svc.Today(), "")
	if err != nil {
		t.Fatalf("A reminders: %v", err)
	}
	firesB, err := b.svc.UpcomingReminders(ctx, b.svc.Today(), "")
	if err != nil {
		t.Fatalf("B reminders: %v", err)
	}
	if len(firesA) != 1 || len(firesB) != 1 {
		t.Fatalf("两端各应有一条提醒：%d / %d", len(firesA), len(firesB))
	}
	if firesA[0].At != firesB[0].At {
		t.Errorf("同一事项两端算出的提醒时刻不同：%s vs %s", firesA[0].At, firesB[0].At)
	}
	if firesA[0].Day != tomorrow {
		t.Errorf("提醒所在天 = %s, want %s", firesA[0].Day, tomorrow)
	}
}

// waitConvergence 交替同步两端，直到它们的快照记录集一致——同步协议的最终一致性承诺。
func waitConvergence(t *testing.T, a, b *node) {
	t.Helper()
	for i := 0; i < 6; i++ {
		a.sync(t)
		b.sync(t)
		sa := snapshotCounts(t, a)
		sb := snapshotCounts(t, b)
		if sa == sb {
			return
		}
	}
	t.Fatalf("两轮之后两端记录数仍不同：%d vs %d", snapshotCounts(t, a), snapshotCounts(t, b))
}

func snapshotCounts(t *testing.T, n *node) int {
	t.Helper()
	rows, err := n.db.Rows(context.Background(), "", true)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	return len(rows)
}

func assertGroups(t *testing.T, v service.ListView, want map[string]int) {
	t.Helper()
	for _, g := range v.Groups {
		if w, ok := want[g.Key]; ok && g.Count != w {
			t.Errorf("桶 %s 计数 = %d, want %d", g.Key, g.Count, w)
		}
	}
	if len(v.Groups) != len(want) {
		t.Errorf("分组数 = %d, want %d", len(v.Groups), len(want))
	}
}

func addDay(t *testing.T, day string, n int) string {
	t.Helper()
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		t.Fatalf("parse %q: %v", day, err)
	}
	return d.AddDate(0, 0, n).Format("2006-01-02")
}
