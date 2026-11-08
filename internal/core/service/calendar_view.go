// calendar_view.go —— 视图模块（日 / 周 / 月）的区间取数。
//
// 清单页要的是「今天该做什么」，所以 ListView 把实例折叠成四个桶；视图要的是「这段时间哪天有什么」，
// 两者不能共用一个接口：折叠会把跨天事项压成一条，网格就画不出跨天条。
// 这里按天铺开、不折叠，并且把无日期事项挡在外面（参考站的网格里也没有它们）。
package service

import (
	"context"
	"fmt"
	"sort"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
)

// calendarMaxDays 是单次区间上限。月视图最多 42 格、周视图 7 格，留足余量又挡住误传，
// 免得一次请求把整个历史拉进内存。
const calendarMaxDays = 400

// CalendarRequest 描述一段区间与过滤条件。过滤字段全为空 = 不过滤（对应「全部清单」视图）。
//
// 自定义视图就是这些字段的组合：ListIDs/CategoryIDs/LabelIDs 是「只看」，
// HideCategoryIDs 是「明确不看」（参考站的 viewMatterClassifyNotShow 就是反向列表）。
// Category 为空串表示「未分类」，所以 CategoryIDs/HideCategoryIDs 里允许出现 ""。
type CalendarRequest struct {
	Start         model.Day `json:"start,omitempty"` // 空 = 今天
	End           model.Day `json:"end,omitempty"`   // 空 = 起始日起 6 周
	ShowDone      bool      `json:"showDone"`        // 已打卡的是否参与
	IncludeHabits bool      `json:"includeHabits,omitempty"`

	ListIDs         []string `json:"listIds,omitempty"`
	CategoryIDs     []string `json:"categoryIds,omitempty"`
	HideCategoryIDs []string `json:"hideCategoryIds,omitempty"`
	LabelIDs        []string `json:"labelIds,omitempty"`
	// HideHabitContexts 是习惯侧的反向过滤（参考站的 viewHabitClassifyNotShow）。
	// 习惯没有「无情境」这一档，所以这里没有空串特殊值。
	HideHabitContexts []string `json:"hideHabitContexts,omitempty"`
}

// CalendarHabit 是网格里的一条习惯。与 HabitCell（习惯页月切片用）不同，这里必须带身份：
// 视图里要点开具体习惯、要按它的颜色画条。
type CalendarHabit struct {
	HabitID string `json:"habitId"`
	// 视图格子要直接画得出一条习惯条，名字与图标色随查询返回，
	// 免得前端再发一次习惯列表请求（改名/改色后视图也立刻跟上）。
	Name   string  `json:"name"`
	Color  string  `json:"color"`
	State  string  `json:"state"` // done | partial | pending
	Amount float64 `json:"amount"`
	Target float64 `json:"target"`
	At     string  `json:"at,omitempty"` // 固定时刻提醒里最早的一个，前端画「几点」
}

// CalendarDay 是网格的一天。Items 已按「全天 → 开始时刻 → 标题」排好，前端不再排。
type CalendarDay struct {
	Day    model.Day       `json:"day"`
	Items  []Occurrence    `json:"items"`
	Habits []CalendarHabit `json:"habits,omitempty"`
}

// CalendarView 是 [Start, End] 的逐日结果，区间内每一天都有一格（空格也在），前端直接铺网格。
type CalendarView struct {
	Start model.Day     `json:"start"`
	End   model.Day     `json:"end"`
	Days  []CalendarDay `json:"days"`
}

