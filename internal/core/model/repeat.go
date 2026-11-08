package model

// RepeatUnit 是重复的粒度。
type RepeatUnit int

const (
	UnitDay RepeatUnit = iota + 1
	UnitWeek
	UnitMonth
	UnitYear
)

// EndMode 是重复序列的终止方式。
type EndMode int

const (
	EndNever EndMode = iota
	EndByDate
	EndByCount
)

// Repeat 描述一条事项（或习惯）的重复规则。
//
// 预设规则都用同一个结构表达，展示名由 Description 反推，避免「预设」和「自定义」两套逻辑分叉：
// 每天 = Unit:UnitDay, Interval:1；每周一至周五 = Unit:UnitWeek, Weekdays:[1..5]；
// 每月最后一天 = Unit:UnitMonth, MonthDays:[-1]。
type Repeat struct {
	Unit      RepeatUnit `json:"unit"`
	Interval  int        `json:"interval"` // 每 N 个 Unit，0 按 1 处理
	Weekdays  []int      `json:"weekdays,omitempty"`
	MonthDays []int      `json:"monthDays,omitempty"` // -1 表示当月最后一天
	YearMonth int        `json:"yearMonth,omitempty"`
	YearDay   int        `json:"yearDay,omitempty"`

	// SkipLegalHolidays：命中法定节假日则不生成当天实例。
	SkipLegalHolidays bool `json:"skipLegalHolidays"`
	// FollowMakeupWorkday：调休上班的周末仍算工作日（法定工作日规则需要它）。
	FollowMakeupWorkday bool `json:"followMakeupWorkday"`
	// SmartSpan：跨天事项只在重复命中的日子出现，不铺满每一天。
	SmartSpan bool `json:"smartSpan"`
	// Ebbinghaus：按遗忘曲线间隔生成实例，此时 Unit/Interval 字段不使用。
	Ebbinghaus bool `json:"ebbinghaus"`

	End EndSpec `json:"end"`
}

// EndSpec 是终止条件。EndByCount 的次数含首次。
type EndSpec struct {
	Mode  EndMode `json:"mode"`
	Date  Day     `json:"date,omitempty"`
	Count int     `json:"count,omitempty"`
}

// EbbinghausIntervals 是艾宾浩斯复习间隔（天），以事项起始日为第 0 次。
// 朝暮计划没有公布它的具体间隔，这是本项目的自选值，可配置。
var EbbinghausIntervals = []int{1, 2, 4, 7, 15, 30, 60}
