package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"planfordo/internal/core/calendar"
	"planfordo/internal/core/id"
	"planfordo/internal/core/model"
	"planfordo/internal/core/service"
	"planfordo/internal/core/store"
	plansync "planfordo/internal/core/sync"
)

// API 是暴露给前端的唯一服务。每个方法都是内核用例的薄封装：
// 补上 context、把错误原样抛给前端（Wails 会转成 JS 异常）、并在写操作后发变更事件。
type API struct {
	app      *application.App
	svc      *service.App
	db       *store.DB
	syncMgr  *plansync.Manager
	dataDir  string
	calendar *calendar.FS

	fired    map[string]bool    // 已提醒过的提醒，避免同一轮重复弹
	reminder context.CancelFunc // 关窗时停掉定时器

	errMu          sync.Mutex // 上报入口可能来自多个 goroutine
	lastErrWhere   string
	lastErrDetail  string
	lastErrAt      time.Time
	suppressedErrs int
}

// NewAPI 打开内核并准备好前端可见的服务面。
func NewAPI(dataDir string) (*API, error) {
	ctx := context.Background()
	db, err := store.Open(ctx, dataDir)
	if err != nil {
		return nil, err
	}
	// 节假日数据缺失是正常状态（返回 nil，规则退化），但文件损坏必须当场报出来，
	// 否则「法定工作日」会静默按普通周一至周五算。
	cal, err := calendar.Load(filepath.Join(dataDir, "calendars"))
	if err != nil {
		db.Close()
		return nil, err
	}
	svc := service.New(db, service.WithCalendar(cal), service.WithLocation(time.Local))
	if err := svc.Seed(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据: %w", err)
	}
	return &API{
		svc:      svc,
		db:       db,
		calendar: cal,
		syncMgr:  plansync.NewManager(db),
		dataDir:  dataDir,
		fired:    map[string]bool{},
	}, nil
}

// Attach 把 Wails 应用回填进来，并启动提醒轮询。
func (a *API) attach(app *application.App) {
	a.app = app
	ctx, cancel := context.WithCancel(context.Background())
	a.reminder = cancel
	go a.reminderLoop(ctx)
}

// Shutdown 停掉后台轮询并关库。
func (a *API) shutdown() {
	if a.reminder != nil {
		a.reminder()
	}
	a.db.Close()
}

// BootInfo 是前端启动时要拿到的环境信息。
type BootInfo struct {
	DataDir       string    `json:"dataDir"`
	DeviceID      string    `json:"deviceId"`
	Today         model.Day `json:"today"`
	ChannelKinds  []string  `json:"channelKinds"`
	CalendarYears []int     `json:"calendarYears"` // 已加载的节假日数据年份，空表示规则退化
	Settings      Settings  `json:"settings"`
}

// Start 给前端做首次握手。
func (a *API) Start() (BootInfo, error) {
	info := BootInfo{
		DataDir:       a.dataDir,
		DeviceID:      a.db.DeviceID(),
		Today:         a.svc.Today(),
		ChannelKinds:  plansync.Kinds(),
		CalendarYears: a.calendar.Years(),
	}
	// nil 切片序列化出来是 null，前端任何 .map/.join 都会把整屏打白，跨界前统一成空数组。
	if info.ChannelKinds == nil {
		info.ChannelKinds = []string{}
	}
	if info.CalendarYears == nil {
		info.CalendarYears = []int{}
	}
	s, err := a.settings()
	if err != nil {
		return info, err
	}
	info.Settings = s
	return info, nil
}

// SaveCalendarYear 写入某一年的法定节假日与调休数据。
//
// 数据本身不内置：每年由国务院办公厅公布，程序不该猜。这里只负责把用户/导入脚本
// 提供的表落到 dataDir/calendars/<year>.json，重新打开后生效。
func (a *API) SaveCalendarYear(t calendar.Table) error {
	if err := calendar.Write(filepath.Join(a.dataDir, "calendars"), t); err != nil {
		return err
	}
	cal, err := calendar.Load(filepath.Join(a.dataDir, "calendars"))
	if err != nil {
		return err
	}
	a.calendar = cal
	a.svc.SetCalendar(cal)
	a.changed("calendar")
	return nil
}

// emit 在前端尚未挂载（CLI、单元测试）时安静跳过。
func (a *API) emit(event string, data any) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit(event, data)
}

func (a *API) changed(what string) {
	a.emit("data:changed", map[string]string{"what": what, "at": a.svc.Today()})
}

// 下面是清单。

// ListView 按请求返回分组后的事项。
func (a *API) ListView(req service.ListViewRequest) (service.ListView, error) {
	return a.svc.ListView(context.Background(), req)
}

// SaveItem 写入事项；scope 决定重复事项被改时影响哪一段。
func (a *API) SaveItem(in service.ItemInput, scope service.Scope, day model.Day) ([]*model.ListItem, error) {
	out, err := a.svc.SaveItem(context.Background(), in, scope, day)
	if err == nil {
		a.changed("item")
	}
	return out, err
}

