package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"planfordo/internal/core/store"
	"planfordo/internal/core/sync"
)

// DefaultTablePrefix 把本应用的数据表和多维表格里的用户自建表隔开：
// 通道只认这个前缀打头的表，别的表一律不碰。
const DefaultTablePrefix = "pf_"

// metaSuffix 是存放快照元信息（revision / deviceId / syncedAt）的表后缀。
// store 的 kind 枚举里没有 "meta"，pf_meta 不可能和实体表撞名。
const (
	metaSuffix = "meta"
	metaRowID  = "meta"
)

// bitable 字段类型枚举（官方文档）：1=文本，2=数字。
const (
	fieldTypeText   = 1
	fieldTypeNumber = 2
)

// basePageSize / baseBatchSize 留成变量方便测试压低到个位数验证分页与分批。
var (
	basePageSize  = 500 // records 单页官方上限
	baseBatchSize = 100 // 批量接口单请求行数，压小降低触发全局限流的概率
)

// baseColumns 是实体表的固定列。payload 是整条记录 JSON 的权威副本；
// 其余列（含 title）只是给人看的镜像。
var baseColumns = []struct {
	Name string
	Type int
}{
	{"id", fieldTypeText},
	{"kind", fieldTypeText},
	{"updated_at", fieldTypeText},
	{"deleted_at", fieldTypeText},
	{"day", fieldTypeText},
	{"parent", fieldTypeText},
	{"status", fieldTypeNumber},
	{"sort", fieldTypeNumber},
	{"payload", fieldTypeText},
	{"title", fieldTypeText},
}

// Base 把全量记录铺在飞书多维表格里：每个 kind 一张数据表，表名 = 前缀 + kind
// （例如 pf_item、pf_habitClock），另有一张 pf_meta 存同步水位。
//
// 第一版是单向权威：本地库是唯一真相源，飞书表里的 title 等可读列只是镜像。
// 用户在飞书表格里手改可读列不会回流到本地——Load 只认 payload 列，
// 下一次 Save 会把改动的内容重新覆盖成镜像。在改掉这个结论之前，
// 不要把飞书表格当编辑入口向用户开放。
//
// 附件字节：Base **明确不支持** sync.BlobChannel，也不打算在这条通道上补。
// 多维表格没有「整块二进制对象」语义，只有一行行的文本/数字列：把 base64
// 塞进文本列会撞单元格长度上限，拆成多行又得自己维护序号与重组，等于在表格里
// 重造一个文件系统。需要跨设备带图片请改用 feishuDrive / WebDAV / localdir，
// 或用「连附件一起导出」的备份文件。引擎遇到不实现 BlobChannel 的通道会跳过
// 字节搬运，只同步附件元数据，并在 Result.BlobsSkipped 里写明原因。
type Base struct {
	name     string
	cli      *apiClient
	appToken string
	prefix   string
}

func newBase(name string, opts map[string]string) (sync.Channel, error) {
	cli, err := newClient(opts)
	if err != nil {
		return nil, err
	}
	app := trim(opts["appToken"])
	if app == "" {
		return nil, errors.New("feishu: feishuBase 通道需要 options.appToken（多维表格 URL 里的 app_token）")
	}
	prefix := trim(opts["tablePrefix"])
	if prefix == "" {
		prefix = DefaultTablePrefix
	}
	return &Base{name: name, cli: cli, appToken: app, prefix: prefix}, nil
}

// Name 返回通道名。
func (b *Base) Name() string { return b.name }

// Kind 返回通道类型。
func (b *Base) Kind() string { return "feishuBase" }

func (b *Base) metaTable() string { return b.prefix + metaSuffix }

// Probe 确认 token 可取、多维表格可读。还没有任何数据表也算通过——
// 建表建列是 Save 的职责，首轮同步前表本来就不该存在。
func (b *Base) Probe(ctx context.Context) error {
	_, err := b.listTables(ctx)
	return err
}

type baseTable struct {
	ID   string `json:"table_id"`
	Name string `json:"name"`
}

