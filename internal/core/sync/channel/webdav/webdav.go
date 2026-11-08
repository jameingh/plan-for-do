// Package webdav 实现 sync.Channel 的 WebDAV 通道：把一个 JSON 快照文件
// 存在 DAV 服务器上（坚果云、Nextcloud、nginx+dav 等），用标准库 net/http
// 手写客户端，支持 Basic 与 Digest 鉴权。
package webdav

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	syncstd "sync"
	"time"

	"planfordo/internal/core/store"
	"planfordo/internal/core/sync"
)

// snapshotFileName 与 localdir 通道保持一致：把一个 DAV 目录指进来时，
// 多设备（以及从 localdir 迁移过来的用户）天然对齐同一个文件。
const snapshotFileName = "planfordo-snapshot.json"

var installOnce syncstd.Once

// Install 把 "webdav" 注册进 sync 工厂表。幂等：重复调用不 panic。
// init 自动调用一次，import 本包即可用 sync.Build；显式 Install 留给
// 需要"确保已注册"语义的调用方与测试。
func Install() {
	installOnce.Do(func() {
		if !hasKind("webdav") {
			sync.Register("webdav", newChannel)
		}
	})
}

func init() { Install() }

func hasKind(kind string) bool {
	for _, k := range sync.Kinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// ErrRemoteAdvanced 表示条件写失败：远端快照已被别的设备推进。
// 引擎会带着新快照重来一轮，而不是静默覆盖先写者。
var ErrRemoteAdvanced = errors.New("webdav: 远端快照已被其他设备推进，本轮放弃写入")

// Channel 是一条 WebDAV 同步通道。
//
// 并发控制设计：sync.Snapshot 没有 ETag 字段，也不该为某个通道加字段
// （快照要跨通道互换），所以"最近一次 Load 看到的远端校验值"随通道实例
// 携带。引擎每轮 SyncOne 都重新 Build 通道并在同一实例上完成 Load →
// SaveConditional，实例字段的生命周期恰好等于一轮同步——上一轮的旧 ETag
// 不可能被误当作本轮的条件，这比"kind → ETag"的全局映射更安全（多个
// 同名通道或并发轮次会互相踩）。mu 保护这些字段与目录确保标记，因为
// 同一实例理论上可被并发调用；remoteKnown 区分"确认不存在"与"还没查过"。
type Channel struct {
	name    string
	root    string   // 已含 scheme/authority/前缀路径，末尾无 "/"
	dirSegs []string // path 选项的原始分段（未编码）
	cred    credentials
	timeout time.Duration

	dl *doer

	mu syncstd.Mutex
	// 目录 MKCOL 只需成功确保一次；失败不留标记，下次调用自然重试
	//（比如瞬时 5xx 之后恢复）。
	dirsOK bool
	// 最近一次观察到的远端状态。observed 区分"这轮已经看过（存在或不存在）"
	// 与"还没查过"：条件写必须以 Load 时看到的校验值为准，中途 re-stat 会把
	// 竞争窗口洗掉，等于无条件覆盖。
	observed    bool
	remoteKnown bool
	lastETag    string
	lastMod     string
}

// newChannel 是 sync.Factory。opts 键：
//
//	url / path / username / password / token / insecureTLS / timeoutSeconds
func newChannel(name string, opts map[string]string) (sync.Channel, error) {
	if name == "" {
		return nil, errors.New("webdav: 通道名不能为空")
	}
	rawRoot := strings.TrimSpace(opts["url"])
	if rawRoot == "" {
		return nil, errors.New("webdav: 缺少 options.url（DAV 根地址）")
	}
	u, err := url.Parse(rawRoot)
	if err != nil {
		return nil, fmt.Errorf("webdav: options.url 无法解析: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("webdav: options.url 只支持 http/https")
	}
	if u.User != nil {
		// 不回显 URL 里的凭证。
		return nil, errors.New("webdav: options.url 不允许内嵌用户名/密码，请用 username/password 或 token")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("webdav: options.url 不应带查询串或锚点")
	}

	c := &Channel{name: name, root: strings.TrimRight(u.String(), "/")}
	var insecure bool

	// path：相对根的原始目录前缀；这里只校验并保留未编码形态，
	// 拼 URL 时统一恰好编码一次，避免双重编码。
	if p := opts["path"]; p != "" {
		segs, err := splitRawPath(p)
		if err != nil {
			return nil, err
		}
		c.dirSegs = segs
	}

	// 凭证：token（Bearer）与 username/password（Basic/Digest）二选一。
	c.cred.token = strings.TrimSpace(opts["token"])
	c.cred.username = opts["username"]
	c.cred.password = opts["password"]
	if c.cred.token != "" {
		if c.cred.username != "" || c.cred.password != "" {
			return nil, errors.New("webdav: token 与 username/password 只能二选一")
		}
	} else if c.cred.username == "" && c.cred.password == "" {
		return nil, errors.New("webdav: 需要 username+password 或 token")
	}

	if s := strings.TrimSpace(opts["insecureTLS"]); s != "" {
		b, err := strconv.ParseBool(s)
		if err != nil {
			return nil, fmt.Errorf("webdav: insecureTLS 需要布尔值: %w", err)
		}
		insecure = b
	}
	c.timeout = defaultTimeout
	if s := strings.TrimSpace(opts["timeoutSeconds"]); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			return nil, errors.New("webdav: timeoutSeconds 需要正整数")
		}
		c.timeout = time.Duration(n) * time.Second
	}

	c.dl = &doer{client: newHTTPClient(c.cred, insecure, c.timeout)}
	return c, nil
}

