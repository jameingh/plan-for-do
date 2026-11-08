package notify

import (
	"context"
	"strings"
	"testing"
)

// TestNopIsSilentlyUsable 钉住「空实现不报错」这条契约：
// 非 Windows 平台与初始化失败都走它，提醒链路不能因为弹不出通知就中断。
func TestNopIsSilentlyUsable(t *testing.T) {
	var s Sender = Nop()
	if s.Available() {
		t.Error("空实现不该声称自己可用")
	}
	if err := s.Send("标题", "正文"); err != nil {
		t.Errorf("空实现的 Send 应返回 nil，得 %v", err)
	}
	s.Close()
	s.Close() // 重复关不该炸
}

// TestNewNeverPanicsWithoutApp 是壳层的启动顺序断言：
// 通知服务要在 application.New 之后起（它要读 app.Config().Name）。
// 单测里没有 app，所以这里只要求「退回空实现或可用实现，都不许 panic」——
// 真机上 attach 的调用点由 check-account 的「测试通知」断言覆盖。
func TestNewNeverPanicsWithoutApp(t *testing.T) {
	defer func() {
		if v := recover(); v != nil {
			t.Errorf("没有 app 时 New 不该 panic：%v", v)
		}
	}()
	s := New(context.Background())
	if s == nil {
		t.Fatal("New 必须返回一个 Sender（哪怕是空的）")
	}
	t.Log("本平台 Available =", s.Available())
	s.Close()
}

// TestSendRejectsEmptyTitle 钉住参数校验：标题为空的调用是界面写错了，
// 要当场报错，不能悄悄发一条没有标题的通知。
func TestSendRejectsEmptyTitle(t *testing.T) {
	s := New(context.Background())
	defer s.Close()
	if !s.Available() {
		t.Skip("本平台没有原生实现，空标题校验由 Windows 侧覆盖")
	}
	err := s.Send("", "只有正文")
	if err == nil || !strings.Contains(err.Error(), "标题") {
		t.Errorf("空标题应报错并说明原因，得 %v", err)
	}
}