// listTables 分页拉全部数据表。漏表意味着 Load 少读实体或 Save 重复建表，
// 所以拿不到下一页游标时必须报错而不是收工。
func (b *Base) listTables(ctx context.Context) ([]baseTable, error) {
	var out []baseTable
	token := ""
	for {
		q := url.Values{"page_size": {"100"}}
		if token != "" {
			q.Set("page_token", token)
		}
		var resp struct {
			Items     []baseTable `json:"items"`
			HasMore   bool        `json:"has_more"`
			PageToken string      `json:"page_token"`
		}
		if err := b.cli.call(ctx, http.MethodGet, fmt.Sprintf(pathBaseTables, b.appToken), q, nil, &resp); err != nil {
			return nil, err
		}
		out = append(out, resp.Items...)
		if !resp.HasMore {
			return out, nil
		}
		if resp.PageToken == "" {
			return nil, errors.New("feishu: 数据表列表 has_more 为真但没有 page_token，中断以避免漏表")
		}
		token = resp.PageToken
	}
}

type baseRecord struct {
	RecordID string         `json:"record_id"`
	Fields   map[string]any `json:"fields"`
}

// allRecords 按 page_token 翻全表；一页最多 basePageSize 条。
func (b *Base) allRecords(ctx context.Context, tableID string) ([]baseRecord, error) {
	var out []baseRecord
	token := ""
	for {
		q := url.Values{"page_size": {strconv.Itoa(basePageSize)}}
		if token != "" {
			q.Set("page_token", token)
		}
		var resp struct {
			Items     []baseRecord `json:"items"`
			HasMore   bool         `json:"has_more"`
			PageToken string       `json:"page_token"`
		}
		if err := b.cli.call(ctx, http.MethodGet, fmt.Sprintf(pathBaseRecords, b.appToken, tableID), q, nil, &resp); err != nil {
			return nil, err
		}
		out = append(out, resp.Items...)
		if !resp.HasMore {
			return out, nil
		}
		if resp.PageToken == "" {
			return nil, errors.New("feishu: records 列表 has_more 为真但没有 page_token，中断以避免只拉到半截记录")
		}
		token = resp.PageToken
	}
}

// ensureTable 返回数据表 ID。表不存在时带着全套列一次建好；
// 表存在但缺列（比如老版本通道建的）时补齐缺列。
func (b *Base) ensureTable(ctx context.Context, name string) (string, error) {
	tables, err := b.listTables(ctx)
	if err != nil {
		return "", err
	}
	for _, tb := range tables {
		if tb.Name == name {
			if err := b.ensureColumns(ctx, tb.ID); err != nil {
				return "", err
			}
			return tb.ID, nil
		}
	}
	return b.createTable(ctx, name)
}

type baseFieldSpec struct {
	FieldName string `json:"field_name"`
	Type      int    `json:"type"`
}

func (b *Base) createTable(ctx context.Context, name string) (string, error) {
	specs := make([]baseFieldSpec, 0, len(baseColumns))
	for _, c := range baseColumns {
		specs = append(specs, baseFieldSpec{FieldName: c.Name, Type: c.Type})
	}
	var out struct {
		TableID string `json:"table_id"`
		Table   struct {
			TableID string `json:"table_id"`
		} `json:"table"`
	}
	err := b.cli.call(ctx, http.MethodPost, fmt.Sprintf(pathBaseTables, b.appToken), nil,
		map[string]any{"table": map[string]any{"name": name, "fields": specs}}, &out)
	if err != nil {
		return "", err
	}
	if out.TableID != "" {
		return out.TableID, nil
	}
	if out.Table.TableID != "" {
		// 有的版本把响应再包一层 table；形状存疑（见 README），两种都认。
		return out.Table.TableID, nil
	}
	// 兜底：重列一遍按名字找，建表本身已经成功了，别让响应形状卡死同步。
	tables, err := b.listTables(ctx)
	if err != nil {
		return "", err
	}
	for _, tb := range tables {
		if tb.Name == name {
			return tb.ID, nil
		}
	}
	return "", fmt.Errorf("feishu: 建表 %s 的响应里解析不出 table_id，接口形状存疑（见 README）", name)
}

