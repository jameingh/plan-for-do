package sync

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

type device struct {
	name string
	db   *store.DB
	ch   Channel
}

// newDevice 起一台「设备」：独立的数据目录 + 指向同一个共享目录的 localdir 通道。
func newDevice(t *testing.T, shared string) *device {
	t.Helper()
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ch, err := Build(Config{
		Name:    "shared",
		Kind:    "localdir",
		Enabled: true,
		Options: map[string]string{"dir": shared},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return &device{name: db.DeviceID(), db: db, ch: ch}
}

func (d *device) putItem(t *testing.T, id, title string) store.Entity {
	t.Helper()
	at, err := d.db.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	item := &model.ListItem{ID: id, ListID: model.DefaultListID, Title: title,
		Date: model.DateSpec{Kind: model.DateSingle, Start: "2026-11-05"}, CreatedAt: at, UpdatedAt: at}
	e, err := store.NewEntity(store.KindItem, item)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	if err := d.db.Put(context.Background(), e); err != nil {
		t.Fatalf("Put: %v", err)
	}
	return e
}

func (d *device) itemTitle(t *testing.T, id string) (string, bool) {
	t.Helper()
	row, found, err := d.db.Get(context.Background(), store.KindItem, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !found || !row.Alive() {
		return "", false
	}
	var it model.ListItem
	if err := row.Decode(&it); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return it.Title, true
}

func sync(t *testing.T, d *device) Result {
	t.Helper()
	res, err := NewEngine(d.db).Run(context.Background(), d.ch)
	if err != nil {
		t.Fatalf("Run(%s): %v", d.name, err)
	}
	return res
}

func TestTwoDevicesConverge(t *testing.T) {
	shared := t.TempDir()
	a, b := newDevice(t, shared), newDevice(t, shared)

	a.putItem(t, "item-1", "从 A 建")
	res := sync(t, a)
	if res.Pushed != 1 {
		t.Fatalf("A 首轮应推 1 条，得 %+v", res)
	}

	res = sync(t, b)
	if res.Applied != 1 {
		t.Fatalf("B 应拉到 1 条，得 %+v", res)
	}
	if title, ok := b.itemTitle(t, "item-1"); !ok || title != "从 A 建" {
		t.Fatalf("B 没收到事项：%q %v", title, ok)
	}

	// B 打一次卡，A 下一轮必须看到。
	at, err := b.db.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	ov := &model.OccurrenceOverride{ID: model.OverrideID("item-1", "2026-11-05"), ItemID: "item-1",
		Day: "2026-11-05", Status: model.StatusClocked, ClockedAt: at, CreatedAt: at, UpdatedAt: at}
	e, err := store.NewEntity(store.KindOverride, ov)
	if err != nil {
		t.Fatalf("NewEntity: %v", err)
	}
	if err := b.db.Put(context.Background(), e); err != nil {
		t.Fatalf("Put: %v", err)
	}
	sync(t, b)
	res = sync(t, a)
	if res.Applied != 1 {
		t.Fatalf("A 应拉到打卡，得 %+v", res)
	}
	row, found, err := a.db.Get(context.Background(), store.KindOverride, ov.ID)
	if err != nil || !found || !row.Alive() {
		t.Fatalf("A 没有那条打卡：%v %v", found, err)
	}
}

func TestConcurrentEditsResolveToNewer(t *testing.T) {
	shared := t.TempDir()
	a, b := newDevice(t, shared), newDevice(t, shared)

	a.putItem(t, "item-1", "共同起点")
	sync(t, a)
	sync(t, b)

	// 两端各自改，互不知情。B 的时间戳更晚。
	a.putItem(t, "item-1", "A 的改动")
	b.putItem(t, "item-1", "B 的改动")

	sync(t, b)
	resA := sync(t, a)
	if resA.Conflicts == 0 {
		t.Errorf("同一条记录两端都改过，应当记冲突：%+v", resA)
	}
	if title, _ := a.itemTitle(t, "item-1"); title != "B 的改动" {
		t.Errorf("A 应接受更晚的 B 版本，得到 %q", title)
	}
	sync(t, a)
	sync(t, b)
	ta, _ := a.itemTitle(t, "item-1")
	tb, _ := b.itemTitle(t, "item-1")
	if ta != tb {
		t.Fatalf("两轮之后两端没收敛：A=%q B=%q", ta, tb)
	}
	if ta != "B 的改动" {
		t.Errorf("收敛结果应是较晚的那条，得到 %q", ta)
	}
}

func TestDeletePropagatesAndDoesNotResurrect(t *testing.T) {
	shared := t.TempDir()
	a, b := newDevice(t, shared), newDevice(t, shared)

	a.putItem(t, "item-1", "会被删掉")
	sync(t, a)
	sync(t, b)
	if _, ok := b.itemTitle(t, "item-1"); !ok {
		t.Fatal("B 还没拿到就要删")
	}

	at, err := a.db.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if err := a.db.SoftDelete(context.Background(), store.KindItem, "item-1", at); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	sync(t, a)
	sync(t, b)
	if _, ok := b.itemTitle(t, "item-1"); ok {
		t.Error("删除没传到 B")
	}

	// B 再同步一轮，不能把本地已经没有的行当「远端缺项」而复活。
	res := sync(t, b)
	if res.Pushed > 0 {
		t.Errorf("B 不该再推东西：%+v", res)
	}
	sync(t, a)
	if _, ok := a.itemTitle(t, "item-1"); ok {
		t.Error("删除又复活了")
	}
}

func TestSchemaGuardRefusesNewerRemote(t *testing.T) {
	shared := t.TempDir()
	a := newDevice(t, shared)
	a.putItem(t, "item-1", "x")
	sync(t, a)

	path := filepath.Join(shared, snapshotFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	s.Schema = SchemaVersion + 7
	bumped, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, bumped, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := NewEngine(a.db).Run(context.Background(), a.ch); err == nil {
		t.Fatal("远端协议更新时必须拒绝，不能静默丢字段")
	} else if !strings.Contains(err.Error(), "高于本机") {
		t.Fatalf("错误信息不符期望: %v", err)
	}
}

func TestConditionalSaveRefusesStaleRevision(t *testing.T) {
	shared := t.TempDir()
	a, b := newDevice(t, shared), newDevice(t, shared)

	cc, ok := a.ch.(ConditionalChannel)
	if !ok {
		t.Fatal("localdir 应实现 ConditionalChannel")
	}
	a.putItem(t, "item-1", "A")
	sync(t, a)

	current, err := a.ch.Load(context.Background())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	b.putItem(t, "item-2", "B")
	sync(t, b) // 远端版本被 B 推进

	if err := cc.SaveConditional(context.Background(), current, current.Revision); err == nil {
		t.Fatal("版本已变，条件写必须失败")
	}
	if err := cc.SaveConditional(context.Background(), current, 999); err == nil {
		t.Fatal("期望版本错了也必须失败")
	}

	// A 重来一轮就该拿到 B 的东西并顺利推上去。
	res := sync(t, a)
	if res.Applied != 1 {
		t.Fatalf("A 重跑应拉到 B 的新项：%+v", res)
	}
	if _, ok := a.itemTitle(t, "item-2"); !ok {
		t.Error("A 没收敛到 item-2")
	}
}

func TestManagerConfigAndSyncAll(t *testing.T) {
	shared := t.TempDir()
	a := newDevice(t, shared)
	ctx := context.Background()
	m := NewManager(a.db)

	if err := m.SaveConfig(ctx, Config{Name: "shared", Kind: "localdir", Enabled: true,
		Options: map[string]string{"dir": shared}}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if err := m.SaveConfig(ctx, Config{Name: "off", Kind: "localdir", Enabled: false,
		Options: map[string]string{"dir": shared}}); err != nil {
		t.Fatalf("SaveConfig off: %v", err)
	}
	list, err := m.Configs(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("Configs len=%d err=%v", len(list), err)
	}
	if err := m.SaveConfig(ctx, Config{Name: "shared", Kind: "localdir", Enabled: true,
		Options: map[string]string{"dir": shared}}); err != nil {
		t.Fatalf("覆盖同名: %v", err)
	}
	if list, err = m.Configs(ctx); err != nil || len(list) != 2 {
		t.Fatalf("同名应覆盖而不是追加：len=%d err=%v", len(list), err)
	}
	if err := m.SaveConfig(ctx, Config{Name: "bad", Kind: "nope"}); err == nil {
		t.Error("未注册类型必须报错")
	}
	if err := m.Probe(ctx, Config{Name: "p", Kind: "webdav-missing"}); err == nil {
		t.Error("Probe 未注册类型必须报错")
	}

	a.putItem(t, "item-1", "走配置")
	results, err := m.SyncAll(ctx)
	if err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("只该跑启用的那条：%+v", results)
	}
	if results[0].Channel != "shared" || results[0].Pushed != 1 {
		t.Errorf("结果不符：%+v", results[0])
	}
	if _, err := m.SyncOne(ctx, "不存在"); err == nil {
		t.Error("SyncOne 对未知通道必须报错")
	}
	if err := m.RemoveConfig(ctx, "off"); err != nil {
		t.Fatalf("RemoveConfig: %v", err)
	}
	if err := m.RemoveConfig(ctx, "off"); err == nil {
		t.Error("重复删除必须报错")
	}
	state, err := m.State(ctx, "shared")
	if err != nil || state.LastSyncAt == "" {
		t.Fatalf("同步水位没落下：%+v err=%v", state, err)
	}
}

// TestConfigsNeverMarshalNull 锁住「新设备一次同步都没配」这条最常见路径。
// nil 切片/nil map 序列化出来是 null，设置页 channels.length 与 Object.keys(options)
// 都会当场崩——而这条路径在开发机上永远走不到，因为开发目录里总有通道。
func TestConfigsNeverMarshalNull(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	m := NewManager(db)

	list, err := m.Configs(ctx)
	if err != nil {
		t.Fatalf("Configs: %v", err)
	}
	if list == nil {
		t.Fatal("没有任何通道时返回了 nil 切片")
	}
	raw, err := json.Marshal(list)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(raw) != "[]" {
		t.Errorf("空配置应序列化成 []，实得 %s", raw)
	}

	// 建一条没有 Options 的通道也不行：options 不能是 null。
	if err := m.SaveConfig(ctx, Config{Name: "shared", Kind: "localdir", Enabled: true,
		Options: map[string]string{"dir": t.TempDir()}}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	list, err = m.Configs(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("Configs len=%d err=%v", len(list), err)
	}
	if list[0].Options == nil {
		t.Error("Options 为 nil map")
	}
	raw, err = json.Marshal(list)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(raw), "null") {
		t.Errorf("通道配置里出现 null，前端会崩：%s", raw)
	}
}

func TestSnapshotRoundTripKeepsTombstones(t *testing.T) {
	shared := t.TempDir()
	a := newDevice(t, shared)
	ctx := context.Background()

	e := a.putItem(t, "item-1", "删我")
	at, err := a.db.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if err := a.db.SoftDelete(ctx, store.KindItem, e.ID, at); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	sync(t, a)

	raw, err := os.ReadFile(filepath.Join(shared, snapshotFileName))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	s, err := ParseSnapshot(raw)
	if err != nil {
		t.Fatalf("ParseSnapshot: %v", err)
	}
	if len(s.Records) != 1 || s.Records[0].DeletedAt == "" {
		t.Fatalf("快照必须带 tombstone，否则删除不会传播：%+v", s.Records)
	}
	if s.DeviceID == "" || s.Revision == 0 || s.SyncedAt == "" {
		t.Errorf("快照头不完整：%+v", s)
	}
	if !tclock.IsNewer(s.SyncedAt, "") {
		t.Error("SyncedAt 应当可用")
	}
}
