package service

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
)

// Occurrence 是一条事项在某一天的渲染单元：本体 + 当天状态 + 子任务进度。
type Occurrence struct {
	Item          model.ListItem   `json:"item"`
	Day           model.Day        `json:"day"`
	Status        model.ItemStatus `json:"status"`
	ClockedAt     model.ClockTime  `json:"clockedAt,omitempty"`
	PostponedFrom model.Day        `json:"postponedFrom,omitempty"`
	OverrideID    string           `json:"overrideId,omitempty"`
	ChildTotal    int              `json:"childTotal"`
	ChildDone     int              `json:"childDone"`
	OverdueDays   int              `json:"overdueDays"`
}

// GroupView 是一个分组桶。Key 对前端是稳定标识，Label 是展示名。
type GroupView struct {
	Key   string       `json:"key"`
	Label string       `json:"label"`
	Count int          `json:"count"`
	Items []Occurrence `json:"items"`
}

// ListView 一次拉全，前端不再为翻页补请求：个人清单的量级下这是最省事的契约。
type ListView struct {
	Day        model.Day   `json:"day"`
	GroupBy    string      `json:"groupBy"`
	Groups     []GroupView `json:"groups"`
	OverdueAll int         `json:"overdueAll"`
}

// ListViewRequest 全部字段可空；空值走括号里的默认。
type ListViewRequest struct {
	Day          model.Day `json:"day,omitempty"`          // 空 = 今天
	GroupBy      string    `json:"groupBy,omitempty"`      // date(默认) | category | quadrants
	ListID       string    `json:"listId,omitempty"`       // 限定清单本
	CategoryID   string    `json:"categoryId,omitempty"`   // 限定分类
	LabelID      string    `json:"labelId,omitempty"`      // 限定标签
	ShowDone     bool      `json:"showDone"`               // 是否显示已打卡，对应设置项
	LookbackDays int       `json:"lookbackDays,omitempty"` // 逾期回溯，默认 180
	HorizonDays  int       `json:"horizonDays,omitempty"`  // 往后预排，默认 60
}

const (
	groupByDate      = "date"
	groupByCategory  = "category"
	groupByQuadrants = "quadrants"

	defaultLookback = 180
	defaultHorizon  = 60
)

var bucketLabels = []struct{ key, label string }{
	{"overdue", "逾期"},
	{"today", "未打卡"},
	{"later", "待办"},
	{"done", "已打卡"},
}

var quadrantLabels = map[model.Priority]string{
	model.QuadrantImportantUrgent: "重要且紧急",
	model.QuadrantImportant:       "重要不紧急",
	model.QuadrantUrgent:          "不重要但紧急",
	model.QuadrantNone:            "不重要不紧急",
}

