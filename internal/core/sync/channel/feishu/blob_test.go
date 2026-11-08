package feishu

import (
	"context"
	"net/http/httptest"
	"testing"

	coresync "planfordo/internal/core/sync"
)

// 快照与归档是两个独立的 driveObject：各自的正式名与临时名前缀互不干扰。
// 覆盖写快照不能删掉归档，覆盖写归档也不能删掉快照。
func TestDriveBlobRoundTripIsolatedFromSnapshot(t *testing.T) {
	fake := newFakeDrive()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	d, ok := ch.(*Drive)
	if !ok {
		t.Fatalf("Build 返回 %T，不是 *Drive", ch)
	}
	ctx := context.Background()
	if !coresync.SupportsBlobs(d) {
		t.Fatal("feishuDrive 应实现 BlobChannel")
	}

	empty, err := d.LoadBlob(ctx)
	if err != nil || len(empty.Blobs) != 0 {
		t.Fatalf("归档不存在时应返回空归档，得 %+v %v", empty, err)
	}
	want := coresync.NewBlobArchive()
	if err := want.Add("a1.png", []byte("hello-drive")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := d.SaveBlob(ctx, want); err != nil {
		t.Fatalf("SaveBlob: %v", err)
	}
	got, err := d.LoadBlob(ctx)
	if err != nil {
		t.Fatalf("LoadBlob: %v", err)
	}
	if got.Blobs["a1.png"].SHA256 != want.Blobs["a1.png"].SHA256 ||
		got.Blobs["a1.png"].DataBase64 != want.Blobs["a1.png"].DataBase64 {
		t.Fatalf("归档往返内容不一致: %+v", got.Blobs)
	}

	if err := d.Save(ctx, newSnapshot(1)); err != nil {
		t.Fatalf("Save 快照: %v", err)
	}
	if n := len(fake.contentsNamed(DefaultBlobFileName)); n != 1 {
		t.Fatalf("覆盖写快照后归档应仍恰好一份，得 %d 份", n)
	}
	if again, err := d.LoadBlob(ctx); err != nil || len(again.Blobs) != 1 {
		t.Fatalf("覆盖写快照后归档内容丢了: %+v %v", again, err)
	}

	if err := want.Add("b1.png", []byte("second")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := d.SaveBlob(ctx, want); err != nil {
		t.Fatalf("再次 SaveBlob: %v", err)
	}
	if n := len(fake.contentsNamed(DefaultSnapshotFileName)); n != 1 {
		t.Fatalf("覆盖写归档后快照应仍恰好一份，得 %d 份", n)
	}
	if snap, err := d.Load(ctx); err != nil || snap.Revision != 1 {
		t.Fatalf("覆盖写归档后快照内容丢了: %+v %v", snap, err)
	}
}

// feishuBase 明确不支持附件字节：只实现 Channel，不实现 BlobChannel。
// 这条断言是「不实现」这件事的护栏，别哪天顺手给 Base 加个半吊子实现。
func TestBaseExplicitlyDoesNotSupportBlobs(t *testing.T) {
	ch := buildChannel(t, "feishuBase", baseOpts("https://open.feishu.cn"))
	if coresync.SupportsBlobs(ch) {
		t.Fatal("feishuBase 不该实现 BlobChannel")
	}
	if _, ok := ch.(coresync.BlobChannel); ok {
		t.Fatal("feishuBase 不该实现 BlobChannel 的两个方法")
	}
}