// DeleteItem 删除事项。
func (a *API) DeleteItem(itemID string, scope service.Scope, day model.Day) error {
	if err := a.svc.DeleteItem(context.Background(), itemID, scope, day); err != nil {
		return err
	}
	a.changed("item")
	return nil
}

// SetItemClock 打卡或取消打卡。
func (a *API) SetItemClock(itemID string, day model.Day, on bool) error {
	if err := a.svc.SetItemClock(context.Background(), itemID, day, on); err != nil {
		return err
	}
	a.changed("clock")
	return nil
}

// SetItemClockState 打卡三态：0 取消 / 1 成功 / 3 失败。
// 状态值直接用内核的 ItemStatus，前端不另建一套枚举，免得两处漂移。
func (a *API) SetItemClockState(itemID string, day model.Day, status model.ItemStatus) error {
	if err := a.svc.SetItemClockState(context.Background(), itemID, day, status); err != nil {
		return err
	}
	a.changed("clock")
	return nil
}

// SetItemTop 置顶/取消置顶。
func (a *API) SetItemTop(itemID string, top bool) error {
	if err := a.svc.SetItemTop(context.Background(), itemID, top); err != nil {
		return err
	}
	a.changed("item")
	return nil
}

// PostponeItems 批量顺延。
func (a *API) PostponeItems(itemIDs []string, from, to model.Day) (int, error) {
	n, err := a.svc.Postpone(context.Background(), itemIDs, from, to)
	if err == nil {
		a.changed("clock")
	}
	return n, err
}

// OverdueBundle 是「批量顺延到今天」需要的两条平行数组。
type OverdueBundle struct {
	ItemIDs []string    `json:"itemIds"`
	Days    []model.Day `json:"days"`
}

// OverdueItems 返回当前逾期的事项。
func (a *API) OverdueItems(day model.Day) (OverdueBundle, error) {
	ids, days, err := a.svc.OverdueItemIDs(context.Background(), day)
	return OverdueBundle{ItemIDs: ids, Days: days}, err
}

// Children 返回子任务。
func (a *API) Children(itemID string) ([]model.Child, error) {
	return a.svc.Children(context.Background(), itemID)
}

// SaveChild 写子任务。
func (a *API) SaveChild(in service.ChildInput) (*model.Child, error) {
	out, err := a.svc.SaveChild(context.Background(), in)
	if err == nil {
		a.changed("child")
	}
	return out, err
}

// SetChildDone 勾选子任务。
func (a *API) SetChildDone(childID string, done bool) error {
	if err := a.svc.SetChildDone(context.Background(), childID, done); err != nil {
		return err
	}
	a.changed("child")
	return nil
}

// SetChildClock 子任务打卡三态：0 取消 / 1 成功 / 3 失败。
func (a *API) SetChildClock(childID string, status model.ItemStatus) error {
	if err := a.svc.SetChildClock(context.Background(), childID, status); err != nil {
		return err
	}
	a.changed("child")
	return nil
}

// LunarCell 是月历格子的农历信息，一次给整月，避免前端一格一调。
type LunarCell struct {
	Day string `json:"day"`
	// 农历日名（初一显示月名，如「正月」），其余为「廿六」这种日名。
	Lunar string `json:"lunar"`
	// 公历节日（元旦/劳动节）或农历节日（除夕/中秋），没有则空。
	Festival string `json:"festival"`
	// 节气名（立冬/小雪…），只在当天恰是二十四节气之一时给。
	// 视图网格要按参考站的样子把节气用彩色标出来，所以它与节日分开返回，由界面决定优先级。
	Term string `json:"term,omitempty"`
	// 周末（周六/周日）。法定节假日与调休的「班/休」需要外部数据源，本项目还没有，
	// 所以视图格子里只标周末，不标班休——宁可少标，不标错。
	Weekend bool `json:"weekend,omitempty"`
}

// LunarLabels 把公历日期批量换成农历日名与节日名，供日期面板的月历使用。
//
// 初一显示「正月/二月…」这种月名，其余显示「廿八」这种日名——和参考站一样。
// 超出 1900–2101 范围的日期返回空农历位，前端会退回只显示公历，不报错打断选日期。
func (a *API) LunarLabels(days []model.Day) ([]LunarCell, error) {
	if len(days) > 60 {
		days = days[:60] // 一个月最多 42 格，多出来的一律不伺候
	}
	out := make([]LunarCell, 0, len(days))
	for _, d := range days {
		cell := LunarCell{Day: d}
		var y, m, dd int
		if _, err := fmt.Sscanf(d, "%d-%d-%d", &y, &m, &dd); err == nil {
			if l, err := calendar.ToLunar(y, m, dd); err == nil {
				// 只给日名（初一 / 廿八）：参考站的格子就是这样，月名塞进去会挤掉数字的排版
				cell.Lunar = l.DayName
				cell.Term = l.SolarTerm
			}
			cell.Festival = calendar.Festival(y, m, dd)
			wd := time.Date(y, time.Month(m), dd, 0, 0, 0, 0, time.Local).Weekday()
			cell.Weekend = wd == time.Saturday || wd == time.Sunday
		}
		out = append(out, cell)
	}
	if out == nil {
		out = []LunarCell{}
	}
	return out, nil
}

