// Package calendar 给内核提供法定节假日与调休上班日的数据源。
//
// 它实现 repeat.HolidaySource，所以数据在不在都不影响其它功能：
// 没有数据文件时「法定工作日」「智能跳过节假日」退化成普通周一至周五，
// 而不是拿一份猜出来的日历去算错用户的打卡与逾期。
//
// 已核实的年份由 data/*.json 内置（见 builtin.go），本机目录只用来覆盖某一年。
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

// YearInfo 是某一年的数据来源说明，设置页要显示它：用户得知道「班/休」标记
// 是官方安排还是自己导入的，也得知道表只覆盖到哪一年。
type YearInfo struct {
	Year         int    `json:"year"`
	Origin       string `json:"origin"` // OriginBuiltin / OriginLocal
	HolidayCount int    `json:"holidayCount"`
	MakeupCount  int    `json:"makeupCount"`
	Source       string `json:"source"`
	LastVerified string `json:"lastVerified"`
}

// FS 是按日查表的 HolidaySource 实现。
type FS struct {
	holidays  map[string]bool
	makeup    map[string]bool
	years     []int
	infos     []YearInfo
	srcByYear map[int]string
}

// New 从若干 Table 组装数据源。全空时返回 nil，调用方把 nil 当「不启用」处理。
func New(tables ...Table) *FS {
	st := make([]sourcedTable, 0, len(tables))
	for _, t := range tables {
		st = append(st, sourcedTable{Table: t, Origin: OriginLocal})
	}
	return build(st...)
}

// build 组装数据源；同一年出现两次时以最后一次为准（Open 已保证一年只有一条）。
func build(tables ...sourcedTable) *FS {
	h, m := map[string]bool{}, map[string]bool{}
	src := map[int]string{}
	years := []int{}
	infos := []YearInfo{}
	for _, t := range tables {
		if t.Table.Year == 0 {
			continue
		}
		years = append(years, t.Table.Year)
		src[t.Table.Year] = t.Table.Source
		hh, mm := 0, 0
		for _, d := range t.Table.Holidays {
			if k := norm(d); k != "" {
				h[k] = true
				hh++
			}
		}
		for _, d := range t.Table.MakeupDays {
			if k := norm(d); k != "" {
				m[k] = true
				mm++
			}
		}
		infos = append(infos, YearInfo{
			Year: t.Table.Year, Origin: t.Origin,
			HolidayCount: hh, MakeupCount: mm,
			Source: t.Table.Source, LastVerified: t.Table.LastVerified,
		})
	}
	if len(h) == 0 && len(m) == 0 {
		return nil
	}
	sort.Ints(years)
	sort.Slice(infos, func(i, j int) bool { return infos[i].Year < infos[j].Year })
	return &FS{holidays: h, makeup: m, years: years, infos: infos, srcByYear: src}
}

// Mark 给界面用：这天标「休」（法定假日）、「班」（调休上班）还是空（普通日子）。
//
// 判定顺序是假日优先——同一天既在放假又在上班属于数据错误，宁可显示休息。
// Validate 会拒掉这种表，运行时不该再遇到。
func (f *FS) Mark(day string) string {
	switch {
	case f.IsHoliday(day):
		return "休"
	case f.IsMakeupWorkday(day):
		return "班"
	default:
		return ""
	}
}

// SourceOf 返回某年数据的出处，没有则空串。界面 tooltip 用它说明「休/班」的依据。
func (f *FS) SourceOf(year int) string {
	if f == nil {
		return ""
	}
	return f.srcByYear[year]
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

// Infos 返回逐年的出处与条数，按年份升序。
func (f *FS) Infos() []YearInfo {
	if f == nil {
		return nil
	}
	return f.infos
}

// Load 读 dir 下所有 *.json 节假日表（不含内置表）。目录不存在或没有文件时返回 (nil, nil)——
// 「还没有本机数据」是正常的启动状态，不该当错误往上抛。
func Load(dir string) (*FS, error) {
	tables, err := loadTables(dir)
	if err != nil {
		return nil, err
	}
	return build(tables...), nil
}

// loadTables 读目录里的表，按文件名排序；目录不存在返回空切片而不是错误。
func loadTables(dir string) ([]sourcedTable, error) {
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

	tables := make([]sourcedTable, 0, len(names))
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("calendar: 读 %s: %w", name, err)
		}
		t, err := parseTable(raw, name)
		if err != nil {
			return nil, err
		}
		tables = append(tables, sourcedTable{Table: t, Origin: OriginLocal})
	}
	return tables, nil
}

// parseTable 解析一份年度表；坏 JSON 与缺 year 都要当场报出来，
// 不能静默当成「没有节假日数据」——那会让法定节假日规则悄悄失效。
func parseTable(raw []byte, name string) (Table, error) {
	var t Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return Table{}, fmt.Errorf("calendar: 解析 %s: %w", name, err)
	}
	if t.Year == 0 {
		return Table{}, fmt.Errorf("calendar: %s 缺 year 字段", name)
	}
	return t, nil
}

// Write 保存某年的数据表，给设置页或导入脚本用。校验在这里做：
// 不管从哪个入口进来（界面、CLI、脚本），写坏一份表都会让节假日规则算错。
func Write(dir string, t Table) error {
	if err := t.Validate(); err != nil {
		return err
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
