package calendar

import "testing"

func mustLunar(t *testing.T, y, m, d int) Lunar {
	t.Helper()
	l, err := ToLunar(y, m, d)
	if err != nil {
		t.Fatalf("ToLunar(%d,%d,%d): %v", y, m, d, err)
	}
	return l
}

// 已知对照点逐条断言。2026-11-06 需求里给的是「九月廿七」，
// 经多个权威万年历交叉验证（黄历网、便民查询万年历均载 11-06＝九月廿八、
// 11-07＝九月廿九），正确值是九月廿八，此处以权威结果为准。
func TestToLunarKnownDates(t *testing.T) {
	cases := []struct {
		y, m, d           int
		year, month, day  int
		isLeap            bool
		ganzhi, shengxiao string
		note              string
	}{
		{2026, 11, 6, 2026, 9, 28, false, "丙午", "马", "九月廿八（需求写的廿七有误）"},
		{2026, 2, 17, 2026, 1, 1, false, "丙午", "马", "丙午马年春节"},
		{2025, 1, 29, 2025, 1, 1, false, "乙巳", "蛇", "乙巳蛇年春节"},
		{2026, 9, 25, 2026, 8, 15, false, "丙午", "马", "中秋八月十五"},
		{2026, 6, 19, 2026, 5, 5, false, "丙午", "马", "端午五月初五"},
		{1900, 1, 31, 1900, 1, 1, false, "庚子", "鼠", "表起点：1900 年正月初一"},
		{2100, 12, 31, 2100, 12, 1, false, "庚申", "猴", "表末端可计算"},
	}
	for _, c := range cases {
		l := mustLunar(t, c.y, c.m, c.d)
		if l.Year != c.year || l.Month != c.month || l.Day != c.day || l.IsLeapMonth != c.isLeap {
			t.Errorf("%s: %d-%02d-%02d → 得 %d年%d月%d日 闰%v，期望 %d年%d月%d日 闰%v", c.note,
				c.y, c.m, c.d, l.Year, l.Month, l.Day, l.IsLeapMonth, c.year, c.month, c.day, c.isLeap)
		}
		if l.YearGanZhi != c.ganzhi {
			t.Errorf("%s: 干支应为 %s，得 %s", c.note, c.ganzhi, l.YearGanZhi)
		}
		if l.YearShengXiao != c.shengxiao {
			t.Errorf("%s: 生肖应为 %s，得 %s", c.note, c.shengxiao, l.YearShengXiao)
		}
	}
}

// 2025 年闰六月：表算出 2025-07-25 是闰六月初一，整段闰六月都在此标记下。
func TestLeapMonth2025(t *testing.T) {
	l := mustLunar(t, 2025, 7, 25)
	if !l.IsLeapMonth || l.Month != 6 {
		t.Errorf("2025-07-25 应为闰六月，得 %d年%d月%d日 闰%v", l.Year, l.Month, l.Day, l.IsLeapMonth)
	}
	if l.MonthName != "闰六月" {
		t.Errorf("闰月月名应为「闰六月」，得 %q", l.MonthName)
	}
	// 前一日还在普通六月（六月大，三十），闰六月初一从 7-25 起。
	if prev := mustLunar(t, 2025, 7, 24); prev.IsLeapMonth || prev.Month != 6 || prev.Day != 30 {
		t.Errorf("2025-07-24 应为六月三十，得 %+v", prev)
	}
	if next := mustLunar(t, 2025, 8, 22); !next.IsLeapMonth || next.Month != 6 || next.Day != 29 {
		t.Errorf("2025-08-22 应为闰六月廿九（闰六月小），得 %+v", next)
	}
}

func TestMonthDayNames(t *testing.T) {
	if got := DayLabel(2026, 11, 6); got != "廿八" {
		t.Errorf("2026-11-06 日名应为廿八，得 %q", got)
	}
	if got := DayLabel(2026, 2, 17); got != "初一" {
		t.Errorf("正月初一的日名应为初一，得 %q", got)
	}
	// 月名习惯叫法：正月、冬月、腊月，不是数字月。
	if got := mustLunar(t, 2026, 1, 1).MonthName; got != "冬月" {
		t.Errorf("2026-01-01 应为农历乙巳年冬月，得 %q", got)
	}
	if DayLabel(1899, 12, 31) != "" {
		t.Error("越界日期日名应为空串而不是猜一个")
	}
}

