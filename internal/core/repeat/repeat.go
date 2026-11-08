// Package repeat 把「一条事项本体 + 重复规则」展开成某些天里的实际出现日期。
//
// 只有纯函数：不读数据库、不看 UI，输入是 model 里的值，输出是升序去重的 Day 序列。
// 打卡状态、逾期分桶不在这里，那是 service 层叠加 OccurrenceOverride 之后的事。
package repeat

import (
	"sort"
	"time"

	"planfordo/internal/core/model"
)

const layout = "2006-01-02"

// maxScanDays 限制单次展开扫描的天数（约 110 年），兜住 Interval=0、锚点异常早等脏数据。
const maxScanDays = 40000

// HolidaySource 提供法定节假日与调休上班日。nil 表示没有日历数据，此时
// SkipLegalHolidays、FollowMakeupWorkday 与「法定工作日」预设退化成普通周一至周五。
type HolidaySource interface {
	IsHoliday(d model.Day) bool
	IsMakeupWorkday(d model.Day) bool
}

// ParseDay 解析本地日历日。
func ParseDay(d model.Day) (time.Time, bool) {
	t, err := time.Parse(layout, d)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// Format 把时间转成本地日历日字符串。
func Format(t time.Time) model.Day { return t.Format(layout) }

// AddDays 在日历日上加减天数。日算绪走 UTC 正午，避开夏令时造成的 23/25 小时天。
func AddDays(d model.Day, n int) model.Day {
	t, ok := ParseDay(d)
	if !ok {
		return d
	}
	return Format(t.AddDate(0, 0, n))
}

// DiffDays 返回 b-a 的天数；无法解析时按 0 处理。
func DiffDays(a, b model.Day) int {
	ta, oka := ParseDay(a)
	tb, okb := ParseDay(b)
	if !oka || !okb {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

// Weekday 返回 1=周一 .. 7=周日，与 model 里 Weekdays 的约定一致。
func Weekday(d model.Day) int {
	t, ok := ParseDay(d)
	if !ok {
		return 1
	}
	w := int(t.Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// BaseDays 展开 DateSpec 自身占用的日子，不看重复规则。
func BaseDays(spec model.DateSpec) []model.Day {
	switch spec.Kind {
	case model.DateSpan:
		if spec.End == "" || DiffDays(spec.End, spec.Start) > 0 {
			return []model.Day{spec.Start}
		}
		out := make([]model.Day, 0, DiffDays(spec.Start, spec.End)+1)
		cur := spec.Start
		for i := 0; i <= maxScanDays; i++ {
			out = append(out, cur)
			if cur == spec.End {
				break
			}
			cur = AddDays(cur, 1)
		}
		return out
	case model.DateSelected:
		out := append([]model.Day(nil), spec.Selected...)
		sort.Strings(out)
		return dedup(out)
	default:
		if spec.Start == "" {
			return nil
		}
		return []model.Day{spec.Start}
	}
}

// Occurrences 返回事项在 [from, to] 闭区间内出现的日子，升序去重。
//
// 语义约定（与朝暮计划的可见行为对齐）：
//   - 无重复规则＝BaseDays 与区间的交集。
//   - 跨天事项 + SmartSpan＝每个命中日只占一天（「只在周期命中日生成当天分段」）。
//   - 跨天事项 + 非 SmartSpan＝每个命中日展开成与原跨度等长的整段，段间可重叠。
//   - 自选多日 + 重复＝以自选日为集合，重复规则只做筛选，不向前滚动。
//   - EndByCount 的次数含锚点日，序列从锚点起算，因此即使 from 晚于锚点也正确。
func Occurrences(item *model.ListItem, from, to model.Day, h HolidaySource) []model.Day {
	if item == nil || from == "" || to == "" || DiffDays(from, to) < 0 {
		return nil
	}
	base := BaseDays(item.Date)
	if len(base) == 0 {
		return nil
	}
	anchor := base[0]

	if item.Repeat == nil {
		return clip(base, from, to)
	}
	r := item.Repeat

	if item.Date.Kind == model.DateSelected {
		out := []model.Day{}
		for _, d := range base {
			if hit(d, r, h, anchor) && inRange(d, from, to) {
				out = append(out, d)
			}
		}
		return out
	}

	span := 0
	if item.Date.Kind == model.DateSpan && !r.SmartSpan {
		span = DiffDays(anchor, specEnd(item.Date))
		if span < 0 {
			span = 0
		}
	}

	out := []model.Day{}
	count := 0
	for d, i := anchor, 0; i < maxScanDays; d, i = AddDays(d, 1), i+1 {
		if DiffDays(d, to) < 0 {
			break // 扫描日已越过窗口末尾，之后的段不可能落进区间
		}
		if hit(d, r, h, anchor) {
			if r.End.Mode == model.EndByDate && r.End.Date != "" && DiffDays(r.End.Date, d) > 0 {
				break // d 已越过结束日
			}
			count++
			if r.End.Mode == model.EndByCount && r.End.Count > 0 && count > r.End.Count {
				break
			}
			for k := 0; k <= span; k++ {
				if day := AddDays(d, k); inRange(day, from, to) {
					out = append(out, day)
				}
			}
		}
	}
	sort.Strings(out)
	return dedup(out)
}

// Occurrence 是叠加了单日例外之后的实例。
type Occurrence struct {
	Day           model.Day
	Status        model.ItemStatus
	ClockedAt     model.ClockTime
	PostponedFrom model.Day // 非空表示这条实例是从那天顺延过来的
	Note          string
}

// Materialize 展开重复序列，再叠加 override。
//
// override 行的 Day 一律是「它最终出现在哪天」：
//   - Status=Skipped 且 Day 在序列里 → 该天不再出现（本次跳过，重复序列本身不动）。
//   - PostponedFrom 非空 → 从 PostponedFrom 挪到 Day，Day 即使不是命中日也会出现。
//   - Status=Clocked → 该天实例标记为已打卡，打卡时间取 ClockedAt。
//
// 「当日及未来」「全部清单」两种批量改动不在此处理，那是 service 层改写本体或补一批 override。
func Materialize(item *model.ListItem, from, to model.Day, overrides []model.OccurrenceOverride, h HolidaySource) []Occurrence {
	days := Occurrences(item, from, to, h)
	byDay := make(map[model.Day]*model.OccurrenceOverride, len(overrides))
	moved := make(map[model.Day]bool, len(overrides))
	for i := range overrides {
		o := overrides[i]
		if o.ItemID != "" && item != nil && o.ItemID != item.ID {
			continue
		}
		byDay[o.Day] = &overrides[i]
		if o.PostponedFrom != "" {
			moved[o.PostponedFrom] = true
			if DiffDays(from, o.Day) >= 0 && DiffDays(o.Day, to) >= 0 {
				days = append(days, o.Day)
			}
		}
	}

	out := make([]Occurrence, 0, len(days))
	for _, d := range dedupSorted(days) {
		if moved[d] {
			continue // 已被顺延走，原日不再出现
		}
		occ := Occurrence{Day: d, Status: model.StatusPending}
		if o, ok := byDay[d]; ok {
			if o.Status == model.StatusSkipped && o.PostponedFrom == "" {
				continue
			}
			occ.Status = o.Status
			occ.ClockedAt = o.ClockedAt
			occ.PostponedFrom = o.PostponedFrom
			occ.Note = o.Note
		}
		out = append(out, occ)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Day < out[j].Day })
	return out
}

func dedupSorted(days []model.Day) []model.Day {
	sort.Strings(days)
	return dedup(days)
}

func specEnd(spec model.DateSpec) model.Day {
	if spec.Kind == model.DateSpan && spec.End != "" {
		return spec.End
	}
	return spec.Start
}

func inRange(d, from, to model.Day) bool {
	return DiffDays(from, d) >= 0 && DiffDays(d, to) >= 0
}

// hit 判定某一天是否被规则命中。anchor 是序列的第 0 天，所有步长都相对它算。
func hit(d model.Day, r *model.Repeat, h HolidaySource, anchor model.Day) bool {
	if r.Ebbinghaus {
		return isEbbinghausDay(d, anchor)
	}
	// 调休上班的周末要在周几筛选之前放行，否则「法定工作日」会漏掉被要求上班的周六、周日。
	// 只作用于按天/按周的规则：每月 24 日这类规则不该被调休日额外撑出实例。
	if h != nil && r.FollowMakeupWorkday && inStep(d, r, anchor) && h.IsMakeupWorkday(d) {
		return true
	}
	interval := r.Interval
	if interval <= 0 {
		interval = 1
	}
	switch r.Unit {
	case model.UnitWeek:
		offset := DiffDays(weekStart(anchor), weekStart(d)) / 7
		if offset < 0 || offset%interval != 0 {
			return false
		}
		if len(r.Weekdays) > 0 {
			if !containsInt(r.Weekdays, Weekday(d)) {
				return false
			}
		} else if Weekday(d) != Weekday(anchor) {
			return false // 「每周」未勾选周几时，只命中与锚点相同的那个星期
		}
	case model.UnitMonth:
		offset := monthsBetween(anchor, d)
		if offset < 0 || offset%interval != 0 {
			return false
		}
		if !matchMonthDay(d, r.MonthDays, anchor) {
			return false
		}
	case model.UnitYear:
		ta, _ := ParseDay(anchor)
		td, _ := ParseDay(d)
		offset := td.Year() - ta.Year()
		if offset < 0 || offset%interval != 0 {
			return false
		}
		if !matchYearDay(d, r, anchor) {
			return false
		}
	default: // UnitDay
		offset := DiffDays(anchor, d)
		if offset < 0 || offset%interval != 0 {
			return false
		}
		if !matchWeekday(d, r.Weekdays) {
			return false
		}
	}
	if h != nil && r.SkipLegalHolidays && h.IsHoliday(d) {
		return false
	}
	return true
}

// inStep 只看步长节奏（每 N 天 / 每 N 周），不看周几与几号筛选。
// 月、年规则返回 false：它们的命中日由「几号」决定，调休补班日不构成新实例。
func inStep(d model.Day, r *model.Repeat, anchor model.Day) bool {
	interval := r.Interval
	if interval <= 0 {
		interval = 1
	}
	switch r.Unit {
	case model.UnitWeek:
		offset := DiffDays(weekStart(anchor), weekStart(d)) / 7
		return offset >= 0 && offset%interval == 0
	case model.UnitDay:
		offset := DiffDays(anchor, d)
		return offset >= 0 && offset%interval == 0
	default:
		return false
	}
}

func matchWeekday(d model.Day, weekdays []int) bool {
	return len(weekdays) == 0 || containsInt(weekdays, Weekday(d))
}

func matchMonthDay(d model.Day, monthDays []int, anchor model.Day) bool {
	td, ok := ParseDay(d)
	if !ok {
		return false
	}
	target := monthDays
	if len(target) == 0 {
		target = []int{dayOfMonth(anchor)}
	}
	day := td.Day()
	n := daysInMonth(td)
	for _, md := range target {
		if md < 0 {
			if n+md+1 == day {
				return true
			}
			continue
		}
		if md == day {
			return true
		}
	}
	return false
}

func matchYearDay(d model.Day, r *model.Repeat, anchor model.Day) bool {
	td, ok := ParseDay(d)
	if !ok {
		return false
	}
	ta, _ := ParseDay(anchor)
	m, day := r.YearMonth, r.YearDay
	if m <= 0 {
		m = int(ta.Month())
	}
	if day <= 0 {
		day = ta.Day()
	}
	if day == 29 && m == 2 && !isLeapYear(td.Year()) {
		return false // 2 月 29 日在不闰的年份直接跳过
	}
	return int(td.Month()) == m && td.Day() == day
}

func isEbbinghausDay(d, anchor model.Day) bool {
	if d == anchor {
		return true
	}
	offset := DiffDays(anchor, d)
	for _, gap := range model.EbbinghausIntervals {
		if gap == offset {
			return true
		}
	}
	return false
}

func weekStart(d model.Day) model.Day {
	return AddDays(d, 1-Weekday(d))
}

func dayOfMonth(d model.Day) int {
	t, ok := ParseDay(d)
	if !ok {
		return 1
	}
	return t.Day()
}

func monthsBetween(a, b model.Day) int {
	ta, oka := ParseDay(a)
	tb, okb := ParseDay(b)
	if !oka || !okb {
		return 0
	}
	return (tb.Year()-ta.Year())*12 + int(tb.Month()) - int(ta.Month())
}

func daysInMonth(t time.Time) int {
	return time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func isLeapYear(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

func clip(days []model.Day, from, to model.Day) []model.Day {
	out := make([]model.Day, 0, len(days))
	for _, d := range days {
		if inRange(d, from, to) {
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return dedup(out)
}

func dedup(days []model.Day) []model.Day {
	out := days[:0]
	for i, d := range days {
		if i > 0 && d == days[i-1] {
			continue
		}
		out = append(out, d)
	}
	return out
}

func containsInt(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
