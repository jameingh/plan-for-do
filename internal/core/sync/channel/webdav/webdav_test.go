package webdav

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	syncstd "sync"
	"testing"
	"time"

	"planfordo/internal/core/store"
	"planfordo/internal/core/sync"
)

// ---------- 最小但行为真实的 WebDAV 服务端桩 ----------

type stubObj struct {
	data []byte
	etag string
	mod  time.Time
}

type davStub struct {
	mu     syncstd.Mutex
	dirs   map[string]bool     // 已存在的集合（解码后的路径，无尾斜杠）
	objs   map[string]*stubObj // 对象（同上）
	serial int                 // 写序号，保证 ETag 每次覆盖都变化

	authMode string // "basic" | "digest" | "token"
	user     string
	pass     string
	token    string
	nonce    string
	digestOK int // 成功校验过的 Digest 请求数

	flaky        int // 剩余要故意失败的请求数
	flakyStatus  int
	mkcolCreated int  // 真正新建成功的集合数
	down         bool // 持续 5xx
	omitETagGet  bool // GET 不回 ETag/Last-Modified（逼客户端走 PROPFIND）

	counts map[string]int // method → 收到的请求数
}

func newDavStub(authMode string) *davStub {
	return &davStub{
		dirs:     map[string]bool{"/dav": true},
		objs:     map[string]*stubObj{},
		authMode: authMode,
		user:     "u",
		pass:     "p",
		token:    "tok-123",
		nonce:    "server-nonce-1",
		counts:   map[string]int{},
	}
}

