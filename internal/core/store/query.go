package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/tclock"
)

const upsertSQL = `
INSERT INTO entity(kind, id, updated_at, deleted_at, day, parent, status, sort, data)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(kind, id) DO UPDATE SET
	updated_at = excluded.updated_at,
	deleted_at = excluded.deleted_at,
	day        = excluded.day,
	parent     = excluded.parent,
	status     = excluded.status,
	sort       = excluded.sort,
	data       = excluded.data`

func (e Entity) args() []any {
	return []any{e.Kind, e.ID, e.UpdatedAt, e.DeletedAt, e.Day, e.Parent, e.Status, e.Sort, string(e.Data)}
}

// Put 写入或覆盖一行。updated_at 必须由调用方用 DB.Tick 发号，否则同步比较会失真。
func (db *DB) Put(ctx context.Context, e Entity) error {
	if _, err := db.sql.ExecContext(ctx, upsertSQL, e.args()...); err != nil {
		return fmt.Errorf("store: 写 %s/%s: %w", e.Kind, e.ID, err)
	}
	return nil
}

// PutMany 在一个事务里写多行，避免出现「父写进去了子没写进去」的半截状态。
func (db *DB) PutMany(ctx context.Context, entities []Entity) error {
	if len(entities) == 0 {
		return nil
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 批量写起事务: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx, upsertSQL)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("store: 批量写预处理: %w", err)
	}
	defer stmt.Close()
	for _, e := range entities {
		if _, err := stmt.ExecContext(ctx, e.args()...); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: 批量写 %s/%s: %w", e.Kind, e.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 批量写提交: %w", err)
	}
	return nil
}

// MergeRemote 应用从别的设备同步来的行：远端更新才覆盖本地。
// 返回 applied 表示本地是否被改写——调用方据此决定要不要再推给其它通道。
//
// 同一主键、同一 updated_at 的真冲突极少但必须可判定：取内容字典序较大的一方。
// 规则两端对称，所以两台设备会收敛到同一条记录，而不是各留各的。
func (db *DB) MergeRemote(ctx context.Context, remote Entity) (bool, error) {
	local, found, err := db.Get(ctx, remote.Kind, remote.ID)
	if err != nil {
		return false, err
	}
	if found {
		switch {
		case tclock.IsNewer(local.UpdatedAt, remote.UpdatedAt):
			return false, nil // 本地更新，远端这条直接丢
		case remote.UpdatedAt == local.UpdatedAt && string(local.Data) >= string(remote.Data):
			return false, nil
		}
	}
	if err := db.Put(ctx, remote); err != nil {
		return false, err
	}
	return true, nil
}

// Get 按主键取一行，含已删除的 tombstone。
func (db *DB) Get(ctx context.Context, kind Kind, id string) (Entity, bool, error) {
	row := db.sql.QueryRowContext(ctx, selectEntitySQL+` WHERE kind = ? AND id = ?`, kind, id)
	e, err := scanEntity(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Entity{}, false, nil
	}
	if err != nil {
		return Entity{}, false, fmt.Errorf("store: 取 %s/%s: %w", kind, id, err)
	}
	return e, true, nil
}

const selectEntitySQL = `
SELECT kind, id, updated_at, deleted_at, day, parent, status, sort, data FROM entity`

type scanner interface{ Scan(dest ...any) error }

func scanEntity(s scanner) (Entity, error) {
	var (
		e   Entity
		raw string
	)
	if err := s.Scan(&e.Kind, &e.ID, &e.UpdatedAt, &e.DeletedAt, &e.Day, &e.Parent, &e.Status, &e.Sort, &raw); err != nil {
		return Entity{}, err
	}
	e.Data = []byte(raw)
	return e, nil
}

func (db *DB) query(ctx context.Context, query string, args ...any) ([]Entity, error) {
	rows, err := db.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: 查询: %w", err)
	}
	defer rows.Close()
	out := []Entity{}
	for rows.Next() {
		e, err := scanEntity(rows)
		if err != nil {
			return nil, fmt.Errorf("store: 读行: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: 遍历: %w", err)
	}
	return out, nil
}