// ItemImages 取一条事项的图片附件。
func (a *API) ItemImages(itemID string) ([]model.Attachment, error) {
	out, err := a.svc.Attachments(context.Background(), "item", itemID)
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []model.Attachment{} // 空指针序列化成 null，前端一读就崩，这里一律给空切片
	}
	return out, nil
}

// AddItemImage 保存一张事项图片。
//
// 前端用普通 <input type=file> 拿到 File，转 base64 传进来——WebView2 不暴露 File.path
// （那是 Electron 的私有能力），iOS 上也没有桌面路径概念，所以走字节而不是路径。
// 复制进 dataDir/attachments 后只留元数据行；10M 上限与参考站一致。
func (a *API) AddItemImage(itemID, name string, dataBase64 string) (model.Attachment, error) {
	ctx := context.Background()
	empty := model.Attachment{}
	existing, err := a.svc.Attachments(ctx, "item", itemID)
	if err != nil {
		return empty, err
	}
	if len(existing) >= service.MaxItemImages {
		return empty, fmt.Errorf("一条事项最多 %d 张图片", service.MaxItemImages)
	}
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return empty, fmt.Errorf("图片数据解码失败: %w", err)
	}
	if len(raw) > 10<<20 {
		return empty, fmt.Errorf("图片 %s 超过 10M", name)
	}
	mime, ok := imageMime(filepath.Ext(name))
	if !ok {
		return empty, fmt.Errorf("文件格式错误：%s 不是图片", name)
	}
	dir := filepath.Join(a.dataDir, "attachments")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return empty, err
	}
	att := model.Attachment{ID: id.New(), OwnerKind: "item", OwnerID: itemID, Mime: mime, Size: int64(len(raw))}
	if err := os.WriteFile(filepath.Join(dir, att.ID+filepath.Ext(name)), raw, 0o644); err != nil {
		return empty, err
	}
	att.Path = "attachments/" + att.ID + filepath.Ext(name)
	if err := a.svc.SaveAttachment(ctx, &att); err != nil {
		return empty, err
	}
	a.changed("attachment")
	return att, nil
}

// DeleteAttachment 删一条附件记录（文件留在磁盘上，见 service/attachment.go 的说明）。
func (a *API) DeleteAttachment(attachmentID string) error {
	if err := a.svc.DeleteAttachment(context.Background(), attachmentID); err != nil {
		return err
	}
	a.changed("attachment")
	return nil
}

func imageMime(ext string) (string, bool) {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png", true
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".gif":
		return "image/gif", true
	case ".webp":
		return "image/webp", true
	case ".bmp":
		return "image/bmp", true
	}
	return "", false
}

// DeleteChild 删子任务。
func (a *API) DeleteChild(childID string) error {
	if err := a.svc.DeleteChild(context.Background(), childID); err != nil {
		return err
	}
	a.changed("child")
	return nil
}

// 下面是分类、标签、清单本。

// Categories 返回分类。
func (a *API) Categories() ([]model.Category, error) { return a.svc.Categories(context.Background()) }

// SaveCategory 写分类。
func (a *API) SaveCategory(in service.CategoryInput) (*model.Category, error) {
	out, err := a.svc.SaveCategory(context.Background(), in)
	if err == nil {
		a.changed("category")
	}
	return out, err
}

// DeleteCategory 删分类；withItems 决定其下事项一起删还是归入未分类。
func (a *API) DeleteCategory(categoryID string, withItems bool) (int, error) {
	n, err := a.svc.DeleteCategory(context.Background(), categoryID, withItems)
	if err == nil {
		a.changed("category")
	}
	return n, err
}

// ReorderCategories 重排分类。
func (a *API) ReorderCategories(orderedIDs []string) error {
	if err := a.svc.ReorderCategories(context.Background(), orderedIDs); err != nil {
		return err
	}
	a.changed("category")
	return nil
}

// Labels 返回标签。
func (a *API) Labels() ([]model.Label, error) { return a.svc.Labels(context.Background()) }

// SaveLabel 写标签。
func (a *API) SaveLabel(in service.LabelInput) (*model.Label, error) {
	out, err := a.svc.SaveLabel(context.Background(), in)
	if err == nil {
		a.changed("label")
	}
	return out, err
}

// DeleteLabel 删标签。
func (a *API) DeleteLabel(labelID string) (int, error) {
	n, err := a.svc.DeleteLabel(context.Background(), labelID)
	if err == nil {
		a.changed("label")
	}
	return n, err
}

// Lists 返回清单本。
func (a *API) Lists() ([]model.List, error) { return a.svc.Lists(context.Background()) }