func (b *Base) ensureColumns(ctx context.Context, tableID string) error {
	have := map[string]bool{}
	token := ""
	for {
		q := url.Values{"page_size": {"100"}}
		if token != "" {
			q.Set("page_token", token)
		}
		var resp struct {
			Items []struct {
				FieldName string `json:"field_name"`
			} `json:"items"`
			HasMore   bool   `json:"has_more"`
			PageToken string `json:"page_token"`
		}
		if err := b.cli.call(ctx, http.MethodGet, fmt.Sprintf(pathBaseFields, b.appToken, tableID), q, nil, &resp); err != nil {
			return err
		}
		for _, f := range resp.Items {
			have[f.FieldName] = true
		}
		if !resp.HasMore {
			break
		}
		if resp.PageToken == "" {
			return errors.New("feishu: 字段列表 has_more 为真但没有 page_token，中断以免把已有列误判成缺列")
		}
		token = resp.PageToken
	}
	for _, c := range baseColumns {
		if have[c.Name] {
			continue
		}
		if err := b.cli.call(ctx, http.MethodPost, fmt.Sprintf(pathBaseFields, b.appToken, tableID), nil,
			map[string]any{"field_name": c.Name, "type": c.Type}, nil); err != nil {
			return fmt.Errorf("feishu: 给数据表 %s 补列 %s 失败: %w", tableID, c.Name, err)
		}
	}
	return nil
}

// Load 列出所有前缀表 → 分页拉记录 → 还原实体。以 payload 列为权威：
// 可读列被人在飞书里改坏也不影响还原结果，下一次 Save 会把镜像改回来。
//
// 遇到没有 payload 或 payload 解析不了的行必须报错而不是跳过：静默丢行会让
// 下一轮 Save 把「快照里没有」解读成「该删」，把远端仅有的数据抹掉。
func (b *Base) Load(ctx context.Context) (*sync.Snapshot, error) {
	tables, err := b.listTables(ctx)
	if err != nil {
		return nil, err
	}
	out := &sync.Snapshot{Schema: sync.SchemaVersion, Records: []store.Entity{}}
	for _, tb := range tables {
		if !strings.HasPrefix(tb.Name, b.prefix) {
			continue
		}
		if tb.Name == b.metaTable() {
			meta, err := b.loadMeta(ctx, tb.ID)
			if err != nil {
				return nil, err
			}
			if meta != nil {
				out.Schema = meta.Schema
				out.DeviceID = meta.DeviceID
				out.SyncedAt = meta.SyncedAt
				out.Revision = meta.Revision
			}
			continue
		}
		recs, err := b.allRecords(ctx, tb.ID)
		if err != nil {
			return nil, err
		}
		for _, r := range recs {
			payload := fieldText(r.Fields["payload"])
			if payload == "" {
				return nil, fmt.Errorf("feishu: 数据表 %s 有缺 payload 的行（record %s），请删除手工添加的行后再同步", tb.Name, r.RecordID)
			}
			var e store.Entity
			if err := json.Unmarshal([]byte(payload), &e); err != nil {
				return nil, fmt.Errorf("feishu: 数据表 %s 的 payload 解析失败: %w", tb.Name, err)
			}
			if e.Kind == "" || e.ID == "" {
				return nil, fmt.Errorf("feishu: 数据表 %s 的 payload 缺 kind/id", tb.Name)
			}
			out.Records = append(out.Records, e)
		}
	}
	sort.Slice(out.Records, func(i, j int) bool {
		if out.Records[i].Kind != out.Records[j].Kind {
			return out.Records[i].Kind < out.Records[j].Kind
		}
		return out.Records[i].ID < out.Records[j].ID
	})
	return out, nil
}

