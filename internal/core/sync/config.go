package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"planfordo/internal/core/store"
)

// Config 是一条通道的配置。它只存在本机 meta 里，绝不进快照——
// 否则飞书 app_secret、WebDAV 密码会被复制到另一端设备甚至网盘上。
type Config struct {
	Name    string            `json:"name"`
	Kind    string            `json:"kind"`
	Enabled bool              `json:"enabled"`
	Options map[string]string `json:"options,omitempty"`
}

// Factory 按配置造出通道。各通道在自己的 init 里注册，新增通道不用改这个文件。
type Factory func(name string, opts map[string]string) (Channel, error)

var factories = map[string]Factory{}

// Register 登记一种通道类型。名字重复是编程错误，直接 panic 让它当场暴露。
func Register(kind string, f Factory) {
	if kind == "" || f == nil {
		panic("sync: Register 参数不完整")
	}
	if _, dup := factories[kind]; dup {
		panic("sync: 通道类型重复注册: " + kind)
	}
	factories[kind] = f
}

// Kinds 返回已注册的通道类型，设置页用它填下拉框。
func Kinds() []string {
	out := make([]string, 0, len(factories))
	for k := range factories {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Build 按配置实例化通道。
func Build(cfg Config) (Channel, error) {
	f, ok := factories[cfg.Kind]
	if !ok {
		return nil, fmt.Errorf("sync: 未注册的通道类型 %q（已注册 %v）", cfg.Kind, Kinds())
	}
	if cfg.Name == "" {
		return nil, errors.New("sync: 通道名不能为空")
	}
	return f(cfg.Name, cfg.Options)
}

const metaChannels = "sync.channels"

// MaskedValue 是回给前端的凭证占位符。原样送回来表示「这条不改」，
// 免得设置页把掩码串当真密钥写进配置、把好用的凭证覆盖坏。
const MaskedValue = "********"

// sensitiveOptions 里的键不参与回显。内核与通道始终拿到真值，只有面向 UI 的
// Configs() 返回值被掩码——凭证属于本机，不该绕道前端再回来。
var sensitiveOptions = map[string]bool{
	"appSecret": true, "password": true, "token": true, "secret": true,
}

// maskOptions 返回脱敏副本，不改原对象。空 Options 也要给空 map：
// nil map 序列化出来是 null，前端 Object.keys(options) 会崩。
func maskOptions(opts map[string]string) map[string]string {
	out := make(map[string]string, len(opts))
	for k, v := range opts {
		if sensitiveOptions[k] && v != "" {
			out[k] = MaskedValue
			continue
		}
		out[k] = v
	}
	return out
}

// unmaskOptions 把掩码占位换回本机已存的真值。新建通道（没有旧配置）时保持原样，
// 让调用方拿到明确报错而不是拿着 "********" 去连服务器。
func (m *Manager) unmask(ctx context.Context, cfg Config) Config {
	list, err := m.configsRaw(ctx)
	if err != nil {
		return cfg
	}
	for _, old := range list {
		if old.Name != cfg.Name {
			continue
		}
		out := Config{Name: cfg.Name, Kind: cfg.Kind, Enabled: cfg.Enabled}
		opts := map[string]string{}
		for k, v := range cfg.Options {
			if v == MaskedValue && sensitiveOptions[k] {
				if prev, ok := old.Options[k]; ok {
					v = prev
				}
			}
			opts[k] = v
		}
		out.Options = opts
		return out
	}
	return cfg
}

// Manager 管通道配置并驱动同步。
type Manager struct {
	db     *store.DB
	engine *Engine
}

// NewManager 构造通道管理器。dataDir 可选，透传给同步引擎用于附件字节搬运；
// 不传的调用方（只管配置/水位的场景）行为与之前一致。
func NewManager(db *store.DB, dataDir ...string) *Manager {
	return &Manager{db: db, engine: NewEngine(db, dataDir...)}
}

// Engine 暴露同步引擎给需要单跑一轮的调用方。
func (m *Manager) Engine() *Engine { return m.engine }

// Configs 返回脱敏后的通道配置，只用于展示。内部执行同步一律走 configsRaw，
// 否则拿到的掩码串会被当成真凭证发出去。
func (m *Manager) Configs(ctx context.Context) ([]Config, error) {
	list, err := m.configsRaw(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Config, 0, len(list))
	for _, c := range list {
		c.Options = maskOptions(c.Options)
		out = append(out, c)
	}
	return out, nil
}

// configsRaw 读原始配置。没有配置时必须返回空切片而不是 nil：
// nil 切片序列化出来是 null，设置页 `channels.length` 会当场崩
// ——而「一台新设备还没配任何通道」恰恰是最常见的路径。
func (m *Manager) configsRaw(ctx context.Context) ([]Config, error) {
	raw, ok, err := m.db.MetaGet(ctx, metaChannels)
	if err != nil {
		return nil, err
	}
	out := []Config{}
	if !ok || raw == "" {
		return out, nil
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("sync: 通道配置损坏: %w", err)
	}
	if out == nil {
		out = []Config{}
	}
	return out, nil
}

// SaveConfig 新增或按名字覆盖一条配置。前端送来的掩码会先换回本机已存的真凭证，
// 其余旧值也从原始配置取，避免把掩码串写回去。
func (m *Manager) SaveConfig(ctx context.Context, cfg Config) error {
	if cfg.Name == "" {
		return errors.New("sync: 通道名不能为空")
	}
	cfg = m.unmask(ctx, cfg)
	if _, err := Build(cfg); err != nil {
		return err
	}
	list, err := m.configsRaw(ctx)
	if err != nil {
		return err
	}
	replaced := false
	for i := range list {
		if list[i].Name == cfg.Name {
			list[i] = cfg
			replaced = true
			break
		}
	}
	if !replaced {
		list = append(list, cfg)
	}
	return m.writeConfigs(ctx, list)
}

// RemoveConfig 删掉一条通道配置（不动远端数据）。
func (m *Manager) RemoveConfig(ctx context.Context, name string) error {
	list, err := m.configsRaw(ctx)
	if err != nil {
		return err
	}
	out := list[:0:0]
	found := false
	for _, c := range list {
		if c.Name == name {
			found = true
			continue
		}
		out = append(out, c)
	}
	if !found {
		return fmt.Errorf("sync: 通道 %q 不存在", name)
	}
	return m.writeConfigs(ctx, out)
}

func (m *Manager) writeConfigs(ctx context.Context, list []Config) error {
	raw, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return m.db.MetaSet(ctx, metaChannels, string(raw))
}

// SyncOne 跑指定通道的一轮同步。
func (m *Manager) SyncOne(ctx context.Context, name string) (Result, error) {
	cfg, err := m.configByName(ctx, name)
	if err != nil {
		return Result{}, err
	}
	ch, err := Build(cfg)
	if err != nil {
		return Result{}, err
	}
	return m.engine.Run(ctx, ch)
}

// SyncAll 依次跑所有启用的通道。串行是刻意的：同一个库并发写只会互相踩 busy_timeout。
// 单条通道失败不影响其它通道，错误随结果一起返回。
func (m *Manager) SyncAll(ctx context.Context) ([]Result, error) {
	list, err := m.configsRaw(ctx)
	if err != nil {
		return nil, err
	}
	out := []Result{}
	for _, cfg := range list {
		if !cfg.Enabled {
			continue
		}
		ch, err := Build(cfg)
		if err != nil {
			out = append(out, Result{Channel: cfg.Name, Skipped: err.Error()})
			continue
		}
		res, err := m.engine.Run(ctx, ch)
		if err != nil {
			res.Skipped = err.Error()
		}
		out = append(out, res)
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
	}
	return out, nil
}

// Probe 测一条通道的连通性；配置未落盘也能测，好让设置页「先测再存」。
// 送来的掩码会先还原成本机已存的真凭证，否则「只改地址不改密钥」这种编辑必然测不过。
func (m *Manager) Probe(ctx context.Context, cfg Config) error {
	ch, err := Build(m.unmask(ctx, cfg))
	if err != nil {
		return err
	}
	return ch.Probe(ctx)
}

// State 返回某通道的同步水位。
func (m *Manager) State(ctx context.Context, name string) (store.SyncState, error) {
	return m.db.GetSyncState(ctx, name)
}

func (m *Manager) configByName(ctx context.Context, name string) (Config, error) {
	list, err := m.configsRaw(ctx)
	if err != nil {
		return Config{}, err
	}
	for _, c := range list {
		if c.Name == name {
			return c, nil
		}
	}
	return Config{}, fmt.Errorf("sync: 通道 %q 不存在", name)
}
