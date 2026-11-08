package sync

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// 一台「带附件目录」的设备：库与 attachments/ 同在一个 dataDir，
// 通道指向所有设备共享的目录。
type blobDevice struct {
	*device
	dataDir string
}

func newBlobDevice(t *testing.T, shared string) *blobDevice {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ch, err := Build(Config{
		Name: "shared", Kind: "localdir", Enabled: true,
		Options: map[string]string{"dir": shared},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return &blobDevice{device: &device{name: db.DeviceID(), db: db, ch: ch}, dataDir: dir}
}

func (d *blobDevice) run(t *testing.T) Result {
	t.Helper()
	res, err := NewEngine(d.db, d.dataDir).Run(context.Background(), d.ch)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return res
}

func (d *blobDevice) attachmentRecord(t *testing.T, id, name string, size int64) {
	t.Helper()
	at, err := d.db.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	att := &model.Attachment{
		ID: id, OwnerKind: "item", OwnerID: "item-1",
		Path: "attachments/" + name, Mime: "image/png", Size: size,
		CreatedAt: at, UpdatedAt: at,
	}
	e, err := store.NewEntity(store.KindAttachment, att)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	if err := d.db.Put(context.Background(), e); err != nil {
		t.Fatalf("Put: %v", err)
	}
}

func (d *blobDevice) putAttachment(t *testing.T, id, name string, data []byte) {
	t.Helper()
	dir := filepath.Join(d.dataDir, "attachments")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	d.attachmentRecord(t, id, name, int64(len(data)))
}

func (d *blobDevice) bytesOf(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(d.dataDir, "attachments", name))
	if err != nil {
		t.Fatalf("读附件 %s: %v", name, err)
	}
	return string(raw)
}

// A 上传附件 → B 同步后文件真的落到 B 的磁盘；B 再加一个附件，
// A 下一轮也能拿到，且归档里两份都在（并集不被覆盖掉）。
func TestBlobChannelTwoDevices(t *testing.T) {
	shared := t.TempDir()
	a, b := newBlobDevice(t, shared), newBlobDevice(t, shared)

	a.putAttachment(t, "att-a", "a1.png", []byte("AAA-bytes"))
	if res := a.run(t); res.BlobsPushed != 1 {
		t.Fatalf("A 首轮应推 1 份字节，得 %+v", res)
	}
	if _, err := os.Stat(filepath.Join(shared, blobFileName)); err != nil {
		t.Fatalf("归档没写出来: %v", err)
	}

	if res := b.run(t); res.BlobsApplied != 1 {
		t.Fatalf("B 应补到 1 份字节，得 %+v", res)
	}
	if got := b.bytesOf(t, "a1.png"); got != "AAA-bytes" {
		t.Fatalf("B 的附件内容 = %q", got)
	}

	b.putAttachment(t, "att-b", "b1.png", []byte("BBB-bytes"))
	if res := b.run(t); res.BlobsPushed != 1 {
		t.Fatalf("B 应只推自己独有的 1 份，得 %+v", res)
	}
	if res := a.run(t); res.BlobsApplied != 1 {
		t.Fatalf("A 应补到 B 的字节，得 %+v", res)
	}
	if got := a.bytesOf(t, "b1.png"); got != "BBB-bytes" {
		t.Fatalf("A 的附件内容 = %q", got)
	}

	raw, err := os.ReadFile(filepath.Join(shared, blobFileName))
	if err != nil {
		t.Fatalf("读归档: %v", err)
	}
	arc, err := ParseBlobArchive(raw)
	if err != nil {
		t.Fatalf("解析归档: %v", err)
	}
	if len(arc.Blobs) != 2 {
		t.Fatalf("归档应保留两份字节的并集，得 %d 条", len(arc.Blobs))
	}
	if !SupportsBlobs(a.ch) {
		t.Fatal("localdir 应实现 BlobChannel")
	}
}

// 通道不实现 BlobChannel（feishuBase 那一类）：记录同步照常完成，
// 字节通路跳过且原因明确回报，不生成归档文件。
type noBlobChannel struct{ Channel }

func TestBlobChannelSkippedWhenUnsupported(t *testing.T) {
	shared := t.TempDir()
	d := newBlobDevice(t, shared)
	d.putAttachment(t, "att-a", "a1.png", []byte("AAA"))

	res, err := NewEngine(d.db, d.dataDir).Run(context.Background(), noBlobChannel{d.ch})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Pushed != 1 {
		t.Fatalf("记录同步不该被字节通路拖住，得 %+v", res)
	}
	if !strings.Contains(res.BlobsSkipped, "不支持") {
		t.Fatalf("跳过原因没回报，得 %+v", res)
	}
	if _, err := os.Stat(filepath.Join(shared, blobFileName)); !os.IsNotExist(err) {
		t.Fatalf("不支持的通道不该生成归档: %v", err)
	}
}

// dataDir 没注入时（只跑记录同步的调用方）行为与旧版一致。
func TestBlobChannelSkippedWithoutDataDir(t *testing.T) {
	d := newBlobDevice(t, t.TempDir())
	d.putAttachment(t, "att-a", "a1.png", []byte("AAA"))
	res, err := NewEngine(d.db).Run(context.Background(), d.ch)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.BlobsSkipped, "附件目录") {
		t.Fatalf("跳过原因没回报，得 %+v", res)
	}
}

