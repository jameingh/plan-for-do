package service

import (
	"context"
	"testing"
	"time"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

// putFocus 直接写一条记录，用于构造「过去某天某个时刻专注过」这种没法靠实时计时跑出来的场景。
// 测试和内核同包，所以能用 a.db；界面侧走不到这条路。
func putFocus(t *testing.T, a *App, ctx context.Context, r *model.FocusRecord) {
	t.Helper()
	if r.CreatedAt == "" {
		r.CreatedAt = tclock.Now()
	}
	if r.UpdatedAt == "" {
		r.UpdatedAt = r.CreatedAt
	}
	e, err := store.NewEntity(store.KindFocus, r)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	if err := a.db.Put(ctx, e); err != nil {
		t.Fatalf("Put: %v", err)
	}
}

// at 是本地时刻 → 内核用的 UTC 定宽串。
func at(t *testing.T, day string, hour, min int) model.ClockTime {
	t.Helper()
	d, err := time.ParseInLocation("2006-01-02", day, time.Local)
	if err != nil {
		t.Fatalf("解析日期 %s: %v", day, err)
	}
	return tclock.Format(time.Date(d.Year(), d.Month(), d.Day(), hour, min, 0, 0, time.Local))
}

func TestFocusStartPauseResumeFinish(t *testing.T) {
	a, ctx := newApp(t)
	r, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp})
	if err != nil {
		t.Fatalf("FocusStart: %v", err)
	}
	if r.Status != model.FocusRunning || r.SegmentStart == "" {
		t.Fatalf("开始应是走表状态，实得 status=%d segment=%q", r.Status, r.SegmentStart)
	}
	// 同一时刻不允许第二次专注
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountDown, TargetSec: 60}); err == nil {
		t.Fatal("进行中还能再开一次专注，应该报错")
	}
	cur, err := a.FocusCurrent(ctx)
	if err != nil || cur == nil || cur.ID != r.ID {
		t.Fatalf("FocusCurrent 应回到那一次，实得 %+v err=%v", cur, err)
	}
	if _, err := a.FocusTick(ctx, r.ID); err != nil {
		t.Fatalf("FocusTick: %v", err)
	}
	if _, err := a.FocusPause(ctx, r.ID); err != nil {
		t.Fatalf("FocusPause: %v", err)
	}
	paused := getRec(t, a, ctx, r.ID)
	if paused.Status != model.FocusPaused || paused.SegmentStart != "" {
		t.Fatalf("暂停后段起点必须清空，实得 %+v", paused)
	}
	// 暂停期间的时间不能计进去
	before := paused.AccumSec
	if _, err := a.FocusTick(ctx, r.ID); err != nil {
		t.Fatalf("FocusTick paused: %v", err)
	}
	after := getRec(t, a, ctx, r.ID).AccumSec
	if after != before {
		t.Fatalf("暂停中不该继续累计：%d → %d", before, after)
	}
	if _, err := a.FocusResume(ctx, r.ID); err != nil {
		t.Fatalf("FocusResume: %v", err)
	}
	done, err := a.FocusFinish(ctx, r.ID, true)
	if err != nil {
		t.Fatalf("FocusFinish: %v", err)
	}
	if done.Status != model.FocusDone || done.EndAt == "" || done.ActualSec != done.AccumSec {
		t.Fatalf("结束应定格实际时长，实得 %+v", done)
	}
	if kinds := focusEventKinds(done); kinds[len(kinds)-1] != "end" {
		t.Fatalf("时间轴最后一条应是 end，实得 %v", kinds)
	}
	list, err := a.FocusList(ctx, "", 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("历史列表应有 1 条，实得 %d err=%v", len(list), err)
	}
	if cur, err := a.FocusCurrent(ctx); err != nil || cur != nil {
		t.Fatalf("结束后不该还有进行中的专注，实得 %+v", cur)
	}
	// 重复结束要报错，不能把已定格的记录再改一遍
	if _, err := a.FocusFinish(ctx, r.ID, true); err == nil {
		t.Fatal("已结束的专注再次结束应报错")
	}
}

