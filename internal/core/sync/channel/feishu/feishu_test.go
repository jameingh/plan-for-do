package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"planfordo/internal/core/store"
	coresync "planfordo/internal/core/sync"
)

// testSecret 用来验证错误信息不回显凭证。
const testSecret = "SEC-DO-NOT-LOG"

func useFastBackoff(t *testing.T) {
	t.Helper()
	oldDelay, oldMax := retryBaseDelay, maxAttempts
	retryBaseDelay = time.Millisecond
	t.Cleanup(func() { retryBaseDelay, maxAttempts = oldDelay, oldMax })
}

func testEntity(kind, id, title string, status int) store.Entity {
	data, _ := json.Marshal(map[string]any{"id": id, "title": title})
	return store.Entity{Kind: kind, ID: id, UpdatedAt: "2026-11-05T00:00:00.000Z", Status: status, Data: data}
}

func newSnapshot(rev int64, recs ...store.Entity) *coresync.Snapshot {
	return &coresync.Snapshot{
		Schema: coresync.SchemaVersion, DeviceID: "devA",
		SyncedAt: "2026-11-05T00:00:01.000Z", Revision: rev, Records: recs,
	}
}

func diffRecords(t *testing.T, want, got []store.Entity) {
	t.Helper()
	render := func(recs []store.Entity) map[string]string {
		out := map[string]string{}
		for _, e := range recs {
			out[e.Kind+"/"+e.ID] = string(e.Data) + "|" + e.UpdatedAt + "|" + strconv.Itoa(e.Status) + "|" + strconv.Itoa(e.Sort)
		}
		return out
	}
	w, g := render(want), render(got)
	if len(w) != len(g) {
		t.Fatalf("记录条数不一致 want %d got %d: %v", len(w), len(g), g)
	}
	for k, v := range w {
		if g[k] != v {
			t.Fatalf("记录 %s 不一致:\nwant %s\ngot  %s", k, v, g[k])
		}
	}
}

func assertNoSecret(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	for _, leak := range []string{testSecret, "Bearer ", "app_secret"} {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("错误信息泄露了 %q: %v", leak, err)
		}
	}
}

func driveOpts(baseURL string) map[string]string {
	return map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": baseURL, "folderToken": "fld-1"}
}

func baseOpts(baseURL string) map[string]string {
	return map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": baseURL, "appToken": "bascX"}
}

// buildChannel 各通道测试的公共入口：都走 Install + sync.Build，顺带验证注册链路。
func buildChannel(t *testing.T, kind string, opts map[string]string) coresync.Channel {
	t.Helper()
	Install()
	ch, err := coresync.Build(coresync.Config{Name: "ch-" + kind, Kind: kind, Enabled: true, Options: opts})
	if err != nil {
		assertNoSecret(t, err)
		t.Fatalf("Build(%s): %v", kind, err)
	}
	return ch
}

func TestTenantTokenCachedAndRefreshedOnceOn401(t *testing.T) {
	useFastBackoff(t)
	var mu stdsync.Mutex
	tokenCalls, pingHits := 0, 0
	var authSeen []string
	mux := http.NewServeMux()
	mux.HandleFunc(pathTenantToken, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		tokenCalls++
		n := tokenCalls
		mu.Unlock()
		fmt.Fprintf(w, `{"code":0,"msg":"ok","tenant_access_token":"t-%d","expire":7200}`, n)
	})
	mux.HandleFunc("/open-apis/ping", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authSeen = append(authSeen, r.Header.Get("Authorization"))
		pingHits++
		hit := pingHits
		mu.Unlock()
		if hit == 2 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{"ok":true}}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cli, err := newClient(map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := cli.callJSON(ctx, http.MethodGet, "/open-apis/ping", nil, nil, ""); err != nil {
		t.Fatalf("首次调用: %v", err)
	}
	// 第二发吃到 401：应当刷新 token 后重试同一请求并成功，业务层无感。
	if _, err := cli.callJSON(ctx, http.MethodGet, "/open-apis/ping", nil, nil, ""); err != nil {
		t.Fatalf("401 后应自动刷新重试: %v", err)
	}
	if tokenCalls != 2 {
		t.Errorf("token 应缓存复用、401 时恰好续签一次，实际取了 %d 次", tokenCalls)
	}
	want := []string{"Bearer t-1", "Bearer t-1", "Bearer t-2"}
	if strings.Join(authSeen, ",") != strings.Join(want, ",") {
		t.Errorf("Authorization 头序列 = %v，想要 %v", authSeen, want)
	}
}

