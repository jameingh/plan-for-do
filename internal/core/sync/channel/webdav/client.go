package webdav

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// defaultTimeout 是单个请求的默认超时；可用 options.timeoutSeconds 覆盖。
const defaultTimeout = 30 * time.Second

// maxRetries 是 429/5xx 的退避重试上限（不含首次尝试）。
const maxRetries = 3

// retryBaseDelay 用变量而非常量，方便测试把退避压到毫秒级。
var retryBaseDelay = 200 * time.Millisecond

// credentials 保存鉴权材料。密码只进 Authorization 头，绝不进日志或错误信息。
type credentials struct {
	username string
	password string
	token    string // Bearer 模式，与 username/password 二选一
}

// digestState 是一次 Digest 认证会话；服务端换 nonce（stale=TRUE）时重建。
type digestState struct {
	realm     string
	nonce     string
	opaque    string
	qop       string
	algorithm string
	nc        uint64
}

// authTransport 在标准库 net/http 之上补 Basic/Digest 挑战-应答。
// 国产 WebDAV（坚果云等）常只认 Digest，而 nginx 部署 Basic/Digest 混用，
// 预设单一方案会一边通一边不通；挑战-应答是唯一两边都能过的写法。
// 401 时按服务端给出的方案重试，成功后记住方案，后续请求抢发认证头省一个来回。
type authTransport struct {
	base http.RoundTripper
	cred credentials

	mu        sync.Mutex
	preferred string       // "basic" | "digest"，上次成功的方案
	cached    *digestState // 复用 nonce、nc 递增
}

func newHTTPClient(cred credentials, insecure bool, timeout time.Duration) *http.Client {
	dflt := http.DefaultTransport.(*http.Transport)
	tr := &http.Transport{
		Proxy:               dflt.Proxy,
		MaxIdleConns:        dflt.MaxIdleConns,
		IdleConnTimeout:     dflt.IdleConnTimeout,
		TLSHandshakeTimeout: dflt.TLSHandshakeTimeout,
	}
	if insecure {
		// 仅当用户显式开 insecureTLS（自签证书场景）；默认绝不跳过校验。
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &http.Client{
		Transport: &authTransport{base: tr, cred: cred},
		Timeout:   timeout,
	}
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.cred.token != "" {
		r := cloneRequest(req)
		r.Header.Set("Authorization", "Bearer "+t.cred.token)
		return t.base.RoundTrip(r)
	}

	// 第一枪：若已知可用方案就抢发认证头，否则裸发等服务端挑战。
	if pre := t.preemptHeader(req); pre != "" {
		r := cloneRequest(req)
		r.Header.Set("Authorization", pre)
		resp, err := t.base.RoundTrip(r)
		if err != nil || resp.StatusCode != http.StatusUnauthorized {
			return resp, err
		}
		return t.challengeAndRetry(req, resp)
	}
	resp, err := t.base.RoundTrip(cloneRequest(req))
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	return t.challengeAndRetry(req, resp)
}

// preemptHeader 依据缓存的方案构造认证头；没有缓存返回空串。
func (t *authTransport) preemptHeader(req *http.Request) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.preferred {
	case "basic":
		return basicHeader(t.cred)
	case "digest":
		if t.cached != nil {
			return t.digestHeaderLocked(t.cached, req)
		}
	}
	return ""
}

