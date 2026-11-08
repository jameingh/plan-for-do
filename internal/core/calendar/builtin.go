// 内置节假日表：国务院每年 11 月前后公布下一年安排，这里打包已核实的年份。
//
// 为什么要内置而不是等用户提供数据：`SkipLegalHolidays` 与「法定工作日」预设在没有
// 数据时静默退化成普通周一至周五（见 repeat.HolidaySource 的注释），用户看不出区别，
// 却会在国庆七天里被提醒「该打卡了」。内置一份带出处的表之后，退化只发生在表没覆盖的
// 年份，而设置页能看到覆盖年份、出处与核对日期。
//
// 数据来源（逐条核对原文，含原文括注的星期）：
//
//	2025：国办发明电〔2024〕12 号，2024-11-12 公布
//	2026：国办发明电〔2025〕7 号，2025-11-04 公布
//	2027：国办发明电〔2026〕10 号，2026-11-05 公布
//
// 表里没有的年份（比如 2028）仍然是「没有数据」，此时退化是正确行为——
// 不能拿今年的安排去猜明年。dataDir/calendars/<year>.json 里有同一年就覆盖内置。
package calendar

import (
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

//go:embed data/*.json
var builtinData embed.FS

// Origin 常量：某年的数据来自内置表还是本机导入。设置页要区分这两者，
// 因为「本机导入」意味着用户（或脚本）改过官方安排。
const (
	OriginBuiltin = "builtin"
	OriginLocal   = "local"
)

// BuiltinYears 返回内置表覆盖的年份，升序。
func BuiltinYears() []int {
	names, err := fs.ReadDir(builtinData, "data")
	if err != nil {
		return nil
	}
	years := []int{}
	for _, n := range names {
		if y, ok := yearOf(n.Name()); ok {
			years = append(years, y)
		}
	}
	sort.Ints(years)
	return years
}

// BuiltinTable 读内置的某一年；没覆盖则 ok 为 false。
func BuiltinTable(year int) (Table, bool) {
	raw, err := builtinData.ReadFile(fmt.Sprintf("data/%d.json", year))
	if err != nil {
		return Table{}, false
	}
	t, err := parseTable(raw, fmt.Sprintf("data/%d.json", year))
	if err != nil {
		// 内置文件是编译期打进来的，坏了属于构建期问题，运行时吞掉只会算错日子
		panic("calendar: 内置 " + strconv.Itoa(year) + " 年表损坏: " + err.Error())
	}
	return t, true
}

// Open 是内核实际用的入口：内置表打底，dir 下的同名年份覆盖内置。
//
// dir 不存在或没有文件不是错误（就是纯内置）；文件损坏必须报错——「节假日规则悄悄
// 失效」是最难查的一类 bug：用户只会发现国庆当天仍然弹了打卡提醒。
func Open(dir string) (*FS, error) {
	local, err := loadTables(dir)
	if err != nil {
		return nil, err
	}
	// 按年归置：本机某一年整年顶掉内置的同一年，而不是往里面加天。
	// 叠加会留下去不掉的错误日期——用户明明改了表，国庆那天还是被标成上班。
	byYear := map[int]sourcedTable{}
	for _, t := range builtinTables() {
		byYear[t.Table.Year] = t
	}
	for _, t := range local {
		byYear[t.Table.Year] = t
	}
	tables := make([]sourcedTable, 0, len(byYear))
	for _, t := range byYear {
		tables = append(tables, t)
	}
	sort.Slice(tables, func(i, j int) bool { return tables[i].Table.Year < tables[j].Table.Year })
	return build(tables...), nil
}

// builtinTables 给出全部内置表。
func builtinTables() []sourcedTable {
	years := BuiltinYears()
	out := make([]sourcedTable, 0, len(years))
	for _, y := range years {
		if t, ok := BuiltinTable(y); ok {
			out = append(out, sourcedTable{Table: t, Origin: OriginBuiltin})
		}
	}
	return out
}

// sourcedTable 带数据来源，供设置页显示「 builtin / local」。
type sourcedTable struct {
	Table
	Origin string
}

// yearOf 从 "2026.json" 取出年份。
func yearOf(name string) (int, bool) {
	if !strings.HasSuffix(name, ".json") {
		return 0, false
	}
	y, err := strconv.Atoi(strings.TrimSuffix(name, ".json"))
	if err != nil || y < 1900 || y > 2100 {
		return 0, false
	}
	return y, true
}
