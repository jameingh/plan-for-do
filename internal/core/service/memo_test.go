package service

import (
	"context"
	"strings"
	"testing"

	"planfordo/internal/core/model"
)

func memoTitles(t *testing.T, a *App, ctx context.Context, req MemoRequest) []string {
	t.Helper()
	list, err := a.MemoList(ctx, req)
	if err != nil {
		t.Fatalf("MemoList: %v", err)
	}
	out := make([]string, 0, len(list))
	for _, it := range list {
		out = append(out, it.Memo.Title)
	}
	return out
}

func TestMemoCreateSaveAndPreview(t *testing.T) {
	a, ctx := newApp(t)

	m, err := a.CreateMemo(ctx, "")
	if err != nil {
		t.Fatalf("CreateMemo: %v", err)
	}
	if m.FileType != model.MemoFileNone {
		t.Fatalf("新建的备忘录 fileType 应为 -1，实得 %d", m.FileType)
	}
	// 空记录也要在列表里（参考站新建后立刻出现一条「无标题」）
	list, err := a.MemoList(ctx, MemoRequest{})
	if err != nil {
		t.Fatalf("MemoList: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("列表应有 1 条，实得 %d", len(list))
	}
	if list[0].Preview != "" {
		t.Fatalf("空正文的摘要应为空，实得 %q", list[0].Preview)
	}

	html := `<div>第一段&nbsp;文字</div><div><br></div><div>&lt;标签&gt;与 &amp; 实体</div>`
	saved, err := a.SaveMemo(ctx, MemoInput{ID: m.ID, Title: "  周记  ", HTML: html})
	if err != nil {
		t.Fatalf("SaveMemo: %v", err)
	}
	if saved.Title != "周记" {
		t.Fatalf("标题应被 trim，实得 %q", saved.Title)
	}
	list, _ = a.MemoList(ctx, MemoRequest{})
	// &nbsp; 要算空白、标签要剥掉、实体要解开
	if want := "第一段 文字 <标签>与 & 实体"; list[0].Preview != want {
		t.Fatalf("摘要 = %q，期望 %q", list[0].Preview, want)
	}
	// 搜索命中标题与正文各算一次
	for _, w := range []string{"周记", "实体", "&"} {
		got, err := a.MemoList(ctx, MemoRequest{Search: w})
		if err != nil {
			t.Fatalf("search %q: %v", w, err)
		}
		if len(got) != 1 {
			t.Fatalf("搜 %q 应命中 1 条，实得 %d", w, len(got))
		}
	}
	if got, _ := a.MemoList(ctx, MemoRequest{Search: "查不到"}); len(got) != 0 {
		t.Fatalf("无关关键词不该命中")
	}
}

func TestMemoPreviewIsTruncated(t *testing.T) {
	a, ctx := newApp(t)
	body := strings.Repeat("字", memoPreviewRunes+50)
	if _, err := a.SaveMemo(ctx, MemoInput{HTML: "<div>" + body + "</div>"}); err != nil {
		t.Fatalf("SaveMemo: %v", err)
	}
	list, _ := a.MemoList(ctx, MemoRequest{})
	if len([]rune(list[0].Preview)) != memoPreviewRunes {
		t.Fatalf("摘要应截到 %d 字，实得 %d", memoPreviewRunes, len([]rune(list[0].Preview)))
	}
	// 搜索不受摘要截断影响：命中尾部内容
	if got, _ := a.MemoList(ctx, MemoRequest{Search: strings.Repeat("字", 10)}); len(got) != 1 {
		t.Fatalf("长正文也该被搜到")
	}
}

func TestMemoOnlyBrIsNotContent(t *testing.T) {
	if memoHasContent("<div><br></div>") {
		t.Fatal("只剩一个 <br> 的空正文不该算有内容")
	}
	if !memoHasContent("<div>x</div>") {
		t.Fatal("有字符就该算有内容")
	}
}

func TestMemoSortTopAndFolders(t *testing.T) {
	a, ctx := newApp(t)

	old, err := a.CreateMemo(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.SaveMemo(ctx, MemoInput{ID: old.ID, Title: "旧"}); err != nil {
		t.Fatal(err)
	}
	// 直接改 CreatedAt 造出时间差（newApp 的时间源是本地时钟，同一秒内测不准）。
	// 必须重新读一条：SaveMemo 返回的是它自己那份，拿旧指针写回会把标题清掉。
	old, err = a.Memo(ctx, old.ID)
	if err != nil {
		t.Fatal(err)
	}
	old.CreatedAt = "2020-01-01T00:00:00Z"
	if err := a.saveMemo(ctx, old, old.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	newer, err := a.CreateMemo(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.SaveMemo(ctx, MemoInput{ID: newer.ID, Title: "新"}); err != nil {
		t.Fatal(err)
	}

	if got := memoTitles(t, a, ctx, MemoRequest{}); strings.Join(got, ",") != "新,旧" {
		t.Fatalf("按创建时间倒序应为 新,旧，实得 %v", got)
	}
	if err := a.SetMemoTop(ctx, old.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := memoTitles(t, a, ctx, MemoRequest{}); strings.Join(got, ",") != "旧,新" {
		t.Fatalf("置顶项要永远在前，实得 %v", got)
	}
	// 参考站的搜索比较器丢掉置顶：搜「旧」时按时间排，「新」不会因置顶被挤到后面
	if got := memoTitles(t, a, ctx, MemoRequest{Search: "旧"}); strings.Join(got, ",") != "旧" {
		t.Fatalf("搜索应命中「旧」，实得 %v", got)
	}

	f, err := a.SaveMemoFolder(ctx, MemoFolderInput{Name: "工作"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.MoveMemoFolders(ctx, []string{newer.ID}, f.ID); err != nil {
		t.Fatal(err)
	}
	if got := memoTitles(t, a, ctx, MemoRequest{FolderID: f.ID}); strings.Join(got, ",") != "新" {
		t.Fatalf("文件夹内只该有「新」，实得 %v", got)
	}
	if got := memoTitles(t, a, ctx, MemoRequest{}); len(got) != 2 {
		t.Fatalf("「全部」不该受文件夹影响，实得 %v", got)
	}

	// 删文件夹：备忘录归入未归类，不跟着陪葬
	n, err := a.DeleteMemoFolder(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("应移走 1 条，实得 %d", n)
	}
	back, err := a.Memo(ctx, newer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if back.FolderID != f.ID {
		t.Fatalf("删文件夹不该改 FolderID，实得 %q", back.FolderID)
	}
	if back.TrashedAt == "" {
		t.Fatal("删文件夹要把它下面的备忘录送进回收站")
	}
	if fs, _ := a.MemoFolders(ctx); len(fs) != 0 {
		t.Fatalf("文件夹该没了，实得 %d", len(fs))
	}
}

func TestMemoTrashRestorePurge(t *testing.T) {
	a, ctx := newApp(t)
	m, err := a.CreateMemo(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.SaveMemo(ctx, MemoInput{ID: m.ID, Title: "要删的"}); err != nil {
		t.Fatal(err)
	}

	if n, err := a.TrashMemos(ctx, []string{m.ID}); err != nil || n != 1 {
		t.Fatalf("TrashMemos: n=%d err=%v", n, err)
	}
	if got := memoTitles(t, a, ctx, MemoRequest{}); len(got) != 0 {
		t.Fatalf("删除后列表该空，实得 %v", got)
	}
	trash := memoTitles(t, a, ctx, MemoRequest{ShowDeleted: true})
	if strings.Join(trash, ",") != "要删的" {
		t.Fatalf("回收站该有它，实得 %v", trash)
	}
	// 重复删除不再改时间戳、也不报错
	if n, err := a.TrashMemos(ctx, []string{m.ID}); err != nil || n != 0 {
		t.Fatalf("重复删除不该计数：n=%d err=%v", n, err)
	}
	stats, err := a.MemoStats(ctx)
	if err != nil || stats.Total != 0 || stats.Trashed != 1 {
		t.Fatalf("MemoStats = %+v err=%v", stats, err)
	}

	if n, err := a.RestoreMemos(ctx, []string{m.ID}); err != nil || n != 1 {
		t.Fatalf("RestoreMemos: n=%d err=%v", n, err)
	}
	if got := memoTitles(t, a, ctx, MemoRequest{}); len(got) != 1 {
		t.Fatalf("恢复后列表该有 1 条，实得 %v", got)
	}

	if n, err := a.PurgeMemos(ctx, []string{m.ID}); err != nil || n != 1 {
		t.Fatalf("PurgeMemos: n=%d err=%v", n, err)
	}
	if _, err := a.Memo(ctx, m.ID); err == nil {
		t.Fatal("彻底删除后读不到才对")
	}
	if got, _ := a.MemoList(ctx, MemoRequest{ShowDeleted: true}); len(got) != 0 {
		t.Fatal("彻底删除后回收站也不该有")
	}
}

func TestMemoFolderNameLimits(t *testing.T) {
	a, ctx := newApp(t)
	if _, err := a.SaveMemoFolder(ctx, MemoFolderInput{Name: "   "}); err == nil {
		t.Fatal("空名要报错")
	}
	long, err := a.SaveMemoFolder(ctx, MemoFolderInput{Name: "一二三四五六七八九十"})
	if err != nil {
		t.Fatal(err)
	}
	if len([]rune(long.Name)) != model.MaxMemoFolderNameRunes || long.Name != "一二三四五六" {
		t.Fatalf("10 字要截到 %d 字，实得 %q", model.MaxMemoFolderNameRunes, long.Name)
	}
	// 刚好 6 字的不动它
	exact, err := a.SaveMemoFolder(ctx, MemoFolderInput{Name: "一二三四五六"})
	if err != nil {
		t.Fatal(err)
	}
	if exact.Name != "一二三四五六" {
		t.Fatalf("6 字不该被截，实得 %q", exact.Name)
	}
}