// SaveList 写清单本。
func (a *API) SaveList(in service.ListInput) (*model.List, error) {
	out, err := a.svc.SaveList(context.Background(), in)
	if err == nil {
		a.changed("list")
	}
	return out, err
}

// DeleteList 删清单本。
func (a *API) DeleteList(listID string, withItems bool) (int, error) {
	n, err := a.svc.DeleteList(context.Background(), listID, withItems)
	if err == nil {
		a.changed("list")
	}
	return n, err
}

// 下面是习惯。

// HabitMonthView 返回习惯页某天 + 某月的整屏数据。
func (a *API) HabitMonthView(day model.Day, month string) (service.HabitView, error) {
	return a.svc.HabitMonthView(context.Background(), day, month)
}

// SaveHabit 写习惯。
func (a *API) SaveHabit(in service.HabitInput) (*model.Habit, error) {
	out, err := a.svc.SaveHabit(context.Background(), in)
	if err == nil {
		a.changed("habit")
	}
	return out, err
}

// DeleteHabit 删习惯。
func (a *API) DeleteHabit(habitID string) error {
	if err := a.svc.DeleteHabit(context.Background(), habitID); err != nil {
		return err
	}
	a.changed("habit")
	return nil
}

// ClockHabit 打卡一次。
func (a *API) ClockHabit(habitID string, day model.Day, amount float64) (*model.HabitClock, error) {
	out, err := a.svc.ClockHabit(context.Background(), habitID, day, amount)
	if err == nil {
		a.changed("habitClock")
	}
	return out, err
}

// CancelHabitClock 取消某天的打卡。
func (a *API) CancelHabitClock(habitID string, day model.Day) (int, error) {
	n, err := a.svc.CancelHabitClock(context.Background(), habitID, day)
	if err == nil {
		a.changed("habitClock")
	}
	return n, err
}

// HabitStats 返回统计。
func (a *API) HabitStats(habitID, month string) (service.HabitStats, error) {
	return a.svc.HabitStats(context.Background(), habitID, month)
}

// HabitMarks 返回打卡日志。
func (a *API) HabitMarks(habitID string) ([]model.HabitMark, error) {
	return a.svc.HabitMarks(context.Background(), habitID)
}

// SaveHabitMark 写打卡日志。
func (a *API) SaveHabitMark(in service.HabitMarkInput) (*model.HabitMark, error) {
	out, err := a.svc.SaveHabitMark(context.Background(), in)
	if err == nil {
		a.changed("habitMark")
	}
	return out, err
}

// DeleteHabitMark 删打卡日志。
func (a *API) DeleteHabitMark(markID string) error {
	if err := a.svc.DeleteHabitMark(context.Background(), markID); err != nil {
		return err
	}
	a.changed("habitMark")
	return nil
}

// HabitUnits 返回习惯单位。
func (a *API) HabitUnits() ([]model.HabitUnit, error) { return a.svc.HabitUnits(context.Background()) }

// SaveHabitUnit 写习惯单位。
func (a *API) SaveHabitUnit(in service.HabitUnitInput) (*model.HabitUnit, error) {
	out, err := a.svc.SaveHabitUnit(context.Background(), in)
	if err == nil {
		a.changed("habitUnit")
	}
	return out, err
}

// HabitContexts 返回情境。
func (a *API) HabitContexts() ([]model.HabitContext, error) {
	return a.svc.HabitContexts(context.Background())
}

// SaveHabitContext 写情境。
func (a *API) SaveHabitContext(in service.HabitContextInput) (*model.HabitContext, error) {
	out, err := a.svc.SaveHabitContext(context.Background(), in)
	if err == nil {
		a.changed("habitContext")
	}
	return out, err
}

// DeleteHabitContext 删情境，其下习惯归入「全天」。
func (a *API) DeleteHabitContext(contextID string) (int, error) {
	n, err := a.svc.DeleteHabitContext(context.Background(), contextID)
	if err == nil {
		a.changed("habitContext")
	}
	return n, err
}

// 下面是提醒与设置。

// UpcomingReminders 返回区间内待触发的提醒。
func (a *API) UpcomingReminders(day, until model.Day) ([]service.ReminderFire, error) {
	return a.svc.UpcomingReminders(context.Background(), day, until)
}

// CalendarView 给视图模块（日/周/月）按区间取数：逐日铺开、不折叠，
// 这样跨天事项才能在网格里连成一条。
func (a *API) CalendarView(req service.CalendarRequest) (service.CalendarView, error) {
	return a.svc.CalendarView(context.Background(), req)
}

// Settings 是 UI 偏好，存本地 meta，不参与同步（换设备重新设更符合直觉）。
type Settings struct {
	ShowDone     bool   `json:"showDone"`
	DefaultGroup string `json:"defaultGroup"`
	Theme        string `json:"theme"`
	// HabitCreateMode 是「新建习惯」弹窗默认打开哪一套：guided（微启动分步引导）或 classic（一张卡）。
	// 只在新建时生效；编辑已有习惯一律走 classic。
	HabitCreateMode string `json:"habitCreateMode"`
	// View 是视图页（日/周/月）的显示配置。
	View ViewConfig `json:"view"`
	// MemoSortType 是备忘录列表的排序方式：0 按创建时间（默认）、1 按修改时间。
	// 参考站把它存在 localStorage 的 memoSortType 键里（"createTime"/"editTime"），
	// 我们存内核设置，这样它跟着同步走、换 WebView 也不丢。
	MemoSortType int `json:"memoSortType"`
}

