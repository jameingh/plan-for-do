// lunar.go 做公历到农历的换算：月历面板要在每个日期数字下面显示农历日，
// 遇到节日、节气再顶替成节日/节气名。
//
// 数据源是经典农历信息表（1900-2100，每年一个十六进制数）：
// 低 4 位是闰月月份（0 表示无闰月），bit4-bit15 依次是正月到十二月的大小月
// （置位为大月 30 天，清零为小月 29 天），bit16 表示闰月是 30 天还是 29 天。
// 表数据取自公开万年历算法（jjonline/calendar.js，已修正 2033hex 等问题行），
// 对照点经过多个权威万年历交叉验证。
//
// 这里只做农历与节日换算。法定节假日和调休是国务院每年安排的行政决定，
// 不该由算法伪造，仍由 calendar.go 的 Table 提供。
package calendar

import (
	"fmt"
	"strconv"
	"time"
)

// Lunar 是某个公历日的农历表示。
type Lunar struct {
	Year          int    // 农历年，如 2026（丙午年从正月初一起算）
	Month         int    // 农历月 1-12；闰月也记作本体月份，配合 IsLeapMonth 区分
	Day           int    // 农历日 1-30
	IsLeapMonth   bool   // 该日是否落在闰月里
	MonthName     string // 「正月」「六月」「闰六月」「腊月」这类习惯叫法
	DayName       string // 「初一」「廿六」「三十」
	YearGanZhi    string // 年干支，如「丙午」，按农历年（正月初一分界）
	YearShengXiao string // 生肖，如「马」
	SolarTerm     string // 当天恰是二十四节气之一时给名字，否则为空
}

// 农历换算的起点：公历 1900-01-31 即农历 1900 年正月初一。
var lunarBase = time.Date(1900, 1, 31, 0, 0, 0, 0, time.UTC)

// lunarInfo[i] 编码农历 1900+i 年的闰月与大小月，覆盖 1900-2100 共 201 年。
var lunarInfo = [201]uint32{
	0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
	0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
	0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
	0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
	0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
	0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
	0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
	0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
	0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
	0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
	0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
	0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
	0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
	0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
	0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
	0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
	0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
	0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
	0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
	0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
	0x0d520, // 2100-2100
}