// ListView 展开重复序列、叠加单日例外，再按请求分组。
func (a *App) ListView(ctx context.Context, req ListViewRequest) (ListView, error) {
	today := req.Day
	if today == "" {
		today = a.Today()
	}
	lookback, horizon := req.LookbackDays, req.HorizonDays
	if lookback <= 0 {
		lookback = defaultLookback
	}
	if horizon <= 0 {
		horizon = defaultHorizon
	}
	groupBy := req.GroupBy
	if groupBy == "" {
		groupBy = groupByDate
	}

	from := repeat.AddDays(today, -lookback)
	to := repeat.AddDays(today, horizon)

	items, err := a.listItems(ctx)
	if err != nil {
		return ListView{}, err
	}
	childStats, err := a.childStats(ctx)
	if err != nil {
		return ListView{}, err
	}

	kept := make([]*model.ListItem, 0, len(items))
	ids := map[string]bool{}
	for _, it := range items {
		if req.ListID != "" && it.ListID != req.ListID {
			continue
		}
		if req.CategoryID != "" && it.Category != req.CategoryID {
			continue
		}
		if req.LabelID != "" && !containsStr(it.LabelIDs, req.LabelID) {
			continue
		}
		kept = append(kept, it)
		ids[it.ID] = true
	}

	overrides, err := a.overridesFor(ctx, ids, from, repeat.AddDays(to, 1))
	if err != nil {
		return ListView{}, err
	}

	pending := []Occurrence{} // 未打卡（逾期 + 今日 + 未来 + 无日期）
	done := []Occurrence{}
	for _, it := range kept {
		if it.Date.Start == "" && len(it.Date.Selected) == 0 {
			// 无日期事项恒在「待办」，不参与重复展开。
			pending = append(pending, a.occurrenceOf(ctx, it, "", model.StatusPending, "", "", childStats))
			continue
		}
		ocs := repeat.Materialize(it, from, to, overrides[it.ID], a.calendar)
		for _, o := range ocs {
			occ := a.occurrenceOf(ctx, it, o.Day, o.Status, o.ClockedAt, o.PostponedFrom, childStats)
			occ.OverrideID = model.OverrideID(it.ID, o.Day)
			if o.Status.Resolved() {
				done = append(done, occ)
			} else {
				pending = append(pending, occ)
			}
		}
	}

	view := ListView{Day: today, GroupBy: groupBy}
	switch groupBy {
	case groupByDate:
		byBucket := map[string][]Occurrence{}
		for _, o := range pending {
			switch {
			case o.Day == "":
				byBucket["later"] = append(byBucket["later"], o)
			case repeat.DiffDays(o.Day, today) > 0:
				byBucket["overdue"] = append(byBucket["overdue"], o)
			case o.Day == today:
				byBucket["today"] = append(byBucket["today"], o)
			default:
				byBucket["later"] = append(byBucket["later"], o)
			}
		}
		// 每个桶里同一条事项只留一次，保留最早的那天：
		// 周重复事项否则会在「待办」里刷出一屏未来的自己。
		for _, b := range bucketLabels {
			if b.key == "done" && !req.ShowDone {
				continue
			}
			xs := collapseByItem(byBucket[b.key], today)
			if b.key == "done" {
				xs = collapseByItem(done, today)
			}
			sortOccurrences(xs)
			view.Groups = append(view.Groups, GroupView{Key: b.key, Label: b.label, Count: len(xs), Items: xs})
		}
		view.OverdueAll = len(collapseByItem(byBucket["overdue"], today))

	case groupByCategory:
		cats, err := a.Categories(ctx)
		if err != nil {
			return ListView{}, err
		}
		names := map[string]string{}
		order := map[string]int{}
		for i, c := range cats {
			names[c.ID] = c.Name
			order[c.ID] = i
		}
		groups := visibleGroups(pending, done, today, req.ShowDone)
		byCat := map[string][]Occurrence{}
		for _, o := range groups {
			byCat[o.Item.Category] = append(byCat[o.Item.Category], o)
		}
		keys := make([]string, 0, len(byCat))
		for k := range byCat {
			keys = append(keys, k)
		}
		sortKeysByOrder(keys, order)
		for _, k := range keys {
			label := names[k]
			key := k
			if k == "" || label == "" {
				label = "未分类"
				key = "uncategorized" // 空 Key 会让 React 与折叠状态用同一个标识，必须给稳定值
			}
			xs := byCat[k]
			sortOccurrences(xs)
			view.Groups = append(view.Groups, GroupView{Key: key, Label: label, Count: len(xs), Items: xs})
		}

	case groupByQuadrants:
		groups := visibleGroups(pending, done, today, req.ShowDone)
		byQ := map[model.Priority][]Occurrence{}
		for _, o := range groups {
			p := o.Item.Priority
			if p == 0 {
				p = model.QuadrantNone
			}
			byQ[p] = append(byQ[p], o)
		}
		for _, p := range []model.Priority{
			model.QuadrantImportantUrgent, model.QuadrantImportant,
			model.QuadrantUrgent, model.QuadrantNone,
		} {
			xs := byQ[p]
			sortOccurrences(xs)
			view.Groups = append(view.Groups, GroupView{
				Key: fmt.Sprintf("q%d", p), Label: quadrantLabels[p], Count: len(xs), Items: xs,
			})
		}

	default:
		return ListView{}, fmt.Errorf("service: 未知分组方式 %q", groupBy)
	}

	// 跨边界前统一收口：nil 切片序列化出来是 null，前端 `g.items.length` 会当场崩。
	// 日期分支侥幸没事（collapseByItem 返回空切片），四象限的空象限就是 nil，直接白屏。
	if view.Groups == nil {
		view.Groups = []GroupView{}
	}
	for i := range view.Groups {
		if view.Groups[i].Items == nil {
			view.Groups[i].Items = []Occurrence{}
		}
	}
	return view, nil
}

