package sync

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	pathpkg "path"
	"path/filepath"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// 附件字节走一条与快照平行的「可选」通路：
//
//   - 快照只带附件元数据（records 里 kind=attachment 的行），文件本体不进快照；
//   - 支持大对象的通道另外存一份 blob 归档，引擎在记录合并后用它补上本机缺的字节；
//   - 通道不实现 BlobChannel 时，整条通路自动跳过，行为与之前完全一致。
//
// 归档刻意选 JSON + base64 而不是 zip：三条通道本来就是「整块文本对象」语义，
// 不需要引入压缩与二进制格式，飞书云盘 / WebDAV 上还能直接打开人工检查。
// 代价是 4/3 体积膨胀，靠 MaxBlobBytes 显式封顶，不让服务端静默截断。

const (
	// BlobArchiveFileName 是附件字节归档的固定文件名，所有实现 BlobChannel 的通道共用，
	// 与快照同目录。换名字等于让各设备各存一份，别改。
	BlobArchiveFileName = "planfordo-blobs.json"
	// BlobSchemaVersion 是 blob 归档的协议版本，与 Snapshot 的 SchemaVersion 各自独立：
	// 归档是可选文件，旧客户端不认识它也不影响记录同步。
	BlobSchemaVersion = 1
	// MaxBlobBytes 是一份归档里「原始字节」总和的上限。
	// 归档是 base64 JSON，真正上传的是原始字节的 4/3 再加点结构开销：
	// 飞书 upload_all 单文件 20MB 是最紧的一环（14MB × 4/3 ≈ 18.7MB，留出余量），
	// WebDAV 客户端读响应上限 32MB 反而更宽。超了要给出明确错误，
	// 而不是让服务端静默截断、或让 GET 读回半截 JSON 报个莫名其妙的解析错。
	MaxBlobBytes = 14 << 20
)

var (
	// ErrBlobTooLarge 表示附件总量超过单份归档上限。
	ErrBlobTooLarge = errors.New("sync: blob 归档超过单份上限")
	// ErrBlobSchemaMismatch 表示远端归档由更新的协议写出。
	ErrBlobSchemaMismatch = errors.New("sync: blob 归档协议版本高于本机")

	errBlobsUnsupported = errors.New("通道不支持附件字节，仅同步附件元数据")
	errNoBlobDir        = errors.New("未配置附件目录，跳过附件字节搬运")
)

// Blob 是一个附件的字节。键是压平后的文件名（如 a1.png），不带目录。
type Blob struct {
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
	DataBase64 string `json:"dataBase64"`
}

// BlobArchive 是一份完整归档。Blobs 是并集：归档里允许留着本机已不引用的字节，
// 因为另一台设备可能还引用它；清理要等所有设备都不再需要，当前不做 GC。
type BlobArchive struct {
	Schema int             `json:"schema"`
	Blobs  map[string]Blob `json:"blobs"`
}

// BlobChannel 是可选的附件字节通道。
//
// 实现者只需存取一份归档，不必懂合并规则：LoadBlob 在文件不存在时返回空归档
// （首轮同步从这里起步），SaveBlob 无条件覆盖。没有二进制对象语义的通道
// （目前是 feishuBase）不实现它，引擎会用 SupportsBlobs 判定并跳过。
type BlobChannel interface {
	LoadBlob(ctx context.Context) (*BlobArchive, error)
	SaveBlob(ctx context.Context, a *BlobArchive) error
}

// SupportsBlobs 告诉界面 / 调用方这条通道能不能搬附件字节。
func SupportsBlobs(ch Channel) bool {
	_, ok := ch.(BlobChannel)
	return ok
}

// NewBlobArchive 造一份空归档。空归档的 Blobs 必须是非 nil map，
// 否则序列化成 null，另一台设备反序列化后写 map 会 panic。
func NewBlobArchive() *BlobArchive {
	return &BlobArchive{Schema: BlobSchemaVersion, Blobs: map[string]Blob{}}
}

