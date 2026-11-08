package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"
	"testing"

	"planfordo/internal/core/model"
	"planfordo/internal/core/tclock"
)

func openDB(t *testing.T) (*DB, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db, dir
}

func mustTick(t *testing.T, db *DB) model.ClockTime {
	t.Helper()
	at, err := db.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	return at
}

func itemEntity(t *testing.T, db *DB, itemID, day string) Entity {
	t.Helper()
	item := &model.ListItem{
		ID:       itemID,
		ListID:   model.DefaultListID,
		Title:    "写周报",
		Date:     model.DateSpec{Kind: model.DateSingle, Start: day},
		Priority: model.QuadrantImportant,
	}
	item.CreatedAt = mustTick(t, db)
	item.UpdatedAt = item.CreatedAt
	e, err := NewEntity(KindItem, item)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	return e
}

func TestOpenMigratesAndKeepsDevice(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first := db.DeviceID()
	if first == "" {
		t.Fatal("DeviceID 为空")
	}
	if got := filepath.Base(db.Path()); got != "planfordo.db" {
		t.Errorf("库文件名 = %q", got)
	}
	rows, err := db.Rows(context.Background(), "", true)
	if err != nil || len(rows) != 0 {
		t.Errorf("迁移后应可读写空表：%v err=%v", rows, err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	again, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("重开: %v", err)
	}
	defer again.Close()
	if again.DeviceID() != first {
		t.Errorf("重开后 DeviceID 变了：%q → %q", first, again.DeviceID())
	}
}

func TestTickIsMonotonicAcrossClockRollback(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)

	seen := map[model.ClockTime]bool{}
	for i := 0; i < 200; i++ {
		at := mustTick(t, db)
		if seen[at] {
			t.Fatalf("第 %d 次 Tick 重复：%s", i, at)
		}
		seen[at] = true
	}

	// 模拟系统时钟回拨：把水位推到未来，后续发号必须继续递增而不是退回 now。
	future := tclock.Millis(tclock.Now()) + 3_600_000
	if err := db.MetaSet(ctx, "clock.tick", strconv.FormatInt(future, 10)); err != nil {
		t.Fatalf("MetaSet: %v", err)
	}
	rolled := mustTick(t, db)
	if tclock.Millis(rolled) <= future {
		t.Fatalf("时钟回拨后发号倒退：%s (水位 %d)", rolled, future)
	}
}

func TestPutGetRoundTripKeepsDerivedColumns(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)
	e := itemEntity(t, db, "item-1", "2026-11-05")
	if err := db.Put(ctx, e); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if e.Day != "2026-11-05" || e.Parent != model.DefaultListID {
		t.Errorf("派生列 day=%q parent=%q", e.Day, e.Parent)
	}

	got, found, err := db.Get(ctx, KindItem, "item-1")
	if err != nil || !found {
		t.Fatalf("Get found=%v err=%v", found, err)
	}
	var item model.ListItem
	if err := got.Decode(&item); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if item.Title != "写周报" || item.Priority != model.QuadrantImportant {
		t.Errorf("还原结果不符：%+v", item)
	}
	if item.Repeat != nil {
		t.Errorf("nil 指针不该被同步回来：%+v", item.Repeat)
	}
}

func TestNewEntityRejectsBadInput(t *testing.T) {
	if _, err := NewEntity(KindItem, &model.ListItem{ID: "x", UpdatedAt: ""}); err == nil {
		t.Error("缺 updatedAt 应当报错，否则同步无法比较新旧")
	}
	if _, err := NewEntity(KindItem, &struct{ ID string }{"x"}); err == nil {
		t.Error("未登记类型应当报错")
	}
	if _, err := NewEntity(KindItem, &model.ListItem{}); err == nil {
		t.Error("缺 ID 应当报错")
	}
}

func TestByParentAndByDay(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)
	at := mustTick(t, db)

	ovr := &model.OccurrenceOverride{
		ID:        model.OverrideID("item-1", "2026-11-05"),
		ItemID:    "item-1",
		Day:       "2026-11-05",
		Status:    model.StatusClocked,
		ClockedAt: at,
		UpdatedAt: at,
	}
	e, err := NewEntity(KindOverride, ovr)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	if err := db.Put(ctx, e); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if e.ID != "ovr:item-1:2026-11-05" || e.Parent != "item-1" || e.Status != int(model.StatusClocked) {
		t.Errorf("override 派生列不符：%+v", e)
	}

	byParent, err := db.ByParent(ctx, KindOverride, "item-1")
	if err != nil || len(byParent) != 1 {
		t.Fatalf("ByParent len=%d err=%v", len(byParent), err)
	}
	byDay, err := db.ByDay(ctx, KindOverride, "2026-11-05")
	if err != nil || len(byDay) != 1 {
		t.Fatalf("ByDay len=%d err=%v", len(byDay), err)
	}
	if none, err := db.ByDay(ctx, KindOverride, "2026-11-06"); err != nil || len(none) != 0 {
		t.Fatalf("不相干的日期查出了东西：%v %v", none, err)
	}
}

