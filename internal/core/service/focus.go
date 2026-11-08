package service

import (
	"context"
	"fmt"
	"sort"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

// 专注（Focus）：正计时 / 番茄钟 / 倒计时三种计时形态 + 记录 + 统计。
//
// 三条口径先钉死，界面与统计都只认这里：
//  1. 一次专注只有「专注阶段」计时。番茄钟的短/长休息不计入 ActualSec，只累计在 RestSec 里展示，
//     所以休息再长也不会把「今日专注时长」灌水。
//  2. 计时账本是 AccumSec + SegmentStart 两段（见 model.FocusRecord）。SegmentStart 只在专注阶段非空，
//     休息阶段一律为空——这样「休息中把应用关掉」不会在恢复时补出一段假专注。
//  3. 进行中的记录（Running/Paused）不落历史列表，只有结束并保存的记录才进统计。
//     点「放弃（不保存）」走墓碑删除，同步端也会跟着消失。

// 单次最长 24 小时，再长就是脏数据；恢复宽限期等于前端 tick 周期，崩溃期间不计时长。
const (
	focusMaxSec       = 24 * 3600
	focusRecoverGrace = 30
	focusStatMaxSpan  = 380
	focusTaskTopN     = 10
	focusListMax      = 500
)

// FocusStartRequest 开始一次专注。关联任务二选一，都不传就是「不挂任务」。
type FocusStartRequest struct {
	Type      model.FocusType  `json:"type"`
	TargetSec int              `json:"targetSec"`
	ItemID    string           `json:"itemId,omitempty"`
	HabitID   string           `json:"habitId,omitempty"`
	Pomodoro  *model.FocusPlan `json:"pomodoro,omitempty"`
}

// FocusInput 既用于「补记专注记录」，也用于详情页的编辑。
// ID 为空 = 新建补记；非空 = 修改。实时记录只接受改心得与改关联任务，
// 时长/日期/类型是计时器算出来的真值，不给人随手改成 3 小时。
type FocusInput struct {
	ID        string          `json:"id,omitempty"`
	Type      model.FocusType `json:"type"`
	Day       model.Day       `json:"day"`
	ActualSec int             `json:"actualSec"`
	Cycles    int             `json:"cycles"`
	ItemID    string          `json:"itemId,omitempty"`
	HabitID   string          `json:"habitId,omitempty"`
	Note      string          `json:"note"`
}

// FocusListItem 是历史列表的一行：记录本体 + 现取的任务名（任务改名不用回写记录）。
type FocusListItem struct {
	Record   model.FocusRecord `json:"record"`
	TaskName string            `json:"taskName"`
	TaskKind string            `json:"taskKind"` // item | habit | ""
}

// FocusOverview 是「累计 / 今日」两块总览。它是全历史的，不受统计区间影响——
// 用户要的「累计专注」就是从头到现在，把区间套上去会变成「这个月累计」，语义不对。
type FocusOverview struct {
	TotalSec   int `json:"totalSec"`
	TotalCount int `json:"totalCount"`
	TodaySec   int `json:"todaySec"`
	TodayCount int `json:"todayCount"`
}

// FocusDaily 是区间内某一天的专注量。
type FocusDaily struct {
	Day   model.Day `json:"day"`
	Sec   int       `json:"sec"`
	Count int       `json:"count"`
}

// FocusTypeSplit 是按专注类型的分解。
type FocusTypeSplit struct {
	Type  model.FocusType `json:"type"`
	Sec   int             `json:"sec"`
	Count int             `json:"count"`
}

// FocusTaskSplit 是按关联任务的排行；ItemID 为空表示「未关联」这一档。
type FocusTaskSplit struct {
	ItemID string `json:"itemId,omitempty"`
	Name   string `json:"name"`
	Sec    int    `json:"sec"`
	Count  int    `json:"count"`
}

// FocusCell 是「时段 × 星期」矩阵的一格。168 格全给，前端不用自己补零。
type FocusCell struct {
	Weekday int `json:"weekday"` // 1=周一 .. 7=周日
	Hour    int `json:"hour"`    // 0..23，本地小时
	Sec     int `json:"sec"`
	Count   int `json:"count"`
}

// FocusStatRequest 是统计区间。
type FocusStatRequest struct {
	Start model.Day `json:"start"`
	End   model.Day `json:"end"`
}

// FocusStat 是一次区间聚合的结果。
type FocusStat struct {
	Start         model.Day        `json:"start"`
	End           model.Day        `json:"end"`
	Today         model.Day        `json:"today"`
	Overview      FocusOverview    `json:"overview"`
	Daily         []FocusDaily     `json:"daily"`
	ByType        []FocusTypeSplit `json:"byType"`
	ByTask        []FocusTaskSplit `json:"byTask"`
	Matrix        []FocusCell      `json:"matrix"`
	UnplacedSec   int              `json:"unplacedSec"` // 补记没有真实时刻，落不进时段矩阵，单独给个交代
	UnplacedCount int              `json:"unplacedCount"`
}

// FocusCandidate 是「关联任务」弹窗里的一行。
type FocusCandidate struct {
	Kind     string          `json:"kind"` // item | habit
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Day      model.Day       `json:"day"`
	TimeText string          `json:"timeText"`
	Group    string          `json:"group"` // 事项所属清单本 / 习惯所属情境
	Icon     model.HabitIcon `json:"icon"`
	Clocked  bool            `json:"clocked"`
}

// FocusCandidateRequest：Day 为空 = 全部待办（逾期 + 今天 + 往后），Tab 为空 = 两类都要。
type FocusCandidateRequest struct {
	Day model.Day `json:"day,omitempty"`
	Tab string    `json:"tab,omitempty"`
}

// —— 内部小工具 ——

func focusEvent(at model.ClockTime, kind, label string) model.FocusEvent {
	return model.FocusEvent{At: at, Kind: kind, Label: label}
}

// focusPlan 补齐番茄配置：0 一律落回默认值，越界夹住。
// 界面上的默认值（4 轮 / 1 分 / 2 分 / 4 次 / 自动休息开）与这里必须一致。
func focusPlan(p *model.FocusPlan) *model.FocusPlan {
	out := model.FocusPlan{Cycles: 4, ShortRest: 1, LongRest: 2, LongEvery: 4, AutoRest: true}
	if p != nil {
		out.FocusSec = p.FocusSec
		if p.Cycles > 0 {
			out.Cycles = clampInt(p.Cycles, 1, 12)
		}
		if p.ShortRest > 0 {
			out.ShortRest = clampInt(p.ShortRest, 1, 120)
		}
		if p.LongRest > 0 {
			out.LongRest = clampInt(p.LongRest, 1, 120)
		}
		if p.LongEvery > 0 {
			out.LongEvery = clampInt(p.LongEvery, 1, 12)
		}
		out.AutoRest = p.AutoRest
	}
	return &out
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (a *App) saveFocus(ctx context.Context, r *model.FocusRecord, at model.ClockTime) error {
	r.UpdatedAt = at
	e, err := store.NewEntity(store.KindFocus, r)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// focusFold 把正在走的那一段折进累计并清空段起点，返回折进去的秒数。
func focusFold(r *model.FocusRecord, at model.ClockTime) int {
	if r.SegmentStart == "" {
		return 0
	}
	st, ok1 := tclock.Parse(r.SegmentStart)
	nt, ok2 := tclock.Parse(at)
	sec := 0
	if ok1 && ok2 {
		if d := int(nt.Sub(st).Seconds()); d > 0 {
			sec = d
		}
	}
	r.SegmentStart = ""
	r.AccumSec += sec
	return sec
}

// focusElapsed 是「此刻为止的真实专注秒数」，含正在走的那一段。
func focusElapsed(r *model.FocusRecord, at model.ClockTime) int {
	total := r.AccumSec
	if r.SegmentStart != "" {
		if st, ok1 := tclock.Parse(r.SegmentStart); ok1 {
			if nt, ok2 := tclock.Parse(at); ok2 {
				if d := int(nt.Sub(st).Seconds()); d > 0 {
					total += d
				}
			}
		}
	}
	return total
}

// focusCheckTask 校验关联任务存在且只关联了一个，返回规范化后的 ID。
func (a *App) focusCheckTask(ctx context.Context, itemID, habitID string) (string, string, error) {
	if itemID != "" && habitID != "" {
		return "", "", fmt.Errorf("service: 关联任务只能选一个（事项与习惯不能同时挂）")
	}
	if itemID != "" {
		if _, err := loadOne[model.ListItem](a, ctx, store.KindItem, itemID); err != nil {
			return "", "", err
		}
	}
	if habitID != "" {
		if _, err := loadOne[model.Habit](a, ctx, store.KindHabit, habitID); err != nil {
			return "", "", err
		}
	}
	return itemID, habitID, nil
}

// focusUnfinished 找出还没结束的那一次（最多一条）。
func focusUnfinished(all []model.FocusRecord) *model.FocusRecord {
	var pick *model.FocusRecord
	for i := range all {
		r := &all[i]
		if r.Status == model.FocusDone {
			continue
		}
		if pick == nil || r.StartAt > pick.StartAt {
			pick = r
		}
	}
	return pick
}

// —— 用例 ——

// FocusStart 开一次专注。同一时刻只允许一次进行中的专注：计时器是独占的，
// 两条并行记录既没法在界面上同时沉浸，也没法在统计里说清哪一段算数。
func (a *App) FocusStart(ctx context.Context, req FocusStartRequest) (*model.FocusRecord, error) {
	if req.Type < model.FocusCountUp || req.Type > model.FocusCountDown {
		return nil, fmt.Errorf("service: 未知的专注类型 %d", int(req.Type))
	}
	if req.TargetSec < 0 || req.TargetSec > focusMaxSec {
		return nil, fmt.Errorf("service: 目标时长超出范围（最多 24 小时）")
	}
	itemID, habitID, err := a.focusCheckTask(ctx, req.ItemID, req.HabitID)
	if err != nil {
		return nil, err
	}
	all, err := loadAll[model.FocusRecord](a, ctx, store.KindFocus)
	if err != nil {
		return nil, err
	}
	if cur := focusUnfinished(all); cur != nil {
		if a.foreign(cur) {
			return nil, fmt.Errorf("service: 另一台设备（%s）还有一次未结束的专注，请先接管或放弃", shortDevice(cur.DeviceID))
		}
		return nil, fmt.Errorf("service: 已有专注进行中，请先结束或放弃")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	r := &model.FocusRecord{
		ID: newID(), Type: req.Type, Status: model.FocusRunning, Source: model.FocusLive,
		DeviceID: a.DeviceID(),
		Day:      a.Today(), StartAt: at, SegmentStart: at, TargetSec: req.TargetSec,
		ItemID: itemID, HabitID: habitID,
		Events:    []model.FocusEvent{focusEvent(at, "start", "开始专注")},
		CreatedAt: at, UpdatedAt: at,
	}
	switch req.Type {
	case model.FocusPomodoro:
		plan := focusPlan(req.Pomodoro)
		r.RoundBase = 0
		r.Pomodoro = plan
		r.Phase = model.FocusPhaseFocus
		if r.TargetSec == 0 {
			r.TargetSec = plan.FocusSec
		}
	case model.FocusCountDown:
		if r.TargetSec <= 0 {
			return nil, fmt.Errorf("service: 倒计时要先选一个时长")
		}
		r.Phase = model.FocusPhaseFocus
	}
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusTick 把走满的一段折进累计并重新起段。前端每 30 秒打一次心跳，
// 于是「应用被关掉」最多丢一个 tick 的精度，而不是把整段没结束的时间全丢。
// 这是心跳不是数据变更：不 emit changed，免得界面每 30 秒重取一遍。
func (a *App) FocusTick(ctx context.Context, id string) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status != model.FocusRunning {
		return r, nil
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	focusFold(r, at)
	r.SegmentStart = at
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusPause 暂停：时间停住，但这次专注还没结束。
func (a *App) FocusPause(ctx context.Context, id string) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status != model.FocusRunning {
		return r, nil
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	focusFold(r, at)
	r.Status = model.FocusPaused
	r.Events = append(r.Events, focusEvent(at, "pause", "暂停"))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusResume 继续。番茄钟用它开下一轮专注段（休息结束时也算「继续」）。
func (a *App) FocusResume(ctx context.Context, id string) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status == model.FocusDone {
		return nil, fmt.Errorf("service: 这次专注已经结束")
	}
	if r.Status == model.FocusRunning {
		return r, nil
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	r.Status = model.FocusRunning
	r.SegmentStart = at
	r.Phase = model.FocusPhaseFocus
	r.Events = append(r.Events, focusEvent(at, "resume", "继续"))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusRestStart 进入休息阶段：只改 phase 与状态，不累计任何秒数。
// 单独一个方法是因为「休息开始」和「休息结束」是两件事——
// 把开始塞进 FocusPhaseEnd 会让时间轴提前写出「短休息结束」。
func (a *App) FocusRestStart(ctx context.Context, id, phase string) (*model.FocusRecord, error) {
	if phase != model.FocusPhaseShort && phase != model.FocusPhaseLong {
		return nil, fmt.Errorf("service: 未知的休息阶段 %q", phase)
	}
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status == model.FocusDone {
		return nil, fmt.Errorf("service: 这次专注已经结束")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	// 休息期间不计时：段起点必须为空，否则恢复时会把休息算进专注。
	focusFold(r, at)
	r.Status = model.FocusPaused
	r.Phase = phase
	label := "短休息开始"
	if phase == model.FocusPhaseLong {
		label = "长休息开始"
	}
	r.Events = append(r.Events, focusEvent(at, "rest", label))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusPhaseEnd 记一次番茄阶段收尾。
//   - phase=focus：把这一轮专注折进累计、轮数 +1，段起点清空（休息期间不计时）；
//   - phase=short/long：只累计 RestSec，供展示，不进 ActualSec。
func (a *App) FocusPhaseEnd(ctx context.Context, id, phase string, restSec int) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status == model.FocusDone {
		return nil, fmt.Errorf("service: 这次专注已经结束")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	switch phase {
	case model.FocusPhaseFocus:
		focusFold(r, at)
		r.Cycles++
		r.RoundBase = r.AccumSec // 下一轮从零开始算，别把已走过的时间算进本轮剩余
		r.Status = model.FocusPaused
		r.Events = append(r.Events, focusEvent(at, "cycle", fmt.Sprintf("第 %d 轮专注完成", r.Cycles)))
	case model.FocusPhaseShort, model.FocusPhaseLong:
		if restSec > 0 {
			r.RestSec += restSec
		}
		label := "短休息结束"
		if phase == model.FocusPhaseLong {
			label = "长休息结束"
		}
		r.Events = append(r.Events, focusEvent(at, "rest", label))
	default:
		return nil, fmt.Errorf("service: 未知的番茄阶段 %q", phase)
	}
	r.Phase = phase
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusFinish 结束这次专注。save=false 就是界面上的「放弃（不保存）」，
// 用墓碑删除而不是硬删：这条记录可能已经同步到另一台设备。
func (a *App) FocusFinish(ctx context.Context, id string, save bool) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status == model.FocusDone {
		return nil, fmt.Errorf("service: 这次专注已经结束")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	focusFold(r, at)
	r.Status = model.FocusDone
	r.EndAt = at
	r.ActualSec = r.AccumSec
	r.SegmentStart = ""
	r.Phase = ""
	if !save {
		r.DeletedAt = at
		r.UpdatedAt = at
		e, err := store.NewEntity(store.KindFocus, r)
		if err != nil {
			return nil, err
		}
		if err := a.db.Put(ctx, e); err != nil {
			return nil, err
		}
		return r, nil
	}
	r.Events = append(r.Events, focusEvent(at, "end", "结束专注"))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusCurrent 取进行中的那一次（没有则返回 nil）。只读，不动库。
func (a *App) FocusCurrent(ctx context.Context) (*model.FocusRecord, error) {
	all, err := loadAll[model.FocusRecord](a, ctx, store.KindFocus)
	if err != nil {
		return nil, err
	}
	if cur := focusUnfinished(all); cur != nil {
		return cur, nil
	}
	return nil, nil
}

// foreign 判断这条记录是不是「另一台设备开的」。
// 空 DeviceID 是升级前的老记录，按本机算——不能把用户正在跑的专注判成别人的。
func (a *App) foreign(r *model.FocusRecord) bool {
	return r != nil && r.DeviceID != "" && r.DeviceID != a.DeviceID()
}

// shortDevice 只取设备 ID 的前 8 位给人看：完整 ID 又长又没用，
// 界面上能区分「不是我这台」就够了。
func shortDevice(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	if id == "" {
		return "未知设备"
	}
	return id
}

// FocusTakeover 把另一台设备的进行中专注接过来。
//
// 为什么需要：同步是记录级的，两台设备都可能看见那条「进行中」。
// 如果界面直接自动恢复，用户会在两台机器上各跑一次，最后留下两条半截记录；
// 所以先问一句，接管 = 把归属改成这台设备并记一笔事件，放弃 = FocusFinish(save=false)。
//
// 本机自己的记录也允许接管（幂等），省得界面为两种情况写两条路。
func (a *App) FocusTakeover(ctx context.Context, id string) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status == model.FocusDone {
		return nil, fmt.Errorf("service: 这次专注已经结束了，不能接管")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	if r.DeviceID == a.DeviceID() {
		return r, nil // 已经是本机的，直接当成功
	}
	from := shortDevice(r.DeviceID)
	r.DeviceID = a.DeviceID()
	// 接管过来一律停在暂停态：原设备可能还在走表，两边同时「进行中」正是要避免的。
	if r.Status == model.FocusRunning {
		r.AccumSec += focusFold(r, at)
		r.SegmentStart = ""
		r.Status = model.FocusPaused
	}
	r.Events = append(r.Events, focusEvent(at, "takeover", "从设备 "+from+" 接管"))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusRecover 是「重启回到那一次」的规则：崩溃/被关掉期间的时间不算专注，
// 最多按一个 tick 的宽限期补，然后强制停在暂停态，让用户自己决定继续还是结束。
func (a *App) FocusRecover(ctx context.Context, id string) (*model.FocusRecord, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	if r.Status != model.FocusRunning {
		return r, nil
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	sec := focusFold(r, at)
	if sec > focusRecoverGrace {
		// focusFold 已经把整段加进去了，多出来的部分要退回来。
		r.AccumSec -= sec - focusRecoverGrace
		sec = focusRecoverGrace
	}
	r.Status = model.FocusPaused
	r.SegmentStart = ""
	r.Events = append(r.Events, focusEvent(at, "recover", "应用重启，已暂停"))
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusGet 取一条记录（详情页）。返回的是「记录 + 现取的任务名」：
// 详情页要显示关联任务的名字，而名字属于事项/习惯，不该在专注记录里存一份副本。
func (a *App) FocusGet(ctx context.Context, id string) (*FocusListItem, error) {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return nil, err
	}
	names, err := a.focusTaskNames(ctx)
	if err != nil {
		return nil, err
	}
	out := &FocusListItem{Record: *r}
	if r.ItemID != "" {
		out.TaskKind, out.TaskName = "item", names[r.ItemID]
	} else if r.HabitID != "" {
		out.TaskKind, out.TaskName = "habit", names[r.HabitID]
	}
	if out.TaskName == "" {
		out.TaskName = "未关联任务"
	}
	return out, nil
}

// FocusSave 建一条补记，或修改已有记录。
func (a *App) FocusSave(ctx context.Context, in FocusInput) (*model.FocusRecord, error) {
	itemID, habitID, err := a.focusCheckTask(ctx, in.ItemID, in.HabitID)
	if err != nil {
		return nil, err
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	if in.ID == "" {
		return a.focusCreateManual(ctx, in, itemID, habitID, at)
	}
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, in.ID)
	if err != nil {
		return nil, err
	}
	if r.Status != model.FocusDone {
		return nil, fmt.Errorf("service: 进行中的专注不能改，先结束它")
	}
	r.Note = in.Note
	r.ItemID, r.HabitID = itemID, habitID
	// 实时记录的类型/日期/时长是计时器算出来的真值，改它们等于伪造历史；
	// 只有补记（没有真实起止时刻）允许整条重写。
	if r.Source == model.FocusManual {
		if err := a.focusValidateManual(in, at, r.Day); err != nil {
			return nil, err
		}
		r.Type, r.Day, r.ActualSec, r.Cycles = in.Type, in.Day, in.ActualSec, in.Cycles
		r.Events = append(r.Events, focusEvent(at, "start", "修改补记"))
	}
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

func (a *App) focusValidateManual(in FocusInput, at model.ClockTime, fallback model.Day) error {
	day := in.Day
	if day == "" {
		day = fallback
	}
	if in.Type < model.FocusCountUp || in.Type > model.FocusCountDown {
		return fmt.Errorf("service: 未知的专注类型 %d", int(in.Type))
	}
	if in.ActualSec <= 0 || in.ActualSec > focusMaxSec {
		return fmt.Errorf("service: 专注时长要在 1 秒到 24 小时之间")
	}
	if repeat.DiffDays(a.Today(), day) > 0 {
		return fmt.Errorf("service: 补记不能写到未来")
	}
	return nil
}

func (a *App) focusCreateManual(ctx context.Context, in FocusInput, itemID, habitID string, at model.ClockTime) (*model.FocusRecord, error) {
	if in.Day == "" {
		in.Day = a.Today()
	}
	if err := a.focusValidateManual(in, at, in.Day); err != nil {
		return nil, err
	}
	r := &model.FocusRecord{
		ID: newID(), Type: in.Type, Status: model.FocusDone, Source: model.FocusManual,
		Day: in.Day, ActualSec: in.ActualSec, TargetSec: in.ActualSec, Cycles: in.Cycles,
		ItemID: itemID, HabitID: habitID, Note: in.Note,
		// 补记不伪造起止时刻：StartAt/EndAt 留空，详情页的时间轴写「补记」。
		Events:    []model.FocusEvent{focusEvent(at, "start", "补记一条专注")},
		CreatedAt: at, UpdatedAt: at,
	}
	if err := a.saveFocus(ctx, r, at); err != nil {
		return nil, err
	}
	return r, nil
}

// FocusDelete 删除一条记录（详情页底部那颗按钮）。
func (a *App) FocusDelete(ctx context.Context, id string) error {
	r, err := loadOne[model.FocusRecord](a, ctx, store.KindFocus, id)
	if err != nil {
		return err
	}
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	r.DeletedAt = at
	r.UpdatedAt = at
	e, err := store.NewEntity(store.KindFocus, r)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// FocusList 历史列表。Day 为空 = 全部；只出已结束的记录，进行中的那条走 FocusCurrent。
func (a *App) FocusList(ctx context.Context, day model.Day, limit int) ([]FocusListItem, error) {
	all, err := loadAll[model.FocusRecord](a, ctx, store.KindFocus)
	if err != nil {
		return nil, err
	}
	names, err := a.focusTaskNames(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]FocusListItem, 0, len(all))
	for _, r := range all {
		if r.Status != model.FocusDone {
			continue
		}
		if day != "" && r.Day != day {
			continue
		}
		item := FocusListItem{Record: r}
		if r.ItemID != "" {
			item.TaskKind, item.TaskName = "item", names[r.ItemID]
		} else if r.HabitID != "" {
			item.TaskKind, item.TaskName = "habit", names[r.HabitID]
		}
		if item.TaskName == "" {
			item.TaskName = "未关联任务"
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].Record, out[j].Record
		if a.Day != b.Day {
			return a.Day > b.Day
		}
		if a.StartAt != b.StartAt {
			return a.StartAt > b.StartAt
		}
		return a.CreatedAt > b.CreatedAt
	})
	if limit <= 0 || limit > focusListMax {
		limit = focusListMax
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// focusTaskNames 一次把事项名与习惯名取全，列表与排行都用它，避免 N+1。
func (a *App) focusTaskNames(ctx context.Context) (map[string]string, error) {
	names := map[string]string{}
	items, err := loadAll[model.ListItem](a, ctx, store.KindItem)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		names[it.ID] = it.Title
	}
	habits, err := loadAll[model.Habit](a, ctx, store.KindHabit)
	if err != nil {
		return nil, err
	}
	for _, h := range habits {
		names[h.ID] = h.Name
	}
	return names, nil
}

// FocusStat 区间聚合。总览是全历史的，其余三块（趋势/类型/任务/时段矩阵）按区间。
func (a *App) FocusStat(ctx context.Context, req FocusStatRequest) (FocusStat, error) {
	if req.Start == "" || req.End == "" {
		return FocusStat{}, fmt.Errorf("service: 统计区间不能为空")
	}
	span := repeat.DiffDays(req.Start, req.End)
	if span < 0 {
		return FocusStat{}, fmt.Errorf("service: 统计区间反了")
	}
	if span > focusStatMaxSpan {
		return FocusStat{}, fmt.Errorf("service: 统计区间过长（最多一年）")
	}
	all, err := loadAll[model.FocusRecord](a, ctx, store.KindFocus)
	if err != nil {
		return FocusStat{}, err
	}
	names, err := a.focusTaskNames(ctx)
	if err != nil {
		return FocusStat{}, err
	}
	today := a.Today()
	st := FocusStat{Start: req.Start, End: req.End, Today: today}

	// 时段矩阵先铺满 168 个零格，前端直接按 weekday/hour 取，不用自己补洞。
	idx := map[int]int{}
	for w := 1; w <= 7; w++ {
		for h := 0; h < 24; h++ {
			idx[w*100+h] = len(st.Matrix)
			st.Matrix = append(st.Matrix, FocusCell{Weekday: w, Hour: h})
		}
	}

	dailyIdx := map[model.Day]int{}
	for i, d := range allDays(req.Start, req.End) {
		dailyIdx[d] = i
		st.Daily = append(st.Daily, FocusDaily{Day: d})
	}
	typeSplit := map[model.FocusType]*FocusTypeSplit{}
	taskSplit := map[string]*FocusTaskSplit{}

	for _, r := range all {
		if r.Status != model.FocusDone {
			continue
		}
		st.Overview.TotalSec += r.ActualSec
		st.Overview.TotalCount++
		if r.Day == today {
			st.Overview.TodaySec += r.ActualSec
			st.Overview.TodayCount++
		}
		if repeat.DiffDays(req.Start, r.Day) < 0 || repeat.DiffDays(r.Day, req.End) < 0 {
			continue // 区间外
		}
		if d, ok := dailyIdx[r.Day]; ok {
			st.Daily[d].Sec += r.ActualSec
			st.Daily[d].Count++
		}
		if p, ok := typeSplit[r.Type]; !ok {
			typeSplit[r.Type] = &FocusTypeSplit{Type: r.Type, Sec: r.ActualSec, Count: 1}
		} else {
			p.Sec += r.ActualSec
			p.Count++
		}
		key := r.ItemID
		if key == "" {
			key = r.HabitID
		}
		if p, ok := taskSplit[key]; !ok {
			taskSplit[key] = &FocusTaskSplit{ItemID: key, Name: names[key], Sec: r.ActualSec, Count: 1}
		} else {
			p.Sec += r.ActualSec
			p.Count++
		}
		// 时段矩阵要有真实时刻才放得下；补记没有时刻，单独累计一个数交代掉。
		if r.StartAt == "" {
			st.UnplacedSec += r.ActualSec
			st.UnplacedCount++
			continue
		}
		if t, ok := tclock.Parse(r.StartAt); ok {
			lt := t.In(a.loc)
			wd := int((lt.Weekday()+6)%7) + 1
			if at, ok := idx[wd*100+lt.Hour()]; ok {
				st.Matrix[at].Sec += r.ActualSec
				st.Matrix[at].Count++
			}
		}
	}
	if d, ok := taskSplit[""]; ok {
		d.Name = "未关联任务"
	}
	for _, p := range typeSplit {
		st.ByType = append(st.ByType, *p)
	}
	sort.Slice(st.ByType, func(i, j int) bool { return st.ByType[i].Type < st.ByType[j].Type })
	for _, p := range taskSplit {
		st.ByTask = append(st.ByTask, *p)
	}
	sort.SliceStable(st.ByTask, func(i, j int) bool {
		if st.ByTask[i].Sec != st.ByTask[j].Sec {
			return st.ByTask[i].Sec > st.ByTask[j].Sec
		}
		return st.ByTask[i].Count > st.ByTask[j].Count
	})
	if len(st.ByTask) > focusTaskTopN {
		st.ByTask = st.ByTask[:focusTaskTopN]
	}
	return st, nil
}

// FocusCandidates 是「关联任务」弹窗的候选：默认全部待办事项，也可以只看某一天；
// 第二页签给习惯。事项直接复用 ListView（它已经把重复序列折成逾期/今天/往后三桶），
// 不再另写一套「待办」判定，免得两处对「什么算没做完」理解不一致。
func (a *App) FocusCandidates(ctx context.Context, req FocusCandidateRequest) ([]FocusCandidate, error) {
	tab := req.Tab
	if tab == "" {
		tab = "item"
	}
	out := make([]FocusCandidate, 0, 32)
	// 「全部待办」与「某一天」是两回事：没传日期 = 全部（逾期 + 今天 + 往后都要在），
	// 传了日期 = 严格只看那一天，逾期项不该混进来（用户选的是「那天的任务」）。
	explicit := req.Day != ""
	day := req.Day
	if !explicit {
		day = a.Today()
	}
	switch tab {
	case "item":
		lv, err := a.ListView(ctx, ListViewRequest{Day: day, GroupBy: groupByDate, ShowDone: false})
		if err != nil {
			return nil, err
		}
		lists, err := loadAll[model.List](a, ctx, store.KindList)
		if err != nil {
			return nil, err
		}
		listName := map[string]string{}
		for _, l := range lists {
			listName[l.ID] = l.Name
		}
		for _, g := range lv.Groups {
			if g.Key == "done" {
				continue
			}
			for _, o := range g.Items {
				if o.Status.Resolved() {
					continue
				}
				if explicit && o.Day != day {
					continue
				}
				out = append(out, FocusCandidate{
					Kind: "item", ID: o.Item.ID, Name: o.Item.Title, Day: o.Day,
					TimeText: focusTimeText(o.Item.Time), Group: listName[o.Item.ListID],
				})
			}
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Day != out[j].Day {
				return out[i].Day < out[j].Day
			}
			return out[i].TimeText < out[j].TimeText
		})
	case "habit":
		habits, err := loadAll[model.Habit](a, ctx, store.KindHabit)
		if err != nil {
			return nil, err
		}
		clocks, err := a.clocksByHabit(ctx)
		if err != nil {
			return nil, err
		}
		for i := range habits {
			h := &habits[i]
			due := len(a.scheduledDays(h, day, day)) > 0
			amount := clocks[h.ID][day]
			out = append(out, FocusCandidate{
				Kind: "habit", ID: h.ID, Name: h.Name, Day: day, Icon: h.Icon,
				TimeText: focusHabitDueText(*h, due), Group: h.Context,
				Clocked: amount > 0,
			})
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Clocked != out[j].Clocked {
				return !out[i].Clocked // 没打的排前面，正是要专注的那批
			}
			return out[i].Name < out[j].Name
		})
	default:
		return nil, fmt.Errorf("service: 未知的候选类型 %q", tab)
	}
	return out, nil
}

func focusTimeText(t model.TimeSpec) string {
	switch t.Kind {
	case model.TimePoint, model.TimeRange:
		if t.End != "" && t.End != t.Start {
			return t.Start + "-" + t.End
		}
		return t.Start
	default:
		return "全天"
	}
}

func focusHabitDueText(h model.Habit, due bool) string {
	if due {
		return "今天该打"
	}
	return "休息日"
}
