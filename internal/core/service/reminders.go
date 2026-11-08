package service

import (
	"context"
	"fmt"
	"sort"
	"time"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/tclock"
)

// allDayAnchorHour 是全天事项算提醒时的锚点时刻。偏移量（提前 30 分钟等）必须挂在一个
// 具体时刻上，取 09:00 与朝暮「当天(09:00)」这条预设对齐，避免给全天事项硬套 00:00。
const allDayAnchorHour = 9

// defaultReminderTime 是固定时刻提醒没给时间时用的墙钟。
const defaultReminderTime = "09:00"

// ReminderFire 是一次将要触发的提醒，绝对时刻已换算好，壳层可以直接排通知。
type ReminderFire struct {
	ItemID     string          `json:"itemId"`
	ReminderID string          `json:"reminderId"`
	Title      string          `json:"title"`
	Day        model.Day       `json:"day"`
	At         model.ClockTime `json:"at"`
	// Habit 为真时 ItemID 装的是习惯 ID：习惯的提醒挂在「排期日的固定时刻」上，
	// 而不是挂在某个事项的开始时刻。前端据此决定点开是事项详情还是习惯详情。
	Habit bool `json:"habit,omitempty"`
}

// UpcomingReminders 算出 [day, until] 区间内还没到点的提醒。
//
// iOS 后台不跑 Go 定时器，只能把这段结果一次性预排成本地通知，所以这里必须返回
// 绝对时刻而不是「提前多久」；桌面端同样用它做倒计时展示。
func (a *App) UpcomingReminders(ctx context.Context, day, until model.Day) ([]ReminderFire, error) {
	if day == "" {
		day = a.Today()
	}
	if until == "" {
		until = repeat.AddDays(day, 7)
	}
	if repeat.DiffDays(until, day) > 0 {
		return nil, fmt.Errorf("service: 提醒区间反了：%s → %s", day, until)
	}
	items, err := a.listItems(ctx)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]bool, len(items))
	for _, it := range items {
		ids[it.ID] = true
	}
	overrides, err := a.overridesFor(ctx, ids, day, until)
	if err != nil {
		return nil, err
	}

	out := []ReminderFire{}
	now := time.Now()
	for _, it := range items {
		if len(it.Reminders) == 0 {
			continue
		}
		resolved := map[model.Day]bool{}
		for _, o := range repeat.Materialize(it, day, until, overrides[it.ID], a.calendar) {
			if o.Status.Resolved() {
				resolved[o.Day] = true
				continue // 已经结清（成功或失败）的那天不再提醒
			}
			base, ok := a.itemStart(o.Day, it.Time)
			if !ok {
				continue
			}
			for _, r := range it.Reminders {
				if absoluteReminder(r) != "" {
					continue // 绝对时刻提醒不走事项实例，见下面单独摊
				}
				fire, ok := fireTime(base, r, a.loc)
				if !ok || fire.Before(now) {
					continue
				}
				out = append(out, ReminderFire{
					ItemID: it.ID, ReminderID: r.ID, Title: it.Title,
					Day: o.Day, At: tclock.Format(fire),
				})
			}
		}
		// 「自定义提醒时间」（remindType=2）认的是它自己那一天：
		// 既不该被重复事项的每个实例重放一遍，也不该因为事项本身没日期就闷掉。
		for _, r := range it.Reminders {
			abs := absoluteReminder(r)
			if abs == "" || resolved[abs] {
				continue
			}
			if repeat.DiffDays(day, abs) < 0 || repeat.DiffDays(abs, until) < 0 {
				continue // 提醒日不在查询区间里
			}
			fire, ok := dayWallClock(abs, r.AtTime, a.loc)
			if !ok || fire.Before(now) {
				continue
			}
			out = append(out, ReminderFire{
				ItemID: it.ID, ReminderID: r.ID, Title: it.Title,
				Day: abs, At: tclock.Format(fire),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At < out[j].At
		}
		return out[i].ItemID < out[j].ItemID
	})
	habitFires, err := a.habitReminders(ctx, day, until, now)
	if err != nil {
		return nil, err
	}
	out = append(out, habitFires...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At < out[j].At
		}
		return out[i].ItemID < out[j].ItemID
	})
	return out, nil
}

