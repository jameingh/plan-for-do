package feishu

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"planfordo/internal/core/store"
	"planfordo/internal/core/sync"
)

// DefaultSnapshotFileName 与 localdir 通道同名，多通道并行时用户的文件观感一致。
const DefaultSnapshotFileName = "planfordo-snapshot.json"

// tmpFilePrefix 是覆盖写过程中过渡文件的命名前缀，见 Save 的覆盖策略注释。
const tmpFilePrefix = ".planfordo-tmp-"

// Drive 把整份快照作为单个 JSON 文件存在飞书云盘的某个文件夹里。
// 它是主通道：读写各一发，语义与 localdir 最接近，出问题也最容易人工检查。
type Drive struct {
	name        string
	cli         *apiClient
	folderToken string
	fileName    string
}

func newDrive(name string, opts map[string]string) (sync.Channel, error) {
	cli, err := newClient(opts)
	if err != nil {
		return nil, err
	}
	folder := trim(opts["folderToken"])
	if folder == "" {
		return nil, errors.New("feishu: feishuDrive 通道需要 options.folderToken（云盘文件夹 URL 里的 token）")
	}
	fileName := trim(opts["fileName"])
	if fileName == "" {
		fileName = DefaultSnapshotFileName
	}
	return &Drive{name: name, cli: cli, folderToken: folder, fileName: fileName}, nil
}

// Name 返回通道名。
func (d *Drive) Name() string { return d.name }

// Kind 返回通道类型。
func (d *Drive) Kind() string { return "feishuDrive" }

// driveFile 是列目录响应里的一条。created_at 在不同站点可能是数字也可能是字符串，
// 收进 RawMessage 再统一 stringify，比赌一种形状稳。
type driveFile struct {
	Token     string          `json:"token"`
	Name      string          `json:"name"`
	Type      string          `json:"type"`
	CreatedAt json.RawMessage `json:"created_at"`
}

// sortKey 给同名文件一个全设备一致的挑选顺序：创建时间串优先，再按 token 字典序。
// 同名多份只在上一轮覆盖写到一半被打断时出现，确定序保证各端读到同一份。
func (f driveFile) sortKey() string {
	return stringifyJSON(f.CreatedAt) + "\x00" + f.Token
}

func stringifyJSON(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if len(s) >= 2 && s[0] == '"' {
		if u, err := strconv.Unquote(s); err == nil {
			return u
		}
	}
	return s
}

// listFiles 翻遍整个目录。分页没收全就报错误，绝不带着半截文件列表去覆盖——
// 漏看一份旧快照意味着 Save 会把它留在原地变成孤儿。
func (d *Drive) listFiles(ctx context.Context) ([]driveFile, error) {
	var out []driveFile
	pageToken := ""
	for {
		q := url.Values{"folder_token": {d.folderToken}, "page_size": {"200"}}
		if pageToken != "" {
			q.Set(drivePageTokenKey, pageToken)
		}
		var resp struct {
			Files         []driveFile `json:"files"`
			HasMore       bool        `json:"has_more"`
			PageToken     string      `json:"page_token"`
			NextPageToken string      `json:"next_page_token"`
		}
		if err := d.cli.call(ctx, http.MethodGet, pathDriveList, q, nil, &resp); err != nil {
			return nil, err
		}
		out = append(out, resp.Files...)
		if !resp.HasMore {
			return out, nil
		}
		next := resp.PageToken
		if next == "" {
			next = resp.NextPageToken
		}
		if next == "" {
			return nil, errors.New("feishu: 云盘列目录 has_more 为真但没有分页游标，中断以避免漏看文件")
		}
		pageToken = next
	}
}

// Probe 验证 token 可取、目录可读，并真实写删一个过渡文件确认写权限。
// 只读不写会让「应用没拿到云盘编辑权限」这种最常见的配置错误在设置页显示正常。
func (d *Drive) Probe(ctx context.Context) error {
	if _, err := d.listFiles(ctx); err != nil {
		return err
	}
	token, err := d.uploadAll(ctx, d.tmpName(), []byte("planfordo-probe"))
	if err != nil {
		return err
	}
	// 探针残留无害：Save 会把 tmp 前缀的文件一并清掉，这里尽力删一次而已。
	if err := d.deleteFile(ctx, token); err != nil {
		return fmt.Errorf("feishu: 云盘可写但探针清理失败（不影响同步，残留文件下轮会被回收）: %w", err)
	}
	return nil
}

// Load 读快照。文件还不存在时返回空快照而不是报错，首轮同步就是从这个状态起步。
func (d *Drive) Load(ctx context.Context) (*sync.Snapshot, error) {
	files, err := d.listFiles(ctx)
	if err != nil {
		return nil, err
	}
	var matches []driveFile
	for _, f := range files {
		if f.Name == d.fileName && f.Type != "folder" {
			matches = append(matches, f)
		}
	}
	if len(matches) == 0 {
		return &sync.Snapshot{Schema: sync.SchemaVersion, Records: []store.Entity{}}, nil
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].sortKey() < matches[j].sortKey() })
	raw, err := d.cli.callRaw(ctx, fmt.Sprintf(pathDriveDownload, matches[len(matches)-1].Token), nil)
	if err != nil {
		return nil, err
	}
	return sync.ParseSnapshot(raw)
}

