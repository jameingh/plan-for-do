// Package model 是领域对象定义，不依赖任何 UI 框架、数据库驱动或同步实现。
// iOS/Android 壳将来复用同一套定义，因此这里只允许纯数据和纯逻辑。
package model

// Day 是本地日历日，形如 "2026-11-05"。打卡、逾期、重复命中都以本地日为准，
// 不用 UTC 日，否则跨时区设备会把同一天的打卡算到两天上。
type Day = string

// ClockTime 是绝对时刻，统一存 UTC 定宽串（见 tclock），字典序即时间序，
// 同步的 LWW 比较才成立。展示时由前端换算成本地时区；本地墙钟语义走 Day 与 HH:MM 字段。
type ClockTime = string

// DateKind 描述事项占用的日期形态，对应朝暮的「单日 / 跨天 / 自选多日」。
type DateKind int

const (
	DateSingle DateKind = iota + 1
	DateSpan
	DateSelected
)

// TimeKind 描述时间形态，Zero 即「全天」。
type TimeKind int

const (
	TimeAllDay TimeKind = iota
	TimePoint
	TimeRange
)

// Priority 是四象限：1 重要且紧急、2 重要不紧急、3 不重要但紧急、4 不重要不紧急。
// 新建事项默认 4，与朝暮一致（0 视为未设置，读取时归一到 4）。
type Priority int

const (
	QuadrantImportantUrgent Priority = 1
	QuadrantImportant       Priority = 2
	QuadrantUrgent          Priority = 3
	QuadrantNone            Priority = 4
)

// ItemStatus 是单个发生实例（occurrence）的状态。
type ItemStatus int

const (
	StatusPending ItemStatus = iota // 未打卡
	StatusClocked                   // 成功打卡
	StatusSkipped                   // 本次跳过（重复序列上的例外）
	// StatusFailed 是「失败打卡」：这一天已经结清，但结果是没做到。
	// 参考站把它和成功打卡并列放在勾选框的右键菜单里，是产品语义的一部分，
	// 不是异常状态——所以它归入「已打卡」桶，只是留痕的记号不同。
	StatusFailed
)

// Resolved 表示这一天已经结清（成功或失败都算），不再出现在未打卡里。
func (s ItemStatus) Resolved() bool { return s == StatusClocked || s == StatusFailed }

// Bucket 是按日期分组时的四个桶。
type Bucket int

const (
	BucketOverdue Bucket = iota + 1 // 逾期
	BucketToday                     // 未打卡（今天该做）
	BucketLater                     // 待办（未来或无日期）
	BucketDone                      // 已打卡
)

// List 是清单本（朝暮的 tbListInfo）。第一版只强制存在 DefaultListID 一个本，
// 但它是 ListItem.ListID 的外键目标，也是将来按项目维度分屏的挂载点。
type List struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
	Sort  int    `json:"sort"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// DefaultListID 是首次启动即存在的清单本，UI 上叫「全部」。
const DefaultListID = "list-default"

// ListItem 是一条清单事项。重复事项只存一条本体，每天实例由 repeat 展开，
// 单日的打卡/跳过/顺延写在 OccurrenceOverride 里。
type ListItem struct {
	ID        string     `json:"id"`
	ListID    string     `json:"listId"`
	Title     string     `json:"title"`
	Remark    string     `json:"remark"`
	Category  string     `json:"category"` // 分类 ID，空表示无分类
	Priority  Priority   `json:"priority"`
	LabelIDs  []string   `json:"labelIds"`
	Date      DateSpec   `json:"date"`
	Time      TimeSpec   `json:"time"`
	Repeat    *Repeat    `json:"repeat,omitempty"`
	Reminders []Reminder `json:"reminders"`
	Progress  int        `json:"progress"` // -1 未设置，0-100 手动进度
	// IsTop 是「置顶」：只影响列内排序，不改变事项本身的时间与状态。
	// 取消置顶不需要记住原位置——排序本来就是按时间/优先级/创建时间稳定推导的。
	IsTop bool `json:"isTop"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// DateSpec 承载三种日期形态。Selected 只在 DateSelected 时有值。
type DateSpec struct {
	Kind     DateKind `json:"kind"`
	Start    Day      `json:"start"`
	End      Day      `json:"end,omitempty"`
	Selected []Day    `json:"selected,omitempty"`
}

// TimeSpec 承载全天/时间点/时间段。HH:MM 为本地墙钟时间。
type TimeSpec struct {
	Kind  TimeKind `json:"kind"`
	Start string   `json:"start,omitempty"`
	End   string   `json:"end,omitempty"`
}

