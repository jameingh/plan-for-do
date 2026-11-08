package service

import (
	"context"
	"fmt"
	"html"
	"regexp"
	"sort"
	"strings"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
)

// 备忘录模块。参考站的形状：左边一列备忘录（文件夹 + 搜索 + 排序 + 回收站），
// 右边一个富文本编辑器（标题 + 工具条 + iframe 正文），删除先进回收站、可批量恢复或彻底删除。
//
// 与参考站的两处有意不同，理由都写在 docs/design-reference.md §22：
//  1. 正文 HTML 存在记录里，而不是像它那样丢 OSS、记录里只留 noteHtmlDataUrl——
//     本产品本地优先，同步按记录合并，正文不进记录就跟着不走。
//  2. 「回收站」用 Memo.TrashedAt 表达；DeletedAt 留给同步引擎当墓碑。
//     参考站删除即进回收站、彻底删除才消失，这两步在我们这里必须是两条不同操作，
//     否则回收站里的东西会被同步当成已删除而在其它设备上消失。

// MemoSort 是列表排序方式，取值与参考站「排序方式」菜单一致。
type MemoSort int

const (
	MemoSortCreated  MemoSort = 0 // 按创建时间排序（默认）
	MemoSortModified MemoSort = 1 // 按修改时间排序
)

// MemoRequest 是备忘录列表入参。
type MemoRequest struct {
	FolderID    string   `json:"folderId"` // "" = 全部（不过滤文件夹）
	Search      string   `json:"search"`   // 命中标题或正文纯文本
	Sort        MemoSort `json:"sort"`
	ShowDeleted bool     `json:"showDeleted"` // true = 列回收站
}

// MemoItem 是列表里的一条：记录本身 + 现算的纯文本摘要。
type MemoItem struct {
	Memo    model.Memo `json:"memo"`
	Preview string     `json:"preview"`
}

// MemoFolderInput 是文件夹的新建/改名入参。
type MemoFolderInput struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Sort int    `json:"sort"`
}

// MemoInput 是备忘录的新建/保存入参。字段全部可空，空串表示「不改」还是「改成空」
// 由调用方明确决定——参考站的保存按钮就是整份覆盖。
type MemoInput struct {
	ID        string `json:"id,omitempty"`
	FolderID  string `json:"folderId"`
	Title     string `json:"title"`
	HTML      string `json:"html"`
	BackImage string `json:"backImage"`
	FileType  int    `json:"fileType"`
	FileID    string `json:"fileId"`
}

// memoPreviewRunes 与参考站的 noteContentText 一致：iframe 端 innerText 截 2000。
// 列表只显示 3 行是 CSS 的 -webkit-line-clamp 在管，这里只管「存多少、搜多少」。
const memoPreviewRunes = 2000

var memoTagRe = regexp.MustCompile(`<[^>]*>`)

// Go 的 \s 只覆盖 ASCII 空白，正文里的不间断空格（U+00A0，编辑器粘贴常见）要一起算。
var memoSpaceRe = regexp.MustCompile(`[\s ]+`)

// memoBlockRe 是段落/换行类标签：先把它们换成换行符再剥标签，
// 否则「<div>第一段</div><div>第二段</div>」会被粘成「第一段第二段」。
var memoBlockRe = regexp.MustCompile(`(?i)<\s*(br|/p|/div|/li|/h[1-6]|/blockquote)\s*/?>`)

// memoPlainText 去标签并解开实体，保留换行（正文的段落分隔靠它）。
func memoPlainText(h string) string {
	h = memoBlockRe.ReplaceAllString(h, "\n")
	s := memoTagRe.ReplaceAllString(h, "")
	s = html.UnescapeString(s)
	return s
}

// memoPreview 是列表摘要：换行压成空格、截断。
func memoPreview(h string) string {
	s := memoSpaceRe.ReplaceAllString(memoPlainText(h), " ")
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > memoPreviewRunes {
		return string(r[:memoPreviewRunes])
	}
	return s
}

// memoHasContent 判断正文是不是真空（编辑器的 iframe 里可能只剩 <div><br></div>）。
func memoHasContent(h string) bool {
	return strings.TrimSpace(memoPreview(h)) != ""
}

func (a *App) saveMemo(ctx context.Context, m *model.Memo, at string) error {
	m.UpdatedAt = at
	e, err := store.NewEntity(store.KindMemo, m)
	if err != nil {
		return err
	}
	return a.db.Put(ctx, e)
}

