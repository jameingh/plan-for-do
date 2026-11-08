package service

import (
	"context"
	"fmt"
	"sort"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
)

// 习惯统计（日/周/月/年四个标签页共用这一份口径）。
//
// 四个页面要的其实是同一件事的四种切法：某个区间里，每个习惯在哪些天打了卡、每天该打几个、
// 有几个打满了。所以这里只出一个区间接口，聚合全在同一个地方算，
// 免得「日统计的完美打卡」和「周统计的完美打卡天数」哪天算拧了。
//
// 三条定义先钉死（用户口径 + 与习惯页现有状态一致）：
//   · 打卡（checked）：那天有打卡记录且量 > 0。半天（多次习惯没打满）也算打了卡；
//     回溯额度允许往非排期日打卡，那种天照样算打卡、格子照样变红。
//   · 打满（done）：那天的量 >= 当日目标（每天一次的习惯就是 1 次）。
//   · 完美打卡：某天**应打的习惯全部打满**。应打 = 那天在排期里且已开始，不含未来天。

// HabitStatRequest 是统计区间入参。
type HabitStatRequest struct {
	Start model.Day `json:"start"`
	End   model.Day `json:"end"`
}

// HabitStatDay 是某个习惯在某一格的状态。
// 非排期日也会出一格（State=rest），这样周/月/年的格子数固定，前端不用自己补洞。
type HabitStatDay struct {
	Day    model.Day `json:"day"`
	State  string    `json:"state"` // done | partial | pending | missed | rest | future
	Amount float64   `json:"amount"`
	Target float64   `json:"target"`
}

// HabitStatHabit 是一个习惯在区间内的整条分布。
type HabitStatHabit struct {
	HabitID string          `json:"habitId"`
	Name    string          `json:"name"`
	Icon    model.HabitIcon `json:"icon"`
	Context string          `json:"context"`
	// Mode 直接透出 model.HabitMode：1 = 每天一次（界面写「1/1次」），2 = 每天多次（按量走，如「3/8杯」）。
	Mode      int            `json:"mode"`
	Unit      string         `json:"unit"`
	Days      []HabitStatDay `json:"days"`
	Checked   int            `json:"checked"`   // 区间内打了卡的天数
	Done      int            `json:"done"`      // 区间内打满的天数
	Scheduled int            `json:"scheduled"` // 区间内应打的天数
	Streak    int            `json:"streak"`    // 截至区间末的连续打卡天数
}

// HabitStatDaySummary 是区间内某一天的横向汇总（所有习惯放一起看）。
type HabitStatDaySummary struct {
	Day       model.Day `json:"day"`
	Scheduled int       `json:"scheduled"` // 今天该打几个习惯
	Done      int       `json:"done"`      // 今天打满了几个
	Checked   int       `json:"checked"`   // 今天有打卡的几个（含没打满的）
	Perfect   bool      `json:"perfect"`   // Scheduled>0 且 Done==Scheduled
	Future    bool      `json:"future"`    // 今天还没到，不参与完美打卡统计
}

// HabitStatSummary 是区间汇总：打卡总数 / 最长连续 / 完美打卡天数。
type HabitStatSummary struct {
	Checkins      int `json:"checkins"`      // 有打卡的「习惯×天」个数
	LongestStreak int `json:"longestStreak"` // 区间内连续「当天有打卡」的最长天数
	PerfectDays   int `json:"perfectDays"`   // 完美打卡的天数
	ScheduledDays int `json:"scheduledDays"` // 至少有一个习惯应打的天数
}

// HabitStat 是区间统计的返回体。
type HabitStat struct {
	Start   model.Day             `json:"start"`
	End     model.Day             `json:"end"`
	Today   model.Day             `json:"today"`
	Habits  []HabitStatHabit      `json:"habits"`
	Days    []HabitStatDaySummary `json:"days"`
	Summary HabitStatSummary      `json:"summary"`
}

