// Package feishu 给同步引擎提供两条飞书通道：云盘快照（feishuDrive）与多维表格（feishuBase）。
// 两条通道共用一个 tenant_access_token 认证 + HTTP 客户端：token 缓存到临近过期才续签，
// 服务端 401 时刷新一次再重试。凭证只从 Options 读取，app_secret 与 tenant_access_token
// 绝不进日志、错误信息或快照。
package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	stdsync "sync"
	"time"
)

// DefaultBaseURL 是飞书开放平台域名；Lark 国际版租户要用 options.baseUrl 覆盖成
// https://open.larksuite.com，代码里不能写死站点。
const DefaultBaseURL = "https://open.feishu.cn"

const (
	maxBackoff       = 10 * time.Second
	tokenRenewGrace  = 60 * time.Second
	httpCallTimeout  = 30 * time.Second
	maxResponseBytes = 64 << 20
)

// retryBaseDelay / maxAttempts 是包级变量而非常量，方便测试把退避压到毫秒级、
// 把「连续超限放弃」的用例控制在几次请求以内。
var (
	retryBaseDelay = 300 * time.Millisecond
	maxAttempts    = 5
)

// 飞书各 endpoint 的路径集中成变量：鉴权、drive 列目录、bitable records 增删改查
// 的形状文档里写得很确定；drive 的 delete / rename 与建表响应的字段形状存疑，
// 真实环境对不上时只改这里，不必动调用点。存疑项在 README 里也逐条列出。
var (
	pathTenantToken = "/open-apis/auth/v3/tenant_access_token/internal"

	pathDriveList     = "/open-apis/drive/v1/files"
	pathDriveUpload   = "/open-apis/drive/v1/files/upload_all"
	pathDriveDownload = "/open-apis/drive/v1/files/%s/download"
	pathDriveDelete   = "/open-apis/drive/v1/files/%s"
	pathDriveRename   = "/open-apis/drive/v1/files/%s/rename"
	// drive 删除文件的 type 查询参数是否必填存疑，做成变量便于线上纠正。
	driveDeleteQueryType = "file"
	// drive 列目录的分页游标键名在文档里叫 page_token，部分响应实测给 next_page_token，两种都认。
	drivePageTokenKey = "page_token"

	pathBaseTables      = "/open-apis/bitable/v1/apps/%s/tables"
	pathBaseFields      = "/open-apis/bitable/v1/apps/%s/tables/%s/fields"
	pathBaseRecords     = "/open-apis/bitable/v1/apps/%s/tables/%s/records"
	pathBaseBatchCreate = "/open-apis/bitable/v1/apps/%s/tables/%s/records/batch_create"
	pathBaseBatchUpdate = "/open-apis/bitable/v1/apps/%s/tables/%s/records/batch_update"
	pathBaseBatchDelete = "/open-apis/bitable/v1/apps/%s/tables/%s/records/batch_delete"
)

// retryAPICodes 是「HTTP 200 但业务 code 值得重试」的集合。99991400 是全局频控；
// 以后在真实环境遇到别的限流码，往这里加，不改重试骨架。
var retryAPICodes = map[int]bool{99991400: true}

// envelope 是飞书 OpenAPI 的统一响应包装。业务错误也在 HTTP 200 里返回非零 code，
// 只看状态码会把限流当成成功。
type envelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

// apiClient 持有租户凭证与 token 缓存。同一进程里多条通道各自持一个实例，
// 互不共享 token——不同 appId 的缓存混用会拿错身份。
type apiClient struct {
	baseURL   string
	appID     string
	appSecret string
	httpc     *http.Client

	mu         stdsync.Mutex
	token      string
	tokenUntil time.Time
}

// newClient 从 Options 造客户端。错误信息只提键名，不回显任何凭证值。
func newClient(opts map[string]string) (*apiClient, error) {
	appID := strings.TrimSpace(opts["appId"])
	secret := strings.TrimSpace(opts["appSecret"])
	if appID == "" || secret == "" {
		return nil, errors.New("feishu: 通道需要 options.appId 与 options.appSecret")
	}
	base := strings.TrimRight(strings.TrimSpace(stringOr(opts["baseUrl"], DefaultBaseURL)), "/")
	return &apiClient{
		baseURL:   base,
		appID:     appID,
		appSecret: secret,
		httpc:     &http.Client{Timeout: httpCallTimeout},
	}, nil
}

