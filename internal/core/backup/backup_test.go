package backup

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	"planfordo/internal/core/model"
	"planfordo/internal/core/store"
	"planfordo/internal/core/tclock"
)

func sample() Payload {
	return Payload{
		Records: []store.Entity{
			{Kind: "item", ID: "a", Data: json.RawMessage(`{"title":"写周报"}`), UpdatedAt: tclock.Now()},
			{Kind: "habit", ID: "b", Data: json.RawMessage(`{"name":"晨跑"}`), UpdatedAt: tclock.Now()},
			{Kind: "item", ID: "c", Data: json.RawMessage(`{"title":"已删"}`), DeletedAt: tclock.Now()},
		},
		Attachments: []Attachment{{ID: "f1", Path: "attachments/f1.png", Mime: "image/png", Size: 3, SHA256: "x"}},
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	pw := "correct horse battery"
	file, err := Seal(sample(), pw, "2026-11-08T10:00:00.000Z", "dev-1")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(file, []byte("写周报")) {
		t.Error("明文里能看到标题，说明根本没加密")
	}
	if !bytes.HasPrefix(file, []byte(magic)) {
		t.Error("魔数不对")
	}
	p, h, err := Open(file, pw)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(p.Records) != 3 || p.Records[0].ID != "a" {
		t.Errorf("记录没原样回来：%+v", p.Records)
	}
	if p.Records[2].DeletedAt == "" {
		t.Error("墓碑必须带着走，否则导入后删掉的东西会复活")
	}
	if len(p.Attachments) != 1 || p.Attachments[0].Path == "" {
		t.Errorf("附件元数据丢了：%+v", p.Attachments)
	}
	if h.Version != Version || h.Records != 3 || h.DeviceID != "dev-1" {
		t.Errorf("头部不符：%+v", h)
	}
	if h.Iterations != iterations || h.KDF != kdfName || h.Cipher != cipherName {
		t.Errorf("算法参数没写进头部：%+v", h)
	}
}

// TestWrongPasswordIsNotSilent 是这份格式最要紧的一条：
// 口令错必须报错，绝不能解出一堆乱码当数据用（那会把库写坏）。
func TestWrongPasswordIsNotSilent(t *testing.T) {
	file, err := Seal(sample(), "right passphrase", "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	_, _, err = Open(file, "wrong passphrase")
	if err == nil {
		t.Fatal("错口令居然解开了")
	}
	if !errors.Is(err, ErrWrongPassword) {
		t.Errorf("错误里要能判别出是口令问题，得 %v", err)
	}
}

func TestTamperingIsDetected(t *testing.T) {
	pw := "a decent password"
	base, err := Seal(sample(), pw, "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	cases := []struct {
		name string
		mut  func(b []byte)
	}{
		{"改密文一字节", func(b []byte) { b[len(b)-1] ^= 0x01 }},
		{"改 nonce", func(b []byte) { b[len(magic)+4+headerLen(b)+3] ^= 0x80 }},
		{"改头部（把 records 数改掉）", func(b []byte) {
			i := bytes.Index(b, []byte(`"records":3`))
			if i > 0 {
				b[i+10] = '9'
			}
		}},
		{"抹掉末尾 8 字节（等于被截断）", func(b []byte) { clear(b[len(b)-8:]) }},
	}
	for _, c := range cases {
		b := append([]byte(nil), base...)
		c.mut(b)
		if _, _, err := Open(b, pw); err == nil {
			t.Errorf("%s：改动没被发现", c.name)
		} else if !errors.Is(err, ErrWrongPassword) && !errors.Is(err, ErrFormat) {
			t.Errorf("%s：错误类型不对：%v", c.name, err)
		}
	}
}

func TestFormatAndVersionGuards(t *testing.T) {
	pw := "a decent password"
	file, err := Seal(sample(), pw, "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, _, err := Open([]byte("这不是备份文件"), pw); !errors.Is(err, ErrFormat) {
		t.Errorf("垃圾输入应报 ErrFormat，得 %v", err)
	}
	if _, _, err := Open(file[:len(magic)+4], pw); !errors.Is(err, ErrFormat) {
		t.Errorf("截断文件应报 ErrFormat，得 %v", err)
	}
	// 头部版本号抬高：旧程序必须拒绝，而不是读丢新字段。
	future := append([]byte(nil), file...)
	head := future[len(magic)+4:]
	var h Header
	if err := json.Unmarshal(head[:int(binary.LittleEndian.Uint32(future[len(magic):len(magic)+4]))], &h); err != nil {
		t.Fatalf("读头: %v", err)
	}
	h.Version = Version + 1
	if _, _, err := Open(rebuild(file, h), pw); !errors.Is(err, ErrFutureVersion) {
		t.Errorf("高版本备份应报 ErrFutureVersion，得 %v", err)
	}
	// 算法参数被改：不认识就拒，别拿默认值硬解。
	h2 := h
	h2.Version = Version
	h2.KDF = "scrypt"
	if _, _, err := Open(rebuild(file, h2), pw); !errors.Is(err, ErrFormat) {
		t.Errorf("不认识的 KDF 应报 ErrFormat，得 %v", err)
	}
}

func TestWeakPasswordRejected(t *testing.T) {
	if _, err := Seal(sample(), "1234567", "now", "dev"); !errors.Is(err, ErrWeakPassword) {
		t.Errorf("7 个字符的口令应被拒，得 %v", err)
	}
	if err := CheckPassword("口令口令口令口令"); err != nil {
		t.Errorf("8 个汉字的口令该过，得 %v", err)
	}
	// 空口令尤其危险：那等于「以为是加密备份其实没加密」。
	if _, err := Seal(sample(), "", "now", "dev"); err == nil {
		t.Error("空口令必须被拒")
	}
}

func TestSealIsNotDeterministic(t *testing.T) {
	pw := "a decent password"
	a, _ := Seal(sample(), pw, "now", "dev")
	b, _ := Seal(sample(), pw, "now", "dev")
	if bytes.Equal(a, b) {
		t.Error("同一份内容两次导出字节完全一样：盐或 nonce 没随机，等于把确定性泄露出去")
	}
}

func TestEmptyPayloadStillRoundTrips(t *testing.T) {
	pw := "a decent password"
	file, err := Seal(Payload{}, pw, "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	p, h, err := Open(file, pw)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(p.Records) != 0 || h.Records != 0 {
		t.Errorf("空备份应能正常打开，得 %+v / %+v", p.Records, h)
	}
}

// TestRecordsSurviveRealJSON 用真实的 entity 数据形状走一遍，
// 确认 store.Entity 的 Data（json.RawMessage）没在压缩/编码里变形。
func TestRecordsSurviveRealJSON(t *testing.T) {
	in := Payload{Records: []store.Entity{{
		Kind: "item", ID: "x1", Day: model.Day("2026-11-10"), Sort: 3,
		Data:      json.RawMessage(`{"title":"带中文与 emoji 🎯","note":"引号\"内\""}`),
		UpdatedAt: tclock.Now(),
	}}}
	pw := "a decent password"
	file, err := Seal(in, pw, "now", "dev")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	p, _, err := Open(file, pw)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if string(p.Records[0].Data) != string(in.Records[0].Data) {
		t.Errorf("Data 变形：\n%s\n%s", p.Records[0].Data, in.Records[0].Data)
	}
	if p.Records[0].Day != "2026-11-10" || p.Records[0].Sort != 3 {
		t.Errorf("派生列没带回来：%+v", p.Records[0])
	}
}

// rebuild 用新头部重算长度并拼回一份文件（密文原样留着，让 GCM 去判）。
func rebuild(file []byte, h Header) []byte {
	head := headerBytes(h)
	hlen := int(binary.LittleEndian.Uint32(file[len(magic) : len(magic)+4]))
	off := len(magic) + 4 + hlen
	out := make([]byte, 0, len(file))
	out = append(out, magic...)
	var l [4]byte
	binary.LittleEndian.PutUint32(l[:], uint32(len(head)))
	out = append(out, l[:]...)
	out = append(out, head...)
	return append(out, file[off:]...)
}

func headerLen(b []byte) int {
	return int(binary.LittleEndian.Uint32(b[len(magic) : len(magic)+4]))
}
