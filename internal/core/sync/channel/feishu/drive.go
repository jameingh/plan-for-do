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
// DefaultBlobFileName 是并列的附件字节归档，命名也跟另外两条通道对齐。
const (
	DefaultSnapshotFileName = "planfordo-snapshot.json"
	DefaultBlobFileName     = sync.BlobArchiveFileName
)

// 探针文件与旧版本遗留过渡文件的前缀。新版本不再生成过渡文件（见 saveObject），
// 但必须继续清理这些前缀：2026-11-09 之前失败轮留在云盘里的 .planfordo-tmp-*
// 只有被认出来才会被回收，否则永远占着目录。
const (
	tmpFilePrefix     = ".planfordo-tmp-"
	blobTmpFilePrefix = ".planfordo-blob-tmp-"
)

// driveObject 是云盘文件夹里的一个「单文件对象」：正式名 + 自己的临时名前缀。
// 快照与 blob 归档只是两个不同 driveObject，共用同一套读/覆盖写骨架。
type driveObject struct {
	fileName  string
	tmpPrefix string
	label     string // 错误信息里的对象名，快照沿用「快照」保持原有诊断文案
}

// Drive 把整份快照（以及可选的附件字节归档）作为 JSON 文件存在飞书云盘的某个文件夹里。
// 它是主通道：读写各一发，语义与 localdir 最接近，出问题也最容易人工检查。
type Drive struct {
	name        string
	cli         *apiClient
	folderToken string
	snapshot    driveObject
	blob        driveObject
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
	if fileName == DefaultBlobFileName {
		return nil, errors.New("feishu: options.fileName 不能与附件字节归档同名")
	}
	return &Drive{
		name: name, cli: cli, folderToken: folder,
		snapshot: driveObject{fileName: fileName, tmpPrefix: tmpFilePrefix, label: "快照"},
		blob:     driveObject{fileName: DefaultBlobFileName, tmpPrefix: blobTmpFilePrefix, label: "附件字节归档"},
	}, nil
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
	token, err := d.uploadAll(ctx, d.tmpName(d.snapshot.tmpPrefix), []byte("planfordo-probe"))
	if err != nil {
		return err
	}
	// 探针残留无害：上传成功已经证明可写，删不掉也不该推翻这个结论；
	// 残留文件由下一次 saveObject 尽力回收。
	_ = d.deleteFile(ctx, token)
	return nil
}

// loadObject 读一个云盘文件。远端没有这个文件时返回 (nil, nil)，
// 由调用方决定是「空快照」还是「空归档」——首轮同步都从这里起步。
// 同名多份按 sortKey 取最新一份，理由见 driveFile.sortKey。
func (d *Drive) loadObject(ctx context.Context, obj driveObject) ([]byte, error) {
	files, err := d.listFiles(ctx)
	if err != nil {
		return nil, err
	}
	var matches []driveFile
	for _, f := range files {
		if f.Name == obj.fileName && f.Type != "folder" {
			matches = append(matches, f)
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].sortKey() < matches[j].sortKey() })
	return d.cli.callRaw(ctx, fmt.Sprintf(pathDriveDownload, matches[len(matches)-1].Token), nil)
}

// Load 读快照。文件还不存在时返回空快照而不是报错。
func (d *Drive) Load(ctx context.Context) (*sync.Snapshot, error) {
	raw, err := d.loadObject(ctx, d.snapshot)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return &sync.Snapshot{Schema: sync.SchemaVersion, Records: []store.Entity{}}, nil
	}
	return sync.ParseSnapshot(raw)
}

// LoadBlob 读附件字节归档；远端没有时返回空归档。
func (d *Drive) LoadBlob(ctx context.Context) (*sync.BlobArchive, error) {
	raw, err := d.loadObject(ctx, d.blob)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return sync.NewBlobArchive(), nil
	}
	return sync.ParseBlobArchive(raw)
}