// Rows 按条件取行。kind 为空表示全部类型；includeDeleted 为假时过滤掉 tombstone。
// 排序固定为 (kind, id)，保证同步快照和测试输出稳定可复现。
func (db *DB) Rows(ctx context.Context, kind Kind, includeDeleted bool) ([]Entity, error) {
	var sb strings.Builder
	sb.WriteString(selectEntitySQL)
	args := []any{}
	where := []string{}
	if kind != "" {
		where = append(where, "kind = ?")
		args = append(args, kind)
	}
	if !includeDeleted {
		where = append(where, "deleted_at = ''")
	}
	if len(where) > 0 {
		sb.WriteString(" WHERE " + strings.Join(where, " AND "))
	}
	sb.WriteString(" ORDER BY kind, id")
	return db.query(ctx, sb.String(), args...)
}

// ByParent 取某父实体下的行，例如一条事项的子孙任务与单日例外。
func (db *DB) ByParent(ctx context.Context, kind Kind, parent string) ([]Entity, error) {
	return db.query(ctx, selectEntitySQL+` WHERE kind = ? AND parent = ? AND deleted_at = '' ORDER BY sort, id`, kind, parent)
}

// ByDay 取某天相关的行，例如某天的习惯打卡与事项单日例外。
func (db *DB) ByDay(ctx context.Context, kind Kind, day model.Day) ([]Entity, error) {
	return db.query(ctx, selectEntitySQL+` WHERE kind = ? AND day = ? AND deleted_at = '' ORDER BY id`, kind, day)
}

// ChangedSince 取 updated_at 严格大于 since 的行，含 tombstone（删除也要传播）。
func (db *DB) ChangedSince(ctx context.Context, since model.ClockTime) ([]Entity, error) {
	if since == "" {
		return db.Rows(ctx, "", true)
	}
	return db.query(ctx, selectEntitySQL+` WHERE updated_at > ? ORDER BY kind, id`, since)
}

// SoftDelete 打 tombstone。物理清理只在 CompactTombstones 里做，删除必须先传播到其他设备。
func (db *DB) SoftDelete(ctx context.Context, kind Kind, id string, at model.ClockTime) error {
	res, err := db.sql.ExecContext(ctx,
		`UPDATE entity SET deleted_at = ?, updated_at = ? WHERE kind = ? AND id = ? AND deleted_at = ''`,
		at, at, kind, id)
	if err != nil {
		return fmt.Errorf("store: 删除 %s/%s: %w", kind, id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("store: %s/%s %w", kind, id, ErrNotFound)
	}
	return nil
}

// CompactTombstones 物理删除早于 olderThan 的 tombstone，返回删掉的行数。
// 只有在确认所有通道都推过之后才该调用，否则删除会在一台设备上消失、在另一台复活。
func (db *DB) CompactTombstones(ctx context.Context, olderThan model.ClockTime) (int, error) {
	if olderThan == "" {
		return 0, errors.New("store: CompactTombstones 需要水位")
	}
	res, err := db.sql.ExecContext(ctx, `DELETE FROM entity WHERE deleted_at <> '' AND updated_at < ?`, olderThan)
	if err != nil {
		return 0, fmt.Errorf("store: 清理 tombstone: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// CountByKind 给出各实体类型的存活行数，设置页与测试用它看数据规模。
func (db *DB) CountByKind(ctx context.Context) (map[Kind]int, error) {
	rows, err := db.sql.QueryContext(ctx, `SELECT kind, COUNT(*) FROM entity WHERE deleted_at = '' GROUP BY kind`)
	if err != nil {
		return nil, fmt.Errorf("store: 统计: %w", err)
	}
	defer rows.Close()
	out := map[Kind]int{}
	for rows.Next() {
		var k Kind
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			return nil, fmt.Errorf("store: 统计读行: %w", err)
		}
		out[k] = n
	}
	return out, rows.Err()
}
