// Package sync 把本机状态与远端状态做「记录级 LWW 全量合并」。
//
// 通道只需要对象存储语义（读一份快照、写一份快照），所以飞书多维表格、飞书云盘、
// WebDAV 和一个普通文件夹能用同一个引擎。单人多设备的量级下，全量快照比增量日志
// 简单得多，也不需要远端参与合并计算。
package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"planfordo/internal/core/model"
	"planfordo/internal/core/repeat"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

// SchemaVersion 是快照的协议版本。远端版本更高时拒绝写入，
// 免得旧客户端把新字段静默丢掉。
const SchemaVersion = 1

// ErrSchemaMismatch 表示远端快照由更新的协议写出。
var ErrSchemaMismatch = errors.New("sync: 快照协议版本高于本机")

// Snapshot 是一份完整状态。Records 含 tombstone，删除必须能传播出去。
type Snapshot struct {
	Schema   int             `json:"schema"`
	DeviceID string          `json:"deviceId"`
	SyncedAt model.ClockTime `json:"syncedAt"`
	Revision int64           `json:"revision"`
	Records  []store.Entity  `json:"records"`
}

// Bytes 序列化快照；通道负责落盘或上传。
func (s *Snapshot) Bytes() ([]byte, error) {
	return json.Marshal(s)
}

// ParseSnapshot 反序列化并校验协议版本。
func ParseSnapshot(raw []byte) (*Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("sync: 解析快照: %w", err)
	}
	if s.Schema > SchemaVersion {
		return nil, fmt.Errorf("%w: 远端 %d > 本机 %d", ErrSchemaMismatch, s.Schema, SchemaVersion)
	}
	if s.Schema == 0 {
		s.Schema = SchemaVersion
	}
	if s.Records == nil {
		s.Records = []store.Entity{}
	}
	return &s, nil
}

// Channel 是一条同步通道。实现者不需要懂合并规则，只负责可靠地存取一份快照。
type Channel interface {
	Name() string
	Kind() string
	// Probe 检查连通性与写权限，设置页的「测试连接」用它。
	Probe(ctx context.Context) error
	Load(ctx context.Context) (*Snapshot, error)
	Save(ctx context.Context, s *Snapshot) error
}

// ConditionalChannel 支持「期望版本号不符就拒写」的通道。网盘类协议能拿到 ETag 时应当实现它，
// 这样两台设备同时推送时后写者会失败并重来，而不是把先写者的记录抹掉。
type ConditionalChannel interface {
	Channel
	SaveConditional(ctx context.Context, s *Snapshot, expectRevision int64) error
}

// Result 是一次同步的产出。
type Result struct {
	Channel   string          `json:"channel"`
	Applied   int             `json:"applied"`   // 从远端落到本地的记录数
	Pushed    int             `json:"pushed"`    // 本地推给远端的记录数
	Conflicts int             `json:"conflicts"` // 两端都改过同一条的次数
	Revision  int64           `json:"revision"`
	SyncedAt  model.ClockTime `json:"syncedAt"`
	Skipped   string          `json:"skipped,omitempty"`
}

// Engine 对一个库执行同步。可并发用于不同通道，但同一库上的写合并靠 SQLite 串行。
type Engine struct {
	db *store.DB
	// TombstoneRetention 是 tombstone 在快照里保留的天数，默认 90。
	TombstoneRetention int
}

// NewEngine 构造同步引擎。
func NewEngine(db *store.DB) *Engine {
	return &Engine{db: db, TombstoneRetention: 90}
}

