package service

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// 附件（事项图片）。
//
// 分工刻意切开：**文件搬运放在壳层**（api.go，它才知道 dataDir 与系统文件对话框），
// 内核只管元数据行。这样 iOS/Android 上换一套文件路径实现，内核与同步逻辑都不用动，
// 也保证内核可以被 CLI 在任意目录下测试。
//
// 同步语义：附件行跟着实体走（LWW + tombstone），**文件本体不进快照**——
// 换设备时行在、文件不在，UI 会显示「图片不在这台设备上」而不是凭空报错。

// MaxItemImages 是一条事项的图片上限，与参考站一致（满 5 张后加号消失）。
const MaxItemImages = 5

// SaveAttachment 写入一条附件元数据。Path 是相对 dataDir 的路径，由壳层决定放哪儿。
func (a *App) SaveAttachment(ctx context.Context, att *model.Attachment) error {
	if strings.TrimSpace(att.ID) == "" {
		return fmt.Errorf("service: 附件缺少 ID")
	}
	if att.OwnerKind == "" || att.OwnerID == "" {
		return fmt.Errorf("service: 附件必须挂在实体上（ownerKind/ownerId）")
	}
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	att.UpdatedAt = at
	if att.CreatedAt == "" {
		att.CreatedAt = at
	}
	att.Path = filepath.ToSlash(att.Path)
	e, err := store.NewEntity(store.KindAttachment, att)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// Attachments 取某个实体（当前只有 item）的附件，按创建顺序。
func (a *App) Attachments(ctx context.Context, ownerKind, ownerID string) ([]model.Attachment, error) {
	rows, err := a.db.Rows(ctx, store.KindAttachment, false)
	if err != nil {
		return nil, err
	}
	out := []model.Attachment{}
	for _, r := range rows {
		var att model.Attachment
		if err := r.Decode(&att); err != nil {
			return nil, err
		}
		if att.OwnerKind != ownerKind || att.OwnerID != ownerID {
			continue
		}
		out = append(out, att)
	}
	sortAttachments(out)
	return out, nil
}

// DeleteAttachment 软删附件行；文件留在磁盘上（删文件的时机交给维护任务，
// 免得「另一台设备刚引用到」时读到半个引用）。
func (a *App) DeleteAttachment(ctx context.Context, id string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.db.SoftDelete(ctx, store.KindAttachment, id, at)
}

func sortAttachments(xs []model.Attachment) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0; j-- {
			key := func(x model.Attachment) string { return x.CreatedAt + "|" + x.ID }
			if key(xs[j]) >= key(xs[j-1]) {
				break
			}
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}
