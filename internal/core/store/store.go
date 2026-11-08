// Package store 是内核的持久层：一个 SQLite 文件，CGO-free（驱动 modernc.org/sqlite），
// 因此同一份代码可以从 Windows/macOS 桌面一直编到 iOS。
//
// 表结构刻意扁平：所有实体进同一张 entity 表，业务字段是 JSON，派生列只为查询服务。
// 这样同步引擎能统一枚举全部记录，模型演进也不必跟着改 DDL。
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // 驱动名 "sqlite"，纯 Go 实现

	"planfordo/internal/core/id"
	"planfordo/internal/core/model"
	"planfordo/internal/core/tclock"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// ErrNotFound 表示按 ID 取记录时库里没有这一条。
var ErrNotFound = errors.New("store: 记录不存在")

const (
	metaDevice    = "device.id"
	metaTick      = "clock.tick"
	syncNoteMax   = 4000
	driverName    = "sqlite"
	dbFileName    = "planfordo.db"
	migrationsDir = "migrations"

	// 迁移记账自建于 bootstrap 语句，不能记在 meta 表里——读 meta 时它还不存在。
	// 按文件名而不是序号记录，中途插入一支迁移也不会让后面的错位。
	bootstrapSQL = `CREATE TABLE IF NOT EXISTS migration (
	name       TEXT NOT NULL PRIMARY KEY,
	applied_at TEXT NOT NULL
)`
)

// DB 是打开的库。所有方法都受 ctx 控制；内部只维持一条连接，写冲突交给 busy_timeout。
type DB struct {
	sql    *sql.DB
	path   string
	device string
}

// Open 打开（必要时创建）dir 下的数据库并跑迁移。
// dir 由壳层按平台解析后传入，内核不自己猜路径——iOS 必须落在 app container 里。
func Open(ctx context.Context, dir string) (*DB, error) {
	if dir == "" {
		return nil, errors.New("store: 数据目录为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("store: 建数据目录: %w", err)
	}
	path := filepath.Join(dir, dbFileName)
	sqlDB, err := sql.Open(driverName, path)
	if err != nil {
		return nil, fmt.Errorf("store: 打开 %s: %w", path, err)
	}
	sqlDB.SetMaxOpenConns(1)
	for _, p := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
	} {
		if _, err := sqlDB.ExecContext(ctx, p); err != nil {
			sqlDB.Close()
			return nil, fmt.Errorf("store: %s: %w", p, err)
		}
	}
	db := &DB{sql: sqlDB, path: path}
	if err := db.migrate(ctx); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if db.device, err = db.ensureDeviceID(ctx); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return db, nil
}

// Close 关库。WAL 会被 checkpoint 到主文件。
func (db *DB) Close() error { return db.sql.Close() }

// Path 返回数据库文件位置，设置页要展示它。
func (db *DB) Path() string { return db.path }

// DeviceID 是本机的稳定标识，同步记录靠它区分来源、并在同刻冲突时破平局。
func (db *DB) DeviceID() string { return db.device }

func (db *DB) ensureDeviceID(ctx context.Context) (string, error) {
	if v, ok, err := db.MetaGet(ctx, metaDevice); err != nil {
		return "", err
	} else if ok && v != "" {
		return v, nil
	}
	// 带设备名后缀纯粹是为了看同步日志时能认出是哪台机器，不参与任何逻辑判断。
	fresh := id.New()
	if host, err := os.Hostname(); err == nil && host != "" {
		if i := strings.IndexAny(host, " \t"); i > 0 {
			host = host[:i]
		}
		fresh = fresh + "-" + sanitize(host)
	}
	if err := db.MetaSet(ctx, metaDevice, fresh); err != nil {
		return "", err
	}
	return fresh, nil
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := b.String()
	if len(out) > 24 {
		out = out[:24]
	}
	return out
}

