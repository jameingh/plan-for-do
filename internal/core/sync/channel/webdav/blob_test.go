package webdav

import (
	"context"
	"testing"

	"planfordo/internal/core/sync"
)

// 归档与快照同目录共存：往返读写不能碰快照对象，也不能污染
// SaveConditional 依赖的 ETag 校验值。
func TestBlobRoundTripKeepsSnapshotUntouched(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	c := buildChannel(t, srv.URL, authOpts("basic"))
	ctx := context.Background()
	if !sync.SupportsBlobs(c) {
		t.Fatal("webdav 应实现 BlobChannel")
	}

	empty, err := c.LoadBlob(ctx)
	if err != nil || len(empty.Blobs) != 0 {
		t.Fatalf("归档不存在时应返回空归档，得 %+v %v", empty, err)
	}
	want := sync.NewBlobArchive()
	if err := want.Add("a1.png", []byte("hello-webdav")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := c.SaveBlob(ctx, want); err != nil {
		t.Fatalf("SaveBlob: %v", err)
	}
	got, err := c.LoadBlob(ctx)
	if err != nil {
		t.Fatalf("LoadBlob: %v", err)
	}
	if got.Blobs["a1.png"].SHA256 != want.Blobs["a1.png"].SHA256 ||
		got.Blobs["a1.png"].DataBase64 != want.Blobs["a1.png"].DataBase64 {
		t.Fatalf("归档往返内容不一致: %+v", got.Blobs)
	}

	stub.mu.Lock()
	_, snapshotTouched := stub.objs["/dav/"+snapshotFileName]
	blobObj := stub.objs["/dav/"+blobFileName]
	stub.mu.Unlock()
	if snapshotTouched {
		t.Fatal("归档读写不该创建或覆盖快照对象")
	}
	if blobObj == nil {
		t.Fatal("归档没落在与快照同目录的固定文件名上")
	}

	// 归档请求不能改写 setValidator：Load → SaveConditional 这条主链路仍要成立。
	snap, err := c.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := c.SaveConditional(ctx, testSnap(1, "条件写"), snap.Revision); err != nil {
		t.Fatalf("归档读写后快照条件写失败: %v", err)
	}
}