func TestFocusFinishDiscardLeavesTombstone(t *testing.T) {
	a, ctx := newApp(t)
	r, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountDown, TargetSec: 300})
	if err != nil {
		t.Fatalf("FocusStart: %v", err)
	}
	dropped, err := a.FocusFinish(ctx, r.ID, false)
	if err != nil {
		t.Fatalf("FocusFinish(save=false): %v", err)
	}
	if dropped.DeletedAt == "" {
		t.Fatal("放弃必须留墓碑，否则另一台设备上的这条不会消失")
	}
	if list, _ := a.FocusList(ctx, "", 0); len(list) != 0 {
		t.Fatalf("放弃的记录不能进历史列表，实得 %d 条", len(list))
	}
	if _, err := a.FocusGet(ctx, r.ID); err == nil {
		t.Fatal("FocusGet 应把墓碑当作不存在")
	}
	// 放弃之后可以立刻开下一次
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp}); err != nil {
		t.Fatalf("放弃后重开应成功：%v", err)
	}
}

// TestFocusRecoverClampsCrashGap 锁住「关掉应用的那段时间不算专注」。
func TestFocusRecoverClampsCrashGap(t *testing.T) {
	a, ctx := newApp(t)
	r, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp})
	if err != nil {
		t.Fatalf("FocusStart: %v", err)
	}
	// 假装上一个 tick 之后进程就被关了：段起点挪到 3 小时前
	old := getRec(t, a, ctx, r.ID)
	old.SegmentStart = tclock.Format(time.Now().Add(-3 * time.Hour))
	if err := a.saveFocus(ctx, old, tclock.Now()); err != nil {
		t.Fatalf("saveFocus: %v", err)
	}
	back, err := a.FocusRecover(ctx, r.ID)
	if err != nil {
		t.Fatalf("FocusRecover: %v", err)
	}
	if back.AccumSec > focusRecoverGrace {
		t.Fatalf("崩溃期间的 3 小时不能算专注，实得 %d 秒", back.AccumSec)
	}
	if back.Status != model.FocusPaused || back.SegmentStart != "" {
		t.Fatalf("恢复后应停在暂停态等用户决定，实得 status=%d segment=%q", back.Status, back.SegmentStart)
	}
	if kinds := focusEventKinds(back); !containsString(kinds, "recover") {
		t.Fatalf("时间轴要留下「应用重启」这条，实得 %v", kinds)
	}
}