// MemoFolders 按自定义顺序返回文件夹。
func (a *App) MemoFolders(ctx context.Context) ([]model.MemoFolder, error) {
	out, err := loadAll[model.MemoFolder](a, ctx, store.KindMemoFolder)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// SaveMemoFolder 建或改文件夹。名字上限 12 字，重名不拦（参考站也没拦）。
func (a *App) SaveMemoFolder(ctx context.Context, in MemoFolderInput) (*model.MemoFolder, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("service: 文件夹名不能为空")
	}
	if len([]rune(name)) > model.MaxMemoFolderNameRunes {
		name = string([]rune(name)[:model.MaxMemoFolderNameRunes])
	}
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var f model.MemoFolder
	if in.ID == "" {
		f = model.MemoFolder{ID: newID(), Name: name, Sort: in.Sort, CreatedAt: at}
	} else {
		old, err := loadOne[model.MemoFolder](a, ctx, store.KindMemoFolder, in.ID)
		if err != nil {
			return nil, err
		}
		f = *old
		f.Name = name
		if in.Sort > 0 {
			f.Sort = in.Sort
		}
	}
	f.UpdatedAt = at
	e, err := store.NewEntity(store.KindMemoFolder, &f)
	if err != nil {
		return nil, err
	}
	if err := a.db.Put(ctx, e); err != nil {
		return nil, err
	}
	return &f, nil
}

// DeleteMemoFolder 删文件夹。参考站的语义不是「挪到未归类」，而是
// **把该文件夹下所有备忘录一起送进回收站**（evidence-memo-bundle §4：
// 深拷贝 + folderDelete:1，连带把 noteDeleteState===0 的全部标成 1）。
// 回收站里还能恢复，所以这不是删除数据；彻底删除才走墓碑。
func (a *App) DeleteMemoFolder(ctx context.Context, folderID string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	memos, err := loadAll[model.Memo](a, ctx, store.KindMemo)
	if err != nil {
		return 0, err
	}
	n := 0
	if folderID != "" {
		for i := range memos {
			if memos[i].FolderID != folderID || memos[i].TrashedAt != "" {
				continue
			}
			memos[i].TrashedAt = at
			if err := a.saveMemo(ctx, &memos[i], at); err != nil {
				return n, err
			}
			n++
		}
	}
	if err := a.db.SoftDelete(ctx, store.KindMemoFolder, folderID, at); err != nil {
		return n, err
	}
	return n, nil
}

// MemoList 返回一列备忘录。回收站视图（ShowDeleted）忽略文件夹与排序，按删除时间倒序。
// 置顶项永远在前，与参考站一致（列表里置顶图标只是标记，不改变其它项的顺序）。
func (a *App) MemoList(ctx context.Context, req MemoRequest) ([]MemoItem, error) {
	all, err := loadAll[model.Memo](a, ctx, store.KindMemo)
	if err != nil {
		return nil, err
	}
	word := strings.TrimSpace(req.Search)
	out := make([]MemoItem, 0, len(all))
	for _, m := range all {
		if req.ShowDeleted {
			if m.TrashedAt == "" {
				continue
			}
		} else if m.TrashedAt != "" {
			continue
		}
		// 「全部」= 不过滤；未归类的 FolderID 是空串，所以在别的文件夹里不出现。
		if !req.ShowDeleted && req.FolderID != "" && m.FolderID != req.FolderID {
			continue
		}
		preview := memoPreview(m.HTML)
		if word != "" {
			hay := strings.ToLower(m.Title + "\n" + preview + "\n" + memoPlainText(m.HTML))
			if !strings.Contains(hay, strings.ToLower(word)) {
				continue
			}
		}
		out = append(out, MemoItem{Memo: m, Preview: preview})
	}
	sorting := word != ""
	sort.SliceStable(out, func(i, j int) bool {
		// 参考站：搜索时丢掉置顶优先级（getMemoArray 与 searchMemo 是两条比较器）
		if !sorting && out[i].Memo.IsTop != out[j].Memo.IsTop {
			return out[i].Memo.IsTop
		}
		if req.ShowDeleted {
			// 回收站按创建时间倒序，不是删除时间
			if out[i].Memo.CreatedAt != out[j].Memo.CreatedAt {
				return out[i].Memo.CreatedAt > out[j].Memo.CreatedAt
			}
			return out[i].Memo.ID < out[j].Memo.ID
		}
		key := out[i].Memo.CreatedAt
		other := out[j].Memo.CreatedAt
		if req.Sort == MemoSortModified {
			key, other = out[i].Memo.UpdatedAt, out[j].Memo.UpdatedAt
		}
		if key != other {
			return key > other
		}
		return out[i].Memo.ID < out[j].Memo.ID
	})
	return out, nil
}

// CreateMemo 新建一条空备忘录并立刻打开编辑器（参考站的「新建备忘录」就是这个动作）。
// 空记录也要落库：列表里它显示成「无标题」，编辑后再保存。
func (a *App) CreateMemo(ctx context.Context, folderID string) (*model.Memo, error) {
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	m := model.Memo{
		ID: newID(), FolderID: folderID, FileType: model.MemoFileNone,
		CreatedAt: at, UpdatedAt: at,
	}
	if err := a.saveMemo(ctx, &m, at); err != nil {
		return nil, err
	}
	return &m, nil
}