// termInfo[i] 编码公历 1900+i 年的二十四节气日期：30 个十六进制字符分 6 段，
// 每段 5 个 hex 转十进制后是 6 位数字「AbcDeF」，依次给出 4 个节气日
// A、Bc、D、Ef（A、D 恒为一位数，Bc、Ef 恒为两位数），覆盖该年的 24 个节气。
var termInfo = [201]string{
	"9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c3598082c95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f", // 1900-1903
	"b027097bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f", // 1904-1907
	"b027097bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f", // 1908-1911
	"b027097bd097c36b0b6fc9274c91aa", "9778397bd19801ec9210c965cc920e", "97b6b97bd19801ec95f8c965cc920f", "97bd09801d98082c95f8e1cfcc920f", // 1912-1915
	"97bd097bd097c36b0b6fc9210c8dc2", "9778397bd197c36c9210c9274c91aa", "97b6b97bd19801ec95f8c965cc920e", "97bd09801d98082c95f8e1cfcc920f", // 1916-1919
	"97bd097bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c91aa", "97b6b97bd19801ec95f8c965cc920e", "97bcf97c3598082c95f8e1cfcc920f", // 1920-1923
	"97bd097bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c3598082c95f8c965cc920f", // 1924-1927
	"97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c3598082c95f8c965cc920f", // 1928-1931
	"97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f", // 1932-1935
	"97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f", // 1936-1939
	"97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f", // 1940-1943
	"97bd097bd07f595b0b6fc920fb0722", "9778397bd097c36b0b6fc9210c8dc2", "9778397bd19801ec9210c9274c920e", "97b6b97bd19801ec95f8c965cc920f", // 1944-1947
	"97bd07f5307f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c920e", "97b6b97bd19801ec95f8c965cc920f", // 1948-1951
	"97bd07f5307f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c91aa", "97b6b97bd19801ec9210c965cc920e", // 1952-1955
	"97bd07f1487f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", // 1956-1959
	"97bcf7f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", // 1960-1963
	"97bcf7f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", // 1964-1967
	"97bcf7f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e", // 1968-1971
	"97bcf7f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c9274c920e", // 1972-1975
	"97bcf7f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c91aa", "97b6b97bd197c36c9210c9274c920e", // 1976-1979
	"97bcf7f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c920e", // 1980-1983
	"97b6b7f0e47f531b0723b0b6fb0722", "7f0e37f5307f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2", "9778397bd097c36b0b70c9274c91aa", // 1984-1987
	"97b6b7f0e47f531b0723b0b6fb0721", "7f0e37f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc9210c8dc2", "9778397bd097c36b0b6fc9274c91aa", // 1988-1991
	"97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", // 1992-1995
	"97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", // 1996-1999
	"97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa", // 2000-2003
	"97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9274c91aa", // 2004-2007
	"97b6b7f0e47f531b0723b0787b0721", "7f0e27f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c91aa", // 2008-2011
	"97b6b7f0e47f149b0723b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c8dc2", // 2012-2015
	"977837f0e37f149b0723b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722", "7f0e37f5307f595b0b0bc920fb0722", "7f0e397bd097c35b0b6fc9210c8dc2", // 2016-2019
	"977837f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e37f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc9210c8dc2", // 2020-2023
	"977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", // 2024-2027
	"977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722", // 2028-2031
	"977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", // 2032-2035
	"977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", // 2036-2039
	"977837f0e37f14998082b0787b06bd", "7f07e7f0e47f149b0723b0787b0721", "7f0e27f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", // 2040-2043
	"977837f0e37f14998082b0723b06bd", "7f07e7f0e37f149b0723b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722", // 2044-2047
	"977837f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722", "7f0e37f1487f595b0b0bb0b6fb0722", // 2048-2051
	"7f0e37f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722", "7f0e37f1487f531b0b0bb0b6fb0722", // 2052-2055
	"7f0e37f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e37f1487f531b0b0bb0b6fb0722", // 2056-2059
	"7f0e37f0e37f14898082b072297c35", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", // 2060-2063
	"7f0e37f0e37f14898082b072297c35", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722", // 2064-2067
	"7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f149b0723b0787b0721", "7f0e27f1487f531b0b0bb0b6fb0722", // 2068-2071
	"7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0723b06bd", "7f07e7f0e47f149b0723b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722", // 2072-2075
	"7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0723b06bd", "7f07e7f0e37f14998083b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722", // 2076-2079
	"7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14898082b0723b02d5", "7f07e7f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722", // 2080-2083
	"7f0e36665b66aa89801e9808297c35", "665f67f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722", // 2084-2087
	"7f0e36665b66a449801e9808297c35", "665f67f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", // 2088-2091
	"7f0e36665b66a449801e9808297c35", "665f67f0e37f14898082b072297c35", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", // 2092-2095
	"7f0e26665b66a449801e9808297c35", "665f67f0e37f1489801eb072297c35", "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721", // 2096-2099
	"7f0e27f1487f531b0b0bb0b6fb0722", // 2100-2100
}

// 天干、地支与生肖速查表。1984 年为甲子年，故按 (年-4)%10、(年-4)%12 取。
var (
	lianGan   = [10]string{"甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"}
	diZhi     = [12]string{"子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"}
	shengXiao = [12]string{"鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"}
)

// 农历月名。正月、冬月、腊月是习惯叫法，不是「一月」「十一月」「十二月」。
var lunarMonthNames = [12]string{"正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"}

// 数字到汉字的映射，拼日名「初五」「廿七」时用。
var cnNum = [10]string{"一", "二", "三", "四", "五", "六", "七", "八", "九", "十"}

// solarTermNames 按「小寒起、冬至止」的顺序列二十四节气。
// 第 n 个节气（n 从 1 起）落在公历 (n+1)/2 月，与 termInfo 的四段切分一致。
var solarTermNames = [24]string{
	"小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明", "谷雨",
	"立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑",
	"白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至",
}

// leapMonth 返回农历 y 年的闰月月份，0 表示没有闰月。
func leapMonth(y int) int { return int(lunarInfo[y-1900] & 0xf) }

// leapDays 返回农历 y 年闰月的天数；没有闰月时返回 0。
func leapDays(y int) int {
	if m := lunarInfo[y-1900] & 0xf; m != 0 {
		if lunarInfo[y-1900]&0x10000 != 0 {
			return 30
		}
		return 29
	}
	return 0
}