// TestFocusPomodoroRestNotCounted 锁住「休息不计入专注时长」。
func TestFocusPomodoroRestNotCounted(t *testing.T) {
	a, ctx := newApp(t)
	r, err := a.FocusStart(ctx, FocusStartRequest{
		Type:     model.FocusPomodoro,
		Pomodoro: &model.FocusPlan{Cycles: 2, ShortRest: 1, LongRest: 2, LongEvery: 4, AutoRest: true, FocusSec: 1500},
	})
	if err != nil {
		t.Fatalf("FocusStart: %v", err)
	}
	if r.Pomodoro == nil || r.Pomodoro.Cycles != 2 || r.TargetSec != 1500 {
		t.Fatalf("番茄配置应随记录存快照，实得 %+v target=%d", r.Pomodoro, r.TargetSec)
	}
	if r.Phase != model.FocusPhaseFocus {
		t.Fatalf("第一轮应是专注阶段，实得 %q", r.Phase)
	}
	// 第一轮专注结束 → 折时间、轮数 +1、段起点清空
	afterFocus, err := a.FocusPhaseEnd(ctx, r.ID, model.FocusPhaseFocus, 0)
	if err != nil {
		t.Fatalf("FocusPhaseEnd focus: %v", err)
	}
	if afterFocus.Cycles != 1 || afterFocus.SegmentStart != "" || afterFocus.Status != model.FocusPaused {
		t.Fatalf("专注轮结束后应停在暂停等休息，实得 %+v", afterFocus)
	}
	// 本轮基准必须推到当前累计：漏了这一步，第二轮的剩余会拿全程累计去减，
	// 一休息完就「已超时」，整个番茄会一路自动冲到最后一轮（2026-11-08 自检抓到过）。
	if afterFocus.RoundBase != afterFocus.AccumSec {
		t.Fatalf("一轮结束后 RoundBase 应等于累计秒数，实得 %d vs %d", afterFocus.RoundBase, afterFocus.AccumSec)
	}
	accum := afterFocus.AccumSec
	// 进入休息：只改阶段，不累计任何秒数
	inRest, err := a.FocusRestStart(ctx, r.ID, model.FocusPhaseShort)
	if err != nil {
		t.Fatalf("FocusRestStart: %v", err)
	}
	if inRest.Phase != model.FocusPhaseShort || inRest.Status != model.FocusPaused || inRest.SegmentStart != "" {
		t.Fatalf("休息开始应清空段起点，实得 %+v", inRest)
	}
	if inRest.AccumSec != accum {
		t.Fatalf("休息开始不能改累计：%d → %d", accum, inRest.AccumSec)
	}
	if _, err := a.FocusRestStart(ctx, r.ID, "nap"); err == nil {
		t.Fatal("未知休息阶段应报错")
	}
	// 休息 60 秒只进 RestSec
	afterRest, err := a.FocusPhaseEnd(ctx, r.ID, model.FocusPhaseShort, 60)
	if err != nil {
		t.Fatalf("FocusPhaseEnd short: %v", err)
	}
	if afterRest.RestSec != 60 {
		t.Fatalf("休息秒数应单独累计，实得 %d", afterRest.RestSec)
	}
	if afterRest.AccumSec != accum {
		t.Fatalf("休息不能进专注累计：%d → %d", accum, afterRest.AccumSec)
	}
	// 第二轮
	if _, err := a.FocusResume(ctx, r.ID); err != nil {
		t.Fatalf("FocusResume: %v", err)
	}
	if _, err := a.FocusPhaseEnd(ctx, r.ID, model.FocusPhaseFocus, 0); err != nil {
		t.Fatalf("第二轮结束: %v", err)
	}
	done, err := a.FocusFinish(ctx, r.ID, true)
	if err != nil {
		t.Fatalf("FocusFinish: %v", err)
	}
	if done.Cycles != 2 || done.RestSec != 60 || done.ActualSec != done.AccumSec {
		t.Fatalf("结算：轮数/休息/实际专注都要各自归位，实得 %+v", done)
	}
	if _, err := a.FocusPhaseEnd(ctx, r.ID, "nap", 0); err == nil {
		t.Fatal("未知番茄阶段应报错")
	}
}

func TestFocusManualBackfill(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	yday := repeat.AddDays(today, -1)
	it, err := a.SaveItem(ctx, ItemInput{Title: "写周报", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	r, err := a.FocusSave(ctx, FocusInput{
		Type: model.FocusCountDown, Day: yday, ActualSec: 25 * 60,
		ItemID: it[0].ID, Note: "补记的",
	})
	if err != nil {
		t.Fatalf("补记: %v", err)
	}
	if r.Source != model.FocusManual || r.Status != model.FocusDone {
		t.Fatalf("补记应是已完成且标来源，实得 %+v", r)
	}
	if r.StartAt != "" || r.EndAt != "" {
		t.Fatalf("补记不能伪造起止时刻，实得 %q~%q", r.StartAt, r.EndAt)
	}
	// 未来日期与 0 秒都要拒
	if _, err := a.FocusSave(ctx, FocusInput{Type: model.FocusCountUp, Day: repeat.AddDays(today, 1), ActualSec: 60}); err == nil {
		t.Fatal("补记不能写到未来")
	}
	if _, err := a.FocusSave(ctx, FocusInput{Type: model.FocusCountUp, Day: today, ActualSec: 0}); err == nil {
		t.Fatal("0 秒的补记应报错")
	}
	if _, err := a.FocusSave(ctx, FocusInput{Type: model.FocusCountUp, Day: today, ActualSec: 25 * 3600}); err == nil {
		t.Fatal("超过 24 小时应报错")
	}
	// 补记可以整条改（它本来就是手填的）
	up, err := a.FocusSave(ctx, FocusInput{ID: r.ID, Type: model.FocusPomodoro, Day: yday, ActualSec: 40 * 60, Note: "改成 40 分"})
	if err != nil {
		t.Fatalf("改补记: %v", err)
	}
	if up.Type != model.FocusPomodoro || up.ActualSec != 40*60 || up.Note != "改成 40 分" {
		t.Fatalf("补记应可整条重写，实得 %+v", up)
	}
	// 实时记录只让改心得与关联任务，时长是真值
	live, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp})
	if err != nil {
		t.Fatalf("FocusStart: %v", err)
	}
	if _, err := a.FocusSave(ctx, FocusInput{ID: live.ID, Note: "进行中不许改"}); err == nil {
		t.Fatal("进行中的记录不能走 FocusSave，先结束它")
	}
	fin, err := a.FocusFinish(ctx, live.ID, true)
	if err != nil {
		t.Fatalf("FocusFinish: %v", err)
	}
	edited, err := a.FocusSave(ctx, FocusInput{ID: fin.ID, Type: model.FocusCountDown, Day: repeat.AddDays(today, -9), ActualSec: 9999, Note: "只改这条"})
	if err != nil {
		t.Fatalf("编辑实时记录: %v", err)
	}
	if edited.Note != "只改这条" {
		t.Fatalf("心得要能改，实得 %q", edited.Note)
	}
	if edited.Type != model.FocusCountUp || edited.Day != today || edited.ActualSec != fin.ActualSec {
		t.Fatalf("实时记录的类型/日期/时长不能被人手改，实得 %+v", edited)
	}
	if err := a.FocusDelete(ctx, fin.ID); err != nil {
		t.Fatalf("FocusDelete: %v", err)
	}
	if list, _ := a.FocusList(ctx, "", 0); len(list) != 1 {
		t.Fatalf("删掉后历史应只剩补记那条，实得 %d", len(list))
	}
}