// HabitStat 算出 [start,end] 区间的习惯统计。
func (a *App) HabitStat(ctx context.Context, req HabitStatRequest) (HabitStat, error) {
	if req.Start == "" || req.End == "" {
		return HabitStat{}, fmt.Errorf("service: 统计区间不能为空")
	}
	// repeat.DiffDays(a,b) 是「从 a 数到 b」的天数，负数就是区间写反了
	if repeat.DiffDays(req.Start, req.End) < 0 {
		return HabitStat{}, fmt.Errorf("service: 统计区间反了：%s → %s", req.Start, req.End)
	}
	// 一次最多一年：年统计正好 366 格，再多就是别的入口的事了
	if repeat.DiffDays(req.Start, req.End) > 380 {
		return HabitStat{}, fmt.Errorf("service: 统计区间过长（最多一年）")
	}
	habits, err := a.habits(ctx)
	if err != nil {
		return HabitStat{}, err
	}
	clocks, err := a.clocksByHabit(ctx)
	if err != nil {
		return HabitStat{}, err
	}
	units, err := a.HabitUnits(ctx)
	if err != nil {
		return HabitStat{}, err
	}
	unitName := map[string]string{}
	for _, u := range units {
		unitName[u.ID] = u.Name
	}
	today := a.Today()

	span := allDays(req.Start, req.End)
	out := HabitStat{Start: req.Start, End: req.End, Today: today,
		Habits: make([]HabitStatHabit, 0, len(habits)),
		Days:   make([]HabitStatDaySummary, 0, len(span))}
	byDay := make(map[model.Day]*HabitStatDaySummary, len(span))
	for _, d := range span {
		s := HabitStatDaySummary{Day: d, Future: repeat.DiffDays(today, d) > 0}
		out.Days = append(out.Days, s)
		byDay[d] = &out.Days[len(out.Days)-1]
	}

	for _, h := range habits {
		target := 1.0
		if h.Mode == model.HabitMultiPerDay {
			target = h.DailyTarget
		}
		scheduled := map[model.Day]bool{}
		for _, d := range a.scheduledDays(h, req.Start, req.End) {
			scheduled[d] = true
		}
		row := HabitStatHabit{
			HabitID: h.ID, Name: h.Name, Icon: h.Icon, Context: h.Context,
			Mode: int(h.Mode), Unit: unitName[h.UnitID],
			Days: make([]HabitStatDay, 0, len(span)),
		}
		amounts := clocks[h.ID]
		for _, d := range span {
			amt := amounts[d]
			due := scheduled[d] && d >= h.StartDay
			cell := HabitStatDay{Day: d, Amount: amt, Target: target}
			// 打卡优先于排期：回溯额度允许往非排期日打卡，那天就必须显示成「打了卡」，
			// 不能因为它不在排期表里就画成休息——用户的打卡记录被吞掉比多出一格更糟。
			switch {
			case amt >= target && target > 0:
				cell.State = "done"
			case amt > 0:
				cell.State = "partial"
			case !due:
				cell.State = "rest" // 没排期 / 习惯还没开始，且那天确实没打
			case repeat.DiffDays(today, d) > 0:
				cell.State = "future"
			case d == today:
				cell.State = "pending"
			default:
				cell.State = "missed"
			}
			row.Days = append(row.Days, cell)
			sum := byDay[d]
			if due {
				row.Scheduled++
				sum.Scheduled++
			}
			if amt > 0 {
				row.Checked++
				sum.Checked++
				out.Summary.Checkins++
				// 「打满」只统计应打日：额外补打不该把当天的完美打卡算成 Done>Scheduled
				if due && amt >= target {
					row.Done++
					sum.Done++
				}
			}
		}
		row.Streak = a.streak(h, amounts, req.End)
		out.Habits = append(out.Habits, row)
	}

	// 完美打卡与最长连续：都按「天」这条横切面算，和上面逐习惯的口径互不干扰。
	streak, best := 0, 0
	for i := range out.Days {
		d := &out.Days[i]
		if d.Scheduled > 0 {
			out.Summary.ScheduledDays++
			if !d.Future && d.Done == d.Scheduled {
				d.Perfect = true
				out.Summary.PerfectDays++
			}
		}
		// 连续：当天只要有打卡就续上（未来天直接断开，不能提前算进连击）
		if d.Checked > 0 && !d.Future {
			streak++
			if streak > best {
				best = streak
			}
			continue
		}
		if d.Future {
			// 未来天既不算断开也不算续上；但已经过完的天里，「该打却没打」必须断连击，
			// 否则一个整月没打卡也会因为全是 rest 而报出 0 之外的假数字。
			if d.Scheduled > 0 {
				streak = 0
			}
			continue
		}
		if d.Scheduled > 0 {
			streak = 0
		}
	}
	out.Summary.LongestStreak = best

	// 习惯按名字排，保证四个页签里顺序稳定（卡片位置不会每次刷新都跳）
	sort.SliceStable(out.Habits, func(i, j int) bool {
		if out.Habits[i].Context != out.Habits[j].Context {
			return out.Habits[i].Context < out.Habits[j].Context
		}
		return out.Habits[i].HabitID < out.Habits[j].HabitID
	})
	return out, nil
}

// allDays 展开 [from,to] 的每一天。
func allDays(from, to model.Day) []model.Day {
	out := []model.Day{}
	d := from
	for {
		out = append(out, d)
		if d == to || len(out) > 400 {
			break
		}
		d = repeat.AddDays(d, 1)
	}
	return out
}