func (s *davStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counts[r.Method]++
	if s.down {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if s.flaky > 0 {
		s.flaky--
		w.WriteHeader(s.flakyStatus)
		return
	}
	if !s.authenticated(w, r) {
		return
	}
	p := strings.TrimRight(r.URL.Path, "/")
	switch r.Method {
	case "OPTIONS":
		w.Header().Set("DAV", "1")
		w.WriteHeader(http.StatusNoContent)
	case "MKCOL":
		switch {
		case s.dirs[p]:
			w.WriteHeader(http.StatusMethodNotAllowed) // 已存在
		case !s.dirs[parentPath(p)]:
			w.WriteHeader(http.StatusConflict) // 父集合缺失
		default:
			s.dirs[p] = true
			s.mkcolCreated++
			w.WriteHeader(http.StatusCreated)
		}
	case "GET":
		obj := s.objs[p]
		if obj == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if !s.omitETagGet {
			w.Header().Set("ETag", obj.etag)
			w.Header().Set("Last-Modified", obj.mod.UTC().Format(http.TimeFormat))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(obj.data)
	case "PUT":
		s.handlePut(w, r, p)
	case "PROPFIND":
		s.handlePropfind(w, r, p)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *davStub) handlePut(w http.ResponseWriter, r *http.Request, p string) {
	parent := parentPath(p)
	obj := s.objs[p]
	if im := r.Header.Get("If-Match"); im != "" {
		if obj == nil || obj.etag != im {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
	}
	if inm := r.Header.Get("If-None-Match"); inm == "*" && obj != nil {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if cond := r.Header.Get("If"); cond != "" {
		gmt := strings.Trim(cond, "<>")
		if obj == nil || obj.mod.UTC().Format(http.TimeFormat) != gmt {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
	}
	if !s.dirs[parent] && parent != "" {
		w.WriteHeader(http.StatusConflict)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.serial++
	sum := md5.Sum(append(data, byte(s.serial)))
	if obj == nil {
		s.objs[p] = &stubObj{data: data, etag: etagOf(s.serial, sum), mod: time.Now().UTC()}
		w.Header().Set("ETag", s.objs[p].etag)
		w.WriteHeader(http.StatusCreated)
		return
	}
	obj.data = data
	obj.etag = etagOf(s.serial, sum)
	obj.mod = time.Now().UTC()
	w.Header().Set("ETag", obj.etag)
	w.WriteHeader(http.StatusNoContent)
}

func etagOf(serial int, sum [16]byte) string {
	return fmt.Sprintf(`"%d-%x"`, serial, sum)
}

type xProp struct {
	ETag         string `xml:"getetag,omitempty"`
	LastModified string `xml:"getlastmodified,omitempty"`
	ResourceType struct {
		Collection *struct{} `xml:"collection,omitempty"`
	} `xml:"resourcetype"`
}

type xPropstat struct {
	Prop   xProp  `xml:"prop"`
	Status string `xml:"status"`
}

type xResponse struct {
	Href     string    `xml:"href"`
	Propstat xPropstat `xml:"propstat"`
}

type xMultistatus struct {
	XMLName   xml.Name    `xml:"DAV: multistatus"`
	Responses []xResponse `xml:"response"`
}

func (s *davStub) handlePropfind(w http.ResponseWriter, r *http.Request, p string) {
	depth := r.Header.Get("Depth")
	var ms xMultistatus
	if obj := s.objs[p]; obj != nil {
		ms.Responses = []xResponse{s.fileEntry(p, obj)}
	} else if s.dirs[p] {
		// 故意把集合自身也列进来——很多真实服务端 Depth:1 就是这样，
		// 解析端必须容得下。
		self := xResponse{Href: hrefOf(p) + "/", Propstat: xPropstat{Status: "HTTP/1.1 200 OK"}}
		self.Propstat.Prop.ResourceType.Collection = &struct{}{}
		ms.Responses = append(ms.Responses, self)
		if depth != "0" {
			for k := range s.dirs {
				if childOf(k, p) && k != p {
					e := xResponse{Href: hrefOf(k), Propstat: xPropstat{Status: "HTTP/1.1 200 OK"}}
					e.Propstat.Prop.ResourceType.Collection = &struct{}{}
					ms.Responses = append(ms.Responses, e)
				}
			}
			for k, obj := range s.objs {
				if childOf(k, p) {
					ms.Responses = append(ms.Responses, s.fileEntry(k, obj))
				}
			}
		}
	} else {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	raw, err := xml.Marshal(ms)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(207)
	_, _ = w.Write([]byte(xml.Header))
	_, _ = w.Write(raw)
}

func (s *davStub) fileEntry(p string, obj *stubObj) xResponse {
	e := xResponse{Href: hrefOf(p), Propstat: xPropstat{Status: "HTTP/1.1 200 OK"}}
	e.Propstat.Prop.ETag = obj.etag
	e.Propstat.Prop.LastModified = obj.mod.UTC().Format(http.TimeFormat)
	return e
}

// childOf 判断 k 是否为 p 的直接子项。
func childOf(k, p string) bool {
	return strings.HasPrefix(k, p+"/") && !strings.Contains(strings.TrimPrefix(k, p+"/"), "/")
}

func hrefOf(p string) string {
	segs := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range segs {
		segs[i] = escapeSegment(s)
	}
	return "/" + strings.Join(segs, "/")
}

func parentPath(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return ""
	}
	return p[:i]
}

// ---------- 桩的鉴权 ----------

const stubRealm = "davstub"

func (s *davStub) challengeDigest(w http.ResponseWriter, stale bool) {
	h := fmt.Sprintf(`Digest realm=%q, nonce=%q, opaque="opq", qop="auth", algorithm=MD5`, stubRealm, s.nonce)
	if stale {
		h += `, stale="TRUE"`
	}
	w.Header().Set("WWW-Authenticate", h)
	w.WriteHeader(http.StatusUnauthorized)
}

func (s *davStub) authenticated(w http.ResponseWriter, r *http.Request) bool {
	switch s.authMode {
	case "basic":
		u, p, ok := r.BasicAuth()
		if !ok || u != s.user || p != s.pass {
			w.Header().Set("WWW-Authenticate", `Basic realm="`+stubRealm+`"`)
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	case "token":
		if r.Header.Get("Authorization") != "Bearer "+s.token {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+stubRealm+`"`)
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	default: // digest
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Digest ") {
			s.challengeDigest(w, false)
			return false
		}
		params := parseParams(strings.TrimPrefix(h, "Digest "))
		uri := r.URL.EscapedPath()
		ha := hashFunc("MD5")
		ha1 := ha(s.user + ":" + stubRealm + ":" + s.pass)
		ha2 := ha(r.Method + ":" + uri)
		ok := params["username"] == s.user && params["realm"] == stubRealm &&
			params["nonce"] == s.nonce && params["qop"] == "auth" &&
			params["uri"] == uri && params["opaque"] == "opq" &&
			params["cnonce"] != "" && ncValid(params["nc"]) &&
			params["response"] == ha(ha1+":"+s.nonce+":"+params["nc"]+":"+params["cnonce"]+":auth:"+ha2)
		if !ok {
			s.challengeDigest(w, false)
			return false
		}
		s.digestOK++
		return true
	}
}

func ncValid(s string) bool {
	n, err := strconv.ParseUint(s, 16, 32)
	return err == nil && n > 0
}

// ---------- 测试辅助 ----------

func mustStub(t *testing.T, authMode string) (*davStub, *httptest.Server) {
	t.Helper()
	s := newDavStub(authMode)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return s, srv
}

func buildChannel(t *testing.T, srvURL string, opts map[string]string) *Channel {
	t.Helper()
	full := map[string]string{"url": srvURL + "/dav"}
	for k, v := range opts {
		full[k] = v
	}
	ch, err := sync.Build(sync.Config{Name: "dav", Kind: "webdav", Enabled: true, Options: full})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	c, ok := ch.(*Channel)
	if !ok {
		t.Fatalf("Build 返回类型 %T，不是 *Channel", ch)
	}
	return c
}

func authOpts(mode string) map[string]string {
	switch mode {
	case "token":
		return map[string]string{"token": "tok-123"}
	default:
		return map[string]string{"username": "u", "password": "p"}
	}
}

func testSnap(rev int64, title string) *sync.Snapshot {
	data, _ := json.Marshal(map[string]string{"title": title})
	return &sync.Snapshot{
		Schema:   sync.SchemaVersion,
		DeviceID: "dev-1",
		Revision: rev,
		Records: []store.Entity{{
			Kind: store.KindItem, ID: "i1",
			UpdatedAt: "2026-11-05T00:00:00.000Z",
			Data:      data,
		}},
	}
}

func fastRetry(t *testing.T) {
	t.Helper()
	old := retryBaseDelay
	retryBaseDelay = time.Millisecond
	t.Cleanup(func() { retryBaseDelay = old })
}

// ---------- 测试 ----------

func TestInstallIdempotentAndBuild(t *testing.T) {
	Install()
	Install() // 重复调用不得 panic
	if !hasKind("webdav") {
		t.Fatal("webdav 未注册")
	}
	ch, err := sync.Build(sync.Config{
		Name: "n", Kind: "webdav",
		Options: map[string]string{"url": "https://dav.example.com/dav/", "username": "u", "password": "p"},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if ch.Kind() != "webdav" || ch.Name() != "n" {
		t.Fatalf("通道标识错误: %s/%s", ch.Name(), ch.Kind())
	}
	if _, err := sync.Build(sync.Config{
		Name: "bad", Kind: "webdav",
		Options: map[string]string{"url": "https://x.example/dav", "username": "u", "password": "p", "token": "t"},
	}); err == nil {
		t.Fatal("token 与 username/password 共存应报错")
	}
}

func TestProbeCreatesDirsAndEncodesPath(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	opts := authOpts("basic")
	opts["path"] = `同步 目录/sub 100%`
	c := buildChannel(t, srv.URL, opts)
	if err := c.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if !stub.dirs["/dav/同步 目录"] || !stub.dirs["/dav/同步 目录/sub 100%"] {
		t.Fatalf("目录没建出来: %v", stub.dirs)
	}
	// 恰好两段新建成功（服务端解码后能命中原始名字，证明没双重编码；
	// counts 里还含 401 挑战轮，不能直接当建目录次数用）。
	if stub.mkcolCreated != 2 {
		t.Fatalf("MKCOL 新建次数 %d，期望 2", stub.mkcolCreated)
	}
}

func TestProbeBadCredentialsDiagnosable(t *testing.T) {
	_, srv := mustStub(t, "basic")
	opts := map[string]string{"username": "u", "password": "s3cret-不该出现在错误里"}
	c := buildChannel(t, srv.URL, opts)
	err := c.Probe(context.Background())
	if err == nil {
		t.Fatal("凭证错误应报错")
	}
	if !strings.Contains(err.Error(), "凭证被服务器拒绝") {
		t.Fatalf("错误不可诊断: %v", err)
	}
	if strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("错误信息泄露凭证: %v", err)
	}
	if !strings.Contains(err.Error(), "davstub") {
		t.Logf("提示: 错误未包含 realm（可接受）: %v", err)
	}
}

func TestDigestAndBasicAuthRoundTrips(t *testing.T) {
	for _, mode := range []string{"basic", "digest"} {
		t.Run(mode, func(t *testing.T) {
			stub, srv := mustStub(t, mode)
			c := buildChannel(t, srv.URL, authOpts(mode))
			if err := c.Probe(context.Background()); err != nil {
				t.Fatalf("Probe: %v", err)
			}
			snap := testSnap(1, "买牛奶")
			if err := c.Save(context.Background(), snap); err != nil {
				t.Fatalf("Save: %v", err)
			}
			got, err := c.Load(context.Background())
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got.Revision != 1 || len(got.Records) != 1 || got.Records[0].ID != "i1" {
				t.Fatalf("回环内容不一致: %#v", got)
			}
			// 覆盖写：旧内容不残留，ETag 必须变化。
			_, etag1, _ := c.validator()
			if etag1 == "" {
				t.Fatal("Save 后没有拿到 ETag")
			}
			if err := c.Save(context.Background(), testSnap(2, "买面包")); err != nil {
				t.Fatalf("覆盖 Save: %v", err)
			}
			_, etag2, _ := c.validator()
			if etag2 == etag1 {
				t.Fatal("覆盖写后 ETag 未变化")
			}
			stub.mu.Lock()
			body := stub.objs["/dav/"+snapshotFileName].data
			digestOK := stub.digestOK
			stub.mu.Unlock()
			if !strings.Contains(string(body), "买面包") || strings.Contains(string(body), "买牛奶") {
				t.Fatalf("远端残留旧内容: %s", body)
			}
			if mode == "digest" && digestOK == 0 {
				t.Fatal("Digest 路径没被服务端校验通过")
			}
			if mode == "basic" && digestOK != 0 {
				t.Fatal("Basic 模式不该走 Digest")
			}
		})
	}
}

func TestBearerTokenAuth(t *testing.T) {
	stub, srv := mustStub(t, "token")
	c := buildChannel(t, srv.URL, authOpts("token"))
	if err := c.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if err := c.Save(context.Background(), testSnap(1, "token 写")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	stub.mu.Lock()
	body := string(stub.objs["/dav/"+snapshotFileName].data)
	stub.mu.Unlock()
	if !strings.Contains(body, "token 写") {
		t.Fatalf("token 模式写入失败: %s", body)
	}
}

func TestLoadMissingSnapshotIsEmpty(t *testing.T) {
	_, srv := mustStub(t, "basic")
	c := buildChannel(t, srv.URL, authOpts("basic"))
	got, err := c.Load(context.Background())
	if err != nil {
		t.Fatalf("首轮 Load 不应报错: %v", err)
	}
	if got.Schema != sync.SchemaVersion || len(got.Records) != 0 || got.Records == nil {
		t.Fatalf("空快照形态不对: %#v", got)
	}
	if known, _, _ := c.validator(); known {
		t.Fatal("远端不存在时 remoteKnown 应为 false")
	}
}

func TestSaveConditionalStaleETagFailsFreshSucceeds(t *testing.T) {
	stub, srv := mustStub(t, "digest")
	ctx := context.Background()

	devA := buildChannel(t, srv.URL, authOpts("digest"))
	if s, err := devA.Load(ctx); err != nil || s.Revision != 0 {
		t.Fatalf("A 首轮 Load: %v %#v", err, s)
	}
	if err := devA.SaveConditional(ctx, testSnap(1, "A 的首写"), 0); err != nil {
		t.Fatalf("A 条件首写（If-None-Match 创建）: %v", err)
	}

	// B 设备完整走一轮：Load → 推进版本 → 条件写。
	devB := buildChannel(t, srv.URL, authOpts("digest"))
	bSnap, err := devB.Load(ctx)
	if err != nil || bSnap.Revision != 1 {
		t.Fatalf("B Load: %v rev=%d", err, bSnap.Revision)
	}
	if err := devB.SaveConditional(ctx, testSnap(2, "B 抢先推进"), bSnap.Revision); err != nil {
		t.Fatalf("B 条件写: %v", err)
	}

	// A 拿着过期校验值再写 → 必须失败且远端内容不被破坏。
	err = devA.SaveConditional(ctx, testSnap(3, "A 的过期写"), 1)
	if !errors.Is(err, ErrRemoteAdvanced) {
		t.Fatalf("过期条件写应得 ErrRemoteAdvanced，实际: %v", err)
	}
	if strings.Contains(err.Error(), "u:") || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("错误泄露凭证: %v", err)
	}
	stub.mu.Lock()
	body := string(stub.objs["/dav/"+snapshotFileName].data)
	stub.mu.Unlock()
	if !strings.Contains(body, "B 抢先推进") || strings.Contains(body, "A 的过期写") {
		t.Fatalf("412 后远端内容被破坏: %s", body)
	}

	// A 重新 Load 后条件写应成功。
	if s, err := devA.Load(ctx); err != nil || s.Revision != 2 {
		t.Fatalf("A 重 Load: %v rev=%d", err, s.Revision)
	}
	if err := devA.SaveConditional(ctx, testSnap(3, "A 重来后写入"), 2); err != nil {
		t.Fatalf("A 重来后条件写: %v", err)
	}
	stub.mu.Lock()
	body = string(stub.objs["/dav/"+snapshotFileName].data)
	stub.mu.Unlock()
	if !strings.Contains(body, "A 重来后写入") {
		t.Fatalf("重来的条件写没落到远端: %s", body)
	}
}

func TestSaveConditionalRaceToFirstWriteBlocked(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	ctx := context.Background()
	devA := buildChannel(t, srv.URL, authOpts("basic"))
	if _, err := devA.Load(ctx); err != nil { // A 看到空远端
		t.Fatal(err)
	}
	devB := buildChannel(t, srv.URL, authOpts("basic"))
	if err := devB.Save(ctx, testSnap(1, "B 先创建")); err != nil { // B 抢先落盘
		t.Fatal(err)
	}
	// A 的条件仍是 If-None-Match:* → 412，不许把 B 抹掉。
	if err := devA.SaveConditional(ctx, testSnap(1, "A 晚到的首写"), 0); !errors.Is(err, ErrRemoteAdvanced) {
		t.Fatalf("晚到首写应被拒: %v", err)
	}
	stub.mu.Lock()
	body := string(stub.objs["/dav/"+snapshotFileName].data)
	stub.mu.Unlock()
	if !strings.Contains(body, "B 先创建") {
		t.Fatalf("首写竞争失败方覆盖了胜方: %s", body)
	}
}

func TestRetry429OnceThenSuccess(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	fastRetry(t)
	ctx := context.Background()
	c := buildChannel(t, srv.URL, authOpts("basic"))
	if err := c.Save(ctx, testSnap(1, "限流后仍要到")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	stub.mu.Lock()
	stub.flaky, stub.flakyStatus = 1, http.StatusTooManyRequests
	before := stub.counts["GET"]
	stub.mu.Unlock()
	got, err := c.Load(ctx)
	if err != nil {
		t.Fatalf("429 后 Load 应重试成功: %v", err)
	}
	if got.Revision != 1 {
		t.Fatalf("Load 内容不对: %#v", got)
	}
	stub.mu.Lock()
	after := stub.counts["GET"]
	stub.mu.Unlock()
	if after-before != 2 {
		t.Fatalf("期望一次 429 + 一次成功共 2 个 GET，实际 %d", after-before)
	}
}

func TestPersistent5xxLimitedRetries(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	fastRetry(t)
	c := buildChannel(t, srv.URL, authOpts("basic"))
	stub.mu.Lock()
	stub.down = true
	stub.mu.Unlock()
	_, err := c.Load(context.Background())
	if err == nil {
		t.Fatal("持续 5xx 应报错")
	}
	if !strings.Contains(err.Error(), "放弃") {
		t.Fatalf("错误应说明重试耗尽: %v", err)
	}
	stub.mu.Lock()
	n := stub.counts["GET"]
	stub.mu.Unlock()
	if n != maxRetries+1 {
		t.Fatalf("重试次数 %d，期望恰好 %d", n, maxRetries+1)
	}
}

func TestNoETagOnGETFallsBackToPropfind(t *testing.T) {
	stub, srv := mustStub(t, "basic")
	ctx := context.Background()
	setup := buildChannel(t, srv.URL, authOpts("basic"))
	if err := setup.Save(ctx, testSnap(7, "无 GET ETag")); err != nil {
		t.Fatal(err)
	}
	stub.mu.Lock()
	stub.omitETagGet = true
	wantETag := stub.objs["/dav/"+snapshotFileName].etag
	stub.mu.Unlock()

	c := buildChannel(t, srv.URL, authOpts("basic"))
	if _, err := c.Load(ctx); err != nil {
		t.Fatalf("Load: %v", err)
	}
	known, etag, _ := c.validator()
	if !known || etag != wantETag {
		t.Fatalf("PROPFIND 兜底没拿到校验值: known=%v etag=%q want=%q", known, etag, wantETag)
	}
	// 拿到的校验值应能驱动条件写。
	if err := c.SaveConditional(ctx, testSnap(8, "条件写"), 7); err != nil {
		t.Fatalf("基于 PROPFIND ETag 的条件写失败: %v", err)
	}
}

func TestNestedDirsAndConditionalWithDirs(t *testing.T) {
	stub, srv := mustStub(t, "digest")
	ctx := context.Background()
	opts := authOpts("digest")
	opts["path"] = "plan for do/同步"
	c := buildChannel(t, srv.URL, opts)
	if err := c.Probe(ctx); err != nil {
		t.Fatalf("Probe 嵌套目录: %v", err)
	}
	stub.mu.Lock()
	ok := stub.dirs["/dav/plan for do"] && stub.dirs["/dav/plan for do/同步"]
	stub.mu.Unlock()
	if !ok {
		t.Fatalf("嵌套目录没建全: %v", stub.dirs)
	}
	if _, err := c.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.SaveConditional(ctx, testSnap(1, "深路径首写"), 0); err != nil {
		t.Fatalf("深路径条件写: %v", err)
	}
	stub.mu.Lock()
	_, exists := stub.objs["/dav/plan for do/同步/"+snapshotFileName]
	stub.mu.Unlock()
	if !exists {
		t.Fatal("深路径快照没落盘")
	}
}

func TestContextCancellationHonored(t *testing.T) {
	_, srv := mustStub(t, "basic")
	c := buildChannel(t, srv.URL, authOpts("basic"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Probe(ctx); err == nil {
		t.Fatal("取消的 ctx 应让请求失败")
	} else if !errors.Is(err, context.Canceled) {
		t.Fatalf("应透传 context.Canceled: %v", err)
	}
}

func TestChallengeParsing(t *testing.T) {
	cs := parseChallenges([]string{
		`Digest realm="dav, with comma", nonce="abc123", opaque="x", qop="auth,int", stale=TRUE`,
		`Basic realm="b"`,
	})
	if len(cs) != 2 {
		t.Fatalf("挑战条数: %d", len(cs))
	}
	if cs[0].scheme != "digest" || cs[0].params["realm"] != "dav, with comma" {
		t.Fatalf("Digest 挑战解析错: %#v", cs[0])
	}
	if cs[0].params["stale"] != "TRUE" {
		t.Fatalf("stale 参数丢了: %#v", cs[0].params)
	}
	q, ok := pickQop(cs[0].params["qop"])
	if !ok || q != "auth" {
		t.Fatalf("qop=auth,int 应选 auth，得 %q ok=%v", q, ok)
	}
	if _, ok := pickQop("auth-int"); ok {
		t.Error("仅 auth-int 时必须明确失败而不是算错应答")
	}
}