// Bytes 序列化归档，顺带卡住体积上限。
func (a *BlobArchive) Bytes() ([]byte, error) {
	if a == nil {
		return nil, errors.New("sync: blob 归档为空")
	}
	if a.Schema == 0 {
		a.Schema = BlobSchemaVersion
	}
	total := a.rawBytes()
	if total > MaxBlobBytes {
		return nil, fmt.Errorf("%w: 约 %d > %d 字节，附件太多请改用「连附件一起导出」的备份文件",
			ErrBlobTooLarge, total, MaxBlobBytes)
	}
	return json.Marshal(a)
}

// rawBytes 用 base64 长度估算原始字节数（不解码，避免为一次写回把所有附件解一遍）。
func (a *BlobArchive) rawBytes() int64 {
	var total int64
	for _, b := range a.Blobs {
		n := len(b.DataBase64)
		if n >= 4 {
			total += int64(n / 4 * 3)
			if strings.HasSuffix(b.DataBase64, "==") {
				total -= 2
			} else if strings.HasSuffix(b.DataBase64, "=") {
				total--
			}
		}
	}
	return total
}

// Add 把一段本地字节放进归档，校验和由内容算出。
func (a *BlobArchive) Add(name string, raw []byte) error {
	if !safeBlobName(name) {
		return fmt.Errorf("sync: 非法的 blob 键名 %q", name)
	}
	if a.Blobs == nil {
		a.Blobs = map[string]Blob{}
	}
	if a.Schema == 0 {
		a.Schema = BlobSchemaVersion
	}
	sum := sha256.Sum256(raw)
	a.Blobs[name] = Blob{
		SHA256:     fmt.Sprintf("%x", sum),
		Size:       int64(len(raw)),
		DataBase64: base64.StdEncoding.EncodeToString(raw),
	}
	return nil
}

// ParseBlobArchive 反序列化并校验协议版本。远端归档可以被替换，
// 所以键名一律过一遍安全规则：含路径分隔符的条目直接丢掉，绝不写穿目录。
func ParseBlobArchive(raw []byte) (*BlobArchive, error) {
	var a BlobArchive
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("sync: 解析 blob 归档: %w", err)
	}
	if a.Schema > BlobSchemaVersion {
		return nil, fmt.Errorf("%w: 远端 %d > 本机 %d", ErrBlobSchemaMismatch, a.Schema, BlobSchemaVersion)
	}
	if a.Schema == 0 {
		a.Schema = BlobSchemaVersion
	}
	if a.Blobs == nil {
		a.Blobs = map[string]Blob{}
	}
	for k := range a.Blobs {
		if !safeBlobName(k) {
			delete(a.Blobs, k)
		}
	}
	// 读侧也卡一次：远端归档可能由更新的客户端 / 用户手工放上去，
	// 不能把超限内容一路带进内存再写盘。
	if total := a.rawBytes(); total > MaxBlobBytes {
		return nil, fmt.Errorf("%w: 远端归档约 %d 字节，超过 %d；请清理旧附件或改用备份文件",
			ErrBlobTooLarge, total, MaxBlobBytes)
	}
	return &a, nil
}