// loadMeta 读同步水位行；表不存在或还没写过水位时返回 nil（等同首轮起步）。
func (b *Base) loadMeta(ctx context.Context, tableID string) (*sync.Snapshot, error) {
	recs, err := b.allRecords(ctx, tableID)
	if err != nil {
		return nil, err
	}
	for _, r := range recs {
		if fieldText(r.Fields["id"]) != metaRowID {
			continue // 多余的行是人为误加，交给下一次 Save 删除，不该卡住读取
		}
		payload := fieldText(r.Fields["payload"])
		if payload == "" {
			return nil, errors.New("feishu: pf_meta 的水位行缺 payload")
		}
		// 借 ParseSnapshot 顺带校验协议版本：远端版本更高时拒绝继续。
		return sync.ParseSnapshot([]byte(payload))
	}
	return nil, nil
}

// Save 按 (表, id) upsert 全量记录，并删掉远端多出来的行。
// 表不存在时自动建表建列。写序是「先建表写入、后删多余行、最后写水位」：
// 中途失败远端只会是超集，多出的行下一轮 Save 会删净；反过来可能删掉
// 本轮还没写进去的记录。任何一步失败都返回错误，由引擎重跑一轮。
func (b *Base) Save(ctx context.Context, s *sync.Snapshot) error {
	if s == nil {
		return errors.New("feishu: 快照为空")
	}
	byKind := map[string][]store.Entity{}
	for _, e := range s.Records {
		if e.Kind == "" || e.ID == "" {
			return fmt.Errorf("feishu: 快照里有缺 kind/id 的记录（kind=%q id=%q）", e.Kind, e.ID)
		}
		byKind[e.Kind] = append(byKind[e.Kind], e)
	}
	for _, kind := range sortedKeys(byKind) {
		if err := b.saveKind(ctx, kind, byKind[kind]); err != nil {
			return err
		}
	}
	return b.saveMeta(ctx, s)
}

func (b *Base) saveKind(ctx context.Context, kind string, recs []store.Entity) error {
	tableID, err := b.ensureTable(ctx, b.prefix+kind)
	if err != nil {
		return err
	}
	existing, err := b.allRecords(ctx, tableID)
	if err != nil {
		return err
	}
	type rowRef struct {
		recordID string
		payload  string
	}
	current := map[string]rowRef{}
	var orphans []string
	for _, r := range existing {
		if r.RecordID == "" {
			continue
		}
		// id 列理论上必有；万一被清空就用 payload 兜底，和 Load 的权威顺序一致。
		id := fieldText(r.Fields["id"])
		if id == "" {
			var e store.Entity
			if p := fieldText(r.Fields["payload"]); p != "" {
				_ = json.Unmarshal([]byte(p), &e)
			}
			id = e.ID
		}
		if id == "" {
			orphans = append(orphans, r.RecordID)
			continue
		}
		if dup, ok := current[id]; ok {
			orphans = append(orphans, dup.recordID) // 同一记录出现重复行时只保留一条
		}
		current[id] = rowRef{recordID: r.RecordID, payload: fieldText(r.Fields["payload"])}
	}
	wanted := make(map[string]bool, len(recs))
	var creates, updates []any
	for _, e := range recs {
		fields, payload, err := entityFields(e)
		if err != nil {
			return err
		}
		wanted[e.ID] = true
		cur, ok := current[e.ID]
		switch {
		case !ok:
			creates = append(creates, map[string]any{"fields": fields})
		case cur.payload != payload:
			// payload 一致的行不动：引擎每轮都推全量，只改写真正变过的行才省得出限流额度。
			updates = append(updates, map[string]any{"record_id": cur.recordID, "fields": fields})
		}
	}
	var deletes []string
	for id, cur := range current {
		if !wanted[id] {
			deletes = append(deletes, cur.recordID)
		}
	}
	deletes = append(deletes, orphans...)
	sort.Strings(deletes) // record_id 本身随机，排序让请求体确定、失败现场可复现

	if err := b.postRecords(ctx, pathBaseBatchCreate, tableID, creates); err != nil {
		return err
	}
	if err := b.postRecords(ctx, pathBaseBatchUpdate, tableID, updates); err != nil {
		return err
	}
	if len(deletes) > 0 {
		items := make([]any, 0, len(deletes))
		for _, id := range deletes {
			items = append(items, id)
		}
		if err := b.postRecords(ctx, pathBaseBatchDelete, tableID, items); err != nil {
			return err
		}
	}
	return nil
}