// ViewConfig 对应参考站「自定义视图」+「视图设置」那 8 个 localStorage 标量。
// 两处刻意不同：① 存本地 meta 而不是浏览器 localStorage（换 WebView 不丢）；
// ② 隐藏项用字符串数组而不是它的逗号串（那边用 `search(id)` 子串匹配，id 前缀互含会误伤）。
//
// 字段全部按「零值即默认」设计：老偏好记录里没有 view 时，Unmarshal 出来的零值
// 正好是「都显示 / 按清单配色 / 不隐藏任何分类」，不需要额外的兼容补丁。
type ViewConfig struct {
	// HideMatterClocked：视图网格里不显示已打卡的事项（参考站的 viewMatterClockedIsShow="0"）。
	HideMatterClocked bool `json:"hideMatterClocked"`
	// HideHabitClocked：同上，习惯侧。
	HideHabitClocked bool `json:"hideHabitClocked"`
	// MatterColorMode：0 按清单本设置的颜色 / 1 按分类 / 2 按优先级 / 3 固定色。
	MatterColorMode int `json:"matterColorMode"`
	// MatterColorValue：模式 3 的固定色（十六进制）。
	MatterColorValue string `json:"matterColorValue"`
	// HabitColorMode：0 跟随习惯图标颜色 / 1 固定色。
	HabitColorMode int `json:"habitColorMode"`
	// HabitColorValue：习惯侧固定色。
	HabitColorValue string `json:"habitColorValue"`
	// HideCategories：清单侧隐藏的分类 ID；空串代表「无分类」。
	HideCategories []string `json:"hideCategories,omitempty"`
	// HideHabitContexts：习惯侧隐藏的情境 ID（习惯没有「无情境」这一档，所以没有特殊值）。
	HideHabitContexts []string `json:"hideHabitContexts,omitempty"`
}

const settingsKey = "ui.settings"

// ReportError 让前端把未捕获错误落到磁盘。
//
// 生产构建里 devtools 是关的，界面崩了只剩白屏，用户说不清、我也看不到栈。
// 错误写进 dataDir/app-errors.log，崩溃就有据可查。
func (a *API) ReportError(where string, detail string) error {
	if len(detail) > 4000 {
		detail = detail[:4000]
	}
	path := filepath.Join(a.dataDir, "app-errors.log")

	a.errMu.Lock()
	defer a.errMu.Unlock()
	now := time.Now()
	// 渲染崩溃会一秒刷几百条一模一样的错误（实测一个下午堆了 1.3 万行），
	// 同一句一分钟内只落一次，其余计数，下一条不同时把省略量写出来。
	if where == a.lastErrWhere && detail == a.lastErrDetail && now.Sub(a.lastErrAt) < time.Minute {
		a.suppressedErrs++
		return nil
	}
	prefix := ""
	if a.suppressedErrs > 0 {
		prefix = fmt.Sprintf("（上一条重复省略 %d 次）\n", a.suppressedErrs)
	}
	a.lastErrWhere, a.lastErrDetail, a.lastErrAt, a.suppressedErrs = where, detail, now, 0
	line := fmt.Sprintf("%s%s [%s] %s\n", prefix, now.Format("2006-01-02 15:04:05.000"), where, detail)

	if err := rotateErrLog(path); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(line); err != nil {
		return err
	}
	return nil
}

// rotateErrLog 把错误日志压在 512KB 以内：超了就只保留最后 128KB。
// 日志是为了定位问题，不该变成第二个问题。
func rotateErrLog(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if st.Size() <= 512<<10 {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	keep := raw[len(raw)-(128<<10):]
	if i := bytes.IndexByte(keep, '\n'); i >= 0 && i+1 < len(keep) {
		keep = keep[i+1:] // 别从半行开始
	}
	return os.WriteFile(path, keep, 0o644)
}

// GetSettings 读偏好。
func (a *API) GetSettings() (Settings, error) { return a.settings() }

// defaultSettings 是唯一的默认值来源。
//
// 之前内核默认 showDone=false、前端默认 true，同一个开关两处定义：老用户点过之后
// 存在库里看不出问题，新设备第一次启动就少一整列「已打卡」，而且只有别人看不到。
// 默认按参考站来：显示已打卡。
func defaultSettings() Settings {
	return Settings{
		ShowDone:        true,
		DefaultGroup:    "date",
		Theme:           "light",
		HabitCreateMode: "guided",
		// 隐藏项给空数组而不是 nil：Go 的 nil 切片序列化出来是 `null`，
		// 前端那边 `.join()` 会当场炸掉启动（2026-11-07 实测过）。
		View: ViewConfig{HideCategories: []string{}, HideHabitContexts: []string{}},
	}
}

func (a *API) settings() (Settings, error) {
	raw, ok, err := a.db.MetaGet(context.Background(), settingsKey)
	if err != nil || !ok {
		return defaultSettings(), err
	}
	var s Settings
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return defaultSettings(), nil // 偏好损坏就退回默认，别把启动卡住
	}
	if s.DefaultGroup == "" {
		s.DefaultGroup = "date"
	}
	// 老库里的偏好没有这个字段（或写脏了），退回默认，别让新建弹窗两头都不像
	if s.HabitCreateMode != "guided" && s.HabitCreateMode != "classic" {
		s.HabitCreateMode = defaultSettings().HabitCreateMode
	}
	return s, nil
}