func stringOr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// accessToken 返回缓存的 tenant_access_token；缓存按 expire 提前一个宽限期失效，
// 避免拿着刚过期的 token 去打业务接口再吃一个 401。
func (c *apiClient) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.tokenUntil) {
		return c.token, nil
	}
	body, err := json.Marshal(map[string]string{"app_id": c.appID, "app_secret": c.appSecret})
	if err != nil {
		return "", fmt.Errorf("feishu: 构造鉴权请求: %w", err)
	}
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			if err := sleepBackoff(ctx, attempt, nil); err != nil {
				return "", err
			}
		}
		status, _, raw, err := c.sendOnce(ctx, http.MethodPost, pathTenantToken, nil, body, "application/json", "")
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			lastErr = fmt.Errorf("feishu: 获取 tenant_access_token 返回 HTTP %d", status)
			if !retryableStatus(status) {
				return "", lastErr
			}
			continue
		}
		var env struct {
			Code   int    `json:"code"`
			Token  string `json:"tenant_access_token"`
			Expire int64  `json:"expire"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return "", fmt.Errorf("feishu: 解析 tenant_access_token 响应: %w", err)
		}
		if env.Code != 0 || env.Token == "" {
			// msg 理论上不含 token，但鉴权接口只报 code，泄密面再小一档。
			lastErr = fmt.Errorf("feishu: 获取 tenant_access_token 失败 (code=%d)", env.Code)
			if retryAPICodes[env.Code] {
				continue
			}
			return "", lastErr
		}
		ttl := time.Duration(env.Expire) * time.Second
		if ttl < 2*tokenRenewGrace {
			ttl = 2 * tokenRenewGrace
		}
		c.token = env.Token
		c.tokenUntil = time.Now().Add(ttl - tokenRenewGrace)
		return c.token, nil
	}
	return "", lastErr
}

// invalidate 在 401 后清掉缓存，强制下一次取新 token。
func (c *apiClient) invalidate() {
	c.mu.Lock()
	c.token = ""
	c.mu.Unlock()
}

// sendOnce 发一次不带重试语义的原始请求。错误信息只含路径与状态，不含凭证。
func (c *apiClient) sendOnce(ctx context.Context, method, path string, query url.Values,
	body []byte, contentType, token string) (int, http.Header, []byte, error) {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("feishu: 构造请求: %w", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, nil, nil, ctx.Err()
		}
		return 0, nil, nil, fmt.Errorf("feishu: 请求 %s 失败: %w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("feishu: 读取 %s 响应: %w", path, err)
	}
	if len(raw) > maxResponseBytes {
		// 超限说明响应被劫持或接口形状错了；报错好过返回截断内容。
		return 0, resp.Header, nil, fmt.Errorf("feishu: %s 响应超过 %d MB 上限", path, maxResponseBytes>>20)
	}
	return resp.StatusCode, resp.Header, raw, nil
}

// callJSON 发一个带鉴权的请求并解出 envelope.data。它负责：
// 401 刷新 token 后只重试一次、HTTP 429/5xx 与限流业务码指数退避、ctx 取消即时返回。
func (c *apiClient) callJSON(ctx context.Context, method, path string, query url.Values,
	body []byte, contentType string) (json.RawMessage, error) {
	refreshed := false
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		tok, err := c.accessToken(ctx)
		if err != nil {
			return nil, err
		}
		if contentType == "" && body != nil {
			contentType = "application/json"
		}
		status, hdr, raw, err := c.sendOnce(ctx, method, path, query, body, contentType, tok)
		if err != nil {
			return nil, err
		}
		if status == http.StatusUnauthorized {
			if refreshed {
				return nil, errors.New("feishu: token 刷新后仍被服务端拒绝，请检查应用凭证与权限")
			}
			refreshed = true
			c.invalidate()
			continue
		}
		if retryableStatus(status) {
			if attempt == maxAttempts {
				break
			}
			if err := sleepBackoff(ctx, attempt, hdr); err != nil {
				return nil, err
			}
			continue
		}
		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			return nil, fmt.Errorf("feishu: 解析 %s 响应: %w", path, err)
		}
		if env.Code == 0 {
			return env.Data, nil
		}
		if retryAPICodes[env.Code] {
			if attempt == maxAttempts {
				break
			}
			if err := sleepBackoff(ctx, attempt, hdr); err != nil {
				return nil, err
			}
			continue
		}
		return nil, fmt.Errorf("feishu: %s 失败 (code=%d): %s", path, env.Code, env.Msg)
	}
	return nil, fmt.Errorf("feishu: %s 重试 %d 次仍失败（限流或服务不可用）", path, maxAttempts)
}

// call 是 callJSON 的 Go 值包装：payload 非 nil 时序列化为 JSON 请求体，
// out 非 nil 时把 data 解进 out。
func (c *apiClient) call(ctx context.Context, method, path string, query url.Values, payload, out any) error {
	var body []byte
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("feishu: 构造 %s 请求体: %w", path, err)
		}
		body = raw
	}
	data, err := c.callJSON(ctx, method, path, query, body, "")
	if err != nil {
		return err
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("feishu: 解析 %s 响应: %w", path, err)
	}
	return nil
}

// callRaw 拉取按字节返回的响应（drive download 不套 envelope）。
// 失败时飞书仍可能以 200 + JSON 错误体回复；快照顶层没有 code 字段，
// 所以「解析得出 envelope 且 code 非零」一定意味着出错，重试语义与 callJSON 相同。
func (c *apiClient) callRaw(ctx context.Context, path string, query url.Values) ([]byte, error) {
	refreshed := false
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		tok, err := c.accessToken(ctx)
		if err != nil {
			return nil, err
		}
		status, hdr, raw, err := c.sendOnce(ctx, http.MethodGet, path, query, nil, "", tok)
		if err != nil {
			return nil, err
		}
		if status == http.StatusUnauthorized {
			if refreshed {
				return nil, errors.New("feishu: token 刷新后仍被服务端拒绝，请检查应用凭证与权限")
			}
			refreshed = true
			c.invalidate()
			continue
		}
		if retryableStatus(status) {
			if attempt == maxAttempts {
				break
			}
			if err := sleepBackoff(ctx, attempt, hdr); err != nil {
				return nil, err
			}
			continue
		}
		if status >= 200 && status < 300 {
			if env, ok := asEnvelope(raw); ok && env.Code != 0 {
				if retryAPICodes[env.Code] {
					if attempt == maxAttempts {
						break
					}
					if err := sleepBackoff(ctx, attempt, hdr); err != nil {
						return nil, err
					}
					continue
				}
				return nil, fmt.Errorf("feishu: %s 失败 (code=%d): %s", path, env.Code, env.Msg)
			}
			return raw, nil
		}
		var env envelope
		_ = json.Unmarshal(raw, &env)
		return nil, fmt.Errorf("feishu: %s 返回 HTTP %d (code=%d): %s", path, status, env.Code, env.Msg)
	}
	return nil, fmt.Errorf("feishu: %s 重试 %d 次仍失败（限流或服务不可用）", path, maxAttempts)
}

func asEnvelope(raw []byte) (envelope, bool) {
	var env envelope
	if len(raw) == 0 || raw[0] != '{' {
		return env, false
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, false
	}
	return env, true
}

func retryableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusInternalServerError,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// sleepBackoff 指数退避，优先服从服务端的 Retry-After，可被取消的 ctx 打断。
func sleepBackoff(ctx context.Context, attempt int, hdr http.Header) error {
	d := retryBaseDelay
	for i := 1; i < attempt && d < maxBackoff; i++ {
		d *= 2
	}
	if hdr != nil {
		if secs, err := strconv.Atoi(strings.TrimSpace(hdr.Get("Retry-After"))); err == nil && secs > 0 {
			if w := time.Duration(secs) * time.Second; w > d {
				d = min(w, maxBackoff)
			}
		}
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
