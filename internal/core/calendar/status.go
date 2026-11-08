package calendar

// Status 是「当前生效的节假日数据」的一份说明，给设置页与 CLI 打印用。
//
// 为什么要摆到界面上：班/休标记和「法定工作日」重复会直接影响用户哪天被提醒，
// 而数据是有年份上限的。不显示覆盖范围，用户就会把 2028 年当成也准。
type Status struct {
	Years        []YearInfo `json:"years"`        // 实际生效的逐年信息（内置 + 本机导入）
	BuiltinYears []int      `json:"builtinYears"` // 内置表覆盖的年份
	LocalYears   []int      `json:"localYears"`   // 被本机导入顶掉的年份
	Dir          string     `json:"dir"`          // 放 <year>.json 的目录
}

// StatusOf 组装说明；cal 为 nil（一年都没有）时给出空数组而不是 null。
func StatusOf(cal *FS, dir string) Status {
	st := Status{
		Years:        cal.Infos(),
		BuiltinYears: BuiltinYears(),
		Dir:          dir,
	}
	if st.Years == nil {
		st.Years = []YearInfo{}
	}
	if st.BuiltinYears == nil {
		st.BuiltinYears = []int{}
	}
	for _, i := range st.Years {
		if i.Origin == OriginLocal {
			st.LocalYears = append(st.LocalYears, i.Year)
		}
	}
	if st.LocalYears == nil {
		st.LocalYears = []int{}
	}
	return st
}