// SaveSettings 写偏好。
func (a *API) SaveSettings(s Settings) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := a.db.MetaSet(context.Background(), settingsKey, string(raw)); err != nil {
		return err
	}
	a.changed("settings")
	return nil
}

// 下面是同步。

// SyncChannels 返回已配置的通道。
func (a *API) SyncChannels() ([]plansync.Config, error) {
	return a.syncMgr.Configs(context.Background())
}

// SaveSyncChannel 新增或覆盖一条通道配置。
func (a *API) SaveSyncChannel(cfg plansync.Config) error {
	return a.syncMgr.SaveConfig(context.Background(), cfg)
}

// RemoveSyncChannel 删通道配置（不动远端数据）。
func (a *API) RemoveSyncChannel(name string) error {
	return a.syncMgr.RemoveConfig(context.Background(), name)
}

// ProbeSyncChannel 测连通性，允许针对未落盘的配置测。
func (a *API) ProbeSyncChannel(cfg plansync.Config) error {
	return a.syncMgr.Probe(context.Background(), cfg)
}

// SyncNow 跑一条通道；name 为空表示跑所有启用的通道。
func (a *API) SyncNow(name string) ([]plansync.Result, error) {
	ctx := context.Background()
	var results []plansync.Result
	var err error
	if name == "" {
		results, err = a.syncMgr.SyncAll(ctx)
	} else {
		var r plansync.Result
		r, err = a.syncMgr.SyncOne(ctx, name)
		results = []plansync.Result{r}
	}
	a.emit("sync:done", results)
	return results, err
}

// SyncState 返回某通道水位与最近一次的结果摘要。
func (a *API) SyncState(name string) (store.SyncState, error) {
	return a.syncMgr.State(context.Background(), name)
}

// reminderLoop 每 30 秒扫一次未来一分钟内的提醒，触发事件给前端。
//
// 桌面端可以在这儿直接弹系统通知；iOS 不跑后台定时器，
// 所以真正的落地方式是前端激活时把 UpcomingReminders 的结果预排成本地通知。
func (a *API) reminderLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.fireDueReminders(ctx)
		}
	}
}

func (a *API) fireDueReminders(ctx context.Context) {
	fires, err := a.svc.UpcomingReminders(ctx, a.svc.Today(), "")
	if err != nil {
		return
	}
	deadline := time.Now().Add(60 * time.Second)
	due := []service.ReminderFire{}
	for _, f := range fires {
		at, ok := parseClock(f.At)
		if !ok || at.After(deadline) {
			continue
		}
		key := f.ItemID + "|" + f.ReminderID + "|" + f.At
		if a.fired[key] {
			continue
		}
		a.fired[key] = true
		due = append(due, f)
	}
	if len(due) == 0 {
		return
	}
	sort.SliceStable(due, func(i, j int) bool { return due[i].At < due[j].At })
	a.emit("reminder:due", due)
}