func TestUnrecoverable401StopsAfterOneRefresh(t *testing.T) {
	useFastBackoff(t)
	var mu stdsync.Mutex
	tokenCalls := 0
	mux := http.NewServeMux()
	mux.HandleFunc(pathTenantToken, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		tokenCalls++
		n := tokenCalls
		mu.Unlock()
		fmt.Fprintf(w, `{"code":0,"msg":"ok","tenant_access_token":"t-%d","expire":7200}`, n)
	})
	mux.HandleFunc("/open-apis/ping", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cli, _ := newClient(map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": srv.URL})
	_, err := cli.callJSON(context.Background(), http.MethodGet, "/open-apis/ping", nil, nil, "")
	if err == nil || !strings.Contains(err.Error(), "刷新") {
		t.Fatalf("持续 401 应报错，得到: %v", err)
	}
	if tokenCalls != 2 {
		t.Errorf("401 只允许刷新一次，token 取了 %d 次", tokenCalls)
	}
	assertNoSecret(t, err)
}

func TestRateLimitCodeBackoffThenSuccess(t *testing.T) {
	useFastBackoff(t)
	var mu stdsync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc(pathTenantToken, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"code":0,"msg":"ok","tenant_access_token":"t-1","expire":7200}`)
	})
	mux.HandleFunc("/open-apis/x", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		my := n
		mu.Unlock()
		if my <= 2 {
			fmt.Fprint(w, `{"code":99991400,"msg":"操作过于频繁","data":{}}`)
			return
		}
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{"v":1}}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cli, _ := newClient(map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": srv.URL})
	data, err := cli.callJSON(context.Background(), http.MethodGet, "/open-apis/x", nil, nil, "")
	if err != nil {
		t.Fatalf("限流码应退避后重试直至成功: %v", err)
	}
	if !strings.Contains(string(data), `"v":1`) {
		t.Errorf("data = %s", data)
	}
	if n != 3 {
		t.Errorf("请求次数 = %d，想要 3", n)
	}
}

func TestRateLimitExhaustedReturnsError(t *testing.T) {
	useFastBackoff(t)
	maxAttempts = 3
	var mu stdsync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc(pathTenantToken, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"code":0,"msg":"ok","tenant_access_token":"t-1","expire":7200}`)
	})
	mux.HandleFunc("/open-apis/x", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		mu.Unlock()
		fmt.Fprint(w, `{"code":99991400,"msg":"操作过于频繁","data":{}}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cli, _ := newClient(map[string]string{"appId": "cli_a", "appSecret": testSecret, "baseUrl": srv.URL})
	_, err := cli.callJSON(context.Background(), http.MethodGet, "/open-apis/x", nil, nil, "")
	if err == nil || !strings.Contains(err.Error(), "重试 3 次") {
		t.Fatalf("超限后应放弃并报错，得到: %v", err)
	}
	if n != 3 {
		t.Errorf("请求必须设上限，实际发了 %d 次", n)
	}
	assertNoSecret(t, err)
}

// ---------- 云盘通道 ----------

type driveNode struct {
	name    string
	content string
	created int
}

type fakeDrive struct {
	mu         stdsync.Mutex
	files      map[string]*driveNode
	seq        int
	tokenCalls int
	faults     map[string]int // "upload"|"delete" → 剩余注入次数
	// lastUploadSize / lastUploadName 记录 upload_all 收到的关键字段，
	// 给「必填 size」「必须以正式名直传」两条回归护栏用。
	lastUploadSize string
	lastUploadName string
	// renameCalls 是护栏：飞书 v1 根本没有改名接口，代码不该再发这种请求。
	renameCalls int
	// deleteFault* 模拟「删除返回业务错误」的两种真实情形：另一轮已经删掉
	// （文件不在，1061001/1061007）与文件仍在不让删。
	deleteFaultName    string
	deleteFaultCode    int
	deleteFaultRemoves bool
	// duplicateOnUpload 模拟另一轮并发在上传完成后也写了一份同名文件。
	duplicateOnUpload bool
}

func newFakeDrive() *fakeDrive {
	return &fakeDrive{files: map[string]*driveNode{}, faults: map[string]int{}}
}

func (f *fakeDrive) hitLocked(op string) bool {
	if f.faults[op] > 0 {
		f.faults[op]--
		return true
	}
	return false
}

func rateLimitReply(w http.ResponseWriter) {
	fmt.Fprint(w, `{"code":99991400,"msg":"操作过于频繁","data":{}}`)
}

func (f *fakeDrive) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == pathTenantToken {
		f.tokenCalls++
		fmt.Fprintf(w, `{"code":0,"msg":"ok","tenant_access_token":"t-%d","expire":7200}`, f.tokenCalls)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	dl := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, pathDriveList+"/"), "/download")
	switch {
	case r.URL.Path == pathDriveList && r.Method == http.MethodGet:
		type entry struct {
			Token   string `json:"token"`
			Name    string `json:"name"`
			Type    string `json:"type"`
			Created int    `json:"created_at"`
		}
		var list []entry
		for tok, n := range f.files {
			list = append(list, entry{Token: tok, Name: n.name, Type: "file", Created: n.created})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Token < list[j].Token })
		if list == nil {
			list = []entry{}
		}
		payload, _ := json.Marshal(map[string]any{"files": list, "has_more": false, "page_token": ""})
		fmt.Fprintf(w, `{"code":0,"msg":"ok","data":%s}`, payload)
	case r.URL.Path == pathDriveUpload && r.Method == http.MethodPost:
		if f.hitLocked("upload") {
			rateLimitReply(w)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			fmt.Fprintf(w, `{"code":2,"msg":"坏的多部分请求: %s"}`, err)
			return
		}
		f.lastUploadSize = r.FormValue("size")
		name := r.FormValue("file_name")
		f.lastUploadName = name
		fh, _, err := r.FormFile("file")
		if err != nil {
			fmt.Fprintf(w, `{"code":2,"msg":"缺文件段: %s"}`, err)
			return
		}
		defer fh.Close()
		buf, err := io.ReadAll(fh)
		if err != nil {
			fmt.Fprintf(w, `{"code":2,"msg":"读文件失败: %s"}`, err)
			return
		}
		f.seq++
		tok := fmt.Sprintf("f%d", f.seq)
		f.files[tok] = &driveNode{name: name, content: string(buf), created: f.seq}
		if f.duplicateOnUpload {
			f.seq++
			f.files[fmt.Sprintf("f%d", f.seq)] = &driveNode{name: name, content: "concurrent-copy", created: f.seq}
		}
		fmt.Fprintf(w, `{"code":0,"msg":"ok","data":{"file_token":%q}}`, tok)
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/download"):
		node, ok := f.files[dl]
		if !ok {
			fmt.Fprint(w, `{"code":1,"msg":"文件不存在"}`)
			return
		}
		w.Write([]byte(node.content))
	case r.Method == http.MethodPatch && strings.HasSuffix(r.URL.Path, "/rename"):
		// 护栏：真实飞书对这个名字返回 HTTP 404 + 纯文本 "404 page not found"。
		// 一旦代码又去调改名接口，这里计数并把错误暴露出来。
		f.renameCalls++
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "404 page not found")
	case r.Method == http.MethodDelete:
		if f.hitLocked("delete") {
			rateLimitReply(w)
			return
		}
		if n, ok := f.files[dl]; ok && f.deleteFaultCode != 0 && n.name == f.deleteFaultName {
			if f.deleteFaultRemoves {
				delete(f.files, dl)
			}
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, `{"code":%d,"msg":"injected delete failure","data":{}}`, f.deleteFaultCode)
			return
		}
		if _, ok := f.files[dl]; !ok {
			fmt.Fprint(w, `{"code":1,"msg":"文件不存在"}`)
			return
		}
		delete(f.files, dl)
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{}}`)
	default:
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `{"code":404,"msg":"no route %s"}`, r.URL.Path)
	}
}