// migrate 按文件名顺序应用尚未执行过的迁移，每支一个事务并在 migration 表记账。
func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.sql.ExecContext(ctx, bootstrapSQL); err != nil {
		return fmt.Errorf("store: 建迁移记账表: %w", err)
	}
	entries, err := migrationFS.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("store: 读迁移目录: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var done string
		err := db.sql.QueryRowContext(ctx, `SELECT name FROM migration WHERE name = ?`, name).Scan(&done)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: 查迁移 %s: %w", name, err)
		}
		raw, err := migrationFS.ReadFile(migrationsDir + "/" + name)
		if err != nil {
			return fmt.Errorf("store: 读迁移 %s: %w", name, err)
		}
		tx, err := db.sql.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("store: 迁移 %s 起事务: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(raw)); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: 迁移 %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO migration(name, applied_at) VALUES(?, ?)`, name, tclock.Now()); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: 迁移 %s 记账: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: 迁移 %s 提交: %w", name, err)
		}
	}
	return nil
}

// Tick 发一个单调递增的时间戳，所有 updated_at 都必须由它产生。
//
// 直接取 time.Now() 会让同一毫秒内的两次写无法比较新旧，回拨系统时钟更会让新改动
// 「永远输给」旧改动；所以取 max(现在, 上次+1ms) 并持久化。
func (db *DB) Tick(ctx context.Context) (model.ClockTime, error) {
	last, ok, err := db.MetaGet(ctx, metaTick)
	if err != nil {
		return "", err
	}
	prev, _ := strconv.ParseInt(last, 10, 64)
	now := tclock.Millis(tclock.Now())
	next := now
	if ok && prev >= now {
		next = prev + 1
	}
	if err := db.MetaSet(ctx, metaTick, strconv.FormatInt(next, 10)); err != nil {
		return "", err
	}
	return tclock.FromMillis(next), nil
}

// MetaGet 读元数据。
func (db *DB) MetaGet(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := db.sql.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return "", false, nil
	case err != nil:
		return "", false, fmt.Errorf("store: 读 meta %s: %w", key, err)
	}
	return v, true, nil
}

// MetaSet 写元数据。
func (db *DB) MetaSet(ctx context.Context, key, value string) error {
	_, err := db.sql.ExecContext(ctx,
		`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	if err != nil {
		return fmt.Errorf("store: 写 meta %s: %w", key, err)
	}
	return nil
}

// SyncState 是某个通道的水位。字段必须带 json tag：没有 tag 时 Go 会把导出字段名
// 原样序列化成大写键，前端拿到的就是 Channel/LastSyncAt 这种混着的大小写。
type SyncState struct {
	Channel      string          `json:"channel"`
	LastSyncAt   model.ClockTime `json:"lastSyncAt"`
	LastPushedAt model.ClockTime `json:"lastPushedAt"`
	Note         string          `json:"note"`
}

// GetSyncState 读通道水位；不存在时返回零值。
func (db *DB) GetSyncState(ctx context.Context, channel string) (SyncState, error) {
	var s SyncState
	err := db.sql.QueryRowContext(ctx,
		`SELECT channel, last_sync_at, last_pushed_at, note FROM sync_state WHERE channel = ?`, channel).
		Scan(&s.Channel, &s.LastSyncAt, &s.LastPushedAt, &s.Note)
	if errors.Is(err, sql.ErrNoRows) {
		return SyncState{Channel: channel}, nil
	}
	if err != nil {
		return SyncState{}, fmt.Errorf("store: 读同步水位 %s: %w", channel, err)
	}
	return s, nil
}

// SetSyncState 写通道水位；note 截断到 syncNoteMax，用于放最近一次的冲突或错误摘要。
func (db *DB) SetSyncState(ctx context.Context, s SyncState) error {
	if s.Channel == "" {
		return errors.New("store: 同步水位缺 channel")
	}
	note := s.Note
	if len(note) > syncNoteMax {
		note = note[:syncNoteMax]
	}
	_, err := db.sql.ExecContext(ctx,
		`INSERT INTO sync_state(channel, last_sync_at, last_pushed_at, note) VALUES(?, ?, ?, ?)
		 ON CONFLICT(channel) DO UPDATE SET
			last_sync_at = excluded.last_sync_at,
			last_pushed_at = excluded.last_pushed_at,
			note = excluded.note`,
		s.Channel, s.LastSyncAt, s.LastPushedAt, note)
	if err != nil {
		return fmt.Errorf("store: 写同步水位 %s: %w", s.Channel, err)
	}
	return nil
}