// 覆盖策略（为什么）：drive v1 的 files/upload_all 只有「新增」语义——同名文件再传
// 一次会变成目录里并存的第二份，不会替换；带 file_token 的内容更新接口 v1 也没有
// 可用的（medias 更新是给文档内嵌素材的）。所以「删旧建新」是唯一能做出覆盖语义的路，
// 而且必须显式删，绝不能靠再传一个同名文件。
//
// 分三步：先以临时名上传新快照，成功后才删旧文件和上一轮崩溃留下的临时文件，
// 最后把新文件改名成正式名。任意时刻被打断，远端要么「旧快照完好」要么
// 「没有快照」：后者与首轮同步的起点相同，引擎下一轮 Load 到空快照、Revision=0，
// 会把本地全量重新推上来，两端数据本来就都在，所以不会丢。反过来若先删后传，
// 上传失败就会把远端掏空。任何一步失败都直接报错，不存在半截快照落远端。
func (d *Drive) Save(ctx context.Context, s *sync.Snapshot) error {
	if s == nil {
		return errors.New("feishu: 快照为空")
	}
	raw, err := s.Bytes()
	if err != nil {
		return err
	}
	files, err := d.listFiles(ctx)
	if err != nil {
		return err
	}
	var stale []string
	for _, f := range files {
		if f.Type == "folder" {
			continue
		}
		if f.Name == d.fileName || strings.HasPrefix(f.Name, tmpFilePrefix) {
			stale = append(stale, f.Token)
		}
	}
	token, err := d.uploadAll(ctx, d.tmpName(), raw)
	if err != nil {
		return err
	}
	for _, t := range stale {
		if t == token {
			continue
		}
		if err := d.deleteFile(ctx, t); err != nil {
			return fmt.Errorf("feishu: 清理旧快照失败（新快照已完整存在，下一轮 Save 会重新覆盖）: %w", err)
		}
	}
	if err := d.rename(ctx, token, d.fileName); err != nil {
		return fmt.Errorf("feishu: 发布新快照失败，远端暂时没有正式快照；引擎下一轮会重推全量: %w", err)
	}
	return nil
}

// SaveConditional 拿不到 ETag，只能在写前重读一次远端版本做粗校验。
// 校验与写入之间有天然竞态窗口，但引擎把「拒写」当作重来一轮而不是失败，
// 两台设备因此会收敛而不是互相抹掉对方的记录。
func (d *Drive) SaveConditional(ctx context.Context, s *sync.Snapshot, expectRevision int64) error {
	current, err := d.Load(ctx)
	if err != nil {
		return err
	}
	if current.Revision != expectRevision {
		return fmt.Errorf("feishu: 远端版本已从 %d 变为 %d，本轮放弃", expectRevision, current.Revision)
	}
	return d.Save(ctx, s)
}

func (d *Drive) uploadAll(ctx context.Context, fileName string, content []byte) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	// 字段名 file_name / parent_type / parent_node / file 按官方文档；
	// 上传快照 JSON 走 explorer（云空间）语义而不是 docs，docs 会做格式转换。
	mw.WriteField("file_name", fileName)
	mw.WriteField("parent_type", "explorer")
	mw.WriteField("parent_node", d.folderToken)
	part, err := mw.CreateFormFile("file", fileName)
	if err != nil {
		return "", fmt.Errorf("feishu: 构造上传体: %w", err)
	}
	if _, err := part.Write(content); err != nil {
		return "", fmt.Errorf("feishu: 构造上传体: %w", err)
	}
	if err := mw.Close(); err != nil {
		return "", fmt.Errorf("feishu: 构造上传体: %w", err)
	}
	data, err := d.cli.callJSON(ctx, http.MethodPost, pathDriveUpload, nil, buf.Bytes(), mw.FormDataContentType())
	if err != nil {
		return "", err
	}
	var out struct {
		FileToken string `json:"file_token"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.FileToken == "" {
		return "", errors.New("feishu: upload_all 响应里没有 file_token，接口形状存疑（见 README 存疑点）")
	}
	return out.FileToken, nil
}

func (d *Drive) deleteFile(ctx context.Context, token string) error {
	q := url.Values{"type": {driveDeleteQueryType}}
	return d.cli.call(ctx, http.MethodDelete, fmt.Sprintf(pathDriveDelete, token), q, nil, nil)
}

func (d *Drive) rename(ctx context.Context, token, newName string) error {
	q := url.Values{"file_token": {token}}
	return d.cli.call(ctx, http.MethodPatch, fmt.Sprintf(pathDriveRename, token), q,
		map[string]string{"new_name": newName}, nil)
}

// tmpName 混入纳秒时间与随机后缀：多台设备共用同一个文件夹，只靠时间戳
// 在时钟回拨时会撞名，撞名的两个过渡文件会互相覆盖删除。
func (d *Drive) tmpName() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		b = []byte(strconv.FormatInt(time.Now().UnixNano()%1e9, 10))
	}
	return tmpFilePrefix + strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + hex.EncodeToString(b)
}