// normalizeItem 把 nil 切片换成空切片。
//
// Go 的 nil 切片序列化成 JSON 是 null，前端拿到就 `.map` 报错、整屏白页；
// 跨界线的地方太多，与其让每个调用方各自防守，不如在读写两个咽喉点统一。
func normalizeItem(it *model.ListItem) {
	if it.LabelIDs == nil {
		it.LabelIDs = []string{}
	}
	if it.Reminders == nil {
		it.Reminders = []model.Reminder{}
	}
}

func (a *App) occurrenceOf(ctx context.Context, it *model.ListItem, day model.Day,
	status model.ItemStatus, clockedAt, postponedFrom model.Day, childStats map[string]childCount) Occurrence {
	normalizeItem(it)
	o := Occurrence{
		Item: *it, Day: day, Status: status, PostponedFrom: postponedFrom,
	}
	if clockedAt != "" {
		o.ClockedAt = clockedAt
	}
	if c, ok := childStats[it.ID]; ok {
		o.ChildTotal, o.ChildDone = c.total, c.done
	}
	if day != "" && !status.Resolved() {
		if d := repeat.DiffDays(day, a.Today()); d > 0 {
			o.OverdueDays = d
		}
	}
	return o
}

type childCount struct{ total, done int }

func (a *App) childStats(ctx context.Context) (map[string]childCount, error) {
	rows, err := a.db.Rows(ctx, store.KindChild, false)
	if err != nil {
		return nil, err
	}
	out := map[string]childCount{}
	for _, r := range rows {
		var c model.Child
		if err := r.Decode(&c); err != nil {
			return nil, err
		}
		cc := out[c.ItemID]
		cc.total++
		if c.Done {
			cc.done++
		}
		out[c.ItemID] = cc
	}
	return out, nil
}

// visibleGroups 给「非日期视图」（分类、四象限）决定该展示哪些实例。
//
// 参考站的象限卡里是「已打卡 12 / 未打卡 5」并列两个子组，所以待办与已打卡必须分开返回：
// 只给 pending 的话象限里永远出不来已打卡子组；把两者混在一起折叠成一行又会丢掉状态。
func visibleGroups(pending, done []Occurrence, today model.Day, showDone bool) []Occurrence {
	out := collapseByItem(pending, today)
	if showDone {
		out = append(out, collapseByItem(done, today)...)
	}
	return out
}

// collapseByItem 让同一条事项在一个分组里只出现一次，保留最早的一天。
func collapseByItem(xs []Occurrence, today model.Day) []Occurrence {
	best := map[string]Occurrence{}
	order := []string{}
	for _, o := range xs {
		cur, ok := best[o.Item.ID]
		if !ok {
			best[o.Item.ID] = o
			order = append(order, o.Item.ID)
			continue
		}
		if o.Day != "" && (cur.Day == "" || o.Day < cur.Day) {
			o.OverdueDays = cur.OverdueDays
			best[o.Item.ID] = o
		}
	}
	out := make([]Occurrence, 0, len(best))
	for _, k := range order {
		o := best[k]
		if o.Day != "" && !o.Status.Resolved() && repeat.DiffDays(o.Day, today) > 0 {
			o.OverdueDays = repeat.DiffDays(o.Day, today)
		}
		out = append(out, o)
	}
	return out
}