// habitReminders 把习惯的固定时刻提醒摊到它的排期日上。
// 已经打满的那天不再提醒——参考站也是这个行为，打完卡当天不会再响。
func (a *App) habitReminders(ctx context.Context, day, until model.Day, now time.Time) ([]ReminderFire, error) {
	habits, err := a.habits(ctx)
	if err != nil {
		return nil, err
	}
	clocks, err := a.clocksByHabit(ctx)
	if err != nil {
		return nil, err
	}
	out := []ReminderFire{}
	for _, h := range habits {
		if len(h.Reminders) == 0 {
			continue
		}
		days := a.scheduledDays(h, day, until)
		target := 1.0
		if h.Mode == model.HabitMultiPerDay {
			target = h.DailyTarget
		}
		done := clocks[h.ID]
		for _, d := range days {
			if done[d] >= target {
				continue
			}
			for _, r := range h.Reminders {
				hh, mm, err := parseHHMM(r.AtTime)
				if err != nil {
					continue
				}
				dt, ok := repeat.ParseDay(d)
				if !ok {
					continue
				}
				fire := time.Date(dt.Year(), dt.Month(), dt.Day(), hh, mm, 0, 0, a.loc)
				if fire.Before(now) {
					continue
				}
				out = append(out, ReminderFire{
					ItemID: h.ID, ReminderID: r.ID, Title: h.Name,
					Day: d, At: tclock.Format(fire), Habit: true,
				})
			}
		}
	}
	return out, nil
}

// itemStart 把「哪天 + 什么时刻」拼成本地瞬时。全天或没时间时按 09:00。
func (a *App) itemStart(day model.Day, t model.TimeSpec) (time.Time, bool) {
	if day == "" {
		return time.Time{}, false
	}
	hh, mm := allDayAnchorHour, 0
	if t.Kind != model.TimeAllDay {
		var err error
		hh, mm, err = parseHHMM(t.Start)
		if err != nil {
			return time.Time{}, false
		}
	}
	d, ok := repeat.ParseDay(day)
	if !ok {
		return time.Time{}, false
	}
	return time.Date(d.Year(), d.Month(), d.Day(), hh, mm, 0, 0, a.loc), true
}

// dayWallClock 把「某天 + HH:MM」拼成本地瞬时；时间没给时按默认 09:00。
func dayWallClock(day model.Day, at string, loc *time.Location) (time.Time, bool) {
	d, ok := repeat.ParseDay(day)
	if !ok {
		return time.Time{}, false
	}
	hh, mm, err := parseHHMM(at)
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(d.Year(), d.Month(), d.Day(), hh, mm, 0, 0, loc), true
}

func parseHHMM(s string) (int, int, error) {
	if s == "" {
		s = defaultReminderTime
	}
	var hh, mm int
	if _, err := fmt.Sscanf(s, "%d:%d", &hh, &mm); err != nil {
		return 0, 0, fmt.Errorf("service: 时间 %q 不是 HH:MM", s)
	}
	if hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, fmt.Errorf("service: 时间 %q 越界", s)
	}
	return hh, mm, nil
}

// fireTime 由偏移量或固定时刻算出提醒瞬时。
//
// 三种形态（对齐参考站的 remindType）：
//
//	有提前量 → 事项开始时刻往前推（remindType=1 的「提前 N 天」和 0 的「准时/提前 5 分钟」）；
//	Offset 全 0 且有 AtDay → 就在那个日期的 AtTime（remindType=2，界面上的「自定义提醒时间」滚轮）；
//	Offset 全 0 且只有 AtTime → 事项当天那个时刻（预设「当天(09:00)」）。
//
// 提前量优先，是因为参考站一条提醒只表达一种语义，两者不会同时给。
func fireTime(base time.Time, r model.Reminder, loc *time.Location) (time.Time, bool) {
	o := r.Offset
	if o.Days != 0 || o.Hours != 0 || o.Minutes != 0 {
		return base.Add(-time.Duration(o.Days)*24*time.Hour -
			time.Duration(o.Hours)*time.Hour -
			time.Duration(o.Minutes)*time.Minute), true
	}
	if r.AtDay != "" {
		return dayWallClock(r.AtDay, r.AtTime, loc)
	}
	if r.AtTime != "" {
		hh, mm, err := parseHHMM(r.AtTime)
		if err != nil {
			return time.Time{}, false
		}
		return time.Date(base.Year(), base.Month(), base.Day(), hh, mm, 0, 0, loc), true
	}
	return base, true // 「准时」
}

// absoluteReminder 取出这条提醒绑定的固定日期，不是固定日期型就返回空串。
// 前端「自定义提醒时间」滚轮写的是 Offset 全 0 + AtDay/AtTime，和参考站的 remindType=2 一致。
func absoluteReminder(r model.Reminder) model.Day {
	if r.AtDay == "" || r.Offset != (model.ReminderOffset{}) {
		return ""
	}
	return r.AtDay
}