func TestFestival(t *testing.T) {
	cases := []struct {
		y, m, d int
		want    string
	}{
		{2026, 2, 17, "春节"},
		{2026, 1, 1, "元旦"},
		{2026, 2, 14, "情人节"},
		{2026, 3, 8, "妇女节"},
		{2026, 4, 1, "愚人节"},
		{2026, 5, 1, "劳动节"},
		{2026, 6, 1, "儿童节"},
		{2026, 8, 1, "建军节"},
		{2026, 9, 10, "教师节"},
		{2026, 10, 1, "国庆节"},
		{2026, 12, 24, "平安夜"},
		{2026, 12, 25, "圣诞节"},
		{2026, 5, 10, "母亲节"}, // 5 月第二个周日
		{2026, 6, 21, "父亲节"}, // 6 月第三个周日
		{2026, 9, 25, "中秋节"},
		{2026, 6, 19, "端午节"},
		{2027, 2, 5, "除夕"}, // 2027 春节（正月初一为 2/6）前一日，腊月廿九（腊月小）
		{2026, 11, 6, ""},  // 普通日子不该硬凑节日
	}
	for _, c := range cases {
		if got := Festival(c.y, c.m, c.d); got != c.want {
			t.Errorf("Festival(%d-%02d-%02d) = %q，期望 %q", c.y, c.m, c.d, got, c.want)
		}
	}
}

func TestSolarTerm(t *testing.T) {
	if got := mustLunar(t, 2026, 2, 4).SolarTerm; got != "立春" {
		t.Errorf("2026-02-04 应为立春，得 %q", got)
	}
	if got := mustLunar(t, 2026, 12, 7).SolarTerm; got != "大雪" {
		t.Errorf("2026-12-07 应为大雪，得 %q", got)
	}
	if got := mustLunar(t, 2026, 11, 6).SolarTerm; got != "" {
		t.Errorf("2026-11-06 不是节气日，得 %q", got)
	}
}

func TestOutOfRange(t *testing.T) {
	for _, c := range [][3]int{{1899, 12, 31}, {2101, 1, 1}, {1900, 1, 30}, {2026, 13, 1}, {2026, 2, 30}} {
		if _, err := ToLunar(c[0], c[1], c[2]); err == nil {
			t.Errorf("ToLunar(%d,%d,%d) 应报错", c[0], c[1], c[2])
		}
	}
}

// 全区间扫描：1900-01-31 至 2100-12-31 每一天都要能换算，字段落在合法区间，
// 且农历 1900-2100 每个年头的正月初一恰好各出现一次（201 个春节）。
func TestFullRangeScan(t *testing.T) {
	newYears := map[int]bool{}
	for day := 0; ; day++ {
		ts := lunarBase.AddDate(0, 0, day)
		if ts.Year() > 2100 {
			break
		}
		l, err := ToLunar(ts.Year(), int(ts.Month()), ts.Day())
		if err != nil {
			t.Fatalf("%s: %v", ts.Format("2006-01-02"), err)
		}
		if l.Month < 1 || l.Month > 12 || l.Day < 1 || l.Day > 30 {
			t.Fatalf("%s: 农历字段越界 %+v", ts.Format("2006-01-02"), l)
		}
		if l.MonthName == "" || l.DayName == "" {
			t.Fatalf("%s: 月名/日名为空 %+v", ts.Format("2006-01-02"), l)
		}
		if !l.IsLeapMonth && l.Month == 1 && l.Day == 1 {
			newYears[l.Year] = true
		}
	}
	if len(newYears) != 201 {
		t.Errorf("1900-2100 共 201 个农历年，各应有一个正月初一，实得 %d", len(newYears))
	}
}
