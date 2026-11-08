// Package tclock 处理「绝对时刻」的规范化字符串形式。
//
// 所有跨设备比较的时间戳（created/updated/deleted/clockedAt）一律存 UTC 定宽格式，
// 这样字典序等于时间序，LWW 合并直接用字符串比较即可。设备本地语义（今天、打卡日、
// 「当天 09:00」这种墙钟提醒）不放在这里，由 model.Day 与 HH:MM 字段承载。
package tclock

import (
	"time"

	"planfordo/internal/core/model"
)

const layout = "2006-01-02T15:04:05.000Z"

// Now 返回当前时刻的规范串。
func Now() model.ClockTime { return Format(time.Now()) }

// Format 把任意时间转成 UTC 定宽串。
func Format(t time.Time) model.ClockTime { return t.UTC().Format(layout) }

// FromMillis 由毫秒时间戳发号，供单调时钟使用。
func FromMillis(ms int64) model.ClockTime { return Format(time.UnixMilli(ms)) }

// Parse 解析规范串；失败返回 ok=false。
func Parse(s model.ClockTime) (time.Time, bool) {
	t, err := time.Parse(layout, s)
	if err != nil {
		// 容忍不带毫秒的写法，外部通道送来的数据可能截断过。
		t, err = time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Time{}, false
		}
	}
	return t.UTC(), true
}

// IsNewer 报告 candidate 是否比 incumbent 新；空串永远较旧，解析不了的按较旧处理。
// 定宽 UTC 串字典序即时间序，但为了容忍不带毫秒/带偏移的历史数据，仍然走解析比较。
func IsNewer(candidate, incumbent model.ClockTime) bool {
	if candidate == incumbent {
		return false
	}
	if candidate == "" {
		return false
	}
	if incumbent == "" {
		return true
	}
	tc, okc := Parse(candidate)
	ti, oki := Parse(incumbent)
	switch {
	case !okc && !oki:
		return candidate > incumbent
	case !okc:
		return false // 解析不了的不能赢
	case !oki:
		return true
	case tc.Equal(ti):
		return candidate > incumbent // 同刻按串比较破平局，判定必须确定
	default:
		return tc.After(ti)
	}
}

// Millis 返回规范串对应的毫秒时间戳；解析失败返回 0。
func Millis(s model.ClockTime) int64 {
	t, ok := Parse(s)
	if !ok {
		return 0
	}
	return t.UnixMilli()
}

// LocalDay 把时刻换算成某时区下的本地日历日。
func LocalDay(s model.ClockTime, loc *time.Location) model.Day {
	t, ok := Parse(s)
	if !ok {
		return ""
	}
	if loc == nil {
		loc = time.Local
	}
	return t.In(loc).Format("2006-01-02")
}
