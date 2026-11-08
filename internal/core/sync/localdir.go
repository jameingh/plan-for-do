package sync

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"planfordo/internal/core/store"
)

// snapshotFileName 是通道目录里的快照文件名。用固定名字，让「把一个网盘同步目录指进来」
// 这种用法在多台设备上自然对齐。blobFileName 是与它并列的附件字节归档。
const (
	snapshotFileName = "planfordo-snapshot.json"
	blobFileName     = BlobArchiveFileName
)

func init() {
	Register("localdir", newLocalDir)
}

// LocalDir 把一个本地目录当同步盘：可以是任何网盘客户端的同步文件夹。
// 它是第一个能端到端跑通的通道，也是其它通道出问题时的兜底备份。
type LocalDir struct {
	name string
	dir  string
}

func newLocalDir(name string, opts map[string]string) (Channel, error) {
	dir := opts["dir"]
	if dir == "" {
		return nil, errors.New("sync: localdir 通道需要 options.dir")
	}
	return &LocalDir{name: name, dir: dir}, nil
}

// Name 返回通道名。
func (c *LocalDir) Name() string { return c.name }

// Kind 返回通道类型。
func (c *LocalDir) Kind() string { return "localdir" }

// Probe 确认目录可建可写。
func (c *LocalDir) Probe(ctx context.Context) error {
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return fmt.Errorf("sync: 建目录 %s: %w", c.dir, err)
	}
	probe := filepath.Join(c.dir, ".planfordo-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("sync: 目录不可写 %s: %w", c.dir, err)
	}
	if _, err := f.WriteString("ok"); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Remove(probe)
}

func (c *LocalDir) path() string     { return filepath.Join(c.dir, snapshotFileName) }
func (c *LocalDir) blobPath() string { return filepath.Join(c.dir, blobFileName) }

// Load 读快照；文件还不存在时返回空快照而不是报错，首轮同步就是从这个状态起步。
func (c *LocalDir) Load(ctx context.Context) (*Snapshot, error) {
	raw, err := os.ReadFile(c.path())
	if errors.Is(err, os.ErrNotExist) {
		return &Snapshot{Schema: SchemaVersion, Records: []store.Entity{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("sync: 读 %s: %w", c.path(), err)
	}
	return ParseSnapshot(raw)
}

// Save 原子写入：先写临时文件再 rename，避免另一端在半截文件上读到空快照。
func (c *LocalDir) Save(ctx context.Context, s *Snapshot) error {
	return c.saveAt(ctx, s, c.path())
}

// SaveConditional 用文件名里的版本号做粗校验：
// 落盘前重读一次远端版本，若已被别的设备推进过就拒写，让调用方重来一轮。
func (c *LocalDir) SaveConditional(ctx context.Context, s *Snapshot, expectRevision int64) error {
	current, err := c.Load(ctx)
	if err != nil {
		return err
	}
	if current.Revision != expectRevision {
		return fmt.Errorf("sync: 远端版本已从 %d 变为 %d，本轮放弃", expectRevision, current.Revision)
	}
	return c.saveAt(ctx, s, c.path())
}

// LoadBlob 读附件字节归档；文件不存在时返回空归档，首轮同步从这里起步。
func (c *LocalDir) LoadBlob(ctx context.Context) (*BlobArchive, error) {
	raw, err := os.ReadFile(c.blobPath())
	if errors.Is(err, os.ErrNotExist) {
		return NewBlobArchive(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("sync: 读 %s: %w", c.blobPath(), err)
	}
	return ParseBlobArchive(raw)
}

// SaveBlob 与快照同一套原子写：临时文件 + rename，不让另一端读到半截归档。
func (c *LocalDir) SaveBlob(ctx context.Context, a *BlobArchive) error {
	if a == nil {
		return errors.New("sync: blob 归档为空")
	}
	raw, err := a.Bytes()
	if err != nil {
		return err
	}
	return c.writeRaw(c.blobPath(), raw)
}

func (c *LocalDir) saveAt(ctx context.Context, s *Snapshot, dest string) error {
	if s == nil {
		return errors.New("sync: 快照为空")
	}
	raw, err := s.Bytes()
	if err != nil {
		return err
	}
	return c.writeRaw(dest, raw)
}

// writeRaw 是快照与归档共用的原子落盘骨架（结构性抽取，行为不变）。
func (c *LocalDir) writeRaw(dest string, raw []byte) error {
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return fmt.Errorf("sync: 建目录 %s: %w", c.dir, err)
	}
	tmp, err := os.CreateTemp(c.dir, ".planfordo-snapshot-*")
	if err != nil {
		return fmt.Errorf("sync: 建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("sync: 写临时文件: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync: 落盘: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("sync: 关闭临时文件: %w", err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return fmt.Errorf("sync: 替换快照: %w", err)
	}
	return nil
}
