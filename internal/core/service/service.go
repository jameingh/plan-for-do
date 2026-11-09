// Package service 是内核的用例层：清单与习惯的全部业务规则都在这里，
// 往上被 Wails 壳直接绑定暴露，往下只依赖 store / repeat / model。
//
// 方法签名刻意保持「可 JSON 序列化入参 + 可 JSON 序列化出参」，
// 这样 iOS/桌面壳和 CLI 都不需要再写一层适配。
package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"planfordo/internal/core/id"
	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

// ErrNotFound 表示请求的实体不存在或已被删除。
var ErrNotFound = errors.New("service: 对象不存在")

// maxScan 是连续天数等「从开始日扫到今天」的循环上限，防脏数据把 UI 卡住。
const maxScan = 40000

// App 是一次进程内的内核实例。
type App struct {
	db       *store.DB
	loc      *time.Location
	calendar repeat.HolidaySource
	// clock 是「现在这个时刻」的唯一来源，默认 time.Now。
	// 测试用 WithClock 钉住它，免得「今天落在周中」这类断言随真实日期翻转。
	clock func() time.Time
}

// Option 定制内核；壳层负责把自己平台解析出的时区与节假日数据源注入进来。
type Option func(*App)

// WithLocation 指定本地时区，决定「今天」是哪一天。默认 time.Local。
func WithLocation(loc *time.Location) Option {
	return func(a *App) {
		if loc != nil {
			a.loc = loc
		}
	}
}

// WithClock 注入墙钟（返回本地或 UTC 时刻均可，Today 会按 loc 换算）。
// 只给测试固定「今天」用；不注入时行为与之前完全一致。
func WithClock(clock func() time.Time) Option {
	return func(a *App) {
		if clock != nil {
			a.clock = clock
		}
	}
}

// WithCalendar 注入法定节假日与调休数据源。不注入时相关规则退化为普通周一至周五。
func WithCalendar(h repeat.HolidaySource) Option {
	return func(a *App) {
		a.calendar = h
	}
}

// New 以内核存储为底座构造服务。
func New(db *store.DB, opts ...Option) *App {
	a := &App{db: db, loc: time.Local, clock: time.Now}
	for _, o := range opts {
		o(a)
	}
	return a
}

// DB 暴露底层存储给同进程内的同步引擎与 CLI，不给 UI。
func (a *App) DB() *store.DB { return a.db }

// SetCalendar 更换节假日数据源。用户在运行中补好日历文件时用它刷新，不用重启进程。
func (a *App) SetCalendar(h repeat.HolidaySource) { a.calendar = h }

// DeviceID 是同步日志里区分来源的稳定标识。
func (a *App) DeviceID() string { return a.db.DeviceID() }

// Today 返回服务所在时区的本地日历日。所有「今天」的判断都必须走它，
// 不让前端传一个可能来自另一时区的日期。
func (a *App) Today() model.Day { return a.clock().In(a.loc).Format("2006-01-02") }

// now 发一个单调时间戳。
func (a *App) now(ctx context.Context) (model.ClockTime, error) {
	return a.db.Tick(ctx)
}

// localDay 把绝对时刻换算成本地日。
func (a *App) localDay(at model.ClockTime) model.Day {
	return tclock.LocalDay(at, a.loc)
}

// seedClock 是种子数据固定的 updatedAt。
//
// 每台设备都用「当前时间」建这批固定 ID 的行，首轮同步就会在 12 条种子记录上各判一次胜负，
// 报出一屏假冲突。用同一个常量后各端生成的 JSON 逐字节相同，合并自然无事发生。
const seedClock = "1970-01-01T00:00:00.000Z"

// Seed 建出首次启动必需的对象，可重复调用。
//
// 种子数据写死 ID（不是随机 ID），所以多台设备各自首次启动会生成同样的行，
// 同步时天然收敛成一条，不会出现两个「全部」清单本。
func (a *App) Seed(ctx context.Context) error {
	at := seedClock
	type seed struct {
		kind store.Kind
		v    any
	}
	seeds := []seed{
		// 默认清单本给一个视图条底色：参考站的清单本天生带色，我们的颜色是选填，
		// 种子留空的话月视图就是一屏 #F6F7F8 灰条，看着像没数据。取值用参考站截图里那条绿。
		{store.KindList, &model.List{ID: model.DefaultListID, Name: "全部", Icon: "list", Color: "#A9C6A8", Sort: 0, CreatedAt: at, UpdatedAt: at}},
	}
	for _, c := range defaultHabitContexts(at) {
		seeds = append(seeds, seed{store.KindHabitContext, c})
	}
	for _, u := range defaultUnits(at) {
		seeds = append(seeds, seed{store.KindHabitUnit, u})
	}
	for _, s := range seeds {
		e, err := store.NewEntity(s.kind, s.v)
		if err != nil {
			return err
		}
		if _, found, err := a.db.Get(ctx, e.Kind, e.ID); err != nil {
			return err
		} else if found {
			continue
		}
		if err := a.db.Put(ctx, e); err != nil {
			return err
		}
	}
	return nil
}