// challengeAndRetry 消费 401 的 WWW-Authenticate，选方案重试。
// 最多两轮 Digest（第二轮处理 stale nonce）+ 一轮 Basic，全部失败才把 401 交回上层。
func (t *authTransport) challengeAndRetry(req *http.Request, first *http.Response) (*http.Response, error) {
	challenges := parseChallenges(first.Header.Values("WWW-Authenticate"))
	last := first
	triedBasic := false
	for round := 0; round < 3; round++ {
		drain(last) // 上一发的 401 体不再需要
		ch, scheme := pickChallenge(challenges)
		if scheme == "digest" {
			st := t.digestStateFor(ch)
			hdr := t.digestHeader(st, req)
			if hdr == "" {
				drain(last)
				return nil, errUnsupportedDigest
			}
			r := cloneRequest(req)
			r.Header.Set("Authorization", hdr)
			resp, err := t.base.RoundTrip(r)
			if err != nil {
				return nil, err
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.remember("digest")
				return resp, nil
			}
			challenges = parseChallenges(resp.Header.Values("WWW-Authenticate"))
			last = resp
			if hasStale(challenges) {
				t.forgetDigest()
				continue // 用新 nonce 再战
			}
			// Digest 被硬拒：如果服务端同时还给 Basic 没试过，换 Basic。
			if _, ok := findChallenge(challenges, "basic"); ok {
				if !triedBasic {
					break // 落到下面 basic 分支
				}
			}
			return synthetic401(resp, req), nil
		}
		if scheme == "basic" && !triedBasic {
			triedBasic = true
			r := cloneRequest(req)
			r.Header.Set("Authorization", basicHeader(t.cred))
			resp, err := t.base.RoundTrip(r)
			if err != nil {
				return nil, err
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.remember("basic")
				return resp, nil
			}
			challenges = parseChallenges(resp.Header.Values("WWW-Authenticate"))
			last = resp
			continue
		}
		return synthetic401(last, req), nil
	}
	// Digest 硬拒后转 Basic。
	if _, ok := findChallenge(challenges, "basic"); !triedBasic && ok {
		r := cloneRequest(req)
		r.Header.Set("Authorization", basicHeader(t.cred))
		return t.base.RoundTrip(r)
	}
	return synthetic401(last, req), nil
}

func (t *authTransport) remember(scheme string) {
	t.mu.Lock()
	t.preferred = scheme
	t.mu.Unlock()
}

// errUnsupportedDigest：服务端只给 MD5-SESS 或 qop=auth-int 这类本实现
// 刻意不支持的变体。明说比算一个注定错误的应答好。
var errUnsupportedDigest = errors.New("webdav: 服务器的 Digest 参数不受支持（仅承诺 MD5/SHA-256 + qop=auth）")

func (t *authTransport) forgetDigest() {
	t.mu.Lock()
	t.cached = nil
	t.mu.Unlock()
}

// digestStateFor 取/建 Digest 会话。同 realm+nonce 时复用缓存会话，
// 让 nc 跨请求单调递增（RFC 7616 要求）；nonce 换了（stale）才重置。
func (t *authTransport) digestStateFor(ch challenge) *digestState {
	alg := strings.ToUpper(ch.params["algorithm"])
	if alg == "" {
		alg = "MD5"
	}
	switch alg {
	case "MD5", "SHA-256", "SHA256":
	default:
		// 含 MD5-SESS 与 SHA-512-256：宁可明确失败，也不拿 MD5 冒充算出一个
		// 注定错误的应答，让用户误以为是凭证问题。
		return nil
	}
	qop, ok := pickQop(ch.params["qop"])
	if !ok {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cached != nil && t.cached.nonce == ch.params["nonce"] && t.cached.realm == ch.params["realm"] {
		return t.cached
	}
	t.cached = &digestState{
		realm:     ch.params["realm"],
		nonce:     ch.params["nonce"],
		opaque:    ch.params["opaque"],
		qop:       qop,
		algorithm: alg,
	}
	return t.cached
}

func (t *authTransport) digestHeader(st *digestState, req *http.Request) string {
	if st == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.digestHeaderLocked(st, req)
}

// digestHeaderLocked 按 RFC 7616/2617 计算 Digest 应答。调用方必须持有 t.mu
// （同一保护锁下完成 nc 递增与 cnonce 生成，保证 nc/cnonce 成对出现在
// 应答哈希和请求头里——这是协议要求而非实现细节）。
func (t *authTransport) digestHeaderLocked(st *digestState, req *http.Request) string {
	if st == nil {
		return ""
	}
	st.nc++
	uri := req.URL.EscapedPath()
	if req.URL.RawQuery != "" {
		uri += "?" + req.URL.RawQuery
	}
	h := hashFunc(st.algorithm)
	ha1 := h(t.cred.username + ":" + st.realm + ":" + t.cred.password)
	ha2 := h(req.Method + ":" + uri)
	nc := fmt.Sprintf("%08x", st.nc)
	cnonce := randomHex(16)
	var response string
	if st.qop == "" {
		response = h(ha1 + ":" + st.nonce + ":" + ha2) // RFC 2069 legacy
		return joinDigest(t.cred.username, st, uri, nc, cnonce, response, false)
	}
	response = h(ha1 + ":" + st.nonce + ":" + nc + ":" + cnonce + ":" + st.qop + ":" + ha2)
	return joinDigest(t.cred.username, st, uri, nc, cnonce, response, true)
}

func joinDigest(username string, st *digestState, uri, nc, cnonce, response string, withQop bool) string {
	parts := []string{
		`username="` + escapeQuote(username) + `"`,
		`realm="` + escapeQuote(st.realm) + `"`,
		`nonce="` + escapeQuote(st.nonce) + `"`,
		`uri="` + escapeQuote(uri) + `"`,
		`algorithm=` + st.algorithm,
	}
	if withQop {
		parts = append(parts, `qop=`+st.qop, `nc=`+nc, `cnonce="`+cnonce+`"`)
	}
	parts = append(parts, `response="`+response+`"`)
	if st.opaque != "" {
		parts = append(parts, `opaque="`+escapeQuote(st.opaque)+`"`)
	}
	return "Digest " + strings.Join(parts, ", ")
}

func escapeQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return r.Replace(s)
}