// Name 返回通道名。
func (c *Channel) Name() string { return c.name }

// Kind 返回通道类型。
func (c *Channel) Kind() string { return "webdav" }

// dirURL 拼出第 n 层目录的完整 URL（原始段恰好编码一次，根 URL 原样保留）。
func (c *Channel) dirURL(n int) string {
	var b strings.Builder
	b.WriteString(c.root)
	for _, seg := range c.dirSegs[:n] {
		b.WriteByte('/')
		b.WriteString(escapeSegment(seg))
	}
	return b.String()
}

func (c *Channel) snapshotURL() string {
	return c.dirURL(len(c.dirSegs)) + "/" + escapeSegment(snapshotFileName)
}

// ensureDirs 逐段 MKCOL 确保快照目录存在。已存在时服务器常返回 405/301，
// 这些都算成功；凭证错误等真问题原样上抛（地址已 redact，不含凭证）。
func (c *Channel) ensureDirs(ctx context.Context) error {
	c.mu.Lock()
	ok := c.dirsOK
	c.mu.Unlock()
	if ok {
		return nil
	}
	for n := 1; n <= len(c.dirSegs); n++ {
		u := c.dirURL(n)
		resp, err := c.dl.do(ctx, "MKCOL", u, nil, nil)
		if err != nil {
			return err
		}
		if mkcolOK(resp.status) {
			continue
		}
		if isAuthFailure(resp.status) {
			return authError(resp)
		}
		return fmt.Errorf("webdav: 建目录 %s 失败，状态 %d", redactURL(u), resp.status)
	}
	c.mu.Lock()
	c.dirsOK = true
	c.mu.Unlock()
	return nil
}

func mkcolOK(status int) bool {
	switch status {
	case http.StatusCreated, http.StatusNoContent, // 201/204 新建成功
		http.StatusMethodNotAllowed,                   // 405 已存在
		http.StatusConflict,                           // 409：坚果云等对已存在集合的怪答案，交由后续请求验证
		http.StatusMovedPermanently, http.StatusFound, // 301/302 尾部斜杠归一
		http.StatusForbidden: // 个别服务端对已存在集合的 MKCOL 回 403
		return true
	}
	return false
}

// Probe 检查连通性与写权限：确保目录存在，再 PROPFIND 该层确认可读。
func (c *Channel) Probe(ctx context.Context) error {
	if err := c.ensureDirs(ctx); err != nil {
		return err
	}
	dir := c.dirURL(len(c.dirSegs)) + "/"
	_, resp, err := c.dl.propfind(ctx, dir, "1")
	if err != nil {
		return err
	}
	if resp == nil {
		return fmt.Errorf("webdav: PROPFIND %s 无响应", redactURL(dir))
	}
	if isAuthFailure(resp.status) {
		return authError(resp)
	}
	if resp.status == http.StatusNotFound {
		return fmt.Errorf("webdav: 目录不存在且无法创建: %s", redactURL(dir))
	}
	return nil
}

// Load 读远端快照。文件不存在（404 等）返回空快照，首轮同步从这里起步。
// 顺带把远端校验值（ETag，缺失则 last-modified/getlastmodified）记进
// 通道实例，供同轮的 SaveConditional 做乐观并发——理由见 Channel 注释。
func (c *Channel) Load(ctx context.Context) (*sync.Snapshot, error) {
	// 建目录失败不拦读取：凭证只读或目录已存在时仍应能拉到快照；
	// 真正的问题会在下面的 GET 上以更准确的错误暴露。
	_ = c.ensureDirs(ctx)
	fileURL := c.snapshotURL()
	resp, err := c.dl.do(ctx, "GET", fileURL, nil, nil)
	if err != nil {
		return nil, err
	}
	switch {
	case resp.status == http.StatusOK:
		s, err := sync.ParseSnapshot(resp.body)
		if err != nil {
			return nil, err
		}
		etag := strings.TrimSpace(resp.header.Get("ETag"))
		lastMod := resp.header.Get("Last-Modified")
		c.setValidator(true, etag, lastMod)
		if etag == "" && lastMod == "" {
			c.enrichValidator(ctx, fileURL)
		}
		return s, nil
	case remoteMissing(resp.status):
		c.setValidator(false, "", "")
		return &sync.Snapshot{Schema: sync.SchemaVersion, Records: []store.Entity{}}, nil
	case isAuthFailure(resp.status):
		return nil, authError(resp)
	default:
		return nil, fmt.Errorf("webdav: GET %s 返回意外状态 %d", redactURL(fileURL), resp.status)
	}
}