func sortKeysByOrder(keys []string, order map[string]int) {
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0; j-- {
			a, b := keys[j-1], keys[j]
			oa, ob := order[a], order[b]
			if a == "" {
				oa = 1 << 30 // 未分类永远排最后
			}
			if b == "" {
				ob = 1 << 30
			}
			if oa > ob || (oa == ob && a > b) {
				keys[j-1], keys[j] = b, a
			} else {
				break
			}
		}
	}
}

// ItemInput 是新建与编辑共用的入参。ID 为空表示新建。
type ItemInput struct {
	ID        string           `json:"id,omitempty"`
	ListID    string           `json:"listId,omitempty"`
	Title     string           `json:"title"`
	Remark    string           `json:"remark"`
	Category  string           `json:"category"`
	Priority  model.Priority   `json:"priority"`
	LabelIDs  []string         `json:"labelIds"`
	Date      model.DateSpec   `json:"date"`
	Time      model.TimeSpec   `json:"time"`
	Repeat    *model.Repeat    `json:"repeat,omitempty"`
	Reminders []model.Reminder `json:"reminders"`
	// Progress 用指针：0% 是用户显式设定的值，不能和「没设过进度」混成一回事。
	Progress *int `json:"progress,omitempty"`
}

// Scope 是修改/删除一条重复事项时的作用范围，对应朝暮的三选一。
type Scope string

const (
	ScopeAll     Scope = "all"
	ScopeThisDay Scope = "thisDay"
	ScopeOnward  Scope = "thisAndFuture"
)