// 归档里的校验和/长度对不上：宁可留空位也不写坏图进目录。
func TestBlobSkipsTamperedEntry(t *testing.T) {
	shared := t.TempDir()
	d := newBlobDevice(t, shared)
	arc := NewBlobArchive()
	arc.Blobs["bad.png"] = Blob{
		SHA256: "deadbeef", Size: 3,
		DataBase64: base64.StdEncoding.EncodeToString([]byte("bad")),
	}
	raw, err := arc.Bytes()
	if err != nil {
		t.Fatalf("归档序列化: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shared, blobFileName), raw, 0o644); err != nil {
		t.Fatalf("写归档: %v", err)
	}
	d.attachmentRecord(t, "att-bad", "bad.png", 3) // 只有记录、没有文件

	res := d.run(t)
	if res.BlobsApplied != 0 || res.BlobsRejected != 1 {
		t.Fatalf("坏条目应被跳过，得 %+v", res)
	}
	if _, err := os.Stat(filepath.Join(d.dataDir, "attachments", "bad.png")); !os.IsNotExist(err) {
		t.Fatalf("坏字节不该落盘: %v", err)
	}
}

// 本地留了半截文件（大小与元数据对不上）：按缺失处理，从归档补回完整字节。
func TestBlobRepairsTruncatedFile(t *testing.T) {
	shared := t.TempDir()
	a, b := newBlobDevice(t, shared), newBlobDevice(t, shared)
	data := []byte("full-image-bytes")
	a.putAttachment(t, "att-a", "a1.png", data)
	a.run(t)

	// B 先合并到记录，但磁盘上只有 1 字节的残片。
	b.attachmentRecord(t, "att-a", "a1.png", int64(len(data)))
	if err := os.MkdirAll(filepath.Join(b.dataDir, "attachments"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.dataDir, "attachments", "a1.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if res := b.run(t); res.BlobsApplied != 1 {
		t.Fatalf("半截文件应被补回，得 %+v", res)
	}
	if got := b.bytesOf(t, "a1.png"); got != string(data) {
		t.Fatalf("补回来的内容 = %q", got)
	}
}

func TestBlobNameFlattensPathAndArchiveKeys(t *testing.T) {
	name, err := blobName("attachments/../../planfordo.db", "id1")
	if err != nil || name != "planfordo.db" {
		t.Fatalf("路径应压平成文件名，得 %q %v", name, err)
	}
	name, err = blobName("", "id1")
	if err != nil || name != "id1.bin" {
		t.Fatalf("没路径时应用 id 顶上，得 %q %v", name, err)
	}
	if _, err := blobName("../", ".."); err == nil {
		t.Fatal("路径与 id 都不可用时必须报错")
	}
	// 归档是被别人也能改的文件：含路径分隔符的键一律丢掉。
	arc, err := ParseBlobArchive([]byte(`{"schema":1,"blobs":{"../evil.png":{"dataBase64":"AA=="},"ok.png":{"dataBase64":"AA=="}}}`))
	if err != nil {
		t.Fatalf("ParseBlobArchive: %v", err)
	}
	if len(arc.Blobs) != 1 || arc.Blobs["ok.png"].DataBase64 != "AA==" {
		t.Fatalf("危险键没被过滤: %+v", arc.Blobs)
	}
}

func TestBlobArchiveGuards(t *testing.T) {
	arc := NewBlobArchive()
	// base64 长度要按 3/4 折算回原始字节，超的得是原始字节上限。
	arc.Blobs["huge"] = Blob{DataBase64: strings.Repeat("A", (MaxBlobBytes/3+1)*4)}
	if _, err := arc.Bytes(); !errors.Is(err, ErrBlobTooLarge) {
		t.Fatalf("超上限应明确报错，得 %v", err)
	}
	if _, err := ParseBlobArchive([]byte(`{"schema":99}`)); !errors.Is(err, ErrBlobSchemaMismatch) {
		t.Fatalf("更高协议版本应拒绝，得 %v", err)
	}
	empty, err := ParseBlobArchive([]byte(`{}`))
	if err != nil || empty.Schema != BlobSchemaVersion || empty.Blobs == nil {
		t.Fatalf("空归档应补全默认值，得 %+v %v", empty, err)
	}
}
