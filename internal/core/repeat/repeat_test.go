package repeat

import (
	"reflect"
	"testing"

	"planfordo/internal/core/model"
)

type fakeCalendar struct {
	holidays map[string]bool
	makeup   map[string]bool
}

func (f fakeCalendar) IsHoliday(d model.Day) bool { return f.holidays[d] }
func (f fakeCalendar) IsMakeupWorkday(d model.Day) bool {
	return f.makeup != nil && f.makeup[d]
}

func item(date model.DateSpec, r *model.Repeat) *model.ListItem {
	return &model.ListItem{ID: "t", Date: date, Repeat: r}
}

func single(d model.Day) model.DateSpec {
	return model.DateSpec{Kind: model.DateSingle, Start: d}
}

func span(a, b model.Day) model.DateSpec {
	return model.DateSpec{Kind: model.DateSpan, Start: a, End: b}
}

func selected(days ...model.Day) model.DateSpec {
	return model.DateSpec{Kind: model.DateSelected, Start: days[0], Selected: days}
}

func TestOccurrences(t *testing.T) {
	wd := []int{1, 2, 3, 4, 5}
	cases := []struct {
		name string
		item *model.ListItem
		from model.Day
		to   model.Day
		cal  HolidaySource
		want []model.Day
	}{
		{
			name: "无重复-单日",
			item: item(single("2026-11-05"), nil),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-05"},
		},
		{
			name: "无重复-跨天铺满",
			item: item(span("2026-11-03", "2026-11-06"), nil),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"},
		},
		{
			name: "无重复-自选多日排序去重",
			item: item(selected("2026-11-10", "2026-11-02", "2026-11-02"), nil),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-02", "2026-11-10"},
		},
		{
			name: "每天",
			item: item(single("2026-11-01"), &model.Repeat{Unit: model.UnitDay, Interval: 1}),
			from: "2026-11-01", to: "2026-11-05",
			want: []model.Day{"2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"},
		},
		{
			name: "每隔3天",
			item: item(single("2026-11-01"), &model.Repeat{Unit: model.UnitDay, Interval: 3}),
			from: "2026-11-01", to: "2026-11-10",
			want: []model.Day{"2026-11-01", "2026-11-04", "2026-11-07", "2026-11-10"},
		},
		{
			name: "每周一至周五",
			item: item(single("2026-11-02"), &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: wd}),
			from: "2026-11-01", to: "2026-11-15",
			want: []model.Day{
				"2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
				"2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13",
			},
		},
		{
			name: "每周-勾选周一",
			item: item(single("2026-11-02"), &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{1}}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"},
		},
		{
			name: "每周-未勾选周则跟随锚点星期(周四)",
			item: item(single("2026-11-05"), &model.Repeat{Unit: model.UnitWeek, Interval: 1}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26"},
		},
		{
			name: "每两周-周三",
			item: item(single("2026-11-04"), &model.Repeat{Unit: model.UnitWeek, Interval: 2, Weekdays: []int{3}}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-04", "2026-11-18"},
		},
		{
			name: "每月24日-跟随锚点日",
			item: item(single("2026-01-24"), &model.Repeat{Unit: model.UnitMonth, Interval: 1}),
			from: "2026-01-01", to: "2026-06-30",
			want: []model.Day{
				"2026-01-24", "2026-02-24", "2026-03-24",
				"2026-04-24", "2026-05-24", "2026-06-24",
			},
		},
		{
			name: "每月最后一天",
			item: item(single("2026-01-31"), &model.Repeat{Unit: model.UnitMonth, Interval: 1, MonthDays: []int{-1}}),
			from: "2026-01-01", to: "2026-04-30",
			want: []model.Day{"2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"},
		},
		{
			name: "每年2月29日-平年跳过",
			item: item(single("2024-02-29"), &model.Repeat{Unit: model.UnitYear, Interval: 1, YearMonth: 2, YearDay: 29}),
			from: "2024-01-01", to: "2028-12-31",
			want: []model.Day{"2024-02-29", "2028-02-29"},
		},
		{
			name: "按日期结束",
			item: item(single("2026-11-01"), &model.Repeat{
				Unit: model.UnitDay, Interval: 1,
				End: model.EndSpec{Mode: model.EndByDate, Date: "2026-11-04"},
			}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"},
		},
		{
			name: "按次数结束-含锚点当天",
			item: item(single("2026-11-01"), &model.Repeat{
				Unit: model.UnitDay, Interval: 1,
				End: model.EndSpec{Mode: model.EndByCount, Count: 3},
			}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-01", "2026-11-02", "2026-11-03"},
		},
		{
			name: "按次数结束-次数在窗口前已用尽",
			item: item(single("2026-11-01"), &model.Repeat{
				Unit: model.UnitDay, Interval: 1,
				End: model.EndSpec{Mode: model.EndByCount, Count: 3},
			}),
			from: "2026-11-05", to: "2026-11-30",
			want: []model.Day{},
		},
		{
			name: "艾宾浩斯-偏移量为1/2/4/7/15/30/60",
			item: item(single("2026-11-01"), &model.Repeat{Ebbinghaus: true}),
			from: "2026-11-01", to: "2027-12-31",
			want: []model.Day{
				"2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05",
				"2026-11-08", "2026-11-16", "2026-12-01", "2026-12-31",
			},
		},
		{
			name: "智能跳过法定节假日",
			item: item(single("2026-11-01"), &model.Repeat{Unit: model.UnitDay, Interval: 1, SkipLegalHolidays: true}),
			from: "2026-11-01", to: "2026-11-05",
			cal:  fakeCalendar{holidays: map[string]bool{"2026-11-02": true, "2026-11-03": true}},
			want: []model.Day{"2026-11-01", "2026-11-04", "2026-11-05"},
		},
		{
			name: "法定工作日-跳节假日且调休周末上班",
			item: item(single("2026-11-02"), &model.Repeat{
				Unit: model.UnitWeek, Interval: 1, Weekdays: wd,
				SkipLegalHolidays: true, FollowMakeupWorkday: true,
			}),
			from: "2026-11-01", to: "2026-11-09",
			cal: fakeCalendar{
				holidays: map[string]bool{"2026-11-03": true},
				makeup:   map[string]bool{"2026-11-07": true, "2026-11-08": true},
			},
			want: []model.Day{
				"2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06",
				"2026-11-07", "2026-11-08", "2026-11-09",
			},
		},
		{
			name: "跨天非智能-每个命中日铺满整段",
			item: item(span("2026-11-03", "2026-11-05"), &model.Repeat{Unit: model.UnitWeek, Interval: 1}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{
				"2026-11-03", "2026-11-04", "2026-11-05",
				"2026-11-10", "2026-11-11", "2026-11-12",
				"2026-11-17", "2026-11-18", "2026-11-19",
				"2026-11-24", "2026-11-25", "2026-11-26",
			},
		},
		{
			name: "跨天智能重复-只留命中日",
			item: item(span("2026-11-03", "2026-11-05"), &model.Repeat{
				Unit: model.UnitWeek, Interval: 1, SmartSpan: true,
			}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"},
		},
		{
			name: "自选多日+每周一至周五-规则只做筛选",
			item: item(selected("2026-11-01", "2026-11-02", "2026-11-08"),
				&model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: wd}),
			from: "2026-11-01", to: "2026-11-30",
			want: []model.Day{"2026-11-02"},
		},
		{
			name: "窗口早于锚点则无实例",
			item: item(single("2026-11-10"), nil),
			from: "2026-11-01", to: "2026-11-05",
			want: []model.Day{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Occurrences(tc.item, tc.from, tc.to, tc.cal)
			if got == nil {
				got = []model.Day{}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got  %v\nwant %v", got, tc.want)
			}
		})
	}
}

func TestMaterialize(t *testing.T) {
	weekly := &model.Repeat{Unit: model.UnitWeek, Interval: 1, Weekdays: []int{1}}

	cases := []struct {
		name      string
		item      *model.ListItem
		from      model.Day
		to        model.Day
		overrides []model.OccurrenceOverride
		wantDays  []model.Day
		wantDone  []model.Day
	}{
		{
			name: "打卡-单日事项",
			item: item(single("2026-11-05"), nil),
			from: "2026-11-01", to: "2026-11-30",
			overrides: []model.OccurrenceOverride{
				{ItemID: "t", Day: "2026-11-05", Status: model.StatusClocked, ClockedAt: "2026-11-05T17:42:03+08:00"},
			},
			wantDays: []model.Day{"2026-11-05"},
			wantDone: []model.Day{"2026-11-05"},
		},
		{
			name: "本次跳过-该天消失",
			item: item(single("2026-11-05"), nil),
			from: "2026-11-01", to: "2026-11-30",
			overrides: []model.OccurrenceOverride{
				{ItemID: "t", Day: "2026-11-05", Status: model.StatusSkipped},
			},
			wantDays: []model.Day{},
			wantDone: []model.Day{},
		},
		{
			name: "顺延-单日事项挪到今天",
			item: item(single("2026-11-01"), nil),
			from: "2026-11-01", to: "2026-11-30",
			overrides: []model.OccurrenceOverride{
				{ItemID: "t", Day: "2026-11-05", Status: model.StatusPending, PostponedFrom: "2026-11-01"},
			},
			wantDays: []model.Day{"2026-11-05"},
			wantDone: []model.Day{},
		},
		{
			name: "重复序列-只影响命中的那一天",
			item: item(single("2026-11-02"), weekly),
			from: "2026-11-01", to: "2026-11-30",
			overrides: []model.OccurrenceOverride{
				{ItemID: "t", Day: "2026-11-09", Status: model.StatusClocked, ClockedAt: "2026-11-09T08:00:00+08:00"},
			},
			wantDays: []model.Day{"2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"},
			wantDone: []model.Day{"2026-11-09"},
		},
		{
			name: "顺延到非命中日-周一事项挪到周三",
			item: item(single("2026-11-02"), weekly),
			from: "2026-11-01", to: "2026-11-30",
			overrides: []model.OccurrenceOverride{
				{ItemID: "t", Day: "2026-11-04", Status: model.StatusPending, PostponedFrom: "2026-11-02"},
			},
			wantDays: []model.Day{"2026-11-04", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"},
			wantDone: []model.Day{},
		},
		{
			name: "无 override-全部待办",
			item: item(single("2026-11-02"), weekly),
			from: "2026-11-08", to: "2026-11-16",
			wantDays: []model.Day{"2026-11-09", "2026-11-16"},
			wantDone: []model.Day{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Materialize(tc.item, tc.from, tc.to, tc.overrides, nil)
			var days, done []model.Day
			for _, o := range got {
				days = append(days, o.Day)
				if o.Status == model.StatusClocked {
					done = append(done, o.Day)
				}
			}
			if days == nil {
				days = []model.Day{}
			}
			if done == nil {
				done = []model.Day{}
			}
			if !reflect.DeepEqual(days, tc.wantDays) {
				t.Fatalf("days got %v want %v", days, tc.wantDays)
			}
			if !reflect.DeepEqual(done, tc.wantDone) {
				t.Fatalf("done got %v want %v", done, tc.wantDone)
			}
		})
	}
}

func TestDayHelpers(t *testing.T) {
	if got := Weekday("2026-11-01"); got != 7 {
		t.Errorf("Weekday(2026-11-01) = %d, want 7 (周日)", got)
	}
	if got := Weekday("2026-11-02"); got != 1 {
		t.Errorf("Weekday(2026-11-02) = %d, want 1 (周一)", got)
	}
	if got := AddDays("2026-12-31", 1); got != "2027-01-01" {
		t.Errorf("AddDays 跨年 = %q", got)
	}
	if got := DiffDays("2026-02-01", "2026-03-01"); got != 28 {
		t.Errorf("DiffDays 平年 2 月 = %d, want 28", got)
	}
	if got := DiffDays("2026-11-05", "2026-11-01"); got != -4 {
		t.Errorf("DiffDays 反向 = %d, want -4", got)
	}
}