func (f *fakeDrive) contentsNamed(name string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for tok, n := range f.files {
		if n.name == name {
			out[tok] = n.content
		}
	}
	return out
}

func (f *fakeDrive) allContents() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, n := range f.files {
		out = append(out, n.content)
	}
	return out
}

func (f *fakeDrive) fileCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.files)
}

func (f *fakeDrive) setFault(op string, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.faults[op] = times
}

func (f *fakeDrive) lastUploadedName() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastUploadName
}

func (f *fakeDrive) renameAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.renameCalls
}

// seedStale 塞一个旧版本失败轮遗留的过渡文件，用来验证新代码会顺手回收它。
func (f *fakeDrive) seedStale(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files["stale"] = &driveNode{name: name, content: "stale", created: 0}
}

func (f *fakeDrive) setDeleteFault(name string, code int, removes bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteFaultName, f.deleteFaultCode, f.deleteFaultRemoves = name, code, removes
}

func (f *fakeDrive) seedNamed(token, name, content string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[token] = &driveNode{name: name, content: content, created: 0}
}

func TestDriveProbeSaveLoadRoundTrip(t *testing.T) {
	useFastBackoff(t)
	fake := newFakeDrive()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	ctx := context.Background()

	if err := ch.Probe(ctx); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if n := fake.fileCount(); n != 0 {
		t.Errorf("Probe 的写探针应自清理，残留 %d 个文件", n)
	}

	snapA := newSnapshot(7,
		testEntity(store.KindItem, "i1", "买牛奶", 1),
		testEntity(store.KindItem, "i2", "写周报", 0))
	if err := ch.Save(ctx, snapA); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := ch.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	diffRecords(t, snapA.Records, got.Records)
	if got.Revision != 7 || got.DeviceID != "devA" {
		t.Errorf("水位还原错误: rev=%d device=%q", got.Revision, got.DeviceID)
	}

	// 覆盖写：替换后目录里只允许有一份正式快照，旧内容不残留。
	snapB := newSnapshot(8, testEntity(store.KindItem, "i1", "买豆浆", 2))
	if err := ch.Save(ctx, snapB); err != nil {
		t.Fatalf("覆盖写 Save: %v", err)
	}
	got, err = ch.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	diffRecords(t, snapB.Records, got.Records)
	wantRaw, _ := snapB.Bytes()
	named := fake.contentsNamed(DefaultSnapshotFileName)
	if len(named) != 1 {
		t.Fatalf("同名快照文件 %d 份，覆盖语义失败", len(named))
	}
	for _, c := range named {
		if c != string(wantRaw) {
			t.Errorf("远端内容不是最新快照")
		}
	}
	if n := fake.fileCount(); n != 1 {
		t.Errorf("过渡临时文件没被回收，剩 %d 个文件", n)
	}

	cc, ok := ch.(coresync.ConditionalChannel)
	if !ok {
		t.Fatal("feishuDrive 应实现 ConditionalChannel")
	}
	if err := cc.SaveConditional(ctx, newSnapshot(9), 123); err == nil ||
		!strings.Contains(err.Error(), "放弃") {
		t.Errorf("版本不符应拒写: %v", err)
	}
	if err := cc.SaveConditional(ctx, newSnapshot(9, testEntity(store.KindItem, "i1", "买酱油", 0)), 8); err != nil {
		t.Fatalf("版本相符应写入: %v", err)
	}
	got, _ = ch.Load(ctx)
	if got.Revision != 9 {
		t.Errorf("条件写后 rev = %d", got.Revision)
	}
}