// SaveMemo 保存正文/标题/归属/背景图/附件。ID 为空时新建（与参考站的「保存」一致：
// 它也是把当前编辑器整份写回，不区分新建与更新）。
func (a *App) SaveMemo(ctx context.Context, in MemoInput) (*model.Memo, error) {
	at, err := a.now(ctx)
	if err != nil {
		return nil, err
	}
	var m model.Memo
	if in.ID == "" {
		m = model.Memo{ID: newID(), FileType: model.MemoFileNone, CreatedAt: at}
	} else {
		old, err := loadOne[model.Memo](a, ctx, store.KindMemo, in.ID)
		if err != nil {
			return nil, err
		}
		m = *old
	}
	m.Title = strings.TrimSpace(in.Title)
	if r := []rune(m.Title); len(r) > model.MaxMemoTitleRunes {
		m.Title = string(r[:model.MaxMemoTitleRunes])
	}
	m.HTML = in.HTML
	m.BackImage = in.BackImage
	m.FolderID = in.FolderID
	if in.FileType >= 0 {
		m.FileType, m.FileID = in.FileType, in.FileID
	}
	if err := a.saveMemo(ctx, &m, at); err != nil {
		return nil, err
	}
	return &m, nil
}

// SetMemoTop 置顶 / 取消置顶。
func (a *App) SetMemoTop(ctx context.Context, memoID string, top bool) error {
	m, err := loadOne[model.Memo](a, ctx, store.KindMemo, memoID)
	if err != nil {
		return err
	}
	if m.IsTop == top {
		return nil
	}
	m.IsTop = top
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	return a.saveMemo(ctx, m, at)
}

// MoveMemoFolders 把若干备忘录移进某个文件夹（folderID 空 = 未归类）。
func (a *App) MoveMemoFolders(ctx context.Context, memoIDs []string, folderID string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range memoIDs {
		m, err := loadOne[model.Memo](a, ctx, store.KindMemo, id)
		if err != nil {
			continue
		}
		m.FolderID = folderID
		if err := a.saveMemo(ctx, m, at); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// TrashMemos 删除（进回收站）。已经在回收站里的跳过，不重复盖时间戳。
func (a *App) TrashMemos(ctx context.Context, memoIDs []string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range memoIDs {
		m, err := loadOne[model.Memo](a, ctx, store.KindMemo, id)
		if err != nil {
			continue
		}
		if m.TrashedAt != "" {
			continue
		}
		m.TrashedAt = at
		if err := a.saveMemo(ctx, m, at); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// RestoreMemos 从回收站恢复。
func (a *App) RestoreMemos(ctx context.Context, memoIDs []string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range memoIDs {
		m, err := loadOne[model.Memo](a, ctx, store.KindMemo, id)
		if err != nil || m.TrashedAt == "" {
			continue
		}
		m.TrashedAt = ""
		if err := a.saveMemo(ctx, m, at); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// PurgeMemos 彻底删除：走同步引擎的墓碑，其它设备上这条也会消失。
func (a *App) PurgeMemos(ctx context.Context, memoIDs []string) (int, error) {
	at, err := a.now(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range memoIDs {
		if _, err := loadOne[model.Memo](a, ctx, store.KindMemo, id); err != nil {
			continue
		}
		if err := a.db.SoftDelete(ctx, store.KindMemo, id, at); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Memo 单读一条，编辑器打开时用。
func (a *App) Memo(ctx context.Context, memoID string) (*model.Memo, error) {
	m, err := loadOne[model.Memo](a, ctx, store.KindMemo, memoID)
	if err != nil {
		return nil, err
	}
	return m, nil
}

// MemoStats 给「回收站有多少条」这类角标用。
type MemoStats struct {
	Total   int `json:"total"`
	Trashed int `json:"trashed"`
}

func (a *App) MemoStats(ctx context.Context) (MemoStats, error) {
	all, err := loadAll[model.Memo](a, ctx, store.KindMemo)
	if err != nil {
		return MemoStats{}, err
	}
	var s MemoStats
	for _, m := range all {
		if m.TrashedAt != "" {
			s.Trashed++
			continue
		}
		s.Total++
	}
	return s, nil
}

// ReorderMemoFolders 按给定 ID 顺序重排文件夹。
// 参考站的「文件夹管理」支持拖拽，关闭面板时把 DOM 顺序写回 folderSort（evidence §4「拖拽」行）。
func (a *App) ReorderMemoFolders(ctx context.Context, orderedIDs []string) error {
	at, err := a.now(ctx)
	if err != nil {
		return err
	}
	for i, id := range orderedIDs {
		f, err := loadOne[model.MemoFolder](a, ctx, store.KindMemoFolder, id)
		if err != nil {
			continue
		}
		if f.Sort == i {
			continue
		}
		f.Sort = i
		f.UpdatedAt = at
		e, err := store.NewEntity(store.KindMemoFolder, f)
		if err != nil {
			return err
		}
		if err := a.db.Put(ctx, e); err != nil {
			return err
		}
	}
	return nil
}