func basicHeader(cred credentials) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(cred.username+":"+cred.password))
}

// hashFunc 支持 MD5 与 SHA-256（RFC 7616）。未知算法报错，
// 免得拿错哈希算出 response 对不上、还以为是凭证错误。
func hashFunc(algorithm string) func(string) string {
	switch algorithm {
	case "SHA-256", "SHA256":
		return func(s string) string {
			sum := sha256.Sum256([]byte(s))
			return hex.EncodeToString(sum[:])
		}
	default:
		return func(s string) string {
			sum := md5.Sum([]byte(s))
			return hex.EncodeToString(sum[:])
		}
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

// pickQop 只承诺支持 qop=auth（任务要求）；auth-int 需要对 body 做哈希，
// 本实现不支持，遇到只给 auth-int 的服务端明确失败而不是算错应答。
// 返回 ok=false 表示无可用 qop。
func pickQop(csv string) (string, bool) {
	for _, q := range strings.Split(csv, ",") {
		if strings.EqualFold(strings.TrimSpace(q), "auth") {
			return "auth", true
		}
	}
	// 没有 qop 参数：RFC 2069 legacy 模式。
	if strings.TrimSpace(csv) == "" {
		return "", true
	}
	return "", false
}

type challenge struct {
	scheme string
	params map[string]string
}

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// parseChallenges 解析 WWW-Authenticate。多个头值各算一条挑战；同一条值内
// scheme 后是逗号分隔的 k=v，v 可为带反斜杠转义的引号串或裸 token。
func parseChallenges(values []string) []challenge {
	var out []challenge
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		sp := strings.IndexAny(v, " \t")
		if sp < 0 {
			out = append(out, challenge{scheme: strings.ToLower(v), params: map[string]string{}})
			continue
		}
		scheme := strings.ToLower(v[:sp])
		if !tokenRe.MatchString(scheme) {
			continue
		}
		out = append(out, challenge{scheme: scheme, params: parseParams(v[sp+1:])})
	}
	return out
}

func parseParams(s string) map[string]string {
	params := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " \t,")
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			break
		}
		key := strings.ToLower(strings.TrimSpace(s[:eq]))
		s = strings.TrimLeft(s[eq+1:], " \t")
		var val string
		if len(s) > 0 && s[0] == '"' {
			var b strings.Builder
			i := 1
			for ; i < len(s); i++ {
				if s[i] == '\\' && i+1 < len(s) {
					b.WriteByte(s[i+1])
					i++
					continue
				}
				if s[i] == '"' {
					break
				}
				b.WriteByte(s[i])
			}
			val = b.String()
			s = strings.TrimLeft(s[min(i+1, len(s)):], " \t")
		} else {
			end := strings.IndexByte(s, ',')
			if end < 0 {
				end = len(s)
			}
			val = strings.TrimSpace(s[:end])
			s = s[end:]
		}
		params[key] = val
	}
	return params
}

func findChallenge(cs []challenge, scheme string) (challenge, bool) {
	for _, c := range cs {
		if c.scheme == scheme {
			return c, true
		}
	}
	return challenge{}, false
}

// pickChallenge 优先 Digest（更强的方案），其次 Basic。
func pickChallenge(cs []challenge) (challenge, string) {
	if c, ok := findChallenge(cs, "digest"); ok {
		return c, "digest"
	}
	if c, ok := findChallenge(cs, "basic"); ok {
		return c, "basic"
	}
	return challenge{}, ""
}

func hasStale(cs []challenge) bool {
	for _, c := range cs {
		if c.scheme == "digest" && strings.EqualFold(c.params["stale"], "true") {
			return true
		}
	}
	return false
}