// SaveItem 写入一条事项。scope 只在编辑重复事项时生效：
//
//   - all：直接改本体，历史与未来的实例一起变。
//   - thisAndFuture：把本体截断到 day 的前一天，再以 day 为锚点新建一条带同样重复规则的事项。
//   - thisDay：本体截断到 day 的前一天，day 当天建成一条不重复的事项，
//     day 之后再用原内容重启一条同样规则的事项——序列不断档，改动只影响一天。
func (a *App) SaveItem(ctx context.Context, in ItemInput, scope Scope, day model.Day) ([]*model.ListItem, error) {
	if strings.TrimSpace(in.Title) == "" {
		return nil, fmt.Errorf("service: 标题不能为空")
	}
	if len(in.LabelIDs) > model.MaxLabelsPerItem {
		return nil, fmt.Errorf("service: 单条事项最多 %d 个标签", model.MaxLabelsPerItem)
	}
	if err := validateDateSpec(in.Date); err != nil {
		return nil, err
	}
	if in.Priority == 0 {
		in.Priority = model.QuadrantNone
	}
	if in.ListID == "" {
		in.ListID = model.DefaultListID
	}

	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}

	if in.ID == "" {
		item := &model.ListItem{
			ID: newID(), ListID: in.ListID, Title: strings.TrimSpace(in.Title), Remark: in.Remark,
			Category: in.Category, Priority: in.Priority, LabelIDs: in.LabelIDs,
			Date: in.Date, Time: in.Time, Repeat: in.Repeat,
			Reminders: normalizeReminders(in.Reminders), Progress: progressOr(in.Progress, -1),
			CreatedAt: at,
		}
		if err := a.saveItem(ctx, item, at); err != nil {
			return nil, err
		}
		return []*model.ListItem{item}, nil
	}

	existing, err := a.getItem(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if day == "" {
		day = a.Today()
	}
	recurring := existing.Repeat != nil

	if !recurring || scope == ScopeAll || scope == "" {
		existing.Title = strings.TrimSpace(in.Title)
		existing.Remark = in.Remark
		existing.Category = in.Category
		existing.Priority = in.Priority
		existing.LabelIDs = in.LabelIDs
		existing.Time = in.Time
		existing.Reminders = normalizeReminders(in.Reminders)
		existing.Progress = progressOr(in.Progress, existing.Progress)
		if !recurring {
			existing.ListID = in.ListID
		}
		// 「全部清单」= 按新值重写整条序列，重复规则本身也在重写范围内。
		// 这两行原来被 `if !recurring` 一起挡住了，后果是：给重复事项选「仅一次」清不掉规则，
		// 界面上「结束」行会一直赖着不走（2026-11-07 弹窗自检抓到）。
		existing.Date = in.Date
		existing.Repeat = in.Repeat
		if err := a.saveItem(ctx, existing, at); err != nil {
			return nil, err
		}
		return []*model.ListItem{existing}, nil
	}

	// 重复事项改局部：原序列截断到 day 之前，之后按 scope 重建。
	if scope == ScopeOnward && onwardIsNoop(existing, in, day) {
		// 「当日及未来」但什么都没改（重复面板把当前已选中的规则又点了一次，就是这么来的）：
		// 不拦住就会截断旧序列 + 新建一条同名事项，用户点几次就多几条。
		return []*model.ListItem{existing}, nil
	}
	truncated := *existing
	truncated.Repeat = truncateThrough(existing.Repeat, repeat.AddDays(day, -1))
	if err := a.saveItem(ctx, &truncated, at); err != nil {
		return nil, err
	}

	edited := *existing
	edited.ID = newID()
	edited.Title = strings.TrimSpace(in.Title)
	edited.Remark = in.Remark
	edited.Category = in.Category
	edited.Priority = in.Priority
	edited.LabelIDs = in.LabelIDs
	edited.Time = in.Time
	edited.Reminders = normalizeReminders(in.Reminders)
	edited.Progress = progressOr(in.Progress, existing.Progress)
	edited.CreatedAt = at
	edited.Date = shiftAnchor(existing.Date, day)

	created := []*model.ListItem{&truncated, &edited}
	switch scope {
	case ScopeOnward:
		// 「当日及未来」把编辑后的规则接在 day 上，包括改掉重复规则本身。
		edited.Repeat = restartFrom(in.Repeat, day)
	case ScopeThisDay:
		// 「仅当天」只改这一天的内容：这天不重复，未来段仍按原规则续上，规则改动在此被忽略。
		edited.Repeat = nil
		edited.Date = model.DateSpec{Kind: model.DateSingle, Start: day}
		if rest := restartFrom(existing.Repeat, repeat.AddDays(day, 1)); rest != nil {
			// day 之后的序列用原内容续上，避免改一天把后面整条抹掉。
			forward := *existing
			forward.ID = newID()
			forward.Date = shiftAnchor(existing.Date, repeat.AddDays(day, 1))
			forward.Repeat = rest
			forward.CreatedAt = at
			if err := a.saveItem(ctx, &forward, at); err != nil {
				return nil, err
			}
			created = append(created, &forward)
		}
	default:
		return nil, fmt.Errorf("service: 未知作用范围 %q", scope)
	}
	if err := a.saveItem(ctx, &edited, at); err != nil {
		return nil, err
	}
	return created, nil
}

func (a *App) DeleteItem(ctx context.Context, itemID string, scope Scope, day model.Day) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	it, err := a.getItem(ctx, itemID)
	if err != nil {
		return err
	}
	if day == "" {
		day = a.Today()
	}
	switch {
	case it.Repeat == nil || scope == ScopeAll || scope == "":
		if err := a.db.SoftDelete(ctx, store.KindItem, itemID, at); err != nil {
			return err
		}
		children, err := a.db.ByParent(ctx, store.KindChild, itemID)
		if err != nil {
			return err
		}
		for _, c := range children {
			if err := a.db.SoftDelete(ctx, store.KindChild, c.ID, at); err != nil {
				return err
			}
		}
		return nil

	case scope == ScopeThisDay:
		// 截断到昨天 + 从明天续上，等于只删掉这一天。
		truncated := *it
		truncated.Repeat = truncateThrough(it.Repeat, repeat.AddDays(day, -1))
		if err := a.saveItem(ctx, &truncated, at); err != nil {
			return err
		}
		forward := *it
		forward.ID = newID()
		forward.Date = shiftAnchor(it.Date, repeat.AddDays(day, 1))
		forward.Repeat = restartFrom(it.Repeat, repeat.AddDays(day, 1))
		forward.CreatedAt = at
		return a.saveItem(ctx, &forward, at)

	case scope == ScopeOnward:
		truncated := *it
		truncated.Repeat = truncateThrough(it.Repeat, repeat.AddDays(day, -1))
		return a.saveItem(ctx, &truncated, at)

	default:
		return fmt.Errorf("service: 未知作用范围 %q", scope)
	}
}

