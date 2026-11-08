package calendar

import (
	"fmt"
	"sort"
	"time"
)

// Validate 检查一份年度表自不自洽。导入前必须过这一关：
// 节假日表一旦写错，「法定工作日」重复、逾期顺延、提醒时刻会一起算错，
// 而且错得很安静——用户只会觉得「怎么国庆还让我打卡」。
func (t Table) Validate() error {
	if t.Year < 1900 || t.Year > 2100 {
		return fmt.Errorf("calendar: %d 超出可支持的年份范围 1900-2100", t.Year)
	}
	seen := map[string]string{} // 日 → 它出现在哪一侧
	for _, list := range [][]string{t.Holidays, t.MakeupDays} {
		for _, d := range list {
			day := norm(d)
			if day == "" {
				return fmt.Errorf("calendar: %d 年表里有不是 YYYY-MM-DD 的日期 %q", t.Year, d)
			}
			if y := day[:4]; y != fmt.Sprintf("%d", t.Year) {
				return fmt.Errorf("calendar: %s 不属于 %d 年", day, t.Year)
			}
		}
	}
	for _, d := range t.Holidays {
		seen[norm(d)] = "holidays"
	}
	for _, d := range t.MakeupDays {
		day := norm(d)
		if side, ok := seen[day]; ok {
			return fmt.Errorf("calendar: %s 同时出现在 %s 和 makeupWorkdays（既是假日又要上班，无法判定）", day, side)
		}
		// 调休上班只会安排在周六或周日；出现在工作日说明抄错了行。
		if wd := weekday(day); wd != time.Saturday && wd != time.Sunday {
			return fmt.Errorf("calendar: 调休上班日 %s 是 %s，不在周末（官方安排不会这样）", day, wd)
		}
	}
	if len(t.Holidays) == 0 && len(t.MakeupDays) == 0 {
		return fmt.Errorf("calendar: %d 年表是空的，导入它等于把内置数据清掉", t.Year)
	}
	return nil
}

// SortedDays 返回某年的全部放假日（升序），CLI 打印与自检断言都用得上。
func (t Table) SortedDays() []string {
	out := append([]string(nil), t.Holidays...)
	sort.Strings(out)
	return out
}

func weekday(day string) time.Weekday {
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		return time.Monday // 到这里 fmt 已经验过格式了，不该发生
	}
	return d.Weekday()
}
