package feishu

import (
	"sort"
	"strings"
	stdsync "sync"

	"planfordo/internal/core/sync"
)

// Options 键名清单（设置页按此渲染表单；含义详见各通道工厂函数）：
//
//	appId / appSecret   自建应用凭证，两条通道必填
//	baseUrl             开放平台域名，默认 https://open.feishu.cn，Lark 国际版填 https://open.larksuite.com
//	folderToken         feishuDrive：云盘文件夹 token
//	fileName            feishuDrive：快照文件名，默认 planfordo-snapshot.json
//	appToken            feishuBase：多维表格 app_token
//	tablePrefix         feishuBase：数据表名前缀，默认 pf_
var OptionsHelp = []string{"appId", "appSecret", "baseUrl", "folderToken", "fileName", "appToken", "tablePrefix"}

var installOnce stdsync.Once

// Install 把两种飞书通道注册进 sync 引擎。
//
// 为什么不走 init()：宿主（桌面壳/CLI）显式调用 Install，测试与嵌入式进程
// 可以完全不碰飞书代码路径；而 sync.Register 对重复注册是 panic，
// Install 必须自己幂等，多次调用（多入口、插件重复加载）只注册一次。
func Install() {
	installOnce.Do(func() {
		sync.Register("feishuDrive", newDrive)
		sync.Register("feishuBase", newBase)
	})
}

// sortedKeys 让 map 遍历变成确定序：批量操作的失败现场才可复现，测试才稳。
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func trim(v string) string { return strings.TrimSpace(v) }
