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
	// nil 接收者也要安全：调用方会把「没数据」直接当 nil 传下去。
	var empty *FS
	if empty.IsHoliday("2026-01-01") || empty.IsMakeupWorkday("2026-01-04") || empty.Years() != nil {
		t.Error("nil 数据源必须全部返回 false/nil")
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