func parseClock(s string) (time.Time, bool) {
	t, err := time.Parse("2006-01-02T15:04:05.000Z", s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// HabitStat 给习惯统计页（日/周/月/年）按区间取数：
// 逐习惯逐日的状态 + 每日横向汇总 + 打卡总数/最长连续/完美打卡天数。
func (a *API) HabitStat(req service.HabitStatRequest) (service.HabitStat, error) {
	out, err := a.svc.HabitStat(context.Background(), req)
	if out.Habits == nil {
		out.Habits = []service.HabitStatHabit{}
	}
	if out.Days == nil {
		out.Days = []service.HabitStatDaySummary{}
	}
	return out, err
}

// —— 备忘录 ——

// MemoFolders 返回文件夹列表（「全部」由界面自己拼，不在这里）。
func (a *API) MemoFolders() ([]model.MemoFolder, error) {
	out, err := a.svc.MemoFolders(context.Background())
	if out == nil {
		out = []model.MemoFolder{}
	}
	return out, err
}

// SaveMemoFolder 建或改文件夹。
func (a *API) SaveMemoFolder(in service.MemoFolderInput) (*model.MemoFolder, error) {
	out, err := a.svc.SaveMemoFolder(context.Background(), in)
	if err == nil {
		a.changed("memoFolder")
	}
	return out, err
}

// ReorderMemoFolders 拖拽排序后把新顺序写回。
func (a *API) ReorderMemoFolders(orderedIDs []string) error {
	if err := a.svc.ReorderMemoFolders(context.Background(), orderedIDs); err != nil {
		return err
	}
	a.changed("memoFolder")
	return nil
}

// DeleteMemoFolder 删文件夹；其下备忘录一起进回收站，返回被送进回收站的条数。
func (a *API) DeleteMemoFolder(folderID string) (int, error) {
	n, err := a.svc.DeleteMemoFolder(context.Background(), folderID)
	if err == nil {
		a.changed("memoFolder")
	}
	return n, err
}

// MemoList 返回一列备忘录（含回收站视图与搜索）。
func (a *API) MemoList(req service.MemoRequest) ([]service.MemoItem, error) {
	out, err := a.svc.MemoList(context.Background(), req)
	if out == nil {
		out = []service.MemoItem{}
	}
	return out, err
}

// Memo 单读一条（编辑器打开时用，列表不带正文）。
func (a *API) Memo(memoID string) (*model.Memo, error) {
	return a.svc.Memo(context.Background(), memoID)
}

// CreateMemo 新建一条空备忘录，返回给界面直接打开编辑器。
func (a *API) CreateMemo(folderID string) (*model.Memo, error) {
	out, err := a.svc.CreateMemo(context.Background(), folderID)
	if err == nil {
		a.changed("memo")
	}
	return out, err
}

// SaveMemo 保存标题/正文/归属/背景图/附件。
func (a *API) SaveMemo(in service.MemoInput) (*model.Memo, error) {
	out, err := a.svc.SaveMemo(context.Background(), in)
	if err == nil {
		a.changed("memo")
	}
	return out, err
}

// SetMemoTop 置顶或取消置顶。
func (a *API) SetMemoTop(memoID string, top bool) error {
	if err := a.svc.SetMemoTop(context.Background(), memoID, top); err != nil {
		return err
	}
	a.changed("memo")
	return nil
}

// MoveMemoFolders 移入文件夹（folderID 空 = 未归类）。
func (a *API) MoveMemoFolders(memoIDs []string, folderID string) (int, error) {
	n, err := a.svc.MoveMemoFolders(context.Background(), memoIDs, folderID)
	if err == nil {
		a.changed("memo")
	}
	return n, err
}

// TrashMemos 删除（进回收站）。
func (a *API) TrashMemos(memoIDs []string) (int, error) {
	n, err := a.svc.TrashMemos(context.Background(), memoIDs)
	if err == nil {
		a.changed("memo")
	}
	return n, err
}

// RestoreMemos 从回收站恢复。
func (a *API) RestoreMemos(memoIDs []string) (int, error) {
	n, err := a.svc.RestoreMemos(context.Background(), memoIDs)
	if err == nil {
		a.changed("memo")
	}
	return n, err
}

// PurgeMemos 彻底删除（走同步墓碑）。
func (a *API) PurgeMemos(memoIDs []string) (int, error) {
	n, err := a.svc.PurgeMemos(context.Background(), memoIDs)
	if err == nil {
		a.changed("memo")
	}
	return n, err
}

// MemoStats 是列表角标用的计数（在库 / 回收站）。
func (a *API) MemoStats() (service.MemoStats, error) {
	return a.svc.MemoStats(context.Background())
}

// AddMemoFile 给备忘录存一个附件（图片/视频/音频/文件），返回附件与它的类型码。
// 与事项图片同一条路子：字节走 base64 进来，落 dataDir/attachments，记录里只留路径。
func (a *API) AddMemoFile(memoID, name, dataBase64 string) (model.Attachment, int, error) {
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return model.Attachment{}, 0, fmt.Errorf("附件数据解码失败: %w", err)
	}
	if len(raw) > 50<<20 {
		return model.Attachment{}, 0, fmt.Errorf("附件大小超过50M")
	}
	kind, mime, err := memoFileKind(name)
	if err != nil {
		return model.Attachment{}, 0, err
	}
	dir := filepath.Join(a.dataDir, "attachments")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return model.Attachment{}, 0, err
	}
	att := model.Attachment{ID: id.New(), OwnerKind: "memo", OwnerID: memoID, Mime: mime, Size: int64(len(raw))}
	if err := os.WriteFile(filepath.Join(dir, att.ID+filepath.Ext(name)), raw, 0o644); err != nil {
		return model.Attachment{}, 0, err
	}
	att.Path = "attachments/" + att.ID + filepath.Ext(name)
	if err := a.svc.SaveAttachment(context.Background(), &att); err != nil {
		return model.Attachment{}, 0, err
	}
	a.changed("attachment")
	return att, kind, nil
}