// remoteMissing 把"文件还不存在"的服务器表达归拢：404 是标准答案，
// 412 出现在个别服务端对异常条件头的答复里——对首轮同步统一按空快照起步。
func remoteMissing(status int) bool {
	return status == http.StatusNotFound || status == http.StatusPreconditionFailed
}

func isAuthFailure(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden
}

// authError 只引用 realm 这类可诊断信息；凭证绝不进错误文本。
func authError(resp *response) error {
	realm := ""
	if h := resp.header.Get("WWW-Authenticate"); h != "" {
		for _, ch := range parseChallenges([]string{h}) {
			if r := ch.params["realm"]; r != "" {
				realm = r
				break
			}
		}
	}
	if realm != "" {
		return fmt.Errorf("webdav: 凭证被服务器拒绝（状态 %d，realm %q），请检查用户名与应用密码", resp.status, realm)
	}
	return fmt.Errorf("webdav: 凭证被服务器拒绝（状态 %d），请检查用户名与应用密码", resp.status)
}

// setValidator 更新通道实例里的远端校验值缓存。
func (c *Channel) setValidator(known bool, etag, lastMod string) {
	c.mu.Lock()
	c.observed = true
	c.remoteKnown = known
	c.lastETag = etag
	c.lastMod = lastMod
	c.mu.Unlock()
}

// forgetValidator 在条件写失败后作废缓存，强制下一轮先 Load。
func (c *Channel) forgetValidator() {
	c.mu.Lock()
	c.observed = false
	c.remoteKnown = false
	c.lastETag = ""
	c.lastMod = ""
	c.mu.Unlock()
}

func (c *Channel) hasObserved() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.observed
}

func (c *Channel) validator() (known bool, etag, lastMod string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.remoteKnown, c.lastETag, c.lastMod
}

// enrichValidator 在 GET 没带 ETag/Last-Modified 时补一次 Depth:0 PROPFIND，
// 从 getetag / getlastmodified 取校验值（部分服务端只在这里给）。
func (c *Channel) enrichValidator(ctx context.Context, fileURL string) {
	entries, _, err := c.dl.propfind(ctx, fileURL, "0")
	if err != nil || len(entries) == 0 {
		return
	}
	e := matchEntry(entries, fileURL)
	c.mu.Lock()
	if c.remoteKnown && c.lastETag == "" && c.lastMod == "" {
		c.lastETag = strings.TrimSpace(e.ETag)
		c.lastMod = e.LastModified
	}
	c.mu.Unlock()
}

// matchEntry 从 PROPFIND 结果里挑出目标资源自己那条。
// 兼容性：Depth:1 时不少服务端会把"集合自身"也列进来；href 也可能是
// 绝对 URL 或根相对混写。统一取路径、解码后按尾段比对。
func matchEntry(entries []propEntry, targetURL string) propEntry {
	want := normalizeHref(urlPathOf(targetURL))
	var fallback propEntry
	for _, e := range entries {
		got := normalizeHref(urlPathOf(e.Href))
		if got == want || strings.HasSuffix(want, "/"+got) || strings.HasSuffix(got, "/"+want) {
			return e
		}
		if fallback.Href == "" {
			fallback = e
		}
	}
	return fallback
}

func normalizeHref(p string) string {
	dec, err := decodePath(p)
	if err != nil {
		dec = p
	}
	return strings.ToLower(strings.TrimRight(dec, "/"))
}

func urlPathOf(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Path != "" {
		return u.Path
	}
	return raw
}

// Save 无条件覆盖写回（与 localdir 语义一致：引擎合并后的全量就是真相）。
func (c *Channel) Save(ctx context.Context, s *sync.Snapshot) error {
	if s == nil {
		return errors.New("webdav: 快照为空")
	}
	if err := c.ensureDirs(ctx); err != nil {
		return err
	}
	resp, err := c.putSnapshot(ctx, c.snapshotURL(), s, nil)
	if err != nil {
		return err
	}
	c.setValidator(true, strings.TrimSpace(resp.header.Get("ETag")), resp.header.Get("Last-Modified"))
	return nil
}

