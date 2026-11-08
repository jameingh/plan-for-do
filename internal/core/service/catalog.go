package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// CategoryInput 是分类的新建/编辑入参。
type CategoryInput struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

// Categories 按自定义顺序返回分类。
func (a *App) Categories(ctx context.Context) ([]model.Category, error) {
	out, err := loadAll[model.Category](a, ctx, store.KindCategory)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// SaveCategory 建或改分类。图标允许是内置图标名，也可能是单个汉字（朝暮的「文」图标）。
func (a *App) SaveCategory(ctx context.Context, in CategoryInput) (*model.Category, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 分类名不能为空")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var cat model.Category
	if in.ID == "" {
		cat = model.Category{ID: newID(), CreatedAt: at}
	} else {
		row, found, err := a.db.Get(ctx, store.KindCategory, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: category %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(&cat); err != nil {
			return nil, err
		}
	}
	cat.Name, cat.Icon, cat.Color = name, in.Icon, in.Color
	cat.UpdatedAt = at
	e, err := store.NewEntity(store.KindCategory, &cat)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &cat, nil
}

// DeleteCategory 删分类。withItems 为真时连同其下事项一起删除，
// 为假时事项归入「未分类」——两种都是朝暮给的选项，语义必须由调用方显式选择。
func (a *App) DeleteCategory(ctx context.Context, categoryID string, withItems bool) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	items, err := a.listItems(ctx)
	if err != nil {
		return 0, err
	}
	affected := 0
	for _, it := range items {
		if it.Category != categoryID {
			continue
		}
		if withItems {
			if err := a.db.SoftDelete(ctx, store.KindItem, it.ID, at); err != nil {
				return affected, err
			}
		} else {
			it.Category = ""
			if err := a.saveItem(ctx, it, at); err != nil {
				return affected, err
			}
		}
		affected++
	}
	if err := a.db.SoftDelete(ctx, store.KindCategory, categoryID, at); err != nil {
		return affected, err
	}
	return affected, nil
}

// ReorderCategories 按给定 ID 顺序重排分类。
func (a *App) ReorderCategories(ctx context.Context, orderedIDs []string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	for i, id := range orderedIDs {
		cat, err := loadOne[model.Category](a, ctx, store.KindCategory, id)
		if err != nil {
			return err
		}
		if cat.Sort == i {
			continue
		}
		cat.Sort = i
		cat.UpdatedAt = at
		e, err := store.NewEntity(store.KindCategory, cat)
		if err != nil {
			return err
		}
		if err := a.db.Put(ctx, e); err != nil {
			return err
		}
	}
	return nil
}

// LabelInput 是标签入参。
type LabelInput struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Labels 返回全部标签，按名字排序方便做输入联想。
func (a *App) Labels(ctx context.Context) ([]model.Label, error) {
	out, err := loadAll[model.Label](a, ctx, store.KindLabel)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// SaveLabel 建或改标签；改名会同步改写引用它的事项，否则事项上的 ID 会悬空。
func (a *App) SaveLabel(ctx context.Context, in LabelInput) (*model.Label, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 标签名不能为空")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var label model.Label
	if in.ID == "" {
		existing, err := a.Labels(ctx)
		if err != nil {
			return nil, err
		}
		for _, l := range existing {
			if l.Name == name {
				return &l, nil // 同名直接复用，避免「加班/加班 /加班」这类重复标签
			}
		}
		label = model.Label{ID: newID(), Name: name, Color: in.Color, CreatedAt: at, UpdatedAt: at}
	} else {
		row, found, err := a.db.Get(ctx, store.KindLabel, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: label %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(&label); err != nil {
			return nil, err
		}
		label.Name, label.Color = name, in.Color
		label.UpdatedAt = at
	}
	e, err := store.NewEntity(store.KindLabel, &label)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &label, nil
}

// DeleteLabel 删标签并从所有事项上摘掉引用。
func (a *App) DeleteLabel(ctx context.Context, labelID string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	items, err := a.listItems(ctx)
	if err != nil {
		return 0, err
	}
	touched := 0
	for _, it := range items {
		if !containsStr(it.LabelIDs, labelID) {
			continue
		}
		kept := it.LabelIDs[:0:0]
		for _, l := range it.LabelIDs {
			if l != labelID {
				kept = append(kept, l)
			}
		}
		it.LabelIDs = kept
		if err := a.saveItem(ctx, it, at); err != nil {
			return touched, err
		}
		touched++
	}
	if err := a.db.SoftDelete(ctx, store.KindLabel, labelID, at); err != nil {
		return touched, err
	}
	return touched, nil
}

// ChildInput 是子任务入参。
type ChildInput struct {
	ID       string         `json:"id,omitempty"`
	ItemID   string         `json:"itemId"`
	Title    string         `json:"title"`
	Remark   string         `json:"remark"`
	Priority model.Priority `json:"priority"`
	Due      model.Day      `json:"due,omitempty"`
	Pinned   bool           `json:"pinned"`
	Done     bool           `json:"done"`
	Failed   bool           `json:"failed"`
	Sort     int            `json:"sort"`
}

// Children 返回某条事项下的子任务。
func (a *App) Children(ctx context.Context, itemID string) ([]model.Child, error) {
	rows, err := a.db.ByParent(ctx, store.KindChild, itemID)
	if err != nil {
		return nil, err
	}
	out := make([]model.Child, 0, len(rows))
	for _, r := range rows {
		var c model.Child
		if err := r.Decode(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Pinned != out[j].Pinned {
			return out[i].Pinned
		}
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// SaveChild 建或改子任务。子任务跟着父事项走，所以校验父事项存在。
func (a *App) SaveChild(ctx context.Context, in ChildInput) (*model.Child, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return nil, fmt.Errorf("service: 子任务标题不能为空")
	}
	if _, err := a.getItem(ctx, in.ItemID); err != nil {
		return nil, err
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var child model.Child
	if in.ID == "" {
		child = model.Child{ID: newID(), ItemID: in.ItemID, Sort: in.Sort, CreatedAt: at, Progress: -1}
	} else {
		row, found, err := a.db.Get(ctx, store.KindChild, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: child %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(&child); err != nil {
			return nil, err
		}
	}
	child.ItemID = in.ItemID
	child.Title = title
	child.Remark = in.Remark
	child.Pinned = in.Pinned
	child.Done = in.Done
	child.Failed = in.Failed && !in.Done // 成功与失败互斥，不能同时为真
	if in.Priority != 0 {
		child.Priority = in.Priority
	}
	if in.Due != "" {
		child.Due = in.Due
	}
	if in.Sort != 0 || child.Sort == 0 {
		child.Sort = in.Sort
	}
	child.UpdatedAt = at
	e, err := store.NewEntity(store.KindChild, &child)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &child, nil
}

// SetChildDone 勾掉或取消勾掉子任务。
func (a *App) SetChildDone(ctx context.Context, childID string, done bool) error {
	status := model.StatusPending
	if done {
		status = model.StatusClocked
	}
	return a.SetChildClock(ctx, childID, status)
}

// SetChildClock 子任务的打卡三态，与主事项同一套语义（参考站的子任务框也是三态）。
func (a *App) SetChildClock(ctx context.Context, childID string, status model.ItemStatus) error {
	child, err := loadOne[model.Child](a, ctx, store.KindChild, childID)
	if err != nil {
		return err
	}
	if status != model.StatusPending && status != model.StatusClocked && status != model.StatusFailed {
		return fmt.Errorf("service: 子任务打卡状态只接受未打卡/成功/失败，收到 %d", status)
	}
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	done := status == model.StatusClocked
	if child.Done == done && child.Failed != done {
		return nil // 重复点同一状态不推进 updated_at，免得同步凭空多一个版本
	}
	child.Done = done
	child.Failed = status == model.StatusFailed
	child.UpdatedAt = at
	e, err := store.NewEntity(store.KindChild, child)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// DeleteChild 删子任务。
func (a *App) DeleteChild(ctx context.Context, childID string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.db.SoftDelete(ctx, store.KindChild, childID, at)
}

// ListInput 是清单本入参。
type ListInput struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

// Lists 返回清单本，按 Sort 排序。
func (a *App) Lists(ctx context.Context) ([]model.List, error) {
	out, err := loadAll[model.List](a, ctx, store.KindList)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// SaveList 建或改清单本。
func (a *App) SaveList(ctx context.Context, in ListInput) (*model.List, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 清单本名称不能为空")
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var list model.List
	if in.ID == "" {
		list = model.List{ID: newID(), CreatedAt: at, Sort: 100}
	} else {
		row, found, err := a.db.Get(ctx, store.KindList, in.ID)
		if err != nil {
			return nil, err
		}
		if !found || !row.Alive() {
			return nil, fmt.Errorf("%w: list %s", ErrNotFound, in.ID)
		}
		if err := row.Decode(&list); err != nil {
			return nil, err
		}
	}
	list.Name, list.Icon, list.Color = name, in.Icon, in.Color
	list.UpdatedAt = at
	e, err := store.NewEntity(store.KindList, &list)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &list, nil
}

// DeleteList 删清单本。默认清单本「全部」不允许删；withItems 决定其下事项是删还是并入默认本。
func (a *App) DeleteList(ctx context.Context, listID string, withItems bool) (int, error) {
	if listID == model.DefaultListID {
		return 0, fmt.Errorf("service: 默认清单本不可删除")
	}
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	items, err := a.listItems(ctx)
	if err != nil {
		return 0, err
	}
	affected := 0
	for _, it := range items {
		if it.ListID != listID {
			continue
		}
		if withItems {
			if err := a.db.SoftDelete(ctx, store.KindItem, it.ID, at); err != nil {
				return affected, err
			}
		} else {
			it.ListID = model.DefaultListID
			if err := a.saveItem(ctx, it, at); err != nil {
				return affected, err
			}
		}
		affected++
	}
	if err := a.db.SoftDelete(ctx, store.KindList, listID, at); err != nil {
		return affected, err
	}
	return affected, nil
}

// HabitUnitInput 是习惯单位入参。
type HabitUnitInput struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

// HabitUnits 返回习惯单位。
func (a *App) HabitUnits(ctx context.Context) ([]model.HabitUnit, error) {
	return loadAll[model.HabitUnit](a, ctx, store.KindHabitUnit)
}

// SaveHabitUnit 新建单位。名称限两个字符是朝暮的约束，写在这里而不是靠前端拦。
func (a *App) SaveHabitUnit(ctx context.Context, in HabitUnitInput) (*model.HabitUnit, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > model.MaxUnitNameRunes {
		return nil, fmt.Errorf("service: 单位名需 1-%d 个字符", model.MaxUnitNameRunes)
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	unit := model.HabitUnit{ID: in.ID, Name: name, CreatedAt: at, UpdatedAt: at}
	if unit.ID == "" {
		existing, err := a.HabitUnits(ctx)
		if err != nil {
			return nil, err
		}
		for _, u := range existing {
			if u.Name == name {
				return &u, nil
			}
		}
		unit.ID = newID()
	}
	e, err := store.NewEntity(store.KindHabitUnit, &unit)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &unit, nil
}

// loadAll 取某类实体的全部存活行并解码。
func loadAll[T any](a *App, ctx context.Context, kind store.Kind) ([]T, error) {
	rows, err := a.db.Rows(ctx, kind, false)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(rows))
	for _, r := range rows {
		var v T
		if err := r.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// loadOne 按 ID 取单个实体。
func loadOne[T any](a *App, ctx context.Context, kind store.Kind, id string) (*T, error) {
	row, found, err := a.db.Get(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	if !found || !row.Alive() {
		return nil, fmt.Errorf("%w: %s %s", ErrNotFound, kind, id)
	}
	var v T
	if err := row.Decode(&v); err != nil {
		return nil, err
	}
	return &v, nil
}