func TestFocusStatAggregates(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	d3 := repeat.AddDays(today, -3)
	d2 := repeat.AddDays(today, -2)
	yday := repeat.AddDays(today, -1)
	it, err := a.SaveItem(ctx, ItemInput{Title: "写周报", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	itemID := it[0].ID

	// 三天的实时记录：本地 09:00 / 20:30 / 23:45，类型各一，前两条挂同一个任务
	fixtures := []struct {
		day    string
		hour   int
		min    int
		typ    model.FocusType
		sec    int
		itemID string
	}{
		{d3, 9, 0, model.FocusCountUp, 45 * 60, itemID},
		{d2, 20, 30, model.FocusPomodoro, 25 * 60, itemID},
		{yday, 23, 45, model.FocusCountDown, 10 * 60, ""},
	}
	for i, f := range fixtures {
		start := at(t, f.day, f.hour, f.min)
		putFocus(t, a, ctx, &model.FocusRecord{
			ID: "focus-" + string(rune('a'+i)), Type: f.typ, Status: model.FocusDone, Source: model.FocusLive,
			Day: f.day, StartAt: start, EndAt: start, ActualSec: f.sec, TargetSec: f.sec, ItemID: f.itemID,
		})
	}
	// 今天一条补记（没有真实时刻，落不进时段矩阵）
	if _, err := a.FocusSave(ctx, FocusInput{Type: model.FocusCountUp, Day: today, ActualSec: 30 * 60}); err != nil {
		t.Fatalf("补记: %v", err)
	}

	st, err := a.FocusStat(ctx, FocusStatRequest{Start: d3, End: today})
	if err != nil {
		t.Fatalf("FocusStat: %v", err)
	}
	if len(st.Daily) != 4 {
		t.Fatalf("区间 4 天要出 4 格（含 0），实得 %d", len(st.Daily))
	}
	daySec := map[string]int{}
	for _, d := range st.Daily {
		daySec[d.Day] = d.Sec
	}
	if daySec[d3] != 45*60 || daySec[d2] != 25*60 || daySec[yday] != 10*60 || daySec[today] != 30*60 {
		t.Fatalf("每日时长对不上：%v", daySec)
	}
	// 总览是全历史的，不受区间影响
	if st.Overview.TotalSec != 110*60 || st.Overview.TotalCount != 4 {
		t.Fatalf("总览应含全部 4 条 / 110 分钟，实得 %+v", st.Overview)
	}
	if st.Overview.TodaySec != 30*60 || st.Overview.TodayCount != 1 {
		t.Fatalf("今日总览只算今天，实得 %+v", st.Overview)
	}
	if len(st.ByType) != 3 {
		t.Fatalf("三种类型都要有，实得 %+v", st.ByType)
	}
	var up, pomo, down int
	for _, p := range st.ByType {
		switch p.Type {
		case model.FocusCountUp:
			up = p.Sec
		case model.FocusPomodoro:
			pomo = p.Sec
		case model.FocusCountDown:
			down = p.Sec
		}
	}
	if up != 75*60 || pomo != 25*60 || down != 10*60 {
		t.Fatalf("类型分解：正计时应 75 分（含今天补记），实得 %d/%d/%d", up, pomo, down)
	}
	if len(st.ByTask) != 2 {
		t.Fatalf("应分成「写周报」与「未关联任务」两档，实得 %+v", st.ByTask)
	}
	if st.ByTask[0].ItemID != itemID || st.ByTask[0].Sec != 70*60 || st.ByTask[0].Name != "写周报" {
		t.Fatalf("任务排行第一名应是写周报 70 分钟，实得 %+v", st.ByTask[0])
	}
	if st.ByTask[1].ItemID != "" || st.ByTask[1].Name != "未关联任务" {
		t.Fatalf("没挂任务的要单列一档，实得 %+v", st.ByTask[1])
	}
	// 时段矩阵恒 168 格，且落在正确的星期 × 小时上
	if len(st.Matrix) != 168 {
		t.Fatalf("矩阵应 168 格，实得 %d", len(st.Matrix))
	}
	cell := func(day string, hour int) FocusCell {
		want := weekdayMonLocal(day)
		for _, c := range st.Matrix {
			if c.Weekday == want && c.Hour == hour {
				return c
			}
		}
		t.Fatalf("矩阵里找不到 %s %d 点", day, hour)
		return FocusCell{}
	}
	if c := cell(d3, 9); c.Sec != 45*60 || c.Count != 1 {
		t.Fatalf("09 点格应是 45 分钟，实得 %+v", c)
	}
	if c := cell(yday, 23); c.Sec != 10*60 {
		t.Fatalf("23 点格应是 10 分钟，实得 %+v", c)
	}
	if st.UnplacedSec != 30*60 || st.UnplacedCount != 1 {
		t.Fatalf("补记那条要落到 Unplaced，实得 %+v", st)
	}

	// 区间校验
	if _, err := a.FocusStat(ctx, FocusStatRequest{Start: today, End: d3}); err == nil {
		t.Fatal("区间反了要报错")
	}
	if _, err := a.FocusStat(ctx, FocusStatRequest{Start: repeat.AddDays(today, -400), End: today}); err == nil {
		t.Fatal("超过一年要报错")
	}
	if _, err := a.FocusStat(ctx, FocusStatRequest{}); err == nil {
		t.Fatal("空区间要报错")
	}
}

func TestFocusCandidates(t *testing.T) {
	a, ctx := newApp(t)
	today := a.Today()
	if _, err := a.SaveItem(ctx, ItemInput{Title: "今天的活", Date: model.DateSpec{Kind: model.DateSingle, Start: today}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem today: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{Title: "后天的活", Date: model.DateSpec{Kind: model.DateSingle, Start: repeat.AddDays(today, 2)}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem later: %v", err)
	}
	if _, err := a.SaveItem(ctx, ItemInput{Title: "昨天的活", Date: model.DateSpec{Kind: model.DateSingle, Start: repeat.AddDays(today, -1)}}, ScopeAll, ""); err != nil {
		t.Fatalf("SaveItem overdue: %v", err)
	}
	if _, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Freq: model.Frequency{Kind: model.FreqDaily}, StartDay: repeat.AddDays(today, -3)}); err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}

	// 默认「全部待办」：逾期 + 今天 + 往后都要在
	all, err := a.FocusCandidates(ctx, FocusCandidateRequest{Tab: "item"})
	if err != nil {
		t.Fatalf("全部待办: %v", err)
	}
	got := map[string]bool{}
	for _, c := range all {
		got[c.Name] = true
		if c.Kind != "item" {
			t.Fatalf("事项页签混进了 %s", c.Kind)
		}
	}
	for _, name := range []string{"今天的活", "后天的活", "昨天的活"} {
		if !got[name] {
			t.Fatalf("全部待办少了 %s：%v", name, all)
		}
	}
	// 指定某一天就只出那一天
	one, err := a.FocusCandidates(ctx, FocusCandidateRequest{Day: today, Tab: "item"})
	if err != nil {
		t.Fatalf("当天候选: %v", err)
	}
	for _, c := range one {
		if c.Day != today {
			t.Fatalf("按天筛还混进了 %s 的 %s", c.Day, c.Name)
		}
	}
	// 习惯页签
	hs, err := a.FocusCandidates(ctx, FocusCandidateRequest{Tab: "habit"})
	if err != nil {
		t.Fatalf("习惯候选: %v", err)
	}
	if len(hs) != 1 || hs[0].Name != "喝水" || hs[0].Kind != "habit" {
		t.Fatalf("习惯候选应只有一条喝水，实得 %+v", hs)
	}
	if _, err := a.FocusCandidates(ctx, FocusCandidateRequest{Tab: "whatever"}); err == nil {
		t.Fatal("未知页签要报错")
	}
}

func TestFocusTaskValidationAndListNames(t *testing.T) {
	a, ctx := newApp(t)
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp, ItemID: "nope"}); err == nil {
		t.Fatal("关联不存在的事项要报错")
	}
	it, err := a.SaveItem(ctx, ItemInput{Title: "写周报", Date: model.DateSpec{Kind: model.DateSingle, Start: a.Today()}}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	h, err := a.SaveHabit(ctx, HabitInput{Name: "喝水", Freq: model.Frequency{Kind: model.FreqDaily}})
	if err != nil {
		t.Fatalf("SaveHabit: %v", err)
	}
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp, ItemID: it[0].ID, HabitID: h.ID}); err == nil {
		t.Fatal("事项与习惯不能同时关联")
	}
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountUp, ItemID: it[0].ID}); err != nil {
		t.Fatalf("关联事项开专注: %v", err)
	}
	if _, err := a.FocusStart(ctx, FocusStartRequest{Type: model.FocusCountDown, TargetSec: -5}); err == nil {
		t.Fatal("负的目标时长要报错")
	}
	// 列表里的任务名是现取的：改名不用回写记录
	if _, err := a.SaveItem(ctx, ItemInput{ID: it[0].ID, Title: "写季度周报", Date: model.DateSpec{Kind: model.DateSingle, Start: a.Today()}}, ScopeAll, ""); err != nil {
		t.Fatalf("改名: %v", err)
	}
	r, err := a.FocusFinish(ctx, mustCurrent(t, a, ctx).ID, true)
	if err != nil {
		t.Fatalf("FocusFinish: %v", err)
	}
	list, err := a.FocusList(ctx, "", 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("列表应有 1 条，实得 %d err=%v", len(list), err)
	}
	if list[0].TaskName != "写季度周报" || list[0].TaskKind != "item" {
		t.Fatalf("任务名要现取，实得 %+v", list[0])
	}
	_ = r
}

// mustCurrent 取进行中的那条，没有就直接失败。
func mustCurrent(t *testing.T, a *App, ctx context.Context) *model.FocusRecord {
	t.Helper()
	cur, err := a.FocusCurrent(ctx)
	if err != nil || cur == nil {
		t.Fatalf("没有进行中的专注 err=%v", err)
	}
	return cur
}

// getRec 走详情页那条路（FocusGet 现在回「记录 + 任务名」），测试里只关心记录本体时用这个。
func getRec(t *testing.T, a *App, ctx context.Context, id string) *model.FocusRecord {
	t.Helper()
	item, err := a.FocusGet(ctx, id)
	if err != nil {
		t.Fatalf("FocusGet(%s): %v", id, err)
	}
	cp := item.Record
	return &cp
}

func focusEventKinds(r *model.FocusRecord) []string {
	out := make([]string, 0, len(r.Events))
	for _, e := range r.Events {
		out = append(out, e.Kind)
	}
	return out
}

func containsString(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