// Run 做一轮同步：拉远端 → 合入本地 → 把合并后的全量推回去。
func (e *Engine) Run(ctx context.Context, ch Channel) (Result, error) {
	if ch == nil {
		return Result{}, errors.New("sync: 通道为空")
	}
	res := Result{Channel: ch.Name()}

	remote, err := ch.Load(ctx)
	if err != nil {
		return res, fmt.Errorf("sync: 拉取 %s: %w", ch.Name(), err)
	}
	applied, conflicts, err := e.merge(ctx, remote)
	if err != nil {
		return res, err
	}
	res.Applied, res.Conflicts = applied, conflicts

	local, rev, err := e.localSnapshot(ctx)
	if err != nil {
		return res, err
	}
	pushed := 0
	for _, rec := range local.Records {
		if !containsRecord(remote.Records, rec) {
			pushed++
		}
	}
	res.Pushed = pushed

	// 合并结果写回远端：两端都推并集，另一台设备下一轮就能拿到全部。
	if pushed > 0 || remote.Revision == 0 || conflicts > 0 {
		local.DeviceID = e.db.DeviceID()
		local.SyncedAt = tclock.Now()
		local.Revision = maxInt64(remote.Revision, rev) + 1
		res.Revision = local.Revision
		res.SyncedAt = local.SyncedAt
		if cc, ok := ch.(ConditionalChannel); ok {
			if err := cc.SaveConditional(ctx, local, remote.Revision); err != nil {
				return res, fmt.Errorf("sync: 写回 %s: %w", ch.Name(), err)
			}
		} else if err := ch.Save(ctx, local); err != nil {
			return res, fmt.Errorf("sync: 写回 %s: %w", ch.Name(), err)
		}
	} else {
		res.Revision = remote.Revision
		res.SyncedAt = remote.SyncedAt
		res.Skipped = "本地无待推送内容"
	}

	state, err := e.db.GetSyncState(ctx, ch.Name())
	if err != nil {
		return res, err
	}
	state.Channel = ch.Name()
	state.LastSyncAt = res.SyncedAt
	if res.Pushed > 0 || res.Applied > 0 {
		state.LastPushedAt = res.SyncedAt
	}
	if err := e.db.SetSyncState(ctx, state); err != nil {
		return res, err
	}
	return res, nil
}

// merge 把远端逐条落到本地，返回应用数与冲突数。
func (e *Engine) merge(ctx context.Context, remote *Snapshot) (applied, conflicts int, err error) {
	if remote == nil || len(remote.Records) == 0 {
		return 0, 0, nil
	}
	for _, rec := range remote.Records {
		if rec.Kind == "" || rec.ID == "" || rec.UpdatedAt == "" {
			continue // 来路不明的行直接丢，别让它污染本地
		}
		local, found, err := e.db.Get(ctx, rec.Kind, rec.ID)
		if err != nil {
			return applied, conflicts, err
		}
		// 冲突 = 同一条记录两端内容不同，与谁赢无关；谁赢由 LWW 决定，
		// 计数是为了在设置页告诉用户「这里发生过覆盖」。
		if found && string(local.Data) != string(rec.Data) {
			conflicts++
		}
		ok, err := e.db.MergeRemote(ctx, rec)
		if err != nil {
			return applied, conflicts, err
		}
		if ok {
			applied++
		}
	}
	return applied, conflicts, nil
}

// localSnapshot 导出本地全量。tombstone 只保留 TombstoneRetention 天内的，
// 否则快照会随删除历史无限膨胀。
func (e *Engine) localSnapshot(ctx context.Context) (*Snapshot, int64, error) {
	rows, err := e.db.Rows(ctx, "", true)
	if err != nil {
		return nil, 0, err
	}
	retention := e.TombstoneRetention
	if retention <= 0 {
		retention = 90
	}
	cutoff := repeat.AddDays(tclock.LocalDay(tclock.Now(), nil), -retention)
	out := make([]store.Entity, 0, len(rows))
	var maxUpdated int64
	for _, r := range rows {
		if !r.Alive() && r.UpdatedAt < cutoff {
			continue
		}
		if len(r.Data) == 0 {
			continue
		}
		out = append(out, r)
		if ms := tclock.Millis(r.UpdatedAt); ms > maxUpdated {
			maxUpdated = ms
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].ID < out[j].ID
	})
	return &Snapshot{Schema: SchemaVersion, Records: out}, maxUpdated, nil
}

func containsRecord(xs []store.Entity, rec store.Entity) bool {
	for _, x := range xs {
		if x.Kind == rec.Kind && x.ID == rec.ID && x.UpdatedAt == rec.UpdatedAt && string(x.Data) == string(rec.Data) {
			return true
		}
	}
	return false
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
