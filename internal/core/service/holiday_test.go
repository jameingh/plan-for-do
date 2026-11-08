package service

import (
	"path/filepath"
	"testing"

	"planfordo/internal/core/calendar"
	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
)

// builtinCalendar 取内置节假日表（不读目录，目录给一个不存在的路径）。
// 用真实数据而不是 fakeCalendar，是为了让「国务院的通知改了规则跟着变」这条链
// 在测试里也成立——fake 的那份只证明算法，证明不了数据接进来了。
func builtinCalendar(t *testing.T) *calendar.FS {
	t.Helper()
	cal, err := calendar.Open(filepath.Join(t.TempDir(), "no-local-tables"))
	if err != nil {
		t.Fatalf("calendar.Open: %v", err)
	}
	if cal == nil {
		t.Fatal("内置节假日表没加载上")
	}
	return cal
}

// legalWorkday 是界面「法定工作日」预设在内核里的形状（ItemPanels.tsx 的 legal 那条）。
func legalWorkday(start model.Day) *model.Repeat {
	return &model.Repeat{
		Unit: model.UnitWeek, Interval: 1, Weekdays: []int{1, 2, 3, 4, 5},
		SkipLegalHolidays: true, FollowMakeupWorkday: true,
	}
}

func itemWith(anchor model.Day, r *model.Repeat, rem ...model.Reminder) *model.ListItem {
	return &model.ListItem{
		Title: "晨间例会", Date: model.DateSpec{Kind: model.DateSingle, Start: anchor},
		Repeat: r, Reminders: rem,
		Time: model.TimeSpec{Kind: model.TimePoint, Start: "09:00"},
	}
}

// TestLegalWorkdaySkipsNationalDay2026 是这份内置数据存在的理由：
// 国庆七天不该出现「法定工作日」实例，而补班的周六周日该出现。
func TestLegalWorkdaySkipsNationalDay2026(t *testing.T) {
	cal := builtinCalendar(t)
	item := itemWith("2026-06-01", legalWorkday("2026-06-01"))

	got := repeat.Occurrences(item, "2026-09-28", "2026-10-12", cal)
	want := []model.Day{"2026-09-28", "2026-09-29", "2026-09-30",
		"2026-10-08", "2026-10-09", "2026-10-10", "2026-10-12"}
	if len(got) != len(want) {
		t.Fatalf("国庆窗口命中 %v，应为 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 天 = %s，应为 %s", i, got[i], want[i])
		}
	}
	// 没有日历数据时同一窗口退化成普通周一至周五：10-10 那个补班周六会消失，
	// 国庆七天反而全在。这条对比就是「数据接进来了」的证据。
	plain := repeat.Occurrences(item, "2026-09-28", "2026-10-12", nil)
	if len(plain) != 11 {
		t.Errorf("无数据时应命中 11 个周一至周五，实得 %d：%v", len(plain), plain)
	}
	if has(plain, "2026-10-10") {
		t.Error("无数据时不该认识补班周六")
	}
}

// TestLegalWorkdayAcrossSpringFestival2027 换一年、换一个假期形态再验一次：
// 2027 春节放 2/5–2/13，补班落在 1/31（周日）和 2/14（周日）。
func TestLegalWorkdayAcrossSpringFestival2027(t *testing.T) {
	cal := builtinCalendar(t)
	item := itemWith("2027-01-04", legalWorkday("2027-01-04"))

	got := repeat.Occurrences(item, "2027-01-25", "2027-02-18", cal)
	if has(got, "2027-02-05") || has(got, "2027-02-12") {
		t.Errorf("除夕到初八这几天不该有法定工作日实例：%v", got)
	}
	for _, d := range []model.Day{"2027-01-31", "2027-02-14"} {
		if !has(got, d) {
			t.Errorf("补班的 %s（周日）应命中：%v", d, got)
		}
	}
	if !has(got, "2027-02-04") || !has(got, "2027-02-15") {
		t.Errorf("假期前后的正常工作日不该被吃掉：%v", got)
	}
}

// TestRemindersQuietDuringHolidays 是最贴近用户体感的一条：
// 「法定工作日 + 每天提醒」的事项在国庆期间不该弹提醒。
func TestRemindersQuietDuringHolidays(t *testing.T) {
	a, ctx := newApp(t)
	a.SetCalendar(builtinCalendar(t))

	rem := []model.Reminder{{ID: "r1", AtTime: "09:00"}}
	created, err := a.SaveItem(ctx, ItemInput{
		Title: "晨间例会", Date: model.DateSpec{Kind: model.DateSingle, Start: "2026-06-01"},
		Repeat: legalWorkday("2026-06-01"), Time: model.TimeSpec{Kind: model.TimePoint, Start: "09:00"},
		Reminders: rem,
	}, ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	if len(created) == 0 {
		t.Fatal("没建出事项")
	}

	fires, err := a.UpcomingReminders(ctx, "2026-09-28", "2026-10-12")
	if err != nil {
		t.Fatalf("UpcomingReminders: %v", err)
	}
	for _, f := range fires {
		if f.Day >= "2026-10-01" && f.Day <= "2026-10-07" {
			t.Errorf("国庆假期里冒出了提醒：%+v", f)
		}
	}
	// UpcomingReminders 会滤掉已经过去的时刻（系统时间已经是 11 月，这一段全是过去），
	// 所以「这几天到底有没有实例」直接问展开引擎，别借道提醒结果。
	days := repeat.Occurrences(created[0], "2026-10-01", "2026-10-07", a.calendar)
	if len(days) != 0 {
		t.Errorf("国庆七天应展开出 0 个实例，实得 %v", days)
	}
	if withOut := repeat.Occurrences(created[0], "2026-10-08", "2026-10-11", a.calendar); len(withOut) != 3 {
		t.Errorf("10-08/09/10(补班) 应有 3 个实例，实得 %v", withOut)
	}
}

func has(days []model.Day, want model.Day) bool {
	for _, d := range days {
		if d == want {
			return true
		}
	}
	return false
}
