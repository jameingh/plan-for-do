//go:build windows

package notify

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	wnotes "github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// win 是 Windows 的原生通知实现：直接用 Wails 自带的通知服务
// （底层 go-toast，纯 syscall/COM，CGO_ENABLED=0 也编得过）。
//
// 为什么不是「powershell 弹 toast」：试过并且不行——未打包的 exe 没有注册 AUMID，
// `CreateToastNotifier(...).Show()` 会被系统丢掉（notifier.Setting.Enabled 读出来是空），
// 气球通知（NotifyIcon.ShowBalloonTip）在这台机上也是一点不显示。
// go-toast 会自己写 HKCU\Software\Classes\CLSID\{guid}\LocalServer32 把应用注册上，
// 这是 Windows 认这条 toast 的前提。
type win struct {
	svc   *wnotes.NotificationService
	mu    sync.Mutex // 服务内部有注册表与 COM 调用，串行更稳
	seq   int64
	epoch int64
	dead  bool
}

// New 起原生通知。必须在 application.New 之后调用：通知服务启动时要读
// app.Config().Name，而那个全局只在 New 里才被填上（读不到就 panic）。
//
// 所以这里把 panic 兜成「退回空实现」：调用顺序写错、或者在没有 app 的进程里
// （CLI、单元测试）误调它，代价只是没有系统通知，而不该是整个应用起不来。
func New(ctx context.Context) (s Sender) {
	defer func() {
		if v := recover(); v != nil {
			s = Nop()
		}
	}()
	svc := wnotes.New()
	if err := svc.ServiceStartup(ctx, application.ServiceOptions{}); err != nil {
		return Nop()
	}
	return &win{svc: svc, epoch: time.Now().Unix()}
}

func (*win) Available() bool { return true }

func (w *win) Send(title, body string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.dead {
		return fmt.Errorf("notify: 通知服务已关闭")
	}
	if title == "" {
		return fmt.Errorf("notify: 标题不能为空")
	}
	// ID 必填，它是系统的「更新/去重」句柄。这里让它每条都不同：
	// 提醒的语义是「这一刻又有一条」，不是「把上一条改掉」。
	// 带上进程启动时刻是为了跨重启也不撞——撞了不报错，但两条不同提醒会被合成一条。
	w.seq++
	id := fmt.Sprintf("planfordo-%d-%d", w.epoch, w.seq)
	return w.svc.SendNotification(wnotes.NotificationOptions{
		ID:    id,
		Title: title,
		Body:  body,
	})
}

func (w *win) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.dead {
		return
	}
	w.dead = true
	_ = w.svc.ServiceShutdown()
}
