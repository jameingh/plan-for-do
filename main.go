// Package main 是 Wails v3 桌面壳。它只做四件事：解析平台目录、打开内核、
// 把内核用例注册成前端可调的服务、把变更与提醒事件推给前端。
//
// 任何业务规则都不该出现在这里——那是 internal/core 的职责，
// iOS 壳与 plando CLI 复用同一套内核。
package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"planfordo/internal/core/service"
	plansync "planfordo/internal/core/sync"
	channelfeishu "planfordo/internal/core/sync/channel/feishu"
	channelwebdav "planfordo/internal/core/sync/channel/webdav"
)

//go:embed all:frontend/dist
var assets embed.FS

const appName = "planfordo"

func init() {
	// 注册事件及其数据类型，绑定生成器据此给前端产出带类型的订阅 API。
	application.RegisterEvent[map[string]string]("data:changed")
	application.RegisterEvent[[]plansync.Result]("sync:done")
	application.RegisterEvent[[]service.ReminderFire]("reminder:due")
}

func main() {
	// 点系统通知时 Windows 会按注册表里的 LocalServer32 再拉起一次本程序，
	// 参数带 -ToastActivated。这一次不该开第二个窗口、更不该去抢同一个 SQLite 库：
	// 通知服务在原地接收点击事件就够了，所以直接退出。
	if toastActivationRequested(os.Args[1:]) {
		return
	}

	dataDir, err := resolveDataDir()
	if err != nil {
		log.Fatalf("启动失败: %v", err)
	}

	// 通道实现在各自的包里 Register，壳只负责显式装配，顺序无关。
	channelfeishu.Install()
	channelwebdav.Install()

	api, err := NewAPI(dataDir)
	if err != nil {
		log.Fatalf("启动失败: %v", err)
	}

	opts := application.Options{
		Name:        appName,
		Description: "跨终端清单与习惯",
		Services: []application.Service{
			application.NewService(api),
		},
		Assets: application.AssetOptions{
			// 内嵌前端 + 事项图片：/attachments/<file> 从数据目录读，其余走内嵌 FS。
			// 前端因此只需要 <img src="/attachments/xxx.png">，不用处理本地文件路径。
			Handler: attachmentHandler(assets, dataDir),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// iOS 构建（需要 macOS + Xcode）在这里加 application.IOSOptions{}，
		// 内核与前端代码都不用动。当前开发机是 Windows，先留空。
	}

	// PLANDO_CDP_PORT 打开 WebView2 远程调试口，只给自检用：可以直接向界面 DOM
	// 派发真实鼠标事件，不用抢用户的鼠标和前台窗口。默认不开，正式使用零影响。
	// 注意 WebView2 会复用同一 user-data-folder 的既有浏览器进程（那时参数被忽略），
	// 所以调试时要同时给一个独立的 PLANDO_WEBVIEW_PROFILE。
	if port := cdpPort(); port != "" {
		opts.Windows.AdditionalBrowserArgs = []string{
			"--remote-debugging-port=" + port,
			"--remote-allow-origins=*",
		}
		if profile := os.Getenv("PLANDO_WEBVIEW_PROFILE"); profile != "" {
			opts.Windows.WebviewUserDataPath = profile
		}
	}

	app := application.New(opts)

	api.attach(app)

	// PLANDO_START_TAB 让界面验证不依赖鼠标点击：只接受白名单值，
	// 不做任意 URL 拼接，免得变成「启动参数能加载任何页面」的口子。
	startURL := "/"
	switch os.Getenv("PLANDO_START_TAB") {
	case "lists", "views", "habits", "focus", "memos", "settings":
		startURL = "/?tab=" + os.Getenv("PLANDO_START_TAB")
	}

	// 窗口尺寸默认 1180x780（按参考站在 1920 屏上的比例定的）。
	// 留环境变量覆盖口是给 CI 用的：GitHub 的 windows runner 虚拟显示只有 1024x768，
	// 1180x780 的窗口会被裁掉一截，界面自检点到的坐标落在屏幕外（check-memo 的背景格子就是这么挂的）。
	winW, winH := windowSize()
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "功到",
		Width:            winW,
		Height:           winH,
		BackgroundColour: application.NewRGB(246, 246, 244),
		URL:              startURL,
	})

	if err := app.Run(); err != nil {
		api.shutdown()
		log.Fatal(err)
	}
	// 关掉提醒轮询并 checkpoint WAL，否则下次启动看到的是半截状态。
	api.shutdown()
}

// toastActivationRequested 认 Windows 通知的激活参数。
//
// 通知服务的注册流程会把「本 exe + %1」写进 HKCU\Software\Classes\CLSID\{guid}\LocalServer32，
// 用户点通知（或通知上的按钮）时 Windows 就带着 -ToastActivated 再拉一次进程。
// 只认这个前缀，别的参数一律当正常启动——不能把「用户双击图标」误判成激活而不开窗。
func toastActivationRequested(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(strings.ToLower(a), "-toastactivated") {
			return true
		}
	}
	return false
}

// attachmentHandler 在内嵌前端之外多挂一条路由：/attachments/<文件名> → 数据目录里的图片。
//
// 只取 base，不做目录拼接，所以「/attachments/../../planfordo.db」这类路径读不到库文件；
// 附件本身按 id+扩展名落盘，文件名里没有用户可控内容。
func attachmentHandler(assets embed.FS, dataDir string) http.Handler {
	base := application.AssetFileServerFS(assets)
	dir := filepath.Join(dataDir, "attachments")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/attachments/") {
			base.ServeHTTP(w, r)
			return
		}
		name := filepath.Base(r.URL.Path)
		if name == "." || name == "/" || !strings.Contains(name, ".") {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, name))
	})
}

// cdpPort 只接受纯数字端口，其它一律当作「没开」。宁可静默忽略，也不要让
// 一个拼错的参数变成「往浏览器命令行里塞任意字符串」。
func cdpPort() string {
	v := os.Getenv("PLANDO_CDP_PORT")
	if v == "" {
		return ""
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return ""
		}
	}
	if len(v) < 4 || len(v) > 5 {
		return ""
	}
	return v
}

// resolveDataDir 定数据目录。PLANDO_DATA_DIR 让 CLI、测试和便携安装能指到别处，
// 剩下的交给系统标准目录——iOS 上这就是 app container 内的可写路径。
func resolveDataDir() (string, error) {
	if v := os.Getenv("PLANDO_DATA_DIR"); v != "" {
		if err := os.MkdirAll(v, 0o755); err != nil {
			return "", fmt.Errorf("建数据目录 %s: %w", v, err)
		}
		return v, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("定位系统配置目录: %w", err)
	}
	dir := filepath.Join(base, appName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("建数据目录 %s: %w", dir, err)
	}
	return dir, nil
}

// windowSize 读 PLANDO_WINDOW_WIDTH / PLANDO_WINDOW_HEIGHT，非法或缺省用 1180x780，
// 并夹在 640..2560 之间，避免一个笔误把窗口开成 0 宽（那样界面自检会点到空气，还看不出原因）。
func windowSize() (int, int) {
	pick := func(key string, def int) int {
		v, err := strconv.Atoi(os.Getenv(key))
		if err != nil || v < 640 || v > 2560 {
			return def
		}
		return v
	}
	return pick("PLANDO_WINDOW_WIDTH", 1180), pick("PLANDO_WINDOW_HEIGHT", 780)
}