// CalendarView 按区间铺开实例。
func (a *App) CalendarView(ctx context.Context, req CalendarRequest) (CalendarView, error) {
	start := req.Start
	if start == "" {
		start = a.Today()
	}
	end := req.End
	if end == "" {
		end = repeat.AddDays(start, 41) // 默认 6 周，正好是月视图的最大网格
	}
	if repeat.DiffDays(start, end) < 0 {
		return CalendarView{}, fmt.Errorf("service: 视图区间反了：%s → %s", start, end)
	}
	if repeat.DiffDays(start, end) >= calendarMaxDays {
		return CalendarView{}, fmt.Errorf("service: 视图区间最多 %d 天，实得 %s → %s", calendarMaxDays, start, end)
	}

	items, err := a.listItems(ctx)
	if err != nil {
		return CalendarView{}, err
	}
	childStats, err := a.childStats(ctx)
	if err != nil {
		return CalendarView{}, err
	}

	kept := make([]*model.ListItem, 0, len(items))
	ids := make(map[string]bool, len(items))
	for _, it := range items {
		if !calendarMatch(it, req) {
			continue
		}
		kept = append(kept, it)
		ids[it.ID] = true
	}

	// overrides 的取法与 ListView 一致：右边界多取一天，覆盖「顺延到区间外那天」的回指。
	overrides, err := a.overridesFor(ctx, ids, start, repeat.AddDays(end, 1))
	if err != nil {
		return CalendarView{}, err
	}

	cells := make([]*CalendarDay, 0, repeat.DiffDays(start, end)+1)
	index := make(map[model.Day]int, len(cells))
	for d := start; repeat.DiffDays(d, end) >= 0; d = repeat.AddDays(d, 1) {
		index[d] = len(cells)
		cells = append(cells, &CalendarDay{Day: d, Items: []Occurrence{}})
	}

	for _, it := range kept {
		// 无日期事项不进网格：它没有「哪天」，参考站的视图里也不出现（清单页的「待办」才有）。
		if it.Date.Start == "" && len(it.Date.Selected) == 0 {
			continue
		}
		for _, o := range repeat.Materialize(it, start, end, overrides[it.ID], a.calendar) {
			i, ok := index[o.Day]
			if !ok {
				continue
			}
			if o.Status.Resolved() && !req.ShowDone {
				continue
			}
			occ := a.occurrenceOf(ctx, it, o.Day, o.Status, o.ClockedAt, o.PostponedFrom, childStats)
			occ.OverrideID = model.OverrideID(it.ID, o.Day)
			cells[i].Items = append(cells[i].Items, occ)
		}
	}

	if req.IncludeHabits {
		if err := a.fillCalendarHabits(ctx, cells, index, start, end, req); err != nil {
			return CalendarView{}, err
		}
	}

	for _, c := range cells {
		sortCalendarItems(c.Items)
	}
	out := CalendarView{Start: start, End: end, Days: make([]CalendarDay, 0, len(cells))}
	for _, c := range cells {
		out.Days = append(out.Days, *c)
	}
	return out, nil
}

// calendarMatch 是自定义视图的过滤。反向列表（HideCategoryIDs）优先，
// 与参考站一致：一个分类被勾成「不显示」时，即使它出现在正向选择里也不给看。
func calendarMatch(it *model.ListItem, req CalendarRequest) bool {
	if len(req.ListIDs) > 0 && !containsStr(req.ListIDs, it.ListID) {
		return false
	}
	if len(req.HideCategoryIDs) > 0 && containsStr(req.HideCategoryIDs, it.Category) {
		return false
	}
	if len(req.CategoryIDs) > 0 && !containsStr(req.CategoryIDs, it.Category) {
		return false
	}
	if len(req.LabelIDs) > 0 {
		hit := false
		for _, l := range req.LabelIDs {
			if containsStr(it.LabelIDs, l) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// sortCalendarItems 让全天事项排在最前，其次按开始时刻，再按标题——
// 网格里一天可能十几条，顺序稳定才不会今天一个样明天一个样。
func sortCalendarItems(xs []Occurrence) {
	sort.SliceStable(xs, func(i, j int) bool {
		a, b := xs[i], xs[j]
		af, bf := a.Item.Time.Kind == model.TimeAllDay || a.Item.Time.Start == "", b.Item.Time.Kind == model.TimeAllDay || b.Item.Time.Start == ""
		if af != bf {
			return af
		}
		if a.Item.Time.Start != b.Item.Time.Start {
			return a.Item.Time.Start < b.Item.Time.Start
		}
		if a.Item.Title != b.Item.Title {
			return a.Item.Title < b.Item.Title
		}
		return a.Item.ID < b.Item.ID
	})
}

// fillCalendarHabits 把习惯摊到它的排期日上。配额型习惯（每周/每月 N 天）在参考站的
// 网格里也是按天出条的，这里沿用 scheduledDays 的排期口径，不额外发明一套。
func (a *App) fillCalendarHabits(ctx context.Context, cells []*CalendarDay, index map[model.Day]int, start, end model.Day, req CalendarRequest) error {
	habits, err := a.habits(ctx)
	if err != nil {
		return err
	}
	clocks, err := a.clocksByHabit(ctx)
	if err != nil {
		return err
	}
	for _, h := range habits {
		// 情境被「自定义视图内容」勾掉的，整条习惯不进网格（参考站的 habitClassifyNotShow）。
		if containsStr(req.HideHabitContexts, h.Context) {
			continue
		}
		target := 1.0
		if h.Mode == model.HabitMultiPerDay {
			target = h.DailyTarget
		}
		byDay := clocks[h.ID]
		at := ""
		for _, r := range h.Reminders {
			if r.AtTime != "" && (at == "" || r.AtTime < at) {
				at = r.AtTime
			}
		}
		for _, d := range a.scheduledDays(h, start, end) {
			i, ok := index[d]
			if !ok {
				continue
			}
			amount := byDay[d]
			cell := CalendarHabit{HabitID: h.ID, Name: h.Name, Color: h.Icon.Color, Amount: amount, Target: target, At: at}
			switch {
			case amount >= target:
				cell.State = "done"
			case amount > 0:
				cell.State = "partial"
			default:
				cell.State = "pending"
			}
			if cell.State == "done" && !req.ShowDone {
				continue
			}
			cells[i].Habits = append(cells[i].Habits, cell)
		}
	}
	return nil
}