func (b *Base) saveMeta(ctx context.Context, s *sync.Snapshot) error {
	tableID, err := b.ensureTable(ctx, b.metaTable())
	if err != nil {
		return err
	}
	meta := sync.Snapshot{
		Schema: s.Schema, DeviceID: s.DeviceID, SyncedAt: s.SyncedAt,
		Revision: s.Revision, Records: []store.Entity{},
	}
	raw, err := meta.Bytes()
	if err != nil {
		return err
	}
	fields := map[string]any{
		"id": metaRowID, "kind": metaSuffix, "payload": string(raw),
		"title": "planfordo 水位 " + strconv.FormatInt(s.Revision, 10),
	}
	recs, err := b.allRecords(ctx, tableID)
	if err != nil {
		return err
	}
	var keep map[string]any
	var deletes []string
	for _, r := range recs {
		if keep == nil && fieldText(r.Fields["id"]) == metaRowID && r.RecordID != "" {
			keep = map[string]any{"record_id": r.RecordID, "fields": fields}
			continue
		}
		if r.RecordID != "" {
			deletes = append(deletes, r.RecordID)
		}
	}
	if keep == nil {
		err = b.postRecords(ctx, pathBaseBatchCreate, tableID, []any{map[string]any{"fields": fields}})
	} else {
		err = b.postRecords(ctx, pathBaseBatchUpdate, tableID, []any{keep})
	}
	if err != nil {
		return err
	}
	sort.Strings(deletes)
	items := make([]any, 0, len(deletes))
	for _, id := range deletes {
		items = append(items, id)
	}
	return b.postRecords(ctx, pathBaseBatchDelete, tableID, items)
}

// postRecords 按 baseBatchSize 切小批发给 bitable 批量接口：
// 批量端点有行数上限，单请求太大也更容易撞全局限流。
func (b *Base) postRecords(ctx context.Context, tmpl, tableID string, records []any) error {
	if len(records) == 0 {
		return nil
	}
	path := fmt.Sprintf(tmpl, b.appToken, tableID)
	for start := 0; start < len(records); start += baseBatchSize {
		end := min(start+baseBatchSize, len(records))
		if err := b.cli.call(ctx, http.MethodPost, path, nil, map[string]any{"records": records[start:end]}, nil); err != nil {
			return fmt.Errorf("feishu: 数据表 %s 批量写入失败，本轮中止（引擎下一轮重推全量）: %w", tableID, err)
		}
	}
	return nil
}

func entityFields(e store.Entity) (map[string]any, string, error) {
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, "", fmt.Errorf("feishu: 序列化 %s/%s 失败: %w", e.Kind, e.ID, err)
	}
	return map[string]any{
		"id":         e.ID,
		"kind":       e.Kind,
		"updated_at": e.UpdatedAt,
		"deleted_at": e.DeletedAt,
		"day":        e.Day,
		"parent":     e.Parent,
		"status":     e.Status,
		"sort":       e.Sort,
		"payload":    string(raw),
		"title":      readableTitle(e.Data),
	}, string(raw), nil
}

// readableTitle 从记录 JSON 里取 title 或 name 作人工浏览列；取不到留空。
// 留空比硬凑一个占位文案好，浏览的人至少不会误以为那是内容。
func readableTitle(data json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	for _, key := range []string{"title", "name"} {
		if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// fieldText 把 records 单元格读成字符串。文本列通常是纯字符串，但按列类型设置
// 不同也可能返回富文本段数组或链接对象；payload 是权威来源，这几种形状都还原得出来。
func fieldText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case []any:
		var sb strings.Builder
		for _, seg := range t {
			if m, ok := seg.(map[string]any); ok {
				sb.WriteString(fieldText(m["text"]))
				continue
			}
			sb.WriteString(fieldText(seg))
		}
		return sb.String()
	case map[string]any:
		return fieldText(t["text"])
	default:
		return fmt.Sprint(t)
	}
}