// 上传失败时远端必须完好保留旧快照：新流程先以正式名上传，失败就没产生新文件，
// 不存在「旧文件已删、新文件还没发布」的空窗——旧 rename 方案正是死在这里。
func TestDriveUploadFaultKeepsOldSnapshot(t *testing.T) {
	useFastBackoff(t)
	maxAttempts = 2
	fake := newFakeDrive()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	ctx := context.Background()

	snapA := newSnapshot(1, testEntity(store.KindItem, "i1", "旧内容", 0))
	if err := ch.Save(ctx, snapA); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fake.setFault("upload", 50)
	snapB := newSnapshot(2, testEntity(store.KindItem, "i1", "新内容", 1))
	err := ch.Save(ctx, snapB)
	if err == nil {
		t.Fatal("upload_all 持续限流时 Save 应报错")
	}
	assertNoSecret(t, err)
	wantRaw, _ := snapA.Bytes()
	named := fake.contentsNamed(DefaultSnapshotFileName)
	if len(named) != 1 {
		t.Fatalf("上传失败后应恰好保留 1 份旧快照，实际 %d 份", len(named))
	}
	for _, c := range named {
		if c != string(wantRaw) {
			t.Error("上传失败后远端内容必须仍是旧快照")
		}
	}
	got, err := ch.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	diffRecords(t, snapA.Records, got.Records)
	if n := fake.renameAttempts(); n != 0 {
		t.Errorf("不该调用不存在的 rename 接口，实际 %d 次", n)
	}

	fake.setFault("upload", 0)
	if err := ch.Save(ctx, snapB); err != nil {
		t.Fatalf("限流解除后应重新覆盖成功: %v", err)
	}
	got, _ = ch.Load(ctx)
	diffRecords(t, snapB.Records, got.Records)
	if n := fake.fileCount(); n != 1 {
		t.Errorf("覆盖后应只剩 1 份快照，实际 %d 个文件", n)
	}
}

// 真实环境结论（2026-11-09）：飞书云盘 v1 没有 rename 接口，同名文件可以重复上传并存。
// 覆盖写因此改成「正式名直传 + 按 token 精确删旧」，并顺手回收旧版本遗留的临时文件。
func TestDriveSaveUsesOfficialNameWithoutRename(t *testing.T) {
	useFastBackoff(t)
	fake := newFakeDrive()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	ctx := context.Background()

	fake.seedStale(tmpFilePrefix + "old-crash")
	if err := ch.Save(ctx, newSnapshot(1, testEntity(store.KindItem, "i1", "第一版", 0))); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := fake.lastUploadedName(); got != DefaultSnapshotFileName {
		t.Fatalf("必须直接以正式名 %q 上传，实际 %q", DefaultSnapshotFileName, got)
	}
	if n := fake.renameAttempts(); n != 0 {
		t.Fatalf("不应再调用不存在的 rename 接口，实际 %d 次", n)
	}
	if n := fake.fileCount(); n != 1 {
		t.Errorf("旧版本遗留的临时文件应被回收，剩 %d 个文件", n)
	}

	if err := ch.Save(ctx, newSnapshot(2, testEntity(store.KindItem, "i1", "第二版", 1))); err != nil {
		t.Fatalf("覆盖写 Save: %v", err)
	}
	if n := len(fake.contentsNamed(DefaultSnapshotFileName)); n != 1 {
		t.Fatalf("覆盖后同名快照应恰好一份，实际 %d 份", n)
	}
	if n := fake.fileCount(); n != 1 {
		t.Errorf("覆盖后不应有残留文件，实际 %d 个", n)
	}
}

// 一次成功的 Save 必须让远端收敛到一份同名文件：既要清掉上传前就存在的旧副本，
// 也要清掉「列目录 → 上传」之间由另一轮并发写入的同名副本。否则引擎在
// pushed=0 / revision≠0 时整轮跳过 Save，重复文件会永远留在云盘里。
func TestDriveSaveConvergesConcurrentDuplicates(t *testing.T) {
	useFastBackoff(t)
	fake := newFakeDrive()
	fake.seedNamed("preset-a", DefaultSnapshotFileName, "old-a")
	fake.seedNamed("preset-b", DefaultSnapshotFileName, "old-b")
	fake.duplicateOnUpload = true
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	ctx := context.Background()

	snap := newSnapshot(1, testEntity(store.KindItem, "i1", "最新内容", 0))
	if err := ch.Save(ctx, snap); err != nil {
		t.Fatalf("Save: %v", err)
	}
	want, _ := snap.Bytes()
	named := fake.contentsNamed(DefaultSnapshotFileName)
	if len(named) != 1 {
		t.Fatalf("覆盖写后同名快照应恰好一份，实际 %d 份", len(named))
	}
	for _, c := range named {
		if c != string(want) {
			t.Error("留下的不是本轮最新快照")
		}
	}
	if n := fake.renameAttempts(); n != 0 {
		t.Errorf("不该调用不存在的 rename 接口，实际 %d 次", n)
	}
}