// ReminderOffset 是提醒相对事项开始时刻的提前量。
type ReminderOffset struct {
	Days    int `json:"days"`
	Hours   int `json:"hours"`
	Minutes int `json:"minutes"`
}

// Reminder 一条事项可挂多个提醒。AtDay/AtTime 用于「当天 09:00」这类固定时刻提醒，
// 与提前量互斥。
type Reminder struct {
	ID      string         `json:"id"`
	Offset  ReminderOffset `json:"offset"`
	AtDay   string         `json:"atDay,omitempty"`
	AtTime  string         `json:"atTime,omitempty"`
	FiredAt string         `json:"firedAt,omitempty"`
}

// Child 是子任务，进度与置顶独立于父事项。
type Child struct {
	ID       string   `json:"id"`
	ItemID   string   `json:"itemId"`
	Title    string   `json:"title"`
	Remark   string   `json:"remark"`
	Sort     int      `json:"sort"`
	Pinned   bool     `json:"pinned"`
	Priority Priority `json:"priority"`
	Done     bool     `json:"done"`
	// Failed 是「失败打卡」：子任务与主事项一样是三态，勾掉=成功，标失败=结清但没做到。
	Failed   bool `json:"failed"`
	Progress int  `json:"progress"`
	Due      Day  `json:"due,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// Category 是分类（朝暮叫「分类」，带图标与颜色）。
type Category struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Icon  string `json:"icon"` // 内置图标名，或单字图标
	Color string `json:"color"`
	Sort  int    `json:"sort"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// Label 是标签，单条事项最多 MaxLabelsPerItem 个。
type Label struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

const MaxLabelsPerItem = 10

// OccurrenceOverride 记录某条重复事项在某一天的例外状态：打卡、跳过、顺延后的日期。
// 主键由 OverrideID 生成为「事项+天」，两台设备同一天打卡才会收敛成一次覆盖而不是两条记录。
// 取消打卡写 DeletedAt，否则另一端会把这条又同步回来。
type OccurrenceOverride struct {
	ID            string     `json:"id"`
	ItemID        string     `json:"itemId"`
	Day           Day        `json:"day"`
	Status        ItemStatus `json:"status"`
	ClockedAt     ClockTime  `json:"clockedAt,omitempty"`
	PostponedFrom Day        `json:"postponedFrom,omitempty"`
	Note          string     `json:"note,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// Habit 是一个习惯。打卡方式分「每天一次」与「每天多次」，后者带量化单位。
type Habit struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Icon    HabitIcon `json:"icon"`
	Context string    `json:"context"` // 情境 ID，空表示「全天」
	Freq    Frequency `json:"freq"`

	Mode        HabitMode `json:"mode"`
	AutoClock   bool      `json:"autoClock"`
	UnitID      string    `json:"unitId,omitempty"`
	DailyTarget float64   `json:"dailyTarget"` // 每日打卡总量，Mode=Multi 时生效
	PerClock    float64   `json:"perClock"`    // 每次打卡完成量

	// Reminders 是习惯自己的固定时刻提醒（参考站一个习惯最多 2 条）。
	// 与事项的 Reminder 不同：这里只用 AtTime（每天几点），Offset/AtDay 不参与。
	Reminders []Reminder `json:"reminders,omitempty"`
	// PopMark 打卡时是否弹出「打卡心得」窗口（参考站 habitIsPopClockView，默认开）。
	PopMark bool `json:"popMark"`

	StartDay     Day `json:"startDay"`
	BackfillDays int `json:"backfillDays"` // 可回溯补打卡的天数，0 表示不允许补打卡

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

type HabitIcon struct {
	Kind  string `json:"kind"` // "image" 或 "text"
	Ref   string `json:"ref"`  // 图片资源标识或单个文字
	Color string `json:"color"`
}

// HabitMode 每天一次 / 每天多次（量化）。
type HabitMode int

const (
	HabitOncePerDay HabitMode = iota + 1
	HabitMultiPerDay
)

// Frequency 习惯的出现频率。Kind 决定哪些字段生效。
type Frequency struct {
	Kind      FreqKind `json:"kind"`
	Weekdays  []int    `json:"weekdays,omitempty"`  // 1=周一 .. 7=周日
	MonthDays []int    `json:"monthDays,omitempty"` // 负数表示从月末倒数，-1 = 最后一天
	EveryN    int      `json:"everyN,omitempty"`    // 每隔 N 天
	// Plan 是配额型频率（FreqWeeklyQuota / FreqMonthlyQuota）一个周期要打满的天数。
	// 参考站的「按周 / 按月」就是这个意思：不指定具体哪天，一周（月）内任意打满 N 天。
	Plan int `json:"plan,omitempty"`
}

type FreqKind int

const (
	FreqDaily FreqKind = iota + 1
	FreqFixedWeekdays
	FreqMonthlyDays
	FreqEveryNDays
	// FreqWeeklyQuota 每周 N 天，任意哪天都算。
	FreqWeeklyQuota
	// FreqMonthlyQuota 每月 N 天，任意哪天都算。
	FreqMonthlyQuota
)

// IsQuota 判断是不是「周期配额」型频率：这类没有固定排期日，周期内每天都可以打。
func (k FreqKind) IsQuota() bool { return k == FreqWeeklyQuota || k == FreqMonthlyQuota }

// HabitClock 是一次打卡记录。每天一次的习惯一天最多一条；取消打卡写 DeletedAt 留 tombstone，
// 否则另一端设备会把这条再「同步」回来。
type HabitClock struct {
	ID        string    `json:"id"`
	HabitID   string    `json:"habitId"`
	Day       Day       `json:"day"`
	Amount    float64   `json:"amount"`
	ClockedAt ClockTime `json:"clockedAt"`
	Manual    bool      `json:"manual"` // 手动打卡还是补打卡/自动打卡

	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// HabitMark 是打卡日志（心得 + 图）。
type HabitMark struct {
	ID        string `json:"id"`
	HabitID   string `json:"habitId"`
	ClockID   string `json:"clockId,omitempty"`
	Day       Day    `json:"day"`
	Time      string `json:"time"`
	Text      string `json:"text"`
	ImagePath string `json:"imagePath,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// HabitUnit 是习惯单位（个/步/公里/页/杯…），名称最多两个字符。
type HabitUnit struct {
	ID   string `json:"id"`
	Name string `json:"name"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

const MaxUnitNameRunes = 2

// HabitContext 是情境（晨间/午间/晚间/全天）。删除情境时其下习惯归入「全天」。
type HabitContext struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Sort int    `json:"sort"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// Attachment 是本地附件（图片/文件），不走云存储。
type Attachment struct {
	ID        string `json:"id"`
	OwnerKind string `json:"ownerKind"` // "item" 或 "habitMark"
	OwnerID   string `json:"ownerId"`
	Path      string `json:"path"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// —— 备忘录 ——

// MemoFolder 是备忘录的文件夹。参考站的「全部」是虚拟项（不入库，表示不过滤），
// 未归类的备忘录 FolderID 为空串，和分类的「无分类」同一个套路。
type MemoFolder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Sort int    `json:"sort"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// MaxMemoFolderNameRunes 是文件夹名上限。参考站的输入框就是 maxlength=6
// （证据 tmp/ref/evidence-memo-bundle.md §8「请输入文件夹名称」），照抄。
const MaxMemoFolderNameRunes = 6

// MaxMemoTitleRunes 是标题上限，同样取自参考站（input.note-title maxlength=4000）。
const MaxMemoTitleRunes = 4000

// 附件类型，取值与参考站 fileType 逐一对齐（-1 是「没有附件」，不是「类型 0 之前的默认」）。
const (
	MemoFileNone  = -1
	MemoFileImage = 0
	MemoFileVideo = 1
	MemoFileFile  = 2
	MemoFileAudio = 3
)

// Memo 是一条备忘录。正文是富文本 HTML：参考站把 HTML 丢在 OSS（noteHtmlDataUrl），
// 记录里只留摘要；我们是本地优先、同步按记录合并，正文必须进记录才能跟着走，
// 所以这里只存 HTML，列表用的纯文本摘要与搜索命中都在用例层现算。
type Memo struct {
	ID        string `json:"id"`
	FolderID  string `json:"folderId"`
	Title     string `json:"title"`
	HTML      string `json:"html"`
	BackImage string `json:"backImage"` // 背景图：附件路径或空
	FileType  int    `json:"fileType"`
	FileID    string `json:"fileId"` // 列表缩略图用的那一个附件（图片/视频/文件/音频）
	IsTop     bool   `json:"isTop"`
	// TrashedAt 非空 = 在回收站里。它和 DeletedAt 是两回事：
	// DeletedAt 是同步引擎的墓碑（彻底删除），TrashedAt 只是用户侧的回收站状态。
	TrashedAt string `json:"trashedAt,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// —— 专注（Focus）——

// FocusType 是专注的三种计时形态。
type FocusType int

const (
	FocusCountUp   FocusType = iota + 1 // 正计时：从 0 往上走
	FocusPomodoro                       // 番茄钟：若干轮「专注 + 休息」
	FocusCountDown                      // 倒计时：选一个分钟数往下减
)

// FocusStatus 是记录状态。Running 与 Paused 都算「这次还没结束」，
// 应用被关掉再开要回到那一次（见 service.FocusCurrent / FocusRecover）。
type FocusStatus int

const (
	FocusRunning FocusStatus = iota + 1 // 在走
	FocusPaused                         // 暂停中，仍属于进行中的专注
	FocusDone                           // 已结束并保存
)

// 记录的来源：实时计时还是事后补记。补记没有真实的起止时刻，不伪造时间戳。
const (
	FocusLive   = 1
	FocusManual = 2
)

// 番茄钟的阶段。休息秒数不计入专注时长——一次番茄只算专注阶段。
const (
	FocusPhaseFocus = "focus"
	FocusPhaseShort = "short"
	FocusPhaseLong  = "long"
)

// FocusEvent 是专注详情页时间轴上的一条。Kind 是给前端选图标的稳定标识，Label 是当时的人话。
type FocusEvent struct {
	At    ClockTime `json:"at"`
	Kind  string    `json:"kind"` // start | pause | resume | cycle | rest | end | recover
	Label string    `json:"label"`
}

// FocusPlan 是一次番茄钟用的配置快照。改设置不回溯历史记录，
// 否则「上次那个 6 轮的番茄」会被今天的设置悄悄改掉。
type FocusPlan struct {
	Cycles    int  `json:"cycles"`    // 番茄钟个数（轮数），默认 4
	ShortRest int  `json:"shortRest"` // 短休息分钟，默认 1
	LongRest  int  `json:"longRest"`  // 长休息分钟，默认 2
	LongEvery int  `json:"longEvery"` // 每几轮上长休息，默认 4
	AutoRest  bool `json:"autoRest"`  // 休息是否自动开始
	FocusSec  int  `json:"focusSec"`  // 每轮专注秒数（用户在滚轮上选的分钟）
}

// FocusRecord 是一次专注。
//
// 计时账本刻意做成「累计 + 当前段起点」两段，而不是结束时算一次差值：
// 应用被关掉/崩溃的那段时间不能算专注。前端每 30 秒调 FocusTick 把走满的一段折进
// AccumSec，所以崩溃最多丢一个 tick 的精度，重启后 FocusRecover 也只按宽限期补一段。
type FocusRecord struct {
	ID     string      `json:"id"`
	Type   FocusType   `json:"type"`
	Status FocusStatus `json:"status"`
	Source int         `json:"source"` // FocusLive / FocusManual

	Day     Day       `json:"day"`
	StartAt ClockTime `json:"startAt,omitempty"` // 补记为空：不伪造时间戳
	EndAt   ClockTime `json:"endAt,omitempty"`

	AccumSec     int       `json:"accumSec"`               // 已折入的专注秒数
	// RoundBase 是「本轮专注开始时累计到哪儿」，番茄钟算本轮剩余要减掉它。
	// 少了这个字段，第二轮会拿全程累计去减一轮的目标，一休息完就「已超时」，直接冲到最后一轮。
	RoundBase int `json:"roundBase"`
	SegmentStart ClockTime `json:"segmentStart,omitempty"` // 非空 = 这一段正在走
	TargetSec    int       `json:"targetSec"`              // 计划时长；正计时不设目标时为 0
	ActualSec    int       `json:"actualSec"`              // 结束时定格的实际专注秒数（不含休息）
	RestSec      int       `json:"restSec"`                // 番茄钟累计休息秒数，只展示
	Cycles       int       `json:"cycles"`                 // 番茄钟已完成的专注轮数
	Phase        string    `json:"phase"`                  // focus / short / long；重启后知道回到哪一段

	Pomodoro *FocusPlan `json:"pomodoro,omitempty"`

	// 关联任务：事项与习惯二选一（都空 = 未关联）。派生列 parent 取非空的那个。
	ItemID  string `json:"itemId,omitempty"`
	HabitID string `json:"habitId,omitempty"`

	Note   string       `json:"note,omitempty"`
	Events []FocusEvent `json:"events,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	DeletedAt string `json:"deletedAt,omitempty"`
}