// memoFileKind 按扩展名分四类，与参考站工具条的 图片/视频/文件/音频 四个入口一一对应。
func memoFileKind(name string) (int, string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	if mime, ok := imageMime(ext); ok {
		return model.MemoFileImage, mime, nil
	}
	switch ext {
	case ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv":
		return model.MemoFileVideo, "video/" + strings.TrimPrefix(ext, "."), nil
	case ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg":
		return model.MemoFileAudio, "audio/" + strings.TrimPrefix(ext, "."), nil
	}
	if ext == "" {
		return 0, "", fmt.Errorf("附件 %s 没有扩展名", name)
	}
	return model.MemoFileFile, "application/octet-stream", nil
}

// —— 专注 ——

// FocusStart 开一次专注。同一时刻只允许一次进行中的专注，第二次会拿到「已有专注进行中」。
func (a *API) FocusStart(req service.FocusStartRequest) (*model.FocusRecord, error) {
	out, err := a.svc.FocusStart(context.Background(), req)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusTick 是计时心跳：把走满的一段折进累计。它不 emit changed——
// 心跳每 30 秒一次，让界面跟着重取一遍数据毫无意义。
func (a *API) FocusTick(focusID string) (*model.FocusRecord, error) {
	return a.svc.FocusTick(context.Background(), focusID)
}

// FocusPause 暂停（时间停住，这次专注还没结束）。
func (a *API) FocusPause(focusID string) (*model.FocusRecord, error) {
	out, err := a.svc.FocusPause(context.Background(), focusID)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusResume 继续，也是番茄钟开下一轮专注段的入口。
func (a *API) FocusResume(focusID string) (*model.FocusRecord, error) {
	out, err := a.svc.FocusResume(context.Background(), focusID)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusRestStart 进入休息阶段（只改阶段与状态，不累计秒数）。
func (a *API) FocusRestStart(focusID, phase string) (*model.FocusRecord, error) {
	out, err := a.svc.FocusRestStart(context.Background(), focusID, phase)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusPhaseEnd 记一次番茄阶段收尾：focus 折时间并 +1 轮，short/long 只累计休息秒数。
func (a *API) FocusPhaseEnd(focusID, phase string, restSec int) (*model.FocusRecord, error) {
	out, err := a.svc.FocusPhaseEnd(context.Background(), focusID, phase, restSec)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusFinish 结束这次专注。save=false 就是界面上的「放弃（不保存）」。
func (a *API) FocusFinish(focusID string, save bool) (*model.FocusRecord, error) {
	out, err := a.svc.FocusFinish(context.Background(), focusID, save)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusCurrent 取进行中的那一次；没有就是 null，界面据此决定回不回沉浸页。
func (a *API) FocusCurrent() (*model.FocusRecord, error) {
	return a.svc.FocusCurrent(context.Background())
}

// FocusRecover 重启后回到那一次：崩溃期间不计时长，最多补一个心跳周期，然后停在暂停态。
func (a *API) FocusRecover(focusID string) (*model.FocusRecord, error) {
	out, err := a.svc.FocusRecover(context.Background(), focusID)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// Focus 单读一条（专注详情页），带回现取的关联任务名。
func (a *API) Focus(focusID string) (*service.FocusListItem, error) {
	return a.svc.FocusGet(context.Background(), focusID)
}

// FocusSave 补记一条，或修改已有记录（实时记录只接受改心得与改关联任务）。
func (a *API) FocusSave(in service.FocusInput) (*model.FocusRecord, error) {
	out, err := a.svc.FocusSave(context.Background(), in)
	if err == nil {
		a.changed("focus")
	}
	return out, err
}

// FocusDelete 删除一条记录。
func (a *API) FocusDelete(focusID string) error {
	if err := a.svc.FocusDelete(context.Background(), focusID); err != nil {
		return err
	}
	a.changed("focus")
	return nil
}

// FocusList 历史列表；day 为空 = 全部。只出已结束的记录。
func (a *API) FocusList(day string, limit int) ([]service.FocusListItem, error) {
	out, err := a.svc.FocusList(context.Background(), day, limit)
	if out == nil {
		out = []service.FocusListItem{}
	}
	return out, err
}

// FocusStat 区间聚合：总览是全历史的，趋势/类型/任务/时段矩阵按区间。
func (a *API) FocusStat(req service.FocusStatRequest) (service.FocusStat, error) {
	out, err := a.svc.FocusStat(context.Background(), req)
	if out.Matrix == nil {
		out.Matrix = []service.FocusCell{}
	}
	if out.Daily == nil {
		out.Daily = []service.FocusDaily{}
	}
	if out.ByType == nil {
		out.ByType = []service.FocusTypeSplit{}
	}
	if out.ByTask == nil {
		out.ByTask = []service.FocusTaskSplit{}
	}
	return out, err
}

// FocusCandidates 是「关联任务」弹窗的候选清单（事项 / 习惯两页签）。
func (a *API) FocusCandidates(req service.FocusCandidateRequest) ([]service.FocusCandidate, error) {
	out, err := a.svc.FocusCandidates(context.Background(), req)
	if out == nil {
		out = []service.FocusCandidate{}
	}
	return out, err
}