// 删除旧文件的两种「假失败」都不能阻断同步：新文件已经以正式名完整存在，
// 删不掉的那份要么已被另一轮删了，要么只是历史垃圾。
func TestDriveSaveToleratesConcurrentAndLeftoverDeleteFailures(t *testing.T) {
	useFastBackoff(t)
	t.Run("并发重复删除旧正式文件", func(t *testing.T) {
		fake := newFakeDrive()
		srv := httptest.NewServer(fake)
		defer srv.Close()
		ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
		ctx := context.Background()
		if err := ch.Save(ctx, newSnapshot(1, testEntity(store.KindItem, "i1", "第一版", 0))); err != nil {
			t.Fatalf("首次 Save: %v", err)
		}
		// 另一轮覆盖写已经把旧文件删了，本轮删除收到 1061001。
		fake.setDeleteFault(DefaultSnapshotFileName, 1061001, true)
		if err := ch.Save(ctx, newSnapshot(2, testEntity(store.KindItem, "i1", "第二版", 1))); err != nil {
			t.Fatalf("重复删除不该阻断同步: %v", err)
		}
		if n := fake.fileCount(); n != 1 {
			t.Errorf("幂等删除后应只剩一份快照，实际 %d 个文件", n)
		}
	})

	t.Run("历史临时残留删不掉", func(t *testing.T) {
		fake := newFakeDrive()
		srv := httptest.NewServer(fake)
		defer srv.Close()
		ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
		ctx := context.Background()
		fake.seedStale(tmpFilePrefix + "stuck")
		fake.setDeleteFault(tmpFilePrefix+"stuck", 1061001, false)
		if err := ch.Save(ctx, newSnapshot(1, testEntity(store.KindItem, "i1", "第一版", 0))); err != nil {
			t.Fatalf("残留删不掉不该阻断同步: %v", err)
		}
		if n := len(fake.contentsNamed(DefaultSnapshotFileName)); n != 1 {
			t.Fatalf("正式快照应恰好一份，实际 %d 份", n)
		}
	})
}

// 404 之类非 JSON 响应必须给出「HTTP 状态 + 响应内容」，而不是被 json.Unmarshal
// 误报成 `invalid character 'p' after top-level value` 掩盖真实原因。
func TestCallJSONReportsPlainText404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == pathTenantToken {
			fmt.Fprint(w, `{"code":0,"msg":"ok","tenant_access_token":"t","expire":7200}`)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "404 page not found")
	}))
	defer srv.Close()
	cli, err := newClient(map[string]string{"appId": "cli_test", "appSecret": "secret_test", "baseUrl": srv.URL})
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	_, err = cli.callJSON(context.Background(), http.MethodPatch,
		"/open-apis/drive/v1/files/tok/rename", nil, []byte(`{"new_name":"n"}`), "")
	if err == nil {
		t.Fatal("HTTP 404 应报错")
	}
	if strings.Contains(err.Error(), "invalid character 'p'") {
		t.Fatalf("不该再出现误导性的 JSON 解析错: %v", err)
	}
	if !strings.Contains(err.Error(), "HTTP 404") || !strings.Contains(err.Error(), "404 page not found") {
		t.Fatalf("诊断信息不明确: %v", err)
	}
	assertNoSecret(t, err)
}

// 删旧失败时，新快照已经以正式名完整上传（同名会有两份），Load 按创建时间
// 取最新的一份；下一轮 Save 会把残留的旧文件一并清掉。宁可多留一份，
// 也不能让远端落到「没有完整快照」的状态。
func TestDriveDeleteFaultKeepsNewSnapshotAndRecovers(t *testing.T) {
	useFastBackoff(t)
	maxAttempts = 2
	fake := newFakeDrive()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuDrive", driveOpts(srv.URL))
	ctx := context.Background()

	snapA := newSnapshot(1, testEntity(store.KindItem, "i1", "旧内容", 0))
	if err := ch.Save(ctx, snapA); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fake.setFault("delete", 50)
	snapB := newSnapshot(2, testEntity(store.KindItem, "i2", "新内容", 0))
	err := ch.Save(ctx, snapB)
	if err == nil || !strings.Contains(err.Error(), "清理旧快照失败") {
		t.Fatalf("删除旧文件失败应报错: %v", err)
	}
	wantRaw, _ := snapB.Bytes()
	named := fake.contentsNamed(DefaultSnapshotFileName)
	if len(named) != 2 {
		t.Fatalf("删旧失败时应有新旧两份同名快照，实际 %d 份", len(named))
	}
	foundNew := false
	for _, c := range named {
		if c == string(wantRaw) {
			foundNew = true
		}
	}
	if !foundNew {
		t.Error("删旧失败时新快照必须已完整存在")
	}
	got, err := ch.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	diffRecords(t, snapB.Records, got.Records)

	fake.setFault("delete", 0)
	if err := ch.Save(ctx, snapB); err != nil {
		t.Fatalf("重试应成功: %v", err)
	}
	got, _ = ch.Load(ctx)
	diffRecords(t, snapB.Records, got.Records)
	if n := fake.fileCount(); n != 1 {
		t.Errorf("失败轮留下的旧文件应被回收，剩 %d 个文件", n)
	}
}

