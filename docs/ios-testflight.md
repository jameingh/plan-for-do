# iOS / TestFlight 出包步骤

**状态：未在本机验证。** 开发机是 Windows，而 Wails v3 打 iOS 包强制要求 macOS + 完整版 Xcode
（仅命令行工具不够）。下面是到 Mac 上要执行的完整流程，命令名取自本仓库
`build/ios/Taskfile.yml`（Wails v3.1.0 模板）与官方 iOS 指南。第一次在 Mac 上跑通后，
请回来把「实际输出」和踩坑补进本文件，不要把它当成已验证的说明书。

## 0. 前置

- Apple 开发者账号（付费 $99/年）。TestFlight 分发必须有它；免费账号只能本机侧载，证书 7 天过期。
- macOS + App Store 装的完整版 Xcode（`xcode-select -p` 指向 `Xcode.app`，不是 `CommandLineTools`）。
- Go 1.26+、Node + npm。
- 装 Wails CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`
  （CLI 版本要和 `go.mod` 里的 wails 版本对齐，本项目锁 3.1.0）。
- 证书与描述文件：钥匙串里建 "Apple Development" 证书；在 developer.apple.com 注册设备 UDID
  与 App ID（Bundle ID 要和 `build/config.yml` 的 `ios.bundleID` 一致），下载 provisioning profile。

## 1. 先把标识符换成你自己的

`build/config.yml` 现在是模板值 `com.yourname.planfordo`（占位）。改掉后重新生成构建资产：

```bash
wails3 task common:update:build-assets
```

它会覆写 `build/ios/Info.plist` 等文件，所以**先改 config 再生成**，否则手改的 plist 会被冲掉。

## 2. 同步器与内核不需要为 iOS 改代码

这是当初选型定的架构约束，落地情况：

- 存储用 `modernc.org/sqlite`（纯 Go，CGO-free），iOS 上直接编；
- 数据目录走 `os.UserConfigDir()`，在 iOS 上就是 app container 内的可写路径；
  调试时可用 `PLANDO_DATA_DIR` 覆盖；
- 同步通道只有 HTTP 与文件读写，`feishuDrive`/`feishuBase`/`webdav`/`localdir` 全平台同码。

要在 iOS 上确认可用的两点：

1. **提醒**：iOS 后台不会跑 Go 定时器。内核 `service.UpcomingReminders` 已经算出绝对时刻列表，
   壳里需要在应用激活（以及每次数据变更）时把这批时刻预排成 `UNUserNotificationCenter` 本地通知，
   注意系统单 App 上限 64 条，所以只排最近一段。桌面端的轮询循环（`api.go` 的 `reminderLoop`）
   在移动端应当换成同样的预排逻辑，而不是指望它到点触发。
2. **ATS**：WebDAV 若走自签证书或明文 HTTP，iOS 默认会被 ATS 拦下。要么服务端上 HTTPS，
   要么在 `Info.plist` 显式加 `NSAppTransportSecurity` 例外——这是安全决策，做之前先确认。

## 3. 模拟器

```bash
wails3 task ios:run              # 构建 + 起模拟器 + 装起来跑
wails3 task ios:logs:dev         # 另开一个终端流日志
wails3 task ios:xcode            # 打开生成的 Xcode 工程（调试期常要）
```

Debug 构建下 WKWebView 可以在 Safari 的 Develop 菜单里审查元素，前端问题在这儿看最快。

## 4. 真机与 .ipa

```bash
wails3 task ios:package IOS_PLATFORM=device \
  CODESIGN_IDENTITY="Apple Development: 你的名字 (TEAMID)" \
  PROVISIONING_PROFILE=path/to/profile.mobileprovision

wails3 task ios:deploy-device              # 装上并启动（可加 DEVICE_ID=<udid>）
wails3 task ios:package:ipa IOS_PLATFORM=device \
  CODESIGN_IDENTITY="..." PROVISIONING_PROFILE="..."   # 出分发用 .ipa
```

出 .ipa 之后上传 TestFlight，三选一：

- **Transporter**（最省事）：把 .ipa 拖进去 → 上传 → App Store Connect 里几分钟后出现在 TestFlight 构建；
- Xcode → Window → Organizer → Distribute App → App Store Connect Upload；
- 命令行 `xcrun altool --upload-app -f app.ipa -t ios -i <BUNDLE_ID> -k <KEY> -s <API_KEY_ID>`，
  密钥用 App Store Connect 里生成的 API Key。

TestFlight 侧：内部测试组（团队成员，最多 100 人，不需要审核）先收；外部测试组要过一次
Beta App Review，并要填测试信息（登录方式、联系方式）。**不走上架**就永远停在内部组，
或者外部组只做小范围邀请。

## 5. 常见断裂点

- Wails 移动端整体标注 experimental，接口和构建流程在 3.x 里可能变；升级 CLI 版本要重新走一遍模拟器。
- `go install` 报 `can't find export data (bufio: buffer full)` 是构建缓存坏了，`go clean -cache` 后重装。
- 前端产物必须先 `npm run build` 生成 `frontend/dist`，`//go:embed all:frontend/dist` 才有东西可嵌。
- iOS 上文件系统不是「随便写」：只有 app container 可写，附件目录要跟数据目录一起从壳注入。