func TestSoftDeleteTombstoneStillPropagates(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)

	earlier := mustTick(t, db)
	db.Put(ctx, itemEntity(t, db, "item-1", "2026-11-05"))

	watermark := mustTick(t, db)
	if err := db.SoftDelete(ctx, KindItem, "item-1", watermark); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	live, err := db.Rows(ctx, KindItem, false)
	if err != nil || len(live) != 0 {
		t.Fatalf("存活行应清空：len=%d err=%v", len(live), err)
	}
	all, err := db.Rows(ctx, KindItem, true)
	if err != nil || len(all) != 1 || all[0].DeletedAt == "" {
		t.Fatalf("tombstone 应保留：%v err=%v", all, err)
	}
	// 严格大于水位：删除时刻就是水位，所以此刻没有待推送的变更。
	if changed, err := db.ChangedSince(ctx, watermark); err != nil || len(changed) != 0 {
		t.Fatalf("水位之后的变更 = %v err=%v, want 空", changed, err)
	}
	// 往回取水位之前的变更，必须包含这条 tombstone，否则删除会在别的设备上复活。
	changed, err := db.ChangedSince(ctx, earlier)
	if err != nil || len(changed) != 1 || changed[0].DeletedAt == "" {
		t.Fatalf("增量里的 tombstone 丢失：len=%d err=%v", len(changed), err)
	}

	if n, err := db.CompactTombstones(ctx, mustTick(t, db)); err != nil || n != 1 {
		t.Fatalf("CompactTombstones n=%d err=%v, want 1", n, err)
	}
	if all, err := db.Rows(ctx, KindItem, true); err != nil || len(all) != 0 {
		t.Fatalf("清理后仍有残留：%v", all)
	}
	if _, err := db.CompactTombstones(ctx, ""); err == nil {
		t.Error("没有水位时不允许清理，否则删除无法传播")
	}
}

func TestMergeRemoteConflictRules(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)

	localOld := itemEntity(t, db, "item-1", "2026-11-05")
	var item model.ListItem
	if err := localOld.Decode(&item); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	item.Title = "本地旧"
	localOld.UpdatedAt = mustTick(t, db)
	localOld.Data = mustJSON(t, &item)
	if err := db.Put(ctx, localOld); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// 远端更旧 → 忽略
	remoteStale := localOld
	remoteStale.UpdatedAt = "2000-01-01T00:00:00.000Z"
	remoteStale.Data = mustJSON(t, &model.ListItem{ID: "item-1", Title: "远端旧", UpdatedAt: remoteStale.UpdatedAt})
	applied, err := db.MergeRemote(ctx, remoteStale)
	if err != nil || applied {
		t.Fatalf("更旧的远端记录不该覆盖本地：applied=%v err=%v", applied, err)
	}

	// 远端更新 → 覆盖
	remoteNew := localOld
	remoteNew.UpdatedAt = mustTick(t, db)
	remoteNew.Data = mustJSON(t, &model.ListItem{ID: "item-1", Title: "远端新", UpdatedAt: remoteNew.UpdatedAt})
	applied, err = db.MergeRemote(ctx, remoteNew)
	if err != nil || !applied {
		t.Fatalf("更新的远端记录应覆盖本地：applied=%v err=%v", applied, err)
	}

	// 同刻真冲突 → 内容字典序大者胜。规则两端对称，两台设备才会收敛到同一条记录。
	a := localOld
	a.ID, a.UpdatedAt = "item-tie", remoteNew.UpdatedAt
	a.Data = mustJSON(t, &model.ListItem{ID: "item-tie", Title: "aaa 落败", UpdatedAt: a.UpdatedAt})
	if applied, err := db.MergeRemote(ctx, a); err != nil || !applied {
		t.Fatalf("首次写入应成功：applied=%v err=%v", applied, err)
	}
	b := a
	b.Data = mustJSON(t, &model.ListItem{ID: "item-tie", Title: "zzz 胜出", UpdatedAt: b.UpdatedAt})
	if applied, err := db.MergeRemote(ctx, b); err != nil || !applied {
		t.Fatalf("同刻冲突应取内容较大者：applied=%v err=%v", applied, err)
	}
	if applied, err := db.MergeRemote(ctx, a); err != nil || applied {
		t.Fatalf("同刻且内容较小的一边不该赢：applied=%v err=%v", applied, err)
	}

	got, _, err := db.Get(ctx, KindItem, "item-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	var final model.ListItem
	if err := got.Decode(&final); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if final.Title != "远端新" {
		t.Errorf("最终标题 = %q", final.Title)
	}
}

func TestSyncStateAndCounts(t *testing.T) {
	ctx := context.Background()
	db, _ := openDB(t)

	state, err := db.GetSyncState(ctx, "localdir")
	if err != nil {
		t.Fatalf("空水位: %v", err)
	}
	if state.Channel != "localdir" || state.LastSyncAt != "" {
		t.Errorf("不存在的通道应返回零值：%+v", state)
	}
	at := mustTick(t, db)
	if err := db.SetSyncState(ctx, SyncState{Channel: "localdir", LastSyncAt: at, LastPushedAt: at, Note: "ok"}); err != nil {
		t.Fatalf("SetSyncState: %v", err)
	}
	got, err := db.GetSyncState(ctx, "localdir")
	if err != nil || got.LastSyncAt != at || got.Note != "ok" {
		t.Fatalf("水位读写不符：%+v err=%v", got, err)
	}
	if err := db.SetSyncState(ctx, SyncState{Channel: ""}); err == nil {
		t.Error("空 channel 应报错")
	}

	db.Put(ctx, itemEntity(t, db, "item-1", "2026-11-05"))
	db.Put(ctx, itemEntity(t, db, "item-2", "2026-11-06"))
	counts, err := db.CountByKind(ctx)
	if err != nil {
		t.Fatalf("CountByKind: %v", err)
	}
	if counts[KindItem] != 2 {
		t.Errorf("items = %d, want 2", counts[KindItem])
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return raw
}