// 情境与单位同样使用固定 ID：删除后重建也不会与另一端的历史记录打架。
func defaultHabitContexts(at model.ClockTime) []*model.HabitContext {
	names := []struct{ id, name string }{
		{"ctx-always", "全天"},
		{"ctx-morning", "晨间"},
		{"ctx-noon", "午间"},
		{"ctx-evening", "晚间"},
	}
	out := make([]*model.HabitContext, 0, len(names))
	for i, n := range names {
		out = append(out, &model.HabitContext{ID: n.id, Name: n.name, Sort: i, CreatedAt: at, UpdatedAt: at})
	}
	return out
}

func defaultUnits(at model.ClockTime) []*model.HabitUnit {
	names := []struct{ id, name string }{
		{"unit-piece", "个"},
		{"unit-step", "步"},
		{"unit-meter", "米"},
		{"unit-km", "公里"},
		{"unit-page", "页"},
		{"unit-cup", "杯"},
		{"unit-minute", "分"},
	}
	out := make([]*model.HabitUnit, 0, len(names))
	for _, n := range names {
		out = append(out, &model.HabitUnit{ID: n.id, Name: n.name, CreatedAt: at, UpdatedAt: at})
	}
	return out
}

// newID 生成随机 ID。固定语义的对象（种子、确定性主键）不走这里。
func newID() string { return id.New() }

// listItems 取出全部存活事项。数据量级是个人清单，直接全量载入再在内存里展开，
// 换来的是重复规则、跨天、自选多日这些形态都能用同一段代码处理。
func (a *App) listItems(ctx context.Context) ([]*model.ListItem, error) {
	rows, err := a.db.Rows(ctx, store.KindItem, false)
	if err != nil {
		return nil, err
	}
	out := make([]*model.ListItem, 0, len(rows))
	for _, r := range rows {
		var it model.ListItem
		if err := r.Decode(&it); err != nil {
			return nil, err
		}
		normalizeItem(&it)
		out = append(out, &it)
	}
	return out, nil
}

func (a *App) getItem(ctx context.Context, itemID string) (*model.ListItem, error) {
	row, found, err := a.db.Get(ctx, store.KindItem, itemID)
	if err != nil {
		return nil, err
	}
	if !found || !row.Alive() {
		return nil, fmt.Errorf("%w: item %s", ErrNotFound, itemID)
	}
	var it model.ListItem
	if err := row.Decode(&it); err != nil {
		return nil, err
	}
	return &it, nil
}

func (a *App) saveItem(ctx context.Context, it *model.ListItem, at model.ClockTime) error {
	it.UpdatedAt = at
	normalizeItem(it)
	e, err := store.NewEntity(store.KindItem, it)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// overridesFor 取一批事项在某段日期范围内的单日例外。
func (a *App) overridesFor(ctx context.Context, itemIDs map[string]bool, from, to model.Day) (map[string][]model.OccurrenceOverride, error) {
	rows, err := a.db.Rows(ctx, store.KindOverride, false)
	if err != nil {
		return nil, err
	}
	out := map[string][]model.OccurrenceOverride{}
	for _, r := range rows {
		var o model.OccurrenceOverride
		if err := r.Decode(&o); err != nil {
			return nil, err
		}
		if !itemIDs[o.ItemID] {
			continue
		}
		if from != "" && repeat.DiffDays(o.Day, from) > 0 {
			continue // 早于窗口
		}
		if to != "" && repeat.DiffDays(to, o.Day) > 0 {
			continue // 晚于窗口
		}
		out[o.ItemID] = append(out[o.ItemID], o)
	}
	return out, nil
}

func containsStr(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// sortOccurrences 的顺序：先按当天时间点（全天的排最后），再按象限（越靠前越要紧），
// 然后创建时间，最后 ID——保证多次渲染结果一致。
func sortOccurrences(xs []Occurrence) {
	sort.SliceStable(xs, func(i, j int) bool {
		// 置顶优先，且置顶项之间仍按下面的规则排，不会互相乱跳。
		if xs[i].Item.IsTop != xs[j].Item.IsTop {
			return xs[i].Item.IsTop
		}
		ti, tj := timeKey(xs[i].Item.Time), timeKey(xs[j].Item.Time)
		if ti != tj {
			return ti < tj
		}
		if xs[i].Item.Priority != xs[j].Item.Priority {
			return xs[i].Item.Priority < xs[j].Item.Priority
		}
		if xs[i].Day != xs[j].Day {
			return xs[i].Day < xs[j].Day
		}
		if xs[i].Item.CreatedAt != xs[j].Item.CreatedAt {
			return xs[i].Item.CreatedAt < xs[j].Item.CreatedAt
		}
		return xs[i].Item.ID < xs[j].Item.ID
	})
}

func timeKey(t model.TimeSpec) string {
	if t.Kind == model.TimeAllDay || strings.TrimSpace(t.Start) == "" {
		return "99:99"
	}
	return t.Start
}