// SaveConditional 用最近一次 Load 带回的 ETag（或 last-modified/getlastmodified）
// 做乐观并发：
//
//   - 已知远端有快照 + 有 ETag → If-Match: <etag>
//   - 已知远端有快照 + 无 ETag 有 last-modified → If: "<gmt>"（RFC 4918 §7.1.1）
//   - 已知远端没有快照 → If-None-Match: *（只许创建，不许覆盖抢先者）
//   - 完全不知道远端状态（没 Load 过）→ 先查一次再定条件
//
// 412 前置检查失败时返回包装 ErrRemoteAdvanced 的错误：明确告诉调用方
// "远端已被别的设备推进"，绝不静默覆盖。失败后缓存校验值作废，
// 强制下一轮先 Load。
func (c *Channel) SaveConditional(ctx context.Context, s *sync.Snapshot, expectRevision int64) error {
	if s == nil {
		return errors.New("webdav: 快照为空")
	}
	if err := c.ensureDirs(ctx); err != nil {
		return err
	}
	fileURL := c.snapshotURL()
	known, etag, lastMod := c.validator()
	if !c.hasObserved() {
		if err := c.statRemote(ctx, fileURL); err != nil {
			return err
		}
		known, etag, lastMod = c.validator()
	}
	cond := http.Header{}
	switch {
	case !known:
		cond.Set("If-None-Match", "*")
	case etag != "":
		cond.Set("If-Match", etag)
	case lastMod != "":
		cond.Set("If", "<"+lastMod+">")
	default:
		c.forgetValidator()
		return fmt.Errorf("webdav: 服务器不提供 ETag 与 last-modified，无法条件写入（期望修订 %d），拒绝盲目覆盖", expectRevision)
	}
	raw, err := s.Bytes()
	if err != nil {
		return err
	}
	resp, err := c.putRaw(ctx, fileURL, raw, cond)
	if err != nil {
		return err
	}
	if resp.status == http.StatusPreconditionFailed {
		c.forgetValidator()
		return fmt.Errorf("%w：期望修订 %d 的校验值已失效，请重新拉取合并后重试", ErrRemoteAdvanced, expectRevision)
	}
	if !putOK(resp.status) {
		c.forgetValidator()
		if isAuthFailure(resp.status) {
			return authError(resp)
		}
		return fmt.Errorf("webdav: 条件 PUT %s 返回状态 %d", redactURL(fileURL), resp.status)
	}
	c.setValidator(true, strings.TrimSpace(resp.header.Get("ETag")), resp.header.Get("Last-Modified"))
	return nil
}

// statRemote 查询远端快照是否存在及其校验值（给没 Load 过的条件写用）。
func (c *Channel) statRemote(ctx context.Context, fileURL string) error {
	resp, err := c.dl.do(ctx, "GET", fileURL, nil, nil)
	if err != nil {
		return err
	}
	if isAuthFailure(resp.status) {
		return authError(resp)
	}
	if remoteMissing(resp.status) {
		c.setValidator(false, "", "")
		return nil
	}
	if resp.status != http.StatusOK {
		return fmt.Errorf("webdav: 探测远端快照返回意外状态 %d", resp.status)
	}
	etag := strings.TrimSpace(resp.header.Get("ETag"))
	lastMod := resp.header.Get("Last-Modified")
	c.setValidator(true, etag, lastMod)
	if etag == "" && lastMod == "" {
		c.enrichValidator(ctx, fileURL)
	}
	return nil
}

func (c *Channel) putSnapshot(ctx context.Context, fileURL string, s *sync.Snapshot, cond http.Header) (*response, error) {
	raw, err := s.Bytes()
	if err != nil {
		return nil, err
	}
	return c.putRaw(ctx, fileURL, raw, cond)
}

// putRaw 发送带 JSON 体的 PUT；409（缺集合）时补一次 ensureDirs 再试一次。
// 其余状态码原样返回，由调用方按语义处理（412=并发冲突等）。
func (c *Channel) putRaw(ctx context.Context, fileURL string, raw []byte, cond http.Header) (*response, error) {
	hdr := http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}
	for k, vs := range cond {
		for _, v := range vs {
			hdr.Add(k, v)
		}
	}
	resp, err := c.dl.do(ctx, "PUT", fileURL, raw, hdr)
	if err != nil {
		return nil, err
	}
	if resp.status == http.StatusConflict {
		// 目录被别的客户端删了：清标记重新确保一次再试。
		c.mu.Lock()
		c.dirsOK = false
		c.mu.Unlock()
		if err := c.ensureDirs(ctx); err != nil {
			return nil, err
		}
		resp, err = c.dl.do(ctx, "PUT", fileURL, raw, hdr)
		if err != nil {
			return nil, err
		}
	}
	return resp, nil
}

func putOK(status int) bool {
	switch status {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent, http.StatusResetContent:
		return true
	}
	return false
}
