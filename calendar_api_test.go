package main

import (
	"path/filepath"
	"testing"

	"planfordo/internal/core/calendar"
	"planfordo/internal/core/model"
)

// TestLunarLabelsMarksWorkdays 是日期面板那两枚角标的来源断言：
// 「休」来自法定假日，「班」来自调休上班，表没覆盖的年份必须是空标记。
// 标错比不标更糟——用户会照着一个不存在的假期安排自己的打卡。
func TestLunarLabelsMarksWorkdays(t *testing.T) {
	api, err := NewAPI(t.TempDir())
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()

	cases := []struct {
		day, want string
	}{
		{"2026-10-01", "休"},
		{"2026-02-15", "休"},
		{"2026-09-20", "班"},
		{"2027-02-05", "休"},
		{"2027-10-09", "班"},
		{"2026-10-20", ""},  // 普通周二
		{"2026-10-11", ""},  // 假期后的第一个周日：既不放也不补班
		{"2028-01-01", ""},  // 内置表只到 2027，不能拿旧规矩猜新年
		{"2025-10-11", "班"}, // 2025 也在表里
	}
	cells, err := api.LunarLabels(marksDays(cases))
	if err != nil {
		t.Fatalf("LunarLabels: %v", err)
	}
	if len(cells) != len(cases) {
		t.Fatalf("格子数 %d，应为 %d", len(cells), len(cases))
	}
	for i, c := range cases {
		got := cells[i]
		if got.Mark != c.want {
			t.Errorf("%s 标记 = %q，应为 %q", c.day, got.Mark, c.want)
		}
		if c.want == "" && got.MarkSource != "" {
			t.Errorf("%s 没标记却带了出处：%q", c.day, got.MarkSource)
		}
		if c.want != "" && got.MarkSource == "" {
			t.Errorf("%s 标了「%s」但没给出处，界面没法交代依据", c.day, c.want)
		}
		if got.Lunar == "" {
			t.Errorf("%s 农历位空了：内置表不该影响农历", c.day)
		}
	}
}

// TestCalendarInfoExplainsCoverage 断言设置页拿得到「覆盖了哪几年、出处是什么、往哪导入」。
func TestCalendarInfoExplainsCoverage(t *testing.T) {
	dir := t.TempDir()
	api, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()

	st := api.CalendarInfo()
	if len(st.Years) < 3 {
		t.Fatalf("生效年份太少：%+v", st.Years)
	}
	for _, y := range st.Years {
		if y.Origin != calendar.OriginBuiltin {
			t.Errorf("%d 年来源应为内置，得 %q", y.Year, y.Origin)
		}
		if y.Source == "" || y.HolidayCount == 0 {
			t.Errorf("%d 年缺出处或条数：%+v", y.Year, y)
		}
	}
	if want := filepath.Join(dir, "calendars"); st.Dir != want {
		t.Errorf("导入目录 = %q，应为 %q", st.Dir, want)
	}
	if len(st.LocalYears) != 0 {
		t.Errorf("新机不该有本机导入的年份：%v", st.LocalYears)
	}

	// 导入一整年 = 整年替换，且坏表在写盘之前就被拒。
	if err := api.SaveCalendarYear(calendar.Table{Year: 2026, Holidays: []string{"2026-01-01"}}); err != nil {
		t.Fatalf("SaveCalendarYear: %v", err)
	}
	if api.calendar.IsHoliday("2026-10-01") {
		t.Error("2026 已被本机表整年替换，内置的国庆还在生效")
	}
	if got := len(api.CalendarInfo().LocalYears); got != 1 {
		t.Errorf("LocalYears 应记录被覆盖的年份，实得 %v", api.CalendarInfo().LocalYears)
	}
	// 补班日不在周末的表必须写不进去：这种表一定是抄错了，让它生效比拒绝更糟。
	if err := api.SaveCalendarYear(calendar.Table{Year: 2027,
		Holidays: []string{"2027-05-01"}, MakeupDays: []string{"2027-05-05"}}); err == nil {
		t.Error("工作日补班的表该校验失败")
	}
}

func marksDays(cases []struct {
	day, want string
}) []model.Day {
	out := make([]model.Day, 0, len(cases))
	for _, c := range cases {
		out = append(out, model.Day(c.day))
	}
	return out
}
