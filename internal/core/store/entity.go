package store

import (
	"encoding/json"
	"fmt"

	"planfordo/internal/core/model"
)

// Kind 是 entity 表 kind 列的取值，同时是同步协议里的实体类型名。
// 改名等于让历史数据变成孤儿，只能配迁移，不能随手改。
type Kind = string

const (
	KindList         Kind = "list"
	KindItem         Kind = "item"
	KindChild        Kind = "child"
	KindCategory     Kind = "category"
	KindLabel        Kind = "label"
	KindOverride     Kind = "override"
	KindHabit        Kind = "habit"
	KindHabitClock   Kind = "habitClock"
	KindHabitMark    Kind = "habitMark"
	KindHabitUnit    Kind = "habitUnit"
	KindHabitContext Kind = "habitContext"
	KindAttachment   Kind = "attachment"
	KindFocus        Kind = "focus"
	KindMemo         Kind = "memo"
	KindMemoFolder   Kind = "memoFolder"
)

// AllKinds 顺序固定，用于枚举同步范围与统计。
var AllKinds = []Kind{
	KindList, KindItem, KindChild, KindCategory, KindLabel, KindOverride,
	KindHabit, KindHabitClock, KindHabitMark, KindHabitUnit, KindHabitContext, KindAttachment,
	KindMemo, KindMemoFolder, KindFocus,
}

// Entity 是 entity 表的一行，也是同步引擎在线上传递的记录。
// data 是权威内容，派生列（day/parent/status/sort）只服务查询，重建不影响正确性。
type Entity struct {
	Kind      Kind            `json:"kind"`
	ID        string          `json:"id"`
	UpdatedAt model.ClockTime `json:"updatedAt"`
	DeletedAt model.ClockTime `json:"deletedAt,omitempty"`
	Day       model.Day       `json:"day,omitempty"`
	Parent    string          `json:"parent,omitempty"`
	Status    int             `json:"status"`
	Sort      int             `json:"sort"`
	Data      json.RawMessage `json:"data"`
}

// Alive 报告这行是否未被删除。
func (e Entity) Alive() bool { return e.DeletedAt == "" }

// Decode 把 data 还原进领域对象。
func (e Entity) Decode(v any) error {
	if len(e.Data) == 0 {
		return fmt.Errorf("store: %s/%s 无 data", e.Kind, e.ID)
	}
	if err := json.Unmarshal(e.Data, v); err != nil {
		return fmt.Errorf("store: 解析 %s/%s: %w", e.Kind, e.ID, err)
	}
	return nil
}

// NewEntity 由领域对象生成一行。新增实体类型时必须补这里的 switch，
// 否则派生列全空，按天/按父查询会静默漏数据。
func NewEntity(kind Kind, v any) (Entity, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return Entity{}, fmt.Errorf("store: 序列化 %s: %w", kind, err)
	}
	e := Entity{Kind: kind, Data: raw, Status: -1}
	switch o := v.(type) {
	case *model.List:
		e.ID, e.UpdatedAt, e.DeletedAt, e.Sort = o.ID, o.UpdatedAt, o.DeletedAt, o.Sort
	case *model.ListItem:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Parent = o.Date.Start, o.ListID
	case *model.Child:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Parent, e.Sort = o.ItemID, o.Sort
		if o.Done {
			e.Status = 1
		} else {
			e.Status = 0
		}
	case *model.Category:
		e.ID, e.UpdatedAt, e.DeletedAt, e.Sort = o.ID, o.UpdatedAt, o.DeletedAt, o.Sort
	case *model.Label:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
	case *model.OccurrenceOverride:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Parent, e.Status = o.Day, o.ItemID, int(o.Status)
	case *model.Habit:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Parent = o.StartDay, o.Context
	case *model.HabitClock:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Parent, e.Status = o.Day, o.HabitID, 1
	case *model.HabitMark:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Parent = o.Day, o.HabitID
	case *model.HabitUnit:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
	case *model.HabitContext:
		e.ID, e.UpdatedAt, e.DeletedAt, e.Sort = o.ID, o.UpdatedAt, o.DeletedAt, o.Sort
	case *model.Attachment:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Parent = o.OwnerID
	case *model.Memo:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Parent = o.FolderID
		if o.TrashedAt != "" {
			e.Status = 1 // 派生列：在回收站里（重建不影响正确性）
		}
		if o.IsTop {
			e.Sort = 1
		}
	case *model.MemoFolder:
		e.ID, e.UpdatedAt, e.DeletedAt, e.Sort = o.ID, o.UpdatedAt, o.DeletedAt, o.Sort
	case *model.FocusRecord:
		e.ID, e.UpdatedAt, e.DeletedAt = o.ID, o.UpdatedAt, o.DeletedAt
		e.Day, e.Status = o.Day, int(o.Status)
		// parent 是「这次专注挂在谁身上」：事项与习惯二选一，都空就是未关联。
		// 任务排行与「按任务筛历史」都靠这一列，别让它在 data 里飘。
		e.Parent = o.ItemID
		if e.Parent == "" {
			e.Parent = o.HabitID
		}
	default:
		return Entity{}, fmt.Errorf("store: 未登记的实体类型 %T（kind=%s）", v, kind)
	}
	if e.ID == "" {
		return Entity{}, fmt.Errorf("store: %s 缺少 ID", kind)
	}
	if e.UpdatedAt == "" {
		return Entity{}, fmt.Errorf("store: %s/%s 缺少 updatedAt，同步无法比较新旧", kind, e.ID)
	}
	return e, nil
}

// DecodeEntities 批量还原领域对象，跳过类型不符的脏数据以外的错误。
func DecodeEntities[T any](entities []Entity) ([]T, error) {
	out := make([]T, 0, len(entities))
	for _, e := range entities {
		var v T
		if err := e.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}