// truncateThrough 把重复序列改成在 lastDay 结束。无结束条件的序列用按日期结束。
func truncateThrough(r *model.Repeat, lastDay model.Day) *model.Repeat {
	if r == nil {
		return nil
	}
	out := *r
	out.End = model.EndSpec{Mode: model.EndByDate, Date: lastDay}
	return &out
}

// restartFrom 生成一条以 newAnchor 起算的同规则重复；原规则已按日期结束且结束日在 newAnchor
// 之前时返回 nil，表示后面不再有实例。次数条件保留原值，续上的段不再重新计数。
func restartFrom(r *model.Repeat, newAnchor model.Day) *model.Repeat {
	if r == nil {
		return nil
	}
	if r.End.Mode == model.EndByDate && r.End.Date != "" && repeat.DiffDays(newAnchor, r.End.Date) < 0 {
		return nil
	}
	out := *r
	return &out
}

// onwardIsNoop 判断「当日及未来」这次编辑实际上什么都没改。
//
// 判定要覆盖重启后真正会落库的每个字段：内容、日期锚点、以及 restartFrom 之后的重复规则。
// 只要有一项不同就必须走截断+新建，那是正常的分段语义；全同才跳过写入。
func onwardIsNoop(existing *model.ListItem, in ItemInput, day model.Day) bool {
	if existing.Title != strings.TrimSpace(in.Title) ||
		existing.Remark != in.Remark ||
		existing.Category != in.Category ||
		existing.Priority != in.Priority ||
		existing.Time != in.Time ||
		existing.ListID != in.ListID ||
		!sameStrings(existing.LabelIDs, in.LabelIDs) ||
		!sameReminders(existing.Reminders, normalizeReminders(in.Reminders)) ||
		existing.Date.Kind != in.Date.Kind ||
		existing.Date.Start != day ||
		!sameDaySlice(existing.Date.Selected, in.Date.Selected) {
		return false
	}
	return sameRepeat(existing.Repeat, restartFrom(in.Repeat, day))
}

// sameRepeat 比较两条规则是否等价。nil 与 nil 相等；字段顺序无关的切片要先排序再比。
func sameRepeat(a, b *model.Repeat) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Unit == b.Unit && a.Interval == b.Interval &&
		sameInts(a.Weekdays, b.Weekdays) && sameInts(a.MonthDays, b.MonthDays) &&
		a.YearMonth == b.YearMonth && a.YearDay == b.YearDay &&
		a.SkipLegalHolidays == b.SkipLegalHolidays && a.FollowMakeupWorkday == b.FollowMakeupWorkday &&
		a.SmartSpan == b.SmartSpan && a.Ebbinghaus == b.Ebbinghaus &&
		a.End.Mode == b.End.Mode && a.End.Date == b.End.Date && a.End.Count == b.End.Count
}

