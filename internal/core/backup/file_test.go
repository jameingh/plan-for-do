package backup

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"planfordo/internal/core/store"
	plansync "planfordo/internal/core/sync"
	"planfordo/internal/core/tclock"
)

// TestExportImportThroughRealDB 走一遍真实链路：写库 → 导出加密文件 →
// 另一个空库 → 解压合并。附件字节也要真的落到目标目录。
func TestExportImportThroughRealDB(t *testing.T) {
	ctx := context.Background()
	srcDir := t.TempDir()
	src, err := store.Open(ctx, srcDir)
	if err != nil {
		t.Fatalf("打开源库: %v", err)
	}
	defer src.Close()

	now := tclock.Now()
	atts := []byte("PNGDATA-1234")
	if err := os.MkdirAll(filepath.Join(srcDir, "attachments"), 0o755); err != nil {
		t.Fatalf("建附件目录: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "attachments", "a1.png"), atts, 0o644); err != nil {
		t.Fatalf("写附件: %v", err)
	}
	mustPut := func(e store.Entity) {
		if err := src.Put(ctx, e); err != nil {
			t.Fatalf("Put %s: %v", e.ID, err)
		}
	}
	mustPut(store.Entity{Kind: "item", ID: "i1", Data: json.RawMessage(`{"title":"写周报"}`), UpdatedAt: now})
	mustPut(store.Entity{Kind: "habit", ID: "h1", Data: json.RawMessage(`{"name":"晨跑"}`), UpdatedAt: now})
	mustPut(store.Entity{Kind: "attachment", ID: "att1",
		Data:      json.RawMessage(`{"id":"att1","ownerKind":"item","ownerId":"i1","path":"attachments/a1.png","mime":"image/png","size":11}`),
		UpdatedAt: now})
	// 一条墓碑：删除也要带过去，否则恢复后它又活了
	mustPut(store.Entity{Kind: "item", ID: "gone", Data: json.RawMessage(`{"title":"删掉的"}`), UpdatedAt: now})
	if err := src.SoftDelete(ctx, "item", "gone", now); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}

	file, sum, err := ExportDB(ctx, src, srcDir, "correct horse", src.DeviceID(), now, true)
	if err != nil {
		t.Fatalf("ExportDB: %v", err)
	}
	if sum.Records == 0 || sum.Attachments != 1 || sum.AttachmentBytes != len(atts) {
		t.Errorf("导出摘要不符：%+v", sum)
	}

	// —— 恢复到一个全新的库 ——
	dstDir := t.TempDir()
	dst, err := store.Open(ctx, dstDir)
	if err != nil {
		t.Fatalf("打开目标库: %v", err)
	}
	defer dst.Close()
	engine := plansync.NewEngine(dst)

	got, err := ImportFile(ctx, file, "correct horse", dstDir, func(ctx context.Context, recs []store.Entity) (int, int, error) {
		return engine.ApplySnapshot(ctx, &plansync.Snapshot{Schema: plansync.SchemaVersion, Records: recs})
	})
	if err != nil {
		t.Fatalf("ImportFile: %v", err)
	}
	if got.Applied != sum.Records {
		t.Errorf("应落库 %d 条，实得 %d", sum.Records, got.Applied)
	}
	if got.SkippedTampered != 0 {
		t.Errorf("不该有被跳过的附件：%+v", got)
	}
	rows, err := dst.Rows(ctx, "", true)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	if len(rows) != sum.Records {
		t.Errorf("目标库记录数 = %d，应为 %d", len(rows), sum.Records)
	}
	var found itemView
	for _, r := range rows {
		if r.Kind == "item" && r.ID == "i1" {
			if err := json.Unmarshal(r.Data, &found); err != nil {
				t.Fatalf("解析 item: %v", err)
			}
		}
	}
	if found.Title != "写周报" {
		t.Errorf("记录内容没恢复：%+v", found)
	}
	if b, err := os.ReadFile(filepath.Join(dstDir, "attachments", "a1.png")); err != nil || string(b) != string(atts) {
		t.Errorf("附件字节没恢复：err=%v len=%d", err, len(b))
	}
}

type itemView struct {
	Title string `json:"title"`
}

// TestImportWrongPasswordLeavesDBAlone 钉住「解不开就一条都不动」：
// 口令错的导入不能先在库里留下一半数据。
func TestImportWrongPasswordLeavesDBAlone(t *testing.T) {
	ctx := context.Background()
	srcDir := t.TempDir()
	src, err := store.Open(ctx, srcDir)
	if err != nil {
		t.Fatalf("打开源库: %v", err)
	}
	defer src.Close()
	if err := src.Put(ctx, store.Entity{Kind: "item", ID: "i1", Data: json.RawMessage(`{"title":"x"}`), UpdatedAt: tclock.Now()}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	file, _, err := ExportDB(ctx, src, srcDir, "correct horse", "dev", tclock.Now(), false)
	if err != nil {
		t.Fatalf("ExportDB: %v", err)
	}

	dstDir := t.TempDir()
	dst, err := store.Open(ctx, dstDir)
	if err != nil {
		t.Fatalf("打开目标库: %v", err)
	}
	defer dst.Close()
	called := false
	_, err = ImportFile(ctx, file, "wrong password", dstDir, func(context.Context, []store.Entity) (int, int, error) {
		called = true
		return 0, 0, nil
	})
	if err == nil {
		t.Fatal("错口令应报错")
	}
	if called {
		t.Error("口令都没解开就调了合并，等于把乱码往库里写")
	}
}

// TestImportSkipsTamperedAttachment：附件字节与校验和不符时跳过，
// 但记录照常合并——坏一张图不该让整份备份白导。
func TestImportSkipsTamperedAttachment(t *testing.T) {
	pw := "correct horse"
	payload := Payload{
		Records:     []store.Entity{{Kind: "item", ID: "i1", Data: json.RawMessage(`{}`), UpdatedAt: tclock.Now()}},
		Attachments: []Attachment{{ID: "a1", Path: "attachments/a1.png", DataBase64: "aGVsbG8=", SHA256: "deadbeef"}},
	}
	file, err := Seal(payload, pw, "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	dstDir := t.TempDir()
	sum, err := ImportFile(context.Background(), file, pw, dstDir, func(context.Context, []store.Entity) (int, int, error) {
		return 1, 0, nil
	})
	if err != nil {
		t.Fatalf("ImportFile: %v", err)
	}
	if sum.SkippedTampered != 1 {
		t.Errorf("被改过的附件应跳过，得 %+v", sum)
	}
	if _, err := os.Stat(filepath.Join(dstDir, "attachments", "a1.png")); !os.IsNotExist(err) {
		t.Error("校验和不对的附件不该写盘")
	}
	if sum.Applied != 1 {
		t.Errorf("记录应照常合并，得 %d", sum.Applied)
	}
}

// TestAttachmentTargetRefusesTraversal：备份文件可以被替换，
// 路径里写 ../../ 就能覆盖库文件或任意位置，必须挡住。
func TestAttachmentTargetRefusesTraversal(t *testing.T) {
	dir := t.TempDir()
	got, err := attachmentTarget(dir, "../../planfordo.db", "id1")
	if err != nil {
		t.Fatalf("attachmentTarget: %v", err)
	}
	want := filepath.Join(dir, "attachments", "planfordo.db")
	if got != want {
		t.Errorf("路径穿越没被压平：%q，应为 %q", got, want)
	}
	if _, err := attachmentTarget(dir, "", ""); err == nil {
		t.Error("既没路径也没 id 时应报错")
	}
}
