package calendar

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNewReturnsNilWhenEmpty(t *testing.T) {
	if got := New(); got != nil {
		t.Errorf("没有数据时应返回 nil，得 %v", got)
	}
	if got := New(Table{Year: 2026}); got != nil {
		t.Errorf("空表也应返回 nil：%v", got)
	}
}

func TestLookupNormalizesAndSplits(t *testing.T) {
	f := New(Table{
		Year:         2026,
		Holidays:     []string{"2026-01-01", " 2026-01-02T00:00:00 ", "坏数据"},
		MakeupDays:   []string{"2026-01-04"},
		Source:       "示例",
		LastVerified: "2025-11-01",
	})
	if f == nil {
		t.Fatal("有数据时不该返回 nil")
	}
	if !f.IsHoliday("2026-01-01") {
		t.Error("元旦应为假日")
	}
	if !f.IsHoliday("2026-01-02") {
		t.Error("带时间后缀的入参应被归一化")
	}
	if f.IsHoliday("2026-01-03") {
		t.Error("工作日不该被认成假日")
	}
	if !f.IsMakeupWorkday("2026-01-04") {
		t.Error("调休上班日应命中")
	}
	if f.IsMakeupWorkday("2026-01-01") {
		t.Error("假日不应同时是调休上班日")
	}
	if got := f.Years(); !reflect.DeepEqual(got, []int{2026}) {
		t.Errorf("Years = %v", got)
	}
	if got := f.Mark("2026-01-01"); got != "休" {
		t.Errorf("假日的标记应是「休」，得 %q", got)
	}
	if got := f.Mark("2026-01-04"); got != "班" {
		t.Errorf("调休上班日的标记应是「班」，得 %q", got)
	}
	if got := f.Mark("2026-01-05"); got != "" {
		t.Errorf("普通日子不该有标记，得 %q", got)
	}
	// nil 接收者也要安全：调用方会把「没数据」直接当 nil 传下去。
	var empty *FS
	if empty.IsHoliday("2026-01-01") || empty.IsMakeupWorkday("2026-01-04") || empty.Years() != nil {
		t.Error("nil 数据源必须全部返回 false/nil")
	}
	if empty.Mark("2026-01-01") != "" || empty.SourceOf(2026) != "" || empty.Infos() != nil {
		t.Error("nil 数据源的 Mark/SourceOf/Infos 也必须给空值")
	}
}

func TestLoadMissingDirIsNotAnError(t *testing.T) {
	f, err := Load(filepath.Join(t.TempDir(), "nope"))
	if err != nil || f != nil {
		t.Fatalf("目录不存在应返回 (nil, nil)，得 (%v, %v)", f, err)
	}
}

func TestWriteLoadRoundTripAndValidation(t *testing.T) {
	dir := t.TempDir()
	in := Table{Year: 2027, Holidays: []string{"2027-01-01"}, MakeupDays: []string{"2027-01-03"},
		Source: "测试", LastVerified: "2026-11-05"}
	if err := Write(dir, in); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := Write(dir, Table{}); err == nil {
		t.Error("缺 year 的表不该写得进去")
	}
	f, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f == nil || !f.IsHoliday("2027-01-01") || !f.IsMakeupWorkday("2027-01-03") {
		t.Fatalf("往返不一致：%+v", f)
	}

	// 坏 JSON 必须报错，不能静默当成「没有节假日数据」——那会让法定节假日规则悄悄失效。
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := Load(dir); err == nil {
		t.Error("坏数据文件必须报错")
	}
}

// TestBuiltinTablesAreValid 是这份内置数据的守门员：每年都要过 Validate，
// 且逐字段核对原文里的条数。改了 data/*.json 一定会撞到这里。
func TestBuiltinTablesAreValid(t *testing.T) {
	years := BuiltinYears()
	want := map[int]struct{ holidays, makeup int }{
		2025: {28, 5}, // 元旦1 + 春节8 + 清明3 + 劳动5 + 端午3 + 国庆中秋8
		2026: {33, 6}, // 元旦3 + 春节9 + 清明3 + 劳动5 + 端午3 + 中秋3 + 国庆7
		2027: {29, 5}, // 元旦3 + 春节9 + 清明3 + 劳动5 + 端午1 + 中秋1 + 国庆7
	}
	if len(years) != len(want) {
		t.Fatalf("内置年份应正好是 %v，得 %v", want, years)
	}
	for _, y := range years {
		tbl, ok := BuiltinTable(y)
		if !ok {
			t.Fatalf("%d 年在 BuiltinYears 里却读不出来", y)
		}
		if err := tbl.Validate(); err != nil {
			t.Errorf("%d 年表没过校验：%v", y, err)
		}
		w := want[y]
		if len(tbl.Holidays) != w.holidays || len(tbl.MakeupDays) != w.makeup {
			t.Errorf("%d 年条数不符：放假 %d（应为 %d）、补班 %d（应为 %d）",
				y, len(tbl.Holidays), w.holidays, len(tbl.MakeupDays), w.makeup)
		}
		if tbl.Source == "" || tbl.LastVerified == "" {
			t.Errorf("%d 年表缺出处或核对日期：%+v", y, tbl)
		}
	}
}