// ---------- 多维表格通道 ----------

type fbField struct {
	Name string
	Type int
}

type fbRow struct {
	id     string
	fields map[string]any
}

type fbTable struct {
	id     string
	name   string
	fields []fbField
	rows   []*fbRow
}

type fakeBase struct {
	mu              stdsync.Mutex
	app             string
	tables          []*fbTable
	nextTable       int
	nextRec         int
	tokenCalls      int
	faults          map[string]int // "batch_create"|"batch_update"|"batch_delete" → 剩余注入次数
	rowsPageLimit   int
	tablesPageLimit int
}

func newFakeBase() *fakeBase {
	return &fakeBase{app: "bascX", faults: map[string]int{}}
}

func (f *fakeBase) hitLocked(op string) bool {
	if f.faults[op] > 0 {
		f.faults[op]--
		return true
	}
	return false
}

func (f *fakeBase) findLocked(id string) *fbTable {
	for _, tb := range f.tables {
		if tb.id == id {
			return tb
		}
	}
	return nil
}

func (f *fakeBase) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == pathTenantToken {
		f.tokenCalls++
		fmt.Fprintf(w, `{"code":0,"msg":"ok","tenant_access_token":"tb-%d","expire":7200}`, f.tokenCalls)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	tablesPath := fmt.Sprintf(pathBaseTables, f.app)
	if r.URL.Path == tablesPath {
		if r.Method == http.MethodGet {
			type item struct {
				ID   string `json:"table_id"`
				Name string `json:"name"`
			}
			var all []item
			for _, tb := range f.tables {
				all = append(all, item{tb.id, tb.name})
			}
			writePaged(w, r, all, f.tablesPageLimit)
			return
		}
		var body struct {
			Table struct {
				Name   string `json:"name"`
				Fields []struct {
					FieldName string `json:"field_name"`
					Type      int    `json:"type"`
				} `json:"fields"`
			} `json:"table"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Table.Name == "" {
			fmt.Fprint(w, `{"code":3,"msg":"bad create body"}`)
			return
		}
		for _, tb := range f.tables {
			if tb.name == body.Table.Name {
				fmt.Fprint(w, `{"code":8000513,"msg":"表名重复"}`)
				return
			}
		}
		f.nextTable++
		tb := &fbTable{id: fmt.Sprintf("tbl%d", f.nextTable), name: body.Table.Name}
		for _, fd := range body.Table.Fields {
			tb.fields = append(tb.fields, fbField{fd.FieldName, fd.Type})
		}
		f.tables = append(f.tables, tb)
		fmt.Fprintf(w, `{"code":0,"msg":"ok","data":{"table_id":%q,"name":%q}}`, tb.id, tb.name)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, tablesPath+"/")
	tid, sub, _ := strings.Cut(rest, "/")
	tb := f.findLocked(tid)
	if tb == nil {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"code":404,"msg":"表不存在"}`)
		return
	}
	switch {
	case sub == "fields" && r.Method == http.MethodGet:
		type item struct {
			FieldName string `json:"field_name"`
			Type      int    `json:"type"`
		}
		var all []item
		for _, fd := range tb.fields {
			all = append(all, item{fd.Name, fd.Type})
		}
		writePaged(w, r, all, 0)
	case sub == "fields" && r.Method == http.MethodPost:
		var body struct {
			FieldName string `json:"field_name"`
			Type      int    `json:"type"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		tb.fields = append(tb.fields, fbField{body.FieldName, body.Type})
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{}}`)
	case sub == "records" && r.Method == http.MethodGet:
		type item struct {
			RecordID string         `json:"record_id"`
			Fields   map[string]any `json:"fields"`
		}
		var all []item
		for _, row := range tb.rows {
			all = append(all, item{row.id, row.fields})
		}
		writePaged(w, r, all, f.rowsPageLimit)
	case strings.HasSuffix(sub, "/batch_create") && r.Method == http.MethodPost:
		if f.hitLocked("batch_create") {
			rateLimitReply(w)
			return
		}
		var body struct {
			Records []struct {
				Fields map[string]any `json:"fields"`
			} `json:"records"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		for _, rec := range body.Records {
			f.nextRec++
			tb.rows = append(tb.rows, &fbRow{id: fmt.Sprintf("r%d", f.nextRec), fields: rec.Fields})
		}
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{"records":[]}}`)
	case strings.HasSuffix(sub, "/batch_update") && r.Method == http.MethodPost:
		if f.hitLocked("batch_update") {
			rateLimitReply(w)
			return
		}
		var body struct {
			Records []struct {
				RecordID string         `json:"record_id"`
				Fields   map[string]any `json:"fields"`
			} `json:"records"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		for _, rec := range body.Records {
			found := false
			for _, row := range tb.rows {
				if row.id == rec.RecordID {
					row.fields = rec.Fields
					found = true
				}
			}
			if !found {
				fmt.Fprint(w, `{"code":8000501,"msg":"记录不存在"}`)
				return
			}
		}
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{"records":[]}}`)
	case strings.HasSuffix(sub, "/batch_delete") && r.Method == http.MethodPost:
		if f.hitLocked("batch_delete") {
			rateLimitReply(w)
			return
		}
		var body struct {
			Records []string `json:"records"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		keep := tb.rows[:0:0]
		for _, row := range tb.rows {
			drop := false
			for _, id := range body.Records {
				if row.id == id {
					drop = true
				}
			}
			if !drop {
				keep = append(keep, row)
			}
		}
		tb.rows = keep
		fmt.Fprint(w, `{"code":0,"msg":"ok","data":{"success":true}}`)
	default:
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `{"code":404,"msg":"no route %s"}`, r.URL.Path)
	}
}

// writePaged 模拟飞书分页：page_token 是偏移量的字符串，limit 能把单页行数压到极小以逼出翻页逻辑。
func writePaged[T any](w http.ResponseWriter, r *http.Request, items []T, limit int) {
	size := 500
	if ps := r.URL.Query().Get("page_size"); ps != "" {
		if v, err := strconv.Atoi(ps); err == nil && v > 0 {
			size = v
		}
	}
	start := 0
	if tok := r.URL.Query().Get("page_token"); tok != "" {
		start, _ = strconv.Atoi(tok)
	}
	if start > len(items) {
		start = len(items)
	}
	end := min(start+size, len(items))
	if limit > 0 && end-start > limit {
		end = start + limit
	}
	hasMore := end < len(items)
	token := ""
	if hasMore {
		token = strconv.Itoa(end)
	}
	data, _ := json.Marshal(map[string]any{"items": items[start:end], "has_more": hasMore, "page_token": token, "total": len(items)})
	fmt.Fprintf(w, `{"code":0,"msg":"ok","data":%s}`, data)
}

func (f *fakeBase) tableNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, tb := range f.tables {
		out = append(out, tb.name)
	}
	return out
}

func (f *fakeBase) fieldNames(table string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, tb := range f.tables {
		if tb.name != table {
			continue
		}
		var out []string
		for _, fd := range tb.fields {
			out = append(out, fd.Name)
		}
		return out
	}
	return nil
}

func (f *fakeBase) rowIDs(table string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, tb := range f.tables {
		if tb.name != table {
			continue
		}
		var out []string
		for _, row := range tb.rows {
			if id, ok := row.fields["id"].(string); ok {
				out = append(out, id)
			}
		}
		sort.Strings(out)
		return out
	}
	return nil
}

func (f *fakeBase) rowCount(table string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, tb := range f.tables {
		if tb.name == table {
			return len(tb.rows)
		}
	}
	return -1
}

// setRowField 模拟用户在飞书表格里手改可读列。
func (f *fakeBase) setRowField(table, entityID string, values map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, tb := range f.tables {
		if tb.name != table {
			continue
		}
		for _, row := range tb.rows {
			if id, _ := row.fields["id"].(string); id == entityID {
				for k, v := range values {
					row.fields[k] = v
				}
			}
		}
	}
}

// addRawTable 模拟用户手工建了一张同名但没列的数据表。
func (f *fakeBase) addRawTable(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextTable++
	f.tables = append(f.tables, &fbTable{id: fmt.Sprintf("tbl%d", f.nextTable), name: name})
}

func (f *fakeBase) setFault(op string, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.faults[op] = times
}

func (f *fakeBase) setLimits(rows, tables int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rowsPageLimit, f.tablesPageLimit = rows, tables
}

func TestBaseEndToEnd(t *testing.T) {
	useFastBackoff(t)
	fake := newFakeBase()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuBase", baseOpts(srv.URL))
	ctx := context.Background()

	if err := ch.Probe(ctx); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	got, err := ch.Load(ctx)
	if err != nil {
		t.Fatalf("空远端 Load: %v", err)
	}
	if got.Revision != 0 || len(got.Records) != 0 {
		t.Errorf("建表前应得到空快照，得到 %+v", got)
	}

	h1 := store.Entity{Kind: store.KindHabitClock, ID: "h1", UpdatedAt: "2026-11-04T23:59:59.000Z",
		Sort: 2, Data: json.RawMessage(`{"name":"晨跑"}`)}
	snapA := newSnapshot(3,
		testEntity(store.KindItem, "i1", "买牛奶", 1),
		testEntity(store.KindItem, "i2", "写周报", 0),
		h1)
	if err := ch.Save(ctx, snapA); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// 自动建表：实体表按前缀+kind 命名，外加水位表。
	names := strings.Join(fake.tableNames(), ",")
	for _, want := range []string{"pf_item", "pf_habitClock", "pf_meta"} {
		if !strings.Contains(names, want) {
			t.Errorf("没自动建出 %s，现有表: %s", want, names)
		}
	}
	got, err = ch.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	diffRecords(t, snapA.Records, got.Records)
	if got.Revision != 3 || got.DeviceID != "devA" || got.SyncedAt != snapA.SyncedAt {
		t.Errorf("水位还原错误: rev=%d device=%q at=%q", got.Revision, got.DeviceID, got.SyncedAt)
	}

	// 可读列是单向镜像：被人为改坏也不影响还原结果。
	fake.setRowField("pf_item", "i1", map[string]any{"title": "手改的", "updated_at": "乱码", "status": 999.0})
	got, err = ch.Load(ctx)
	if err != nil {
		t.Fatalf("坏列 Load: %v", err)
	}
	diffRecords(t, snapA.Records, got.Records)

	// upsert + 删除多余行。
	snapB := newSnapshot(4,
		testEntity(store.KindItem, "i1", "买豆浆", 2),
		testEntity(store.KindItem, "i3", "取快递", 0),
		h1)
	if err := ch.Save(ctx, snapB); err != nil {
		t.Fatalf("Save B: %v", err)
	}
	if ids := strings.Join(fake.rowIDs("pf_item"), ","); ids != "i1,i3" {
		t.Errorf("pf_item 行集 = %s，想要 i1,i3（i2 应被删除）", ids)
	}
	got, _ = ch.Load(ctx)
	diffRecords(t, snapB.Records, got.Records)
	seen := map[string]bool{}
	for _, n := range fake.tableNames() {
		if seen[n] {
			t.Errorf("出现了重名表 %s（列表分页没翻全就会重复建表）", n)
		}
		seen[n] = true
	}

	// 分页必须拉全：单页压到 1 行、1 张表。
	fake.setLimits(1, 1)
	defer fake.setLimits(0, 0)
	got, err = ch.Load(ctx)
	if err != nil {
		t.Fatalf("翻页 Load: %v", err)
	}
	diffRecords(t, snapB.Records, got.Records)
	if err := ch.Save(ctx, snapB); err != nil {
		t.Fatalf("翻页 Save: %v", err)
	}

	// 表存在但缺列（用户手工建的空表）→ 自动补列。
	fake.addRawTable("pf_list")
	snapC := newSnapshot(5, append([]store.Entity{
		{Kind: store.KindList, ID: "l1", UpdatedAt: "2026-11-05T00:00:00.000Z",
			Data: json.RawMessage(`{"name":"收件箱"}`)},
	}, snapB.Records...)...)
	if err := ch.Save(ctx, snapC); err != nil {
		t.Fatalf("补列 Save: %v", err)
	}
	if n := len(fake.fieldNames("pf_list")); n != len(baseColumns) {
		t.Errorf("pf_list 列数 = %d，想要 %d", n, len(baseColumns))
	}
	got, err = ch.Load(ctx)
	if err != nil {
		t.Fatalf("补列后 Load: %v", err)
	}
	diffRecords(t, snapC.Records, got.Records)
}

func TestBaseBatchFailurePropagates(t *testing.T) {
	useFastBackoff(t)
	maxAttempts = 2
	fake := newFakeBase()
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ch := buildChannel(t, "feishuBase", baseOpts(srv.URL))
	ctx := context.Background()

	fake.setFault("batch_create", 50)
	snap := newSnapshot(1, testEntity(store.KindItem, "i1", "买牛奶", 0))
	err := ch.Save(ctx, snap)
	if err == nil || !strings.Contains(err.Error(), "批量写入失败") {
		t.Fatalf("批量接口持续限流必须报错而不是静默: %v", err)
	}
	assertNoSecret(t, err)
	if n := fake.rowCount("pf_item"); n != 0 {
		t.Errorf("写失败时不该留下半截行集，实际 %d 行", n)
	}
	if n := fake.rowCount("pf_meta"); n > 0 {
		t.Errorf("saveKind 失败后不该推进水位，实际 %d 行", n)
	}
	fake.setFault("batch_create", 0)
	if err := ch.Save(ctx, snap); err != nil {
		t.Fatalf("限流解除后重试: %v", err)
	}
	got, _ := ch.Load(ctx)
	diffRecords(t, snap.Records, got.Records)
}

func TestInstallIsIdempotentAndRegisters(t *testing.T) {
	useFastBackoff(t)
	Install()
	Install() // 宿主多处调用也不能 panic

	kinds := strings.Join(coresync.Kinds(), ",")
	for _, want := range []string{"feishuDrive", "feishuBase"} {
		if !strings.Contains(kinds, want) {
			t.Errorf("Kinds 缺 %s: %s", want, kinds)
		}
	}
	ch, err := coresync.Build(coresync.Config{
		Name: "b1", Kind: "feishuBase", Enabled: true,
		Options: map[string]string{"appId": "cli", "appSecret": testSecret, "appToken": "basc", "baseUrl": "http://127.0.0.1:1"},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if ch.Kind() != "feishuBase" || ch.Name() != "b1" {
		t.Errorf("通道身份 = %s/%s", ch.Kind(), ch.Name())
	}
}

func TestMissingOptionsErrorsNameKeysNotSecrets(t *testing.T) {
	useFastBackoff(t)
	Install()
	cases := []struct {
		kind   string
		opts   map[string]string
		wantIn string
	}{
		{"feishuDrive", map[string]string{"appId": "a"}, "appId"},
		{"feishuDrive", map[string]string{"appId": "a", "appSecret": testSecret}, "folderToken"},
		{"feishuBase", map[string]string{"appId": "a", "appSecret": testSecret}, "appToken"},
	}
	for _, c := range cases {
		_, err := coresync.Build(coresync.Config{Name: "x", Kind: c.kind, Options: c.opts})
		if err == nil || !strings.Contains(err.Error(), c.wantIn) {
			t.Errorf("%v 应报缺 %s，得到: %v", c.kind, c.wantIn, err)
		}
		assertNoSecret(t, err)
	}
}