// synthetic401 把"认证尝试用尽"的最后一发整理成干净的 401，
// 头保留供上层诊断（realm 等），body 置空。
func synthetic401(resp *http.Response, req *http.Request) *http.Response {
	h := http.Header{}
	if resp != nil {
		for k, vs := range resp.Header {
			if strings.EqualFold(k, "WWW-Authenticate") {
				for _, v := range vs {
					h.Add(k, v)
				}
			}
		}
		drain(resp) // 丢弃最后一发 401 的 body，归还连接
	}
	return &http.Response{
		StatusCode: http.StatusUnauthorized,
		Status:     "401 Unauthorized",
		Header:     h,
		Body:       http.NoBody,
		Request:    req,
	}
}

// cloneRequest 复制请求并用 GetBody 重置 body，
// 让挑战-应答重试能重发同一份内容（快照是内存里的字节，GetBody 总是可用）。
func cloneRequest(req *http.Request) *http.Request {
	r := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody && req.GetBody != nil {
		if b, err := req.GetBody(); err == nil {
			r.Body = b
		}
	}
	return r
}

func drain(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	resp.Body.Close()
}

// doer 负责发请求与 429/5xx 有限退避重试。错误信息只谈地址与状态码，
// 凭证绝不出现。
type doer struct {
	client *http.Client
}

// response 是重试结束后的最终响应（body 已全部读进内存，快照响应都很小）。
type response struct {
	status   int
	header   http.Header
	body     []byte
	finalURL string
}

func (d *doer) do(ctx context.Context, method, rawURL string, body []byte, extra http.Header) (*response, error) {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := retryBaseDelay << (attempt - 1)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}
		var rdr io.Reader = http.NoBody
		if body != nil {
			// bytes.Reader 让 http.NewRequest 自动填 GetBody，
			// 认证挑战重试时才能把同一份 body 重发。
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, rawURL, rdr)
		if err != nil {
			return nil, fmt.Errorf("webdav: 构造请求: %w", err)
		}
		if body != nil {
			req.ContentLength = int64(len(body))
		}
		for k, vs := range extra {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
		resp, err := d.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = fmt.Errorf("%s 请求失败: %v", method, err)
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("读取响应: %v", readErr)
			continue
		}
		if retryable(resp.StatusCode) {
			lastErr = fmt.Errorf("服务器返回 %d", resp.StatusCode)
			continue
		}
		return &response{status: resp.StatusCode, header: resp.Header, body: raw,
			finalURL: resp.Request.URL.String()}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("请求失败")
	}
	return nil, fmt.Errorf("webdav: 重试 %d 次后放弃: %v（%s）", maxRetries, lastErr, redactURL(rawURL))
}

func retryable(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusLocked, // 423，个别 DAV 服务端处理中
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// propEntry 是 PROPFIND 207 响应里的一条成员。encoding/xml 的 tag 不带
// 命名空间时按 local name 匹配，DAV: 前缀（d: 或默认）都能解析。
type propEntry struct {
	Href         string `xml:"href"`
	ETag         string `xml:"propstat>prop>getetag"`
	LastModified string `xml:"propstat>prop>getlastmodified"`
	Collection   bool   `xml:"propstat>prop>resourcetype>collection"`
}

type multistatus struct {
	XMLName xml.Name    `xml:"multistatus"`
	Entries []propEntry `xml:"response"`
}

// propfind 发指定 Depth 的 PROPFIND。404（集合不存在）返回空列表不报错。
func (d *doer) propfind(ctx context.Context, rawURL string, depth string) ([]propEntry, *response, error) {
	body := []byte(`<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`)
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/xml; charset=utf-8")
	hdr.Set("Depth", depth)
	resp, err := d.do(ctx, "PROPFIND", rawURL, body, hdr)
	if err != nil {
		return nil, nil, err
	}
	if resp.status == http.StatusNotFound {
		return nil, resp, nil
	}
	if resp.status != 207 && resp.status != http.StatusOK {
		return nil, resp, nil
	}
	var ms multistatus
	if err := xml.Unmarshal(resp.body, &ms); err != nil {
		return nil, resp, fmt.Errorf("webdav: 解析 PROPFIND 响应: %w", err)
	}
	return ms.Entries, resp, nil
}

// redactURL 去掉 URL 里可能内嵌的 userinfo。
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = nil
	return u.String()
}