// monthDays 返回农历 y 年普通月 m（1-12）的天数。
func monthDays(y, m int) int {
	if lunarInfo[y-1900]&(0x10000>>uint(m)) != 0 {
		return 30
	}
	return 29
}

// yearDays 返回农历 y 年的总天数（含闰月）。
func yearDays(y int) int {
	sum := 348 // 12 个月全按 29 天算的基数
	for i := uint32(0x8000); i > 0x8; i >>= 1 {
		if lunarInfo[y-1900]&i != 0 {
			sum++
		}
	}
	return sum + leapDays(y)
}

// termDay 返回公历 y 年第 n 个节气（n=1 为小寒）落在当月几日，越界或解析失败返回 0。
func termDay(y, n int) int {
	if y < 1900 || y > 2100 || n < 1 || n > 24 {
		return 0
	}
	s := termInfo[y-1900]
	chunk := s[((n-1)/4)*5 : ((n-1)/4)*5+5]
	v, err := strconv.ParseInt(chunk, 16, 32)
	if err != nil {
		return 0
	}
	ds := strconv.FormatInt(v, 10)
	if len(ds) != 6 {
		return 0 // 表数据约定转十进制必为 6 位；不满足宁可给 0 也不猜
	}
	switch (n - 1) % 4 {
	case 0:
		return int(ds[0] - '0')
	case 1:
		return int(ds[1]-'0')*10 + int(ds[2]-'0')
	case 2:
		return int(ds[3] - '0')
	default:
		return int(ds[4]-'0')*10 + int(ds[5]-'0')
	}
}

// solarTermOf 报告公历 y-m-d 当天是否恰为某节气。
func solarTermOf(y, m, d int) string {
	// 每个公历月恰好含第 2m-1、2m 两个节气（如 2 月含立春、雨水）。
	for _, n := range [2]int{2*m - 1, 2 * m} {
		if termDay(y, n) == d {
			return solarTermNames[n-1]
		}
	}
	return ""
}

// dayName 把农历日 1-30 译成「初一…初十、十一…二十、廿一…三十」。
func dayName(d int) string {
	switch {
	case d < 1 || d > 30:
		return ""
	case d <= 10:
		return "初" + cnNum[d-1]
	case d < 20:
		return "十" + cnNum[d-11]
	case d == 20:
		return "二十"
	case d < 30:
		return "廿" + cnNum[d-21]
	default:
		return "三十"
	}
}

// monthName 把农历月译成习惯叫法，闰月带「闰」前缀。
func monthName(m int, isLeap bool) string {
	if m < 1 || m > 12 {
		return ""
	}
	if isLeap {
		return "闰" + lunarMonthNames[m-1]
	}
	return lunarMonthNames[m-1]
}

// ToLunar 把公历日期换算成农历。范围限定 1900-01-31 至 2100-12-31，
// 超出即报错——农历表只有 201 年，硬算会给出错误日期而不是异常。
func ToLunar(y, m, d int) (Lunar, error) {
	if y < 1900 || y > 2100 {
		return Lunar{}, fmt.Errorf("calendar: 农历换算仅支持 1900-2100，得 %d", y)
	}
	if m < 1 || m > 12 || d < 1 || d > 31 {
		return Lunar{}, fmt.Errorf("calendar: 非法公历日期 %d-%d-%d", y, m, d)
	}
	date := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if date.Year() != y || int(date.Month()) != m || date.Day() != d {
		return Lunar{}, fmt.Errorf("calendar: 非法公历日期 %d-%d-%d", y, m, d)
	}
	if y == 1900 && m == 1 && d < 31 {
		return Lunar{}, fmt.Errorf("calendar: %d-%d-%d 早于农历表起点 1900-01-31", y, m, d)
	}

	offset := int(date.Sub(lunarBase) / (24 * time.Hour))

	// 先定农历年：从 1900 逐年扣天数。循环结束 i 已多走一步，
	// 扣过头（offset<0）时把该年加回来并回退一年。
	i, temp := 1900, 0
	for ; i < 2101 && offset > 0; i++ {
		temp = yearDays(i)
		offset -= temp
	}
	if offset < 0 {
		offset += temp
		i--
	}
	lunarYear := i

	// 再定农历月：闰月排在其本体月份之后，用 isLeap 标记当前正在扣的是不是闰月。
	// mi 会被循环推进到「刚扣完的月的下一个月」，月初整（offset 归零）时它正是目标月。
	leap := leapMonth(lunarYear)
	isLeap := false
	mi := 1
	for ; mi < 13 && offset > 0; mi++ {
		if leap > 0 && mi == leap+1 && !isLeap {
			mi-- // 停在本体月，本轮先扣闰月天数
			isLeap = true
			temp = leapDays(lunarYear)
		} else {
			temp = monthDays(lunarYear, mi)
		}
		if isLeap && mi == leap+1 {
			isLeap = false // 闰月已扣完，解除标记
		}
		offset -= temp
	}
	// offset 恰好归零的边界：目标是刚扣完那之后的月的第一天。若循环停在 leap+1，
	// 需要区分「闰月刚扣完」（目标为普通 leap+1 月）与「本体月刚扣完」（目标为闰月）。
	if offset == 0 && leap > 0 && mi == leap+1 {
		if isLeap {
			isLeap = false
		} else {
			isLeap = true
			mi--
		}
	}
	if offset < 0 {
		offset += temp
		mi--
	}
	lunarMonth := mi

	return Lunar{
		Year:          lunarYear,
		Month:         lunarMonth,
		Day:           offset + 1,
		IsLeapMonth:   isLeap,
		MonthName:     monthName(lunarMonth, isLeap),
		DayName:       dayName(offset + 1),
		YearGanZhi:    ganzhiYear(lunarYear),
		YearShengXiao: shengXiao[(lunarYear-4)%12],
		SolarTerm:     solarTermOf(y, m, d),
	}, nil
}

