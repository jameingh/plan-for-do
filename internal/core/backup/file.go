package backup

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// Summary 是一次导出/导入的结果，界面直接显示这些数字。
type Summary struct {
	Records         int    `json:"records"`
	Attachments     int    `json:"attachments"`     // 元数据条数
	AttachmentBytes int    `json:"attachmentBytes"` // 真正带上的字节数
	Applied         int    `json:"applied"`         // 导入时真正落库的记录数
	Conflicts       int    `json:"conflicts"`       // 导入时内容不同、按 LWW 判过的条数
	SkippedTampered int    `json:"skippedTampered"` // 校验和对不上的附件（跳过，不写盘）
	CreatedAt       string `json:"createdAt"`
	WithAttachments bool   `json:"withAttachments"`
}

// Merger 把一批记录并进本地。由调用方注入同步引擎的合并实现，
// 这样「从备份恢复」与「从通道同步」走的是同一套 LWW 规则。
type Merger func(ctx context.Context, records []store.Entity) (applied, conflicts int, err error)

// ExportDB 把本地全量做成一份加密备份文件。withAttachments 决定是否把附件字节也塞进来。
//
// 与同步快照的一个刻意区别：**墓碑全带，不按 90 天截断**。
// 备份的读者是未来的自己，把「已经删掉」这件事也保住才不会导入后又复活；
// 体积代价可以接受（一条墓碑就是一行 JSON）。
func ExportDB(ctx context.Context, db *store.DB, dataDir, password, deviceID, createdAt string, withAttachments bool) ([]byte, Summary, error) {
	if err := CheckPassword(password); err != nil {
		return nil, Summary{}, err
	}
	rows, err := db.Rows(ctx, "", true)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("backup: 读本地记录: %w", err)
	}
	records := make([]store.Entity, 0, len(rows))
	for _, r := range rows {
		if len(r.Data) == 0 {
			continue // 空记录没法重建，跳过比写进去更好
		}
		records = append(records, r)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].Kind != records[j].Kind {
			return records[i].Kind < records[j].Kind
		}
		return records[i].ID < records[j].ID
	})

	atts := []Attachment{}
	var attBytes int
	for _, r := range records {
		if r.Kind != "attachment" || !r.Alive() {
			continue
		}
		var meta model.Attachment
		if err := json.Unmarshal(r.Data, &meta); err != nil {
			continue // 元数据坏了：不带字节也不该让整份导出失败
		}
		a := Attachment{ID: r.ID, Path: meta.Path, Mime: meta.Mime, Size: meta.Size}
		if withAttachments && meta.Path != "" {
			raw, err := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(meta.Path)))
			if err == nil {
				sum := sha256.Sum256(raw)
				a.SHA256 = fmt.Sprintf("%x", sum)
				a.DataBase64 = base64.StdEncoding.EncodeToString(raw)
				attBytes += len(raw)
			}
			// 文件不在本机（比如换过设备）就只带元数据——导出不该因此失败
		}
		atts = append(atts, a)
	}

	payload := Payload{Records: records, Attachments: atts}
	file, err := Seal(payload, password, createdAt, deviceID)
	if err != nil {
		return nil, Summary{}, err
	}
	return file, Summary{
		Records: len(records), Attachments: len(atts), AttachmentBytes: attBytes,
		CreatedAt: createdAt, WithAttachments: withAttachments,
	}, nil
}

// ImportFile 解开备份并并进本地：先落附件字节，再按 LWW 合并记录。
//
// 先写字节是有意的：记录合并后界面马上能看到附件行，此时文件必须已经在了，
// 否则会出现「有条目但图裂了」的中间态。
func ImportFile(ctx context.Context, file []byte, password, dataDir string, merge Merger) (Summary, error) {
	payload, h, err := Open(file, password)
	if err != nil {
		return Summary{}, err
	}
	sum := Summary{
		Records: len(payload.Records), Attachments: len(payload.Attachments),
		CreatedAt: h.CreatedAt, WithAttachments: h.WithAttachments,
	}
	if dataDir != "" {
		for _, a := range payload.Attachments {
			if a.DataBase64 == "" {
				continue
			}
			raw, err := base64.StdEncoding.DecodeString(a.DataBase64)
			if err != nil {
				sum.SkippedTampered++
				continue
			}
			if a.SHA256 != "" {
				got := sha256.Sum256(raw)
				if fmt.Sprintf("%x", got) != a.SHA256 {
					sum.SkippedTampered++ // 内容与校验和不符：宁可丢掉，也不写一份坏图进去
					continue
				}
			}
			dst, err := attachmentTarget(dataDir, a.Path, a.ID)
			if err != nil {
				sum.SkippedTampered++
				continue
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return sum, fmt.Errorf("backup: 建附件目录: %w", err)
			}
			if err := os.WriteFile(dst, raw, 0o644); err != nil {
				return sum, fmt.Errorf("backup: 写附件 %s: %w", a.ID, err)
			}
			sum.AttachmentBytes += len(raw)
		}
	}
	applied, conflicts, err := merge(ctx, payload.Records)
	sum.Applied, sum.Conflicts = applied, conflicts
	if err != nil {
		return sum, fmt.Errorf("backup: 合并记录: %w", err)
	}
	return sum, nil
}

// attachmentTarget 决定附件写到哪。只取文件名、只允许落在 attachments/ 下：
// 备份文件是可以被替换的，路径里写个 ../../planfordo.db 就能覆盖库文件。
func attachmentTarget(dataDir, path, id string) (string, error) {
	dir := filepath.Join(dataDir, "attachments")
	base := filepath.Base(filepath.FromSlash(strings.TrimSpace(path)))
	if base == "." || base == string(filepath.Separator) || base == "" || strings.Contains(base, "..") {
		// 没给路径就用 id 顶上：元数据里本来就该有 id，文件名可丢
		if id == "" {
			return "", fmt.Errorf("backup: 附件既没有可用路径也没有 id")
		}
		base = id + ".bin"
	}
	return filepath.Join(dir, base), nil
}

// FingerprintFile 给界面显示「这份备份对不对」的短校验串。
func FingerprintFile(file []byte) string { return Fingerprint(file) }