// blobName 把附件元数据里的相对路径压平成归档键 / 落盘文件名。
// 规则与 backup.attachmentTarget 一致：只取文件名，只允许落在 attachments/ 下；
// 路径没给就用记录 ID 顶上。远端记录里的 path/id 都不可信，一律按文件名处理。
func blobName(p, id string) (string, error) {
	flat := strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	base := pathpkg.Base(flat)
	if base == "." || base == "/" || base == "" || !safeBlobName(base) {
		flatID := strings.ReplaceAll(strings.TrimSpace(id), `\`, "/")
		base = pathpkg.Base(flatID)
		if base == "." || base == "/" || base == "" || !safeBlobName(base) {
			return "", fmt.Errorf("sync: 附件既没有可用的路径也没有可用的 ID")
		}
		base += ".bin"
	}
	return base, nil
}

// safeBlobName 只放行不含路径分隔符、不是 . / .. 的单个文件名。
// 不做额外的 ".." 过滤：path.Base 已经压平了路径，普通文件名里带两个点也合法。
func safeBlobName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	return !strings.ContainsAny(name, `/\`)
}

// syncBlobs 在「记录合并之后」搬运附件字节：拉归档 → 补本机缺的字节 →
// 把本机独有的字节并回归档。
//
// 放在合并之后是刻意的：刚从远端并进来的 attachment 行也在这一轮被枚举到，
// 界面看到新附件时文件已经在本地了，不会出现「有条目但图裂了」的中间态。
//
// 归档是并集、写回是覆盖，与快照一样存在 read-merge-write 竞态：写回前再
// Load 一次并只补不删，缩小两台设备互相抹掉的窗口；残留窗口里丢的那一份
// 字节仍留在它本机磁盘上，下一轮同步会重新并进来，最终收敛。
// 归档失败不阻断记录同步——字节搬运是可选增强，错误由 Run 记进 Result.BlobsSkipped。
func (e *Engine) syncBlobs(ctx context.Context, ch Channel, res *Result) error {
	bc, ok := ch.(BlobChannel)
	if !ok {
		return errBlobsUnsupported
	}
	if e.dataDir == "" {
		return errNoBlobDir
	}
	remote, err := bc.LoadBlob(ctx)
	if err != nil {
		return fmt.Errorf("拉取 blob 归档: %w", err)
	}
	if remote == nil {
		remote = NewBlobArchive()
	}

	rows, err := e.db.Rows(ctx, store.KindAttachment, false)
	if err != nil {
		return fmt.Errorf("枚举本地附件: %w", err)
	}
	dir := filepath.Join(e.dataDir, "attachments")
	added := map[string]Blob{}
	var pushed, rejected int
	for _, rec := range rows {
		var att model.Attachment
		if err := rec.Decode(&att); err != nil {
			continue // 元数据坏了不该让整轮字节搬运失败
		}
		name, err := blobName(att.Path, rec.ID)
		if err != nil {
			continue
		}
		dst := filepath.Join(dir, name)
		b, inArchive := remote.Blobs[name]
		// 本地已有且大小对得上 → 只考虑把字节补进归档；半截文件按缺失处理，
		// 从远端归档重新写一份完整字节回来。元数据里的 size 万一写错，
		// 与归档条目大小一致也算完整，否则每轮都会把同一份字节重写一遍。
		present := false
		if fi, err := os.Stat(dst); err == nil {
			if fi.IsDir() {
				continue // 同名目录不是文件，跳过而不是把整轮字节搬运拖垮
			}
			present = att.Size <= 0 || fi.Size() == att.Size ||
				(inArchive && b.Size > 0 && fi.Size() == b.Size)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("检查附件 %s: %w", name, err)
		}
		if present {
			if inArchive {
				continue // 归档里已有同名条目：不覆盖先到者，避免两端来回震荡
			}
			raw, err := os.ReadFile(dst)
			if err != nil {
				return fmt.Errorf("读本地附件 %s: %w", name, err)
			}
			if err := remote.Add(name, raw); err != nil {
				return err
			}
			added[name] = remote.Blobs[name]
			pushed++
			continue
		}

		if !inArchive {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(b.DataBase64)
		if err != nil || (b.SHA256 != "" && fmt.Sprintf("%x", sha256.Sum256(raw)) != b.SHA256) ||
			(b.Size > 0 && int64(len(raw)) != b.Size) {
			rejected++ // 校验和/长度对不上：宁可留个空位，也不写一份坏图进目录
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("建附件目录: %w", err)
		}
		if err := os.WriteFile(dst, raw, 0o644); err != nil {
			return fmt.Errorf("写附件 %s: %w", name, err)
		}
		res.BlobsApplied++
	}
	res.BlobsRejected = rejected
	if pushed == 0 {
		return nil // 归档没有任何新增，省掉一次上传
	}

	fresh, err := bc.LoadBlob(ctx)
	if err != nil {
		return fmt.Errorf("写回前重读 blob 归档: %w", err)
	}
	if fresh == nil {
		fresh = NewBlobArchive()
	}
	for k, v := range added {
		if _, exists := fresh.Blobs[k]; !exists {
			fresh.Blobs[k] = v
		}
	}
	if err := bc.SaveBlob(ctx, fresh); err != nil {
		return fmt.Errorf("写回 blob 归档: %w", err)
	}
	res.BlobsPushed = pushed
	return nil
}
