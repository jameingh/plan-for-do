package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"planfordo/internal/core/model"
	"planfordo/internal/core/service"
)

// TestReportErrorWritesLog 保证「界面崩了」这件事在磁盘上留下痕迹。
// 生产构建没有 devtools，用户只能描述成「点一下就没了」，日志是唯一线索。
func TestReportErrorWritesLog(t *testing.T) {
	dir := t.TempDir()
	api, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()

	if err := api.ReportError("渲染", "TypeError: Cannot read properties of null (reading 'map')\n\tat ListsPage"); err != nil {
		t.Fatalf("ReportError: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "app-errors.log"))
	if err != nil {
		t.Fatalf("读日志: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, "渲染") || !strings.Contains(s, "ListsPage") {
		t.Errorf("日志内容不完整：%q", s)
	}

	// 超长 detail 必须截断，否则一次崩溃能把日志撑爆。
	long := strings.Repeat("x", 9000)
	if err := api.ReportError("同步", long); err != nil {
		t.Fatalf("ReportError 长文本: %v", err)
	}
	raw, err = os.ReadFile(filepath.Join(dir, "app-errors.log"))
	if err != nil {
		t.Fatalf("复读日志: %v", err)
	}
	if len(raw) > 14000 {
		t.Errorf("长错误没被截断，日志 %d 字节", len(raw))
	}
}

// TestNewAPISeedsAndReportsDevice 确认壳的启动面在纯 Go 环境下也能跑通（不需要窗口）。
func TestNewAPISeedsAndReportsDevice(t *testing.T) {
	dir := t.TempDir()
	api, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()

	info, err := api.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if info.DataDir != dir || info.Today == "" {
		t.Errorf("BootInfo 不符：%+v", info)
	}
	// 空切片会让前端 .map 崩，出口必须已经是空数组。
	if info.ChannelKinds == nil || info.CalendarYears == nil {
		t.Errorf("BootInfo 出现 nil 切片，前端会崩：%+v", info)
	}
	if len(info.CalendarYears) != 0 {
		t.Errorf("临时目录不该有节假日数据：%v", info.CalendarYears)
	}
	view, err := api.ListView(service.ListViewRequest{})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if view.Groups == nil {
		t.Error("Groups 为 nil，前端 groups.map 会崩")
	}
	for _, g := range view.Groups {
		if g.Items == nil {
			t.Errorf("组 %s 的 Items 为 nil", g.Key)
		}
	}
}

// TestFreshProfileShowsDoneColumn 锁住「新设备第一次打开就少一整列」这类只有别人会遇到的问题：
// 默认偏好只能有一处定义，且默认显示已打卡。
func TestFreshProfileShowsDoneColumn(t *testing.T) {
	api, err := NewAPI(t.TempDir())
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()

	info, err := api.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !info.Settings.ShowDone {
		t.Error("新配置默认 showDone=false，没手动勾过开关的人看不到「已打卡」列")
	}
	if info.Settings.DefaultGroup != "date" || info.Settings.Theme != "light" {
		t.Errorf("默认偏好不符：%+v", info.Settings)
	}
	if info.Settings.HabitCreateMode != "guided" {
		t.Errorf("新建习惯默认模式 = %q, want guided（微启动引导是默认入口）", info.Settings.HabitCreateMode)
	}

	// 偏好要能往返，且老库里缺字段的记录要退回默认而不是变成「两头都不像」。
	if err := api.SaveSettings(Settings{ShowDone: false, DefaultGroup: "quadrants", Theme: "dark", HabitCreateMode: "classic"}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	back, err := api.GetSettings()
	if err != nil || back.HabitCreateMode != "classic" {
		t.Fatalf("habitCreateMode 没存住：%+v err=%v", back, err)
	}
	if err := api.db.MetaSet(context.Background(), settingsKey, `{"showDone":true,"defaultGroup":"date","theme":"light"}`); err != nil {
		t.Fatalf("写老版偏好: %v", err)
	}
	if got, err := api.GetSettings(); err != nil || got.HabitCreateMode != "guided" {
		t.Errorf("老偏好记录缺 habitCreateMode 时没退回默认：%+v err=%v", got, err)
	}

	// 默认偏好打开时，空库也要给出四个桶，前端才能显示空态而不是整列消失。
	view, err := api.ListView(service.ListViewRequest{ShowDone: info.Settings.ShowDone})
	if err != nil {
		t.Fatalf("ListView: %v", err)
	}
	if len(view.Groups) != 4 {
		t.Errorf("分组数 = %d, want 4（逾期/未打卡/待办/已打卡）", len(view.Groups))
	}
	seen := map[string]bool{}
	for _, g := range view.Groups {
		seen[g.Key] = true
	}
	for _, k := range []string{"overdue", "today", "later", "done"} {
		if !seen[k] {
			t.Errorf("缺少 %s 分组", k)
		}
	}

	// 关掉开关时才允许少一列。
	off, err := api.ListView(service.ListViewRequest{ShowDone: false})
	if err != nil {
		t.Fatalf("ListView off: %v", err)
	}
	for _, g := range off.Groups {
		if g.Key == "done" {
			t.Error("ShowDone=false 仍返回 done 分组")
		}
	}
}

func TestCDPPortOnlyAcceptsDigits(t *testing.T) {
	cases := map[string]string{
		"":                     "",
		"9222":                 "9222",
		"12345":                "12345",
		"92a":                  "",
		"--remote-debugging":   "",
		"92":                   "",
		"123456":               "",
		"9222 --user-data-dir": "",
	}
	for in, want := range cases {
		t.Setenv("PLANDO_CDP_PORT", in)
		if got := cdpPort(); got != want {
			t.Errorf("cdpPort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReportErrorDedupesAndRotates(t *testing.T) {
	dir := t.TempDir()
	api, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer api.shutdown()
	path := filepath.Join(dir, "app-errors.log")

	msg := "TypeError: Cannot read properties of null (reading 'length')"
	for i := 0; i < 200; i++ {
		if err := api.ReportError("渲染", msg); err != nil {
			t.Fatalf("ReportError %d: %v", i, err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读日志: %v", err)
	}
	if got := strings.Count(string(raw), msg); got != 1 {
		t.Errorf("同一句错误写了 %d 次，应该限流成 1 次", got)
	}

	// 换一句时才把省略量补出来
	if err := api.ReportError("同步", "boom"); err != nil {
		t.Fatalf("ReportError 换句: %v", err)
	}
	raw, _ = os.ReadFile(path)
	if !strings.Contains(string(raw), "重复省略 199 次") {
		t.Errorf("没写省略量：%q", raw)
	}

	// 超过 512KB 必须自动截尾
	if err := os.WriteFile(path, bytes.Repeat([]byte("旧错误\n"), 200_000), 0o644); err != nil {
		t.Fatalf("预置日志: %v", err)
	}
	if err := api.ReportError("渲染", "新错误"); err != nil {
		t.Fatalf("ReportError 截尾: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size() > 200<<10 {
		t.Errorf("日志没被压回去，仍有 %d 字节", st.Size())
	}
	raw, _ = os.ReadFile(path)
	if !strings.Contains(string(raw), "新错误") {
		t.Errorf("截尾后把新错误挤掉了：%q", raw[:minInt(len(raw), 200)])
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// 弹窗新增的两条内核能力：农历批量查询、事项图片附件。
func TestLunarLabelsAndItemImages(t *testing.T) {
	dir := t.TempDir()
	a, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer a.shutdown()
	ctx := context.Background()

	// 农历：与参考站逐格比对过的两个日子（2026-11-06 九月廿八、2027-03-08 二月初一）
	// 格子只给日名（初一 / 廿八），月名不塞进去——参考站的格子就是这样，塞了会挤掉数字排版。
	cells, err := a.LunarLabels([]model.Day{"2026-11-06", "2027-03-08"})
	if err != nil {
		t.Fatalf("LunarLabels: %v", err)
	}
	if len(cells) != 2 {
		t.Fatalf("格子数 = %d", len(cells))
	}
	if cells[0].Lunar != "廿八" {
		t.Errorf("2026-11-06 农历 = %q, want 廿八", cells[0].Lunar)
	}
	if cells[1].Lunar != "初一" {
		t.Errorf("2027-03-08 农历 = %q, want 初一", cells[1].Lunar)
	}
	// 3 月 8 日是妇女节：节日位优先于农历位显示
	if cells[1].Festival != "妇女节" {
		t.Errorf("2027-03-08 节日 = %q, want 妇女节", cells[1].Festival)
	}
	// 越界日期不能报错打断面板，只给空格子由前端回落显示公历
	edge, err := a.LunarLabels([]model.Day{"1899-12-31", "不是日期"})
	if err != nil || len(edge) != 2 || edge[0].Lunar != "" {
		t.Errorf("越界处理不符：%+v err=%v", edge, err)
	}

	// 事项 + 图片
	it, err := a.SaveItem(service.ItemInput{Title: "带图事项", Date: model.DateSpec{Kind: model.DateSingle, Start: a.svc.Today()}}, service.ScopeAll, "")
	if err != nil {
		t.Fatalf("SaveItem: %v", err)
	}
	id0 := it[0].ID
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfake-bytes"))
	if _, err := a.AddItemImage(id0, "笔记.png", png); err != nil {
		t.Fatalf("AddItemImage: %v", err)
	}
	// 非图片必须挡住，否则会存下一个前端渲染不出来的空块
	if _, err := a.AddItemImage(id0, "说明.txt", png); err == nil {
		t.Error("txt 不该被当成图片收下")
	}
	list, err := a.ItemImages(id0)
	if err != nil || len(list) != 1 {
		t.Fatalf("ItemImages = %d 条, err=%v", len(list), err)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(list[0].Path))); err != nil {
		t.Errorf("图片没落到数据目录：%v", err)
	}
	// 上限 5 张：第 6 张要报错，而不是静默丢弃
	for i := 0; i < 4; i++ {
		if _, err := a.AddItemImage(id0, fmt.Sprintf("图%d.png", i), png); err != nil {
			t.Fatalf("第 %d 张: %v", i+2, err)
		}
	}
	if _, err := a.AddItemImage(id0, "第6张.png", png); err == nil {
		t.Error("超过 5 张没被挡住")
	}
	if err := a.DeleteAttachment(list[0].ID); err != nil {
		t.Fatalf("DeleteAttachment: %v", err)
	}
	after, err := a.ItemImages(id0)
	if err != nil || len(after) != 4 {
		t.Errorf("删除后剩 %d 条, err=%v", len(after), err)
	}
	_ = ctx
}

// 附件行不能是 null：前端一读 length 就白屏。
func TestItemImagesNeverNull(t *testing.T) {
	dir := t.TempDir()
	a, err := NewAPI(dir)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	defer a.shutdown()
	raw, err := json.Marshal(mustListImages(t, a))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(raw) == "null" {
		t.Error("空附件序列化成 null")
	}
}

func mustListImages(t *testing.T, a *API) []model.Attachment {
	t.Helper()
	out, err := a.ItemImages("不存在的id")
	if err != nil {
		t.Fatalf("ItemImages: %v", err)
	}
	return out
}