// ganzhiYear 返回农历 y 年的干支，1984 甲子年作基准。
func ganzhiYear(y int) string {
	return lianGan[(y-4)%10] + diZhi[(y-4)%12]
}

// DayLabel 只返回农历日名（如「廿八」），换算失败返回空串。
// 月历面板逐格调用，出错不该把整个面板打挂，返回空由前端回落显示公历即可。
func DayLabel(y, m, d int) string {
	l, err := ToLunar(y, m, d)
	if err != nil {
		return ""
	}
	return l.DayName
}

// 农历节日：固定月日组合。除夕特殊——它是腊月最后一天，随大小月在 29/30 之间浮动。
var lunarFestivals = map[[2]string]string{
	{"正月", "初一"}: "春节",
	{"正月", "十五"}: "元宵节",
	{"二月", "初二"}: "龙抬头",
	{"五月", "初五"}: "端午节",
	{"七月", "初七"}: "七夕",
	{"八月", "十五"}: "中秋节",
	{"九月", "初九"}: "重阳节",
	{"腊月", "初八"}: "腊八",
	{"腊月", "廿三"}: "北方小年",
	{"腊月", "廿四"}: "南方小年",
}

// 公历节日，键为「月-日」。文案与参考站对齐，只收参考站展示过的那些。
var solarFestivals = map[string]string{
	"1-1":   "元旦",
	"2-14":  "情人节",
	"3-8":   "妇女节",
	"4-1":   "愚人节",
	"5-1":   "劳动节",
	"6-1":   "儿童节",
	"8-1":   "建军节",
	"9-10":  "教师节",
	"10-1":  "国庆节",
	"12-24": "平安夜",
	"12-25": "圣诞节",
}

// Festival 返回当天最合适的节日名，没有则空串。
// 农历节日优先于公历节日（春节、中秋这类在该日展示农历名更符合习惯），
// 除夕按腊月最后一天判定；母亲节、父亲节是浮动周日，单独算。
func Festival(y, m, d int) string {
	// 浮动周日节日：5 月第二个周日母亲节，6 月第三个周日父亲节。
	if wd := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).Weekday(); wd == time.Sunday {
		switch {
		case m == 5 && d >= 8 && d <= 14:
			return "母亲节"
		case m == 6 && d >= 15 && d <= 21:
			return "父亲节"
		}
	}

	if l, err := ToLunar(y, m, d); err == nil && !l.IsLeapMonth {
		// 除夕＝腊月最后一天；腊月的其它节日（腊八、小年）照常走月日表。
		if l.Month == 12 && l.Day == monthDays(l.Year, 12) {
			return "除夕"
		}
		if name := lunarFestivals[[2]string{monthName(l.Month, false), dayName(l.Day)}]; name != "" {
			return name
		}
	}

	if name := solarFestivals[fmt.Sprintf("%d-%d", m, d)]; name != "" {
		return name
	}
	return ""
}