// TestBuiltinSpotChecks 核对的是「用户会当场发现错」的那几天：长假首尾、补班周六日。
func TestBuiltinSpotChecks(t *testing.T) {
	cal := build(builtinTables()...)
	if cal == nil {
		t.Fatal("内置表组装失败")
	}
	cases := []struct {
		day  string
		want string // 休 / 班 / ""
		why  string
	}{
		{"2025-10-01", "休", "2025 国庆中秋假首日"},
		{"2025-10-08", "休", "2025 国庆中秋假末日"},
		{"2025-10-11", "班", "2025 国庆后补班的周六"},
		{"2026-02-15", "休", "2026 除夕（腊月二十八）"},
		{"2026-02-23", "休", "2026 正月初七"},
		{"2026-02-14", "班", "2026 春节补班的周六"},
		{"2026-10-01", "休", "2026 国庆首日"},
		{"2026-09-20", "班", "2026 国庆补班的周日"},
		{"2026-12-25", "", "圣诞不是法定节假日，只是普通周五"},
		{"2027-02-05", "休", "2027 除夕"},
		{"2027-06-09", "休", "2027 端午只放 1 天"},
		{"2027-10-09", "班", "2027 国庆补班的周六"},
		{"2028-01-01", "", "内置只到 2027：宁可不标，也不拿去年的安排猜明年"},
	}
	for _, c := range cases {
		if got := cal.Mark(c.day); got != c.want {
			t.Errorf("%s（%s）应标 %q，实得 %q", c.day, c.why, c.want, got)
		}
	}
	if got := cal.Years(); !reflect.DeepEqual(got, []int{2025, 2026, 2027}) {
		t.Errorf("生效年份 = %v", got)
	}
	if src := cal.SourceOf(2027); src == "" {
		t.Error("2027 年缺出处，界面 tooltip 就没法交代依据")
	}
}

// TestOpenLocalOverridesYear 验证本机表是「整年替换」而不是叠加：
// 用户修正某一年时， built-in 里被改的那几天必须消失。
func TestOpenLocalOverridesYear(t *testing.T) {
	dir := t.TempDir()
	if err := Write(dir, Table{
		Year:     2026,
		Holidays: []string{"2026-01-01", "2026-01-02"},
		// 补班必须落在周末：2026-01-03 是周六。
		MakeupDays:   []string{"2026-01-03"},
		Source:       "本机修正",
		LastVerified: "2026-11-08",
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	cal, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if cal.IsHoliday("2026-10-01") {
		t.Error("本机已替换 2026，内置的国庆还在生效")
	}
	if !cal.IsHoliday("2026-01-02") {
		t.Error("本机新增的放假日没生效")
	}
	if cal.IsMakeupWorkday("2026-02-14") {
		t.Error("2026 整年已被本机表替换，内置的春节补班日不该还在")
	}
	if !cal.IsMakeupWorkday("2025-01-26") {
		t.Error("没被替换的 2025 仍应来自内置")
	}
	st := StatusOf(cal, dir)
	if len(st.Years) != 3 {
		t.Fatalf("应仍是三年数据，得 %+v", st.Years)
	}
	if st.Years[1].Year != 2026 || st.Years[1].Origin != OriginLocal {
		t.Errorf("2026 应标记为本机导入：%+v", st.Years[1])
	}
	if !reflect.DeepEqual(st.LocalYears, []int{2026}) {
		t.Errorf("LocalYears = %v", st.LocalYears)
	}
	if st.Years[0].Origin != OriginBuiltin {
		t.Errorf("2025 应标记为内置：%+v", st.Years[0])
	}
	if st.Dir != dir {
		t.Errorf("Dir 没回传：%q", st.Dir)
	}
}

func TestValidateCatchesBadTables(t *testing.T) {
	cases := []struct {
		name string
		tbl  Table
	}{
		{"零年份", Table{Holidays: []string{"2026-01-01"}}},
		{"超出范围", Table{Year: 2101, Holidays: []string{"2101-01-01"}}},
		{"日期格式坏", Table{Year: 2026, Holidays: []string{"2026-1-1"}}},
		{"混进别年", Table{Year: 2026, Holidays: []string{"2027-01-01"}}},
		{"既休又班", Table{Year: 2026, Holidays: []string{"2026-10-01"}, MakeupDays: []string{"2026-10-01"}}},
		{"补班不在周末", Table{Year: 2026, Holidays: []string{"2026-10-01"}, MakeupDays: []string{"2026-10-05"}}},
		{"空表", Table{Year: 2026}},
	}
	for _, c := range cases {
		if err := c.tbl.Validate(); err == nil {
			t.Errorf("%s：该报错却通过了", c.name)
		}
	}
	// 正例：2026 元旦三天假 + 1 月 4 日（周日）补班。
	ok := Table{Year: 2026, Holidays: []string{"2026-01-01", "2026-01-02", "2026-01-03"},
		MakeupDays: []string{"2026-01-04"}}
	if err := ok.Validate(); err != nil {
		t.Errorf("正例被拒：%v", err)
	}
}
