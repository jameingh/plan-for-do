//go:build !windows

package notify

import "context"

// New 在 macOS / Linux / iOS 上返回空实现。
//
// 不是偷懒：macOS 的原生通知要求一个签名并打包好的 .app（裸二进制发不出去），
// 而本项目现在的 darwin 产物是未签名的（见 README 的发布矩阵）。
// 在没有 Mac 开发机的情况下写一份「编译得过但没人验过」的通知代码，
// 不如让提醒老老实实留在应用内——功能缺失是已知的，写进 README 就行。
func New(context.Context) Sender { return Nop() }
