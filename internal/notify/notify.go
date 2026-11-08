// Package notify 把一条提醒送到操作系统自己的通知中心。
//
// 为什么需要它：提醒轮询（api.reminderLoop）在 Go 侧跑，窗口最小化或在别的桌面时
// 前端的浮条没人看得见，用户就漏掉了打卡提醒。系统通知是这条链路的最后一公里。
//
// 约束：内核必须保持 CGO-free（见 docs/architecture.md 第 1 节）。Windows 走
// Wails 自带的通知服务（底层 go-toast，纯 syscall/COM，不需要 C）；
// 其它平台目前是空实现——不报错，只是不弹，界面里的开关仍然照常显示状态。
package notify

// Sender 发送一条系统通知。
type Sender interface {
	// Send 送一条通知。实现可能同步返回错误（比如 COM 起不来），
	// 调用方不该因为弹不出来就影响数据写入——错误只用于日志与设置页提示。
	Send(title, body string) error
	// Available 报告本平台有没有真的通知实现。设置页据此决定要不要给开关。
	Available() bool
	// Close 释放平台侧资源（注册表回调、COM 等）。
	Close()
}

// noop 是「这个平台没有原生通知落地」的实现。
type noop struct{}

func (noop) Send(string, string) error { return nil }
func (noop) Available() bool           { return false }
func (noop) Close()                    {}

// Nop 给非 Windows 平台、单元测试与「原生实现初始化失败」兜底。
func Nop() Sender { return noop{} }