func sameReminders(a, b []model.Reminder) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Offset != b[i].Offset || a[i].AtDay != b[i].AtDay || a[i].AtTime != b[i].AtTime {
			return false
		}
	}
	return true
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := append([]int(nil), a...), append([]int(nil), b...)
	sort.Ints(x)
	sort.Ints(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := append([]string(nil), a...), append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func sameDaySlice(a, b []model.Day) bool { return sameStrings(a, b) }

// shiftAnchor 把日期基准挪到 day：单日改起点，跨天保持跨度长度，自选多日只留 day 当天。
func shiftAnchor(spec model.DateSpec, day model.Day) model.DateSpec {
	switch spec.Kind {
	case model.DateSpan:
		length := repeat.DiffDays(spec.Start, spec.End)
		if length < 0 {
			length = 0
		}
		return model.DateSpec{Kind: model.DateSpan, Start: day, End: repeat.AddDays(day, length)}
	case model.DateSelected:
		return model.DateSpec{Kind: model.DateSingle, Start: day}
	default:
		return model.DateSpec{Kind: model.DateSingle, Start: day}
	}
}

func validateDateSpec(d model.DateSpec) error {
	if d.Start != "" {
		if _, ok := repeat.ParseDay(d.Start); !ok {
			return fmt.Errorf("service: 起始日期 %q 不是 YYYY-MM-DD", d.Start)
		}
	}
	if d.Kind == model.DateSpan && d.End != "" {
		if _, ok := repeat.ParseDay(d.End); !ok {
			return fmt.Errorf("service: 结束日期 %q 不是 YYYY-MM-DD", d.End)
		}
		if repeat.DiffDays(d.End, d.Start) > 0 {
			return fmt.Errorf("service: 结束日期 %q 早于开始日期 %q", d.End, d.Start)
		}
	}
	if d.Kind == model.DateSelected && len(d.Selected) == 0 && d.Start == "" {
		return fmt.Errorf("service: 自选多日至少选一天")
	}
	return nil
}

// progressOr 取显式设定的进度；没给就保留原值或默认值。
func progressOr(p *int, fallback int) int {
	if p == nil {
		return fallback
	}
	return *p
}

func normalizeReminders(rs []model.Reminder) []model.Reminder {
	out := make([]model.Reminder, 0, len(rs))
	for _, r := range rs {
		if r.ID == "" {
			r.ID = newID()
		}
		out = append(out, r)
	}
	return out
}

// assertOccursOn 确认事项在那天真的有实例。
//
// 不校验的话会写下永远渲染不出来的例外记录：无日期事项被「打卡」、周重复事项打在
// 不命中的日子，这些孤儿 override 还会随同步扩散到每台设备，越积越多又没人能看见。
// 已经存在的 override（例如顺延来的那一天）算合法。
func (a *App) assertOccursOn(ctx context.Context, itemID string, day model.Day) error {
	if day == "" {
		return fmt.Errorf("service: 打卡需要指定哪一天")
	}
	it, err := a.getItem(ctx, itemID)
	if err != nil {
		return err
	}
	if len(repeat.Occurrences(it, day, day, a.calendar)) > 0 {
		return nil
	}
	row, found, err := a.db.Get(ctx, store.KindOverride, model.OverrideID(itemID, day))
	if err != nil {
		return err
	}
	if found && row.Alive() {
		return nil
	}
	return fmt.Errorf("service: 事项 %s 在 %s 没有实例（重复规则未命中，或事项没有日期）", itemID, day)
}

// SetItemClock 打卡或取消打卡某条事项在某一天的实例。
func (a *App) SetItemClock(ctx context.Context, itemID string, day model.Day, on bool) error {
	status := model.StatusPending
	if on {
		status = model.StatusClocked
	}
	return a.SetItemClockState(ctx, itemID, day, status)
}

// SetItemClockState 写入打卡三态：未打卡 / 成功打卡 / 失败打卡。
//
// 参考站的勾选框左键是「打卡」，右键菜单里是「成功打卡 / 失败打卡 / 取消打卡」，
// 所以失败是一等状态，不能靠「不打卡 + 备注」来表达。
//
// 取消时若这天是顺延来的，只把状态改回未打卡、保留挪动痕迹；
// 否则整条例外删除，让「取消打卡」能传播到其它设备。
func (a *App) SetItemClockState(ctx context.Context, itemID string, day model.Day, status model.ItemStatus) error {
	if status != model.StatusPending && status != model.StatusClocked && status != model.StatusFailed {
		return fmt.Errorf("打卡状态只接受未打卡/成功/失败，收到 %d", status)
	}
	if day == "" {
		day = a.Today()
	}
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	if err := a.assertOccursOn(ctx, itemID, day); err != nil {
		return err
	}
	ovID := model.OverrideID(itemID, day)
	row, found, err := a.db.Get(ctx, store.KindOverride, ovID)
	if err != nil {
		return err
	}
	var existing model.OccurrenceOverride
	if found && row.Alive() {
		if err := row.Decode(&existing); err != nil {
			return err
		}
	} else {
		existing = model.OccurrenceOverride{ID: ovID, ItemID: itemID, Day: day, CreatedAt: at}
	}

	if status == model.StatusPending {
		if !found {
			return nil
		}
		if existing.PostponedFrom != "" {
			existing.Status = model.StatusPending
			existing.ClockedAt = ""
			existing.UpdatedAt = at
			e, err := store.NewEntity(store.KindOverride, &existing)
			if err != nil {
				return err
			}
			return a.db.Put(ctx, e)
		}
		return a.db.SoftDelete(ctx, store.KindOverride, ovID, at)
	}

	existing.Status = status
	existing.ClockedAt = at
	existing.UpdatedAt = at
	e, err := store.NewEntity(store.KindOverride, &existing)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// SetItemTop 置顶/取消置顶。只动 IsTop：排序里置顶项排前面，
// 取消后回到「时间 → 优先级 → 创建时间」的稳定顺序，不需要记原位置。
func (a *App) SetItemTop(ctx context.Context, itemID string, top bool) error {
	it, err := a.getItem(ctx, itemID)
	if err != nil {
		return err
	}
	if it.IsTop == top {
		return nil // 重复点同一个状态不该把事项推到列表末尾
	}
	it.IsTop = top
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.saveItem(ctx, it, at)
}

// Postpone 把 day 上的实例顺延到 target（默认今天）。批量顺延传多个 ID 即可。
//
// 逾期项在界面上的「顺延到今天」就是 Postpone(ctx, ids, 逾期日, 今天)。
func (a *App) Postpone(ctx context.Context, itemIDs []string, day, target model.Day) (int, error) {
	if target == "" {
		target = a.Today()
	}
	if day == "" {
		day = target
	}
	if day == target {
		return 0, nil
	}
	done := 0
	for _, itemID := range itemIDs {
		// 源日必须是真实例：顺延一个不存在的日子会写出孤儿 override。
		if err := a.assertOccursOn(ctx, itemID, day); err != nil {
			return done, err
		}
		at, err := a.now(ctx)
		if err != nil {
			return done, err
		}
		ovID := model.OverrideID(itemID, target)
		row, found, err := a.db.Get(ctx, store.KindOverride, ovID)
		if err != nil {
			return done, err
		}
		ov := model.OccurrenceOverride{ID: ovID, ItemID: itemID, Day: target, CreatedAt: at}
		if found && row.Alive() {
			if err := row.Decode(&ov); err != nil {
				return done, err
			}
		}
		ov.PostponedFrom = day
		ov.UpdatedAt = at
		e, err := store.NewEntity(store.KindOverride, &ov)
		if err != nil {
			return done, err
		}
		if err := a.db.Put(ctx, e); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}

// OverdueItemIDs 给「批量顺延到今天」用：取出当前逾期且未打卡的事项。
func (a *App) OverdueItemIDs(ctx context.Context, day model.Day) ([]string, []model.Day, error) {
	if day == "" {
		day = a.Today()
	}
	view, err := a.ListView(ctx, ListViewRequest{Day: day, GroupBy: groupByDate, HorizonDays: 1, LookbackDays: defaultLookback})
	if err != nil {
		return nil, nil, err
	}
	for _, g := range view.Groups {
		if g.Key != "overdue" {
			continue
		}
		ids := make([]string, 0, len(g.Items))
		days := make([]model.Day, 0, len(g.Items))
		for _, o := range g.Items {
			ids = append(ids, o.Item.ID)
			days = append(days, o.Day)
		}
		return ids, days, nil
	}
	return []string{}, []model.Day{}, nil
}