// 覆盖策略（为什么）：drive v1 的 files/upload_all 只有「新增」语义——同名文件再传
// 一次会成为目录里并存的第二份（实测：两次上传拿到两个不同 file_token，列目录两份都在），
// 不会替换。飞书云盘 v1 也**没有可用的改名接口**：PATCH /files/{token}/rename
// 实测返回 HTTP 404 + 纯文本 "404 page not found"（2026-11-09），官方文档里
// 也没有这个 endpoint。所以「先以正式名上传新文件，再按 token 精确删掉其它同名」
// 是唯一能做出覆盖语义的路，绝不能假设「传个同名文件就等于覆盖」。
//
// 分两步：先列目录收集旧正式文件与历史临时残留的 token，再以正式名上传新内容
// （upload_all 返回新的 file_token），上传成功后才删旧。任意时刻被打断：
//   - 上传失败：远端仍是旧文件，完好；
//   - 上传成功、删旧失败：远端同时有新旧两份同名，loadObject 按创建时间取最新，
//     下一轮 Save 会把旧的也清掉。
//
// 不存在「旧文件已删、新文件还没发布」的空窗——早期「临时名 + 改名」方案正是
// 卡在改名这一步，把正式快照丢在远端之外。
//
// 删旧是幂等的：并发覆盖写时另一轮可能已经删掉了同一个 token，飞书会回
// 1061001 / 1061007 之类的错误；复查一次列目录确认文件已不在就当成功。
// 只有「旧正式文件确实还在、删不掉」才报错，因为它可能让 loadObject 挑回旧内容。
// 至于旧版本遗留的临时残留，删不掉只影响云盘卫生，一律下一轮再试，不阻断本轮。
//
// 快照与 blob 归档各是一个 driveObject：只清自己名字的旧文件与自己前缀的临时文件，
// 免得一次快照覆盖把归档刚上传的文件顺手删掉。
func (d *Drive) saveObject(ctx context.Context, obj driveObject, raw []byte) error {
	files, err := d.listFiles(ctx)
	if err != nil {
		return err
	}
	var official, leftovers []string
	for _, f := range files {
		if f.Type == "folder" {
			continue
		}
		if f.Name == obj.fileName {
			official = append(official, f.Token)
		} else if strings.HasPrefix(f.Name, obj.tmpPrefix) {
			leftovers = append(leftovers, f.Token)
		}
	}
	// 直接以正式名上传：同名会并存成第二份，用本轮返回的 token 把其它同名精确删掉。
	// 不再有「改名发布」这一步——那个接口在飞书 v1 里不存在（见上方注释）。
	token, err := d.uploadAll(ctx, obj.fileName, raw)
	if err != nil {
		return err
	}
	// 上传后再列一次目录：另一轮并发可能在我们「列目录 → 上传」之间也写了一份同名文件，
	// 上传前那次列目录看不见它。两次看到的同名 token 合并，除本轮 token 外全部删掉。
	// 不这么做的话，引擎在「本地无新增 / 远端 revision 非 0」时会整轮跳过 Save，
	// 重复文件就永远没人清了。极端并发下两端可能把对方的文件都删掉，
	// 那等价于首轮空远端：引擎下一轮 Load 空快照、Revision=0，会重推全量自愈。
	after, err := d.listFiles(ctx)
	if err != nil {
		// 新文件已完整存在，复查失败不该把一次成功写入报成失败。
		return nil
	}
	targets := map[string]bool{}
	for _, t := range official {
		if t != token {
			targets[t] = true
		}
	}
	leftover := map[string]bool{}
	for _, t := range leftovers {
		leftover[t] = true
	}
	for _, f := range after {
		if f.Type == "folder" {
			continue
		}
		if f.Name == obj.fileName && f.Token != token {
			targets[f.Token] = true
		}
		if strings.HasPrefix(f.Name, obj.tmpPrefix) {
			leftover[f.Token] = true
		}
	}
	// 旧正式文件必须清掉，否则 loadObject 在 created_at 相同的那一秒里
	// 会按 token 字典序挑，可能挑回旧的。但删除失败有两种：真的没删掉，
	// 或另一轮/另一台设备已经把它删了（并发覆盖写，实测飞书回 1061001 /
	// 1061007 而不是成功）。后者复查一次列目录即可判幂等，不该报同步失败。
	for t := range targets {
		if err := d.deleteFile(ctx, t); err != nil {
			gone, checkErr := d.fileGone(ctx, t)
			if checkErr != nil {
				return fmt.Errorf("feishu: 清理旧%s失败且复查列目录也失败: %w（复查: %v）", obj.label, err, checkErr)
			}
			if !gone {
				return fmt.Errorf("feishu: 清理旧%s失败（新%s已完整存在，下一轮会重新覆盖）: %w", obj.label, obj.label, err)
			}
		}
	}
	// 历史临时残留只影响云盘卫生，不影响读取：删不掉就下一轮再试，绝不阻断同步。
	// 旧版本失败轮留下的 .planfordo-tmp-* 常出现「已被另一轮删掉」的并发错误，
	// 把它当成致命错误会让用户永远同步不成功。
	for t := range leftover {
		_ = d.deleteFile(ctx, t)
	}
	return nil
}

// fileGone 复查某个 token 是否已不在远端，用于把「重复删除」判成成功。
func (d *Drive) fileGone(ctx context.Context, token string) (bool, error) {
	files, err := d.listFiles(ctx)
	if err != nil {
		return false, err
	}
	for _, f := range files {
		if f.Token == token {
			return false, nil
		}
	}
	return true, nil
}

// Save 覆盖写快照。
func (d *Drive) Save(ctx context.Context, s *sync.Snapshot) error {
	if s == nil {
		return errors.New("feishu: 快照为空")
	}
	raw, err := s.Bytes()
	if err != nil {
		return err
	}
	return d.saveObject(ctx, d.snapshot, raw)
}

// SaveBlob 覆盖写附件字节归档。与快照同文件夹、同骨架，但独立的文件名与临时前缀。
func (d *Drive) SaveBlob(ctx context.Context, a *sync.BlobArchive) error {
	if a == nil {
		return errors.New("feishu: blob 归档为空")
	}
	raw, err := a.Bytes()
	if err != nil {
		return err
	}
	return d.saveObject(ctx, d.blob, raw)
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
	// 字段名 file_name / parent_type / parent_node / size / file 按官方文档；
	// 上传快照 JSON 走 explorer（云空间）语义而不是 docs，docs 会做格式转换。
	// size 是必填项：少了它服务端一律回 1061002 params error，且不告诉你是哪个参数
	// （真实环境踩过，2026-11-09）。值必须与 file 的实际字节数一致，且不能为 0。
	mw.WriteField("file_name", fileName)
	mw.WriteField("parent_type", "explorer")
	mw.WriteField("parent_node", d.folderToken)
	mw.WriteField("size", strconv.Itoa(len(content)))
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

// tmpName 混入纳秒时间与随机后缀，只用于 Probe 的写探针：多台设备共用同一个
// 文件夹，只靠时间戳在时钟回拨时会撞名。探针刻意不叫正式名，避免一次连通性
// 测试就在云盘里留下同名快照；清理失败时残留也会被下一轮 saveObject 回收。
func (d *Drive) tmpName(prefix string) string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		b = []byte(strconv.FormatInt(time.Now().UnixNano()%1e9, 10))
	}
	return prefix + strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + hex.EncodeToString(b)
}
