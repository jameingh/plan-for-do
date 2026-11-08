// Package calendar 给内核提供法定节假日与调休上班日的数据源。
//
// 它实现 repeat.HolidaySource，所以数据在不在都不影响其它功能：
// 没有数据文件时「法定工作日」「智能跳过节假日」退化成普通周一至周五，
// 而不是拿一份猜出来的日历去算错用户的打卡与逾期。
package calendar

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Table 是一年的节假日数据。Year 只用于展示与校验文件名，判定一律按日字符串走。
type Table struct {
	Year         int      `json:"year"`
	Holidays     []string `json:"holidays"`       // 放假日，形如 2026-01-01
	MakeupDays   []string `json:"makeupWorkdays"` // 调休要上班的周末，形如 2026-01-04
	Source       string   `json:"source"`         // 出处，例如「国务院办公厅关于2026年部分节假日安排的通知」
	LastVerified string   `json:"lastVerified"`   // 数据核对日期，YYYY-MM-DD
}

// FS 是按日查表的 HolidaySource 实现。
type FS struct {
	holidays map[string]bool
	makeup   map[string]bool
	years    []int
}

// New 从若干 Table 组装数据源。全空时返回 nil，调用方把 nil 当「不启用」处理。
func New(tables ...Table) *FS {
	h, m := map[string]bool{}, map[string]bool{}
	years := []int{}
	for _, t := range tables {
		years = append(years, t.Year)
		for _, d := range t.Holidays {
			if k := norm(d); k != "" {
				h[k] = true
			}
		}
		for _, d := range t.MakeupDays {
			if k := norm(d); k != "" {
				m[k] = true
			}
		}
	}
	if len(h) == 0 && len(m) == 0 {
		return nil
	}
	sort.Ints(years)
	return &FS{holidays: h, makeup: m, years: years}
}

// IsHoliday 报告这天是否法定假日。
func (f *FS) IsHoliday(day string) bool { return f != nil && f.holidays[norm(day)] }

// IsMakeupWorkday 报告这天是否调休上班（通常落在周末）。
func (f *FS) IsMakeupWorkday(day string) bool { return f != nil && f.makeup[norm(day)] }

// Years 返回已加载的年份，设置页要显示数据覆盖范围。
func (f *FS) Years() []int {
	if f == nil {
		return nil
	}
	return f.years
}

// Load 读 dir 下所有 *.json 节假日表。目录不存在或没有文件时返回 (nil, nil)——
// 「还没有数据」是正常的启动状态，不该当错误往上抛。
func Load(dir string) (*FS, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("calendar: 读目录 %s: %w", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	tables := make([]Table, 0, len(names))
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("calendar: 读 %s: %w", name, err)
		}
		var t Table
		if err := json.Unmarshal(raw, &t); err != nil {
			return nil, fmt.Errorf("calendar: 解析 %s: %w", name, err)
		}
		if t.Year == 0 {
			return nil, fmt.Errorf("calendar: %s 缺 year 字段", name)
		}
		tables = append(tables, t)
	}
	return New(tables...), nil
}

// Write 保存某年的数据表，给设置页或导入脚本用。
func Write(dir string, t Table) error {
	if t.Year == 0 {
		return fmt.Errorf("calendar: year 不能为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("calendar: 建目录 %s: %w", dir, err)
	}
	raw, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, fmt.Sprintf("%d.json", t.Year))
	return os.WriteFile(path, raw, 0o644)
}

func norm(day string) string {
	day = strings.TrimSpace(day)
	if len(day) >= 10 {
		return day[:10]
	}
	return ""
}
