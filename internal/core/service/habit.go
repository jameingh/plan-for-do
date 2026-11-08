package service

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
)

// HabitInput 是习惯的新建/编辑入参。
type HabitInput struct {
	ID           string           `json:"id,omitempty"`
	Name         string           `json:"name"`
	Icon         model.HabitIcon  `json:"icon"`
	Context      string           `json:"context"`
	Freq         model.Frequency  `json:"freq"`
	Mode         model.HabitMode  `json:"mode"`
	AutoClock    bool             `json:"autoClock"`
	UnitID       string           `json:"unitId,omitempty"`
	DailyTarget  float64          `json:"dailyTarget"`
	PerClock     float64          `json:"perClock"`
	Reminders    []model.Reminder `json:"reminders,omitempty"`
	PopMark      *bool            `json:"popMark,omitempty"`
	StartDay     model.Day        `json:"startDay"`
	BackfillDays int              `json:"backfillDays"`
}

// maxHabitReminders 是一个习惯能挂的提醒条数上限，与参考站 currentRemind.maxCount 一致。
const maxHabitReminders = 2

// normalizeHabitReminders 只保留固定时刻（HH:MM），去重、排序、补 ID。
// 习惯不像事项那样有「开始时刻」可以减提前量，所以 Offset/AtDay 一律丢掉。
func normalizeHabitReminders(in []model.Reminder) []model.Reminder {
	out := make([]model.Reminder, 0, len(in))
	seen := map[string]bool{}
	for _, r := range in {
		t := strings.TrimSpace(r.AtTime)
		if t == "" || seen[t] {
			continue
		}
		if _, _, err := parseHHMM(t); err != nil {
			continue
		}
		if len(t) > 5 {
			t = t[:5]
		}
		seen[t] = true
		id := r.ID
		if id == "" {
			id = "hr-" + t
		}
		out = append(out, model.Reminder{ID: id, Offset: model.ReminderOffset{}, AtTime: t})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AtTime < out[j].AtTime })
	if len(out) > maxHabitReminders {
		out = out[:maxHabitReminders]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// distinctReminderTimes 数不同时刻的条数，与 normalizeHabitReminders 的去重口径一致。
func distinctReminderTimes(in []model.Reminder) int {
	seen := map[string]bool{}
	for _, r := range in {
		if t := strings.TrimSpace(r.AtTime); t != "" {
			seen[t] = true
		}
	}
	return len(seen)
}

// SaveHabit 建或改习惯。「每天多次」必须给每日总量，否则量化进度无从算起。
func (a *App) SaveHabit(ctx context.Context, in HabitInput) (*model.Habit, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 习惯名不能为空")
	}
	if in.Mode == 0 {
		in.Mode = model.HabitOncePerDay
	}
	if in.Freq.Kind == 0 {
		in.Freq.Kind = model.FreqDaily
	}
	if in.Freq.Kind == model.FreqEveryNDays && in.Freq.EveryN < 1 {
		in.Freq.EveryN = 1
	}
	if in.Freq.Kind.IsQuota() && in.Freq.Plan < 1 {
		in.Freq.Plan = 1
	}
	// 参考站一个习惯最多挂 2 条提醒。按「不同时刻」计数，同一时刻重复提交不算超。
	if distinctReminderTimes(in.Reminders) > maxHabitReminders {
		return nil, fmt.Errorf("service: 一个习惯最多 %d 条提醒", maxHabitReminders)
	}
	if in.Mode == model.HabitMultiPerDay && in.DailyTarget <= 0 {
		return nil, fmt.Errorf("service: 每天多次的习惯要设每日打卡总量")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	h := &model.Habit{}
	if in.ID == "" {
		h.ID = newID()
		h.CreatedAt = at
		h.PopMark = true // 参考站新建习惯默认弹「打卡心得」，编辑时由界面显式给值
		h.StartDay = in.StartDay
		if h.StartDay == "" {
			h.StartDay = a.Today()
		}
	} else {
		row, found, err := a.db.Get(ctx, store.KindHabit, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: habit %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(h); err != nil {
			return nil, err
		}
		if in.StartDay != "" && in.StartDay != h.StartDay {
			h.StartDay = in.StartDay // 改开始日会重算整段统计，只有明确传值才动
		}
	}
	h.Name, h.Icon, h.Context = name, in.Icon, in.Context
	h.Freq, h.Mode, h.AutoClock = in.Freq, in.Mode, in.AutoClock
	h.UnitID, h.DailyTarget, h.PerClock = in.UnitID, in.DailyTarget, in.PerClock
	h.Reminders = normalizeHabitReminders(in.Reminders)
	if in.PopMark != nil {
		h.PopMark = *in.PopMark
	}
	if in.BackfillDays > 0 {
		h.BackfillDays = in.BackfillDays
	}
	h.UpdatedAt = at
	e, err := store.NewEntity(store.KindHabit, h)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return h, nil
}

// DeleteHabit 删习惯本体，打卡历史保留（统计与以后重建同名习惯都要靠它）。
func (a *App) DeleteHabit(ctx context.Context, habitID string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.db.SoftDelete(ctx, store.KindHabit, habitID, at)
}

// HabitContextInput 是情境入参。
type HabitContextInput struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Sort int    `json:"sort"`
}

// HabitContexts 按 Sort 返回情境。
func (a *App) HabitContexts(ctx context.Context) ([]model.HabitContext, error) {
	out, err := loadAll[model.HabitContext](a, ctx, store.KindHabitContext)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// SaveHabitContext 建或改情境。
func (a *App) SaveHabitContext(ctx context.Context, in HabitContextInput) (*model.HabitContext, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 情境名不能为空")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	c := &model.HabitContext{}
	if in.ID == "" {
		c.ID, c.CreatedAt, c.Sort = newID(), at, in.Sort
	} else {
		row, found, err := a.db.Get(ctx, store.KindHabitContext, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: context %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(c); err != nil {
			return nil, err
		}
	}
	c.Name, c.UpdatedAt = name, at
	e, err := store.NewEntity(store.KindHabitContext, c)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return c, nil
}

// DeleteHabitContext 删情境，其下习惯归入「全天」而不是跟着消失。
func (a *App) DeleteHabitContext(ctx context.Context, contextID string) (int, error) {
	if contextID == "ctx-always" {
		return 0, fmt.Errorf("service: 「全天」情境不可删除")
	}
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	habits, err := a.habits(ctx)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, h := range habits {
		if h.Context != contextID {
			continue
		}
		h.Context = ""
		h.UpdatedAt = at
		e, err := store.NewEntity(store.KindHabit, h)
		if err != nil {
			return moved, err
		}
		if err := a.db.Put(ctx, e); err != nil {
			return moved, err
		}
		moved++
	}
	if err := a.db.SoftDelete(ctx, store.KindHabitContext, contextID, at); err != nil {
		return moved, err
	}
	return moved, nil
}

func (a *App) habits(ctx context.Context) ([]*model.Habit, error) {
	rows, err := a.db.Rows(ctx, store.KindHabit, false)
	if err != nil {
		return nil, err
	}
	out := make([]*model.Habit, 0, len(rows))
	for _, r := range rows {
		var h model.Habit
		if err := r.Decode(&h); err != nil {
			return nil, err
		}
		out = append(out, &h)
	}
	return out, nil
}

// habitSchedule 把习惯频率翻成重复规则，好让清单和习惯共用同一个展开引擎。
func habitSchedule(h *model.Habit) *model.Repeat {
	r := &model.Repeat{Unit: model.UnitDay, Interval: 1}
	switch h.Freq.Kind {
	case model.FreqFixedWeekdays:
		r.Unit = model.UnitWeek
		r.Weekdays = h.Freq.Weekdays
		if len(r.Weekdays) == 0 {
			r.Weekdays = []int{repeat.Weekday(h.StartDay)}
		}
	case model.FreqMonthlyDays:
		r.Unit = model.UnitMonth
		r.MonthDays = h.Freq.MonthDays
		if len(r.MonthDays) == 0 {
			d := 1
			if len(h.StartDay) >= 2 {
				fmt.Sscanf(h.StartDay[8:10], "%d", &d)
			}
			r.MonthDays = []int{d}
		}
	case model.FreqEveryNDays:
		r.Interval = h.Freq.EveryN
		if r.Interval < 1 {
			r.Interval = 1
		}
	case model.FreqWeeklyQuota, model.FreqMonthlyQuota:
		// 配额型频率「哪天打都行」，所以排期上就是每天都可打；
		// 计划数与错过由 quotaStats 按周期结算，不靠这里收窄。
		r.Unit = model.UnitDay
		r.Interval = 1
	}
	return r
}

// scheduledDays 返回习惯在 [from,to] 内排期的天。
func (a *App) scheduledDays(h *model.Habit, from, to model.Day) []model.Day {
	item := &model.ListItem{ID: h.ID, Date: model.DateSpec{Kind: model.DateSingle, Start: h.StartDay}, Repeat: habitSchedule(h)}
	return repeat.Occurrences(item, from, to, a.calendar)
}

// HabitCell 是月切片里的一格。只有排期日才产出格子，非排期日不出现（前端按缺格留空渲染），
// 所以状态里没有「休息日」这一态。
type HabitCell struct {
	Day      model.Day `json:"day"`
	State    string    `json:"state"` // done | partial | missed | future
	Amount   float64   `json:"amount"`
	Target   float64   `json:"target"`
	ClockIDs []string  `json:"clockIds,omitempty"`
}

// HabitRow 是习惯列表里的一行。
type HabitRow struct {
	Habit       model.Habit `json:"habit"`
	ContextName string      `json:"contextName"`
	Day         model.Day   `json:"day"`
	Amount      float64     `json:"amount"`
	Target      float64     `json:"target"`
	Clocked     bool        `json:"clocked"`
	DueToday    bool        `json:"dueToday"`
	Streak      int         `json:"streak"`
	TotalDays   int         `json:"totalDays"`
	CanBackfill bool        `json:"canBackfill"`
	Month       []HabitCell `json:"month"`
}

// HabitView 是习惯页某天 + 某月的整屏数据。
type HabitView struct {
	Day        model.Day             `json:"day"`
	Month      string                `json:"month"`
	Contexts   []string              `json:"contexts"` // 情境 ID 顺序，含「全天」兜底
	RowsByCtx  map[string][]HabitRow `json:"rowsByContext"`
	TotalClock int                   `json:"totalClockDays"`
}

// HabitMonthView 展开成月切片并算好连续天数；month 形如 "2026-11"，空则取当月。
func (a *App) HabitMonthView(ctx context.Context, day model.Day, month string) (HabitView, error) {
	if day == "" {
		day = a.Today()
	}
	if month == "" {
		month = day[:7]
	}
	monthStart, monthEnd, err := monthRange(month)
	if err != nil {
		return HabitView{}, err
	}
	habits, err := a.habits(ctx)
	if err != nil {
		return HabitView{}, err
	}
	clocks, err := a.clocksByHabit(ctx)
	if err != nil {
		return HabitView{}, err
	}
	contexts, err := a.HabitContexts(ctx)
	if err != nil {
		return HabitView{}, err
	}
	names := map[string]string{}
	order := []string{}
	for _, c := range contexts {
		names[c.ID] = c.Name
		order = append(order, c.ID)
	}

	view := HabitView{Day: day, Month: month, Contexts: order, RowsByCtx: map[string][]HabitRow{}}
	today := a.Today()
	for _, h := range habits {
		byDay := clocks[h.ID]
		target := 1.0
		if h.Mode == model.HabitMultiPerDay {
			target = h.DailyTarget
		}
		cells := []HabitCell{}
		for _, d := range a.scheduledDays(h, monthStart, monthEnd) {
			amount := byDay[d]
			cell := HabitCell{Day: d, Amount: amount, Target: target}
			switch {
			case amount >= target:
				cell.State = "done"
			case amount > 0:
				cell.State = "partial"
			case repeat.DiffDays(day, d) > 0:
				cell.State = "future" // 还没到
			case d == today:
				// 今天还没过完，说「错过」是假报警，单独给一个 pending。
				cell.State = "pending"
			default:
				cell.State = "missed"
			}
			cells = append(cells, cell)
		}

		row := HabitRow{
			Habit:       *h,
			ContextName: names[h.Context],
			Day:         day,
			Amount:      byDay[day],
			Target:      target,
			Clocked:     byDay[day] >= target,
			DueToday:    len(a.scheduledDays(h, day, day)) > 0,
			Streak:      a.streak(h, byDay, day),
			TotalDays:   len(filteredDays(byDay, h.StartDay, day)),
			CanBackfill: canBackfill(h, day, today),
			Month:       cells,
		}
		key := h.Context
		if key == "" {
			key = "ctx-always"
		}
		view.RowsByCtx[key] = append(view.RowsByCtx[key], row)
		view.TotalClock += row.TotalDays
	}
	return view, nil
}

func monthRange(month string) (model.Day, model.Day, error) {
	if len(month) != 7 || month[4] != '-' {
		return "", "", fmt.Errorf("service: 月份格式应为 YYYY-MM，收到 %q", month)
	}
	start := month + "-01"
	t, ok := repeat.ParseDay(start)
	if !ok {
		return "", "", fmt.Errorf("service: 无法解析月份 %q", month)
	}
	end := repeat.Format(t.AddDate(0, 1, -1))
	return start, end, nil
}

func (a *App) clocksByHabit(ctx context.Context) (map[string]map[model.Day]float64, error) {
	rows, err := a.db.Rows(ctx, store.KindHabitClock, false)
	if err != nil {
		return nil, err
	}
	out := map[string]map[model.Day]float64{}
	for _, r := range rows {
		var c model.HabitClock
		if err := r.Decode(&c); err != nil {
			return nil, err
		}
		amt := c.Amount
		if amt == 0 {
			amt = 1 // 「每天一次」的打卡不填量，按一次计
		}
		byDay := out[c.HabitID]
		if byDay == nil {
			byDay = map[model.Day]float64{}
			out[c.HabitID] = byDay
		}
		byDay[c.Day] += amt
	}
	return out, nil
}

func filteredDays(byDay map[model.Day]float64, from, to model.Day) []model.Day {
	out := []model.Day{}
	for d := range byDay {
		if d >= from && d <= to {
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out
}

// streak 从今天往回数连续达标的「排期日」数。跳过没排期的日子，
// 否则每周三次的习惯永远算不出连续。
func (a *App) streak(h *model.Habit, byDay map[model.Day]float64, today model.Day) int {
	target := 1.0
	if h.Mode == model.HabitMultiPerDay {
		target = h.DailyTarget
	}
	d := today
	n := 0
	for i := 0; i < maxScan; i++ {
		if repeat.DiffDays(h.StartDay, d) < 0 {
			break
		}
		scheduled := len(a.scheduledDays(h, d, d)) > 0
		if !scheduled {
			d = repeat.AddDays(d, -1)
			continue
		}
		if byDay[d] >= target {
			n++
			d = repeat.AddDays(d, -1)
			continue
		}
		if d == today {
			// 今天还没打不断掉连续，与朝暮的「连续天数」口径一致。
			d = repeat.AddDays(d, -1)
			continue
		}
		break
	}
	return n
}

func canBackfill(h *model.Habit, day, today model.Day) bool {
	if day == today {
		return true
	}
	if repeat.DiffDays(day, today) < 0 {
		return false // 未来的日子不能提前打卡
	}
	if h.BackfillDays <= 0 {
		return false
	}
	return repeat.DiffDays(day, today) <= h.BackfillDays
}

// ClockHabit 记一次打卡。补打卡受 BackfillDays 限制，超范围直接拒绝而不是静默修正。
func (a *App) ClockHabit(ctx context.Context, habitID string, day model.Day, amount float64) (*model.HabitClock, error) {
	habit, err := loadOne[model.Habit](a, ctx, store.KindHabit, habitID)
	if err != nil {
		return nil, err
	}
	if day == "" {
		day = a.Today()
	}
	if !canBackfill(habit, day, a.Today()) {
		return nil, fmt.Errorf("service: %s 不在可补打卡范围内（可回溯 %d 天）", day, habit.BackfillDays)
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	if amount <= 0 {
		amount = 1
		if habit.Mode == model.HabitMultiPerDay && habit.PerClock > 0 {
			amount = habit.PerClock
		}
	}
	clock := &model.HabitClock{HabitID: habitID, Day: day, Amount: amount, ClockedAt: at, Manual: day != a.Today(), UpdatedAt: at}
	if habit.Mode == model.HabitOncePerDay {
		// 确定性主键：两台设备同一天打卡收敛成一条，不会重复计数。
		clock.ID = model.DailyClockID(habitID, day)
	} else {
		clock.ID = newID()
	}
	e, err := store.NewEntity(store.KindHabitClock, clock)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return clock, nil
}

// CancelHabitClock 取消某天的打卡：删掉该习惯当天的全部记录。
// 用确定性 ID 的习惯只有一条，「每天多次」则是整批撤销，前端二次确认后调用。
func (a *App) CancelHabitClock(ctx context.Context, habitID string, day model.Day) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	rows, err := a.db.ByDay(ctx, store.KindHabitClock, day)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rows {
		var c model.HabitClock
		if err := r.Decode(&c); err != nil {
			return n, err
		}
		if c.HabitID != habitID {
			continue
		}
		if err := a.db.SoftDelete(ctx, store.KindHabitClock, c.ID, at); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// HabitStats 是习惯详情面板的统计口径。
type HabitStats struct {
	Planned       int       `json:"planned"` // 本月排期且已到期的天数
	Actual        int       `json:"actual"`  // 达到每日目标的天数
	Missed        int       `json:"missed"`  // 已经过完、但没达标的天数（不含今天）
	Pending       int       `json:"pending"` // 排期到了但还没过完的那天，通常是今天
	Ratio         int       `json:"ratio"`   // 0-100
	StartDay      model.Day `json:"startDay"`
	DaysSince     int       `json:"daysSince"`
	TotalDays     int       `json:"totalDays"` // 有任何打卡记录的天数，口径比 Actual 宽
	LongestStreak int       `json:"longestStreak"`
}

// HabitStats 算某习惯的月打卡进度与总进度。
func (a *App) HabitStats(ctx context.Context, habitID, month string) (HabitStats, error) {
	habit, err := loadOne[model.Habit](a, ctx, store.KindHabit, habitID)
	if err != nil {
		return HabitStats{}, err
	}
	today := a.Today()
	if month == "" {
		month = today[:7]
	}
	start, end, err := monthRange(month)
	if err != nil {
		return HabitStats{}, err
	}
	clocks, err := a.clocksByHabit(ctx)
	if err != nil {
		return HabitStats{}, err
	}
	byDay := clocks[habitID]
	target := 1.0
	if habit.Mode == model.HabitMultiPerDay {
		target = habit.DailyTarget
	}

	st := HabitStats{StartDay: habit.StartDay, DaysSince: maxInt(0, repeat.DiffDays(habit.StartDay, today))}
	if repeat.DiffDays(today, end) > 0 {
		end = today // 未来的日子还没发生，不计进「计划打卡」，否则本月永远达不到 100%
	}
	if repeat.DiffDays(start, habit.StartDay) > 0 {
		start = habit.StartDay
	}
	if habit.Freq.Kind.IsQuota() {
		// 配额型频率（每周/每月 N 天，哪天打都行）没有「某一天错过」的概念，
		// 错过只能按周期结算：一个周期过完了还没打满，差几天就算错过几天。
		st.Planned, st.Actual, st.Missed, st.Pending = quotaStats(habit, start, end, today, byDay, target)
	} else {
		for _, d := range a.scheduledDays(habit, start, end) {
			st.Planned++
			switch {
			case byDay[d] >= target:
				st.Actual++
			case d == today:
				// 今天还没过完，不能算错过；单列出来，前端据此解释「错过」为什么是 0。
				st.Pending++
			default:
				st.Missed++
			}
		}
	}
	if st.Planned > 0 {
		st.Ratio = st.Actual * 100 / st.Planned
	}
	st.TotalDays = len(filteredDays(byDay, habit.StartDay, today))
	st.LongestStreak = a.longestStreak(habit, byDay, today)
	return st, nil
}

// quotaPeriodOf 返回某天所属周期的起止（周一为一周之始；月周期就是自然月）。
func quotaPeriodOf(kind model.FreqKind, day model.Day) (model.Day, model.Day) {
	if kind == model.FreqMonthlyQuota {
		first := day[:8] + "01"
		t, ok := repeat.ParseDay(first)
		if !ok {
			return first, first
		}
		return first, repeat.Format(t.AddDate(0, 1, -1))
	}
	wd := repeat.Weekday(day) // 1=周一..7=周日
	first := repeat.AddDays(day, -(wd - 1))
	return first, repeat.AddDays(first, 6)
}

// quotaStats 按周期配额算 计划/实际/错过/待打。窗口内跨几个周期就算几份配额，
// 但周期里还没开始的那部分（窗口截断）不重复计入，避免月初新建的习惯被按整月配额压任务。
func quotaStats(h *model.Habit, start, end, today model.Day, byDay map[model.Day]float64, target float64) (planned, actual, missed, pending int) {
	plan := h.Freq.Plan
	if plan < 1 {
		plan = 1
	}
	target_ := target
	if target_ <= 0 {
		target_ = 1
	}
	seen := map[model.Day]bool{}
	d := start
	for repeat.DiffDays(d, end) >= 0 {
		pStart, pEnd := quotaPeriodOf(h.Freq.Kind, d)
		if !seen[pStart] {
			seen[pStart] = true
			planned += plan
			// 只数这个周期里真正落在窗口内、且已到期的天：窗口还没走到的周期不算配额。
			covFrom, covTo := maxDay(pStart, start), minDay(pEnd, end)
			hit := 0
			for x := covFrom; repeat.DiffDays(x, covTo) >= 0; x = repeat.AddDays(x, 1) {
				if byDay[x] >= target_ {
					hit++
				}
			}
			actual += hit
			switch {
			case repeat.DiffDays(pEnd, today) > 0: // 周期已过完（周期末日在今天之前）
				if short := plan - hit; short > 0 {
					missed += short
				}
			case repeat.DiffDays(pStart, today) >= 0: // 正在进行：还没打满只算「待打」，不算错过
				if hit < plan {
					pending = 1
				}
			}
		}
		d = repeat.AddDays(d, 1)
	}
	return planned, actual, missed, pending
}

func maxDay(a, b model.Day) model.Day {
	if a > b {
		return a
	}
	return b
}

func minDay(a, b model.Day) model.Day {
	if a < b {
		return a
	}
	return b
}

// longestStreak 在排期日序列上找最长连续达标段。
func (a *App) longestStreak(h *model.Habit, byDay map[model.Day]float64, today model.Day) int {
	target := 1.0
	if h.Mode == model.HabitMultiPerDay {
		target = h.DailyTarget
	}
	days := a.scheduledDays(h, h.StartDay, today)
	best, run := 0, 0
	for _, d := range days {
		if byDay[d] >= target {
			run++
			if run > best {
				best = run
			}
			continue
		}
		run = 0
	}
	return best
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// HabitMarkInput 是打卡日志入参。
type HabitMarkInput struct {
	ID        string    `json:"id,omitempty"`
	HabitID   string    `json:"habitId"`
	ClockID   string    `json:"clockId,omitempty"`
	Day       model.Day `json:"day"`
	Time      string    `json:"time,omitempty"`
	Text      string    `json:"text"`
	ImagePath string    `json:"imagePath,omitempty"`
}

// SaveHabitMark 写打卡日志（心得 + 可选配图）。
func (a *App) SaveHabitMark(ctx context.Context, in HabitMarkInput) (*model.HabitMark, error) {
	if strings.TrimSpace(in.Text) == "" && in.ImagePath == "" {
		return nil, fmt.Errorf("service: 日志要么写心得要么配图")
	}
	if _, err := loadOne[model.Habit](a, ctx, store.KindHabit, in.HabitID); err != nil {
		return nil, err
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	mark := &model.HabitMark{}
	if in.ID == "" {
		mark.ID, mark.CreatedAt, mark.Day = newID(), at, in.Day
		if mark.Day == "" {
			mark.Day = a.Today()
		}
	} else {
		row, found, err := a.db.Get(ctx, store.KindHabitMark, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: mark %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(mark); err != nil {
			return nil, err
		}
	}
	mark.HabitID, mark.ClockID, mark.Text, mark.ImagePath = in.HabitID, in.ClockID, in.Text, in.ImagePath
	if in.Time != "" {
		mark.Time = in.Time
	}
	mark.UpdatedAt = at
	e, err := store.NewEntity(store.KindHabitMark, mark)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return mark, nil
}

// HabitMarks 按日期倒序返回某习惯的打卡日志。
func (a *App) HabitMarks(ctx context.Context, habitID string) ([]model.HabitMark, error) {
	rows, err := a.db.ByParent(ctx, store.KindHabitMark, habitID)
	if err != nil {
		return nil, err
	}
	out := make([]model.HabitMark, 0, len(rows))
	for _, r := range rows {
		var m model.HabitMark
		if err := r.Decode(&m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Day != out[j].Day {
			return out[i].Day > out[j].Day
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out, nil
}

// DeleteHabitMark 删一条打卡日志。
func (a *App) DeleteHabitMark(ctx context.Context, markID string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.db.SoftDelete(ctx, store.KindHabitMark, markID, at)
}
