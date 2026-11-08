// Package backup 是「与同步通道解耦的一份加密备份」。
//
// 为什么单独做一件事而不是给通道加加密：同步快照要能被多维表格/网盘那侧读懂才有价值
// （见 docs/architecture.md 第 11 节第 5 条），而备份的读者只有自己。
// 一份带口令的文件既能离线躺着，也能随手扔到任何地方，不必担心看到内容。
//
// 格式（一个文件，从头读到尾）：
//
//	"PLANDOBAK1"            10 字节魔数，认文件用，也防把错文件当备份打开
//	uint32 LE              头部 JSON 的字节长度
//	header JSON            算法参数、口令盐、迭代次数、条数、生成时间与设备 ID
//	12 字节 nonce
//	剩余全部               AES-256-GCM(gzip(payload JSON)) 的密文+认证标签
//
// payload 是 {records:[store.Entity…], attachments:[…]}：
// records 含墓碑，所以「删掉的东西」也能一起带过去，不会导入后又复活。
// attachments 默认只带元数据（路径/大小/校验和），带 --with-attachments 才塞字节。
//
// 口令 → 密钥走 PBKDF2-HMAC-SHA256，盐随机、迭代 310000 次（OWASP 2023 对 PBKDF2-SHA256 的建议量级）。
// 认证标签保证「口令错」与「文件被改过」一定报错，不会解出一堆乱码当数据用。
package backup

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"crypto/pbkdf2"

	"planfordo/internal/core/store"
)

// Version 是容器格式版本。读到更高的版本就拒绝——旧程序看不懂新字段，
// 硬读只会把数据读丢。
const Version = 1

const magic = "PLANDOBAK1"

// iterations 是 PBKDF2 的轮数。写进头部，所以以后调高参数也不会打不开老文件。
const iterations = 310_000

const (
	kdfName    = "pbkdf2-sha256"
	cipherName = "aes-256-gcm"
	saltSize   = 16
	nonceSize  = 12
	keySize    = 32
)

// 三类错误分开，界面才能给出不同的话术：
// 口令错是「再试一次」，文件坏是「换一份备份」，版本高是「升级程序」。
var (
	ErrWrongPassword = errors.New("backup: 口令不对（或这份文件不是这个口令导出的）")
	ErrFormat        = errors.New("backup: 文件不是功到的加密备份，或已被截断/改动")
	ErrFutureVersion = errors.New("backup: 这份备份由更高版本的程序导出，请先升级")
	ErrWeakPassword  = errors.New("backup: 口令太短，至少 8 个字符")
)

// Header 是明文头部（只有算法参数与统计，不含任何用户内容）。
type Header struct {
	Version         int    `json:"version"`
	KDF             string `json:"kdf"`
	Cipher          string `json:"cipher"`
	Salt            []byte `json:"salt"`
	Iterations      int    `json:"iterations"`
	CreatedAt       string `json:"createdAt"`
	DeviceID        string `json:"deviceId"`
	Records         int    `json:"records"`
	Attachments     int    `json:"attachments"`
	WithAttachments bool   `json:"withAttachments"`
}

// Attachment 是一条附件。DataBase64 只在带字节导出时非空。
type Attachment struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Mime       string `json:"mime"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	DataBase64 string `json:"dataBase64,omitempty"`
}

// Payload 是解密之后的内容。
type Payload struct {
	Records     []store.Entity `json:"records"`
	Attachments []Attachment   `json:"attachments,omitempty"`
}

// CheckPassword 只做强度检查。口令永远不进日志、不进文件名、也不进头部。
func CheckPassword(pw string) error {
	if utf8.RuneCountInString(pw) < 8 {
		return ErrWeakPassword
	}
	return nil
}

// Seal 把 payload 压成一份加密文件字节。
func Seal(payload Payload, password, createdAt, deviceID string) ([]byte, error) {
	if err := CheckPassword(password); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("backup: 序列化内容: %w", err)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Name = "payload.json"
	if _, err := zw.Write(raw); err != nil {
		return nil, fmt.Errorf("backup: 压缩: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("backup: 收尾压缩: %w", err)
	}

	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("backup: 取随机盐: %w", err)
	}
	key, err := deriveKey(password, salt)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("backup: 取随机 nonce: %w", err)
	}
	// 头部作为「附加认证数据」一起进 GCM：改一个字节（比如把 version 调低、
	// 把 withAttachments 改成 false）都会让解密失败，而不是解出一份被降级内容。
	aad := headerBytes(Header{
		Version: Version, KDF: kdfName, Cipher: cipherName, Salt: salt, Iterations: iterations,
		CreatedAt: createdAt, DeviceID: deviceID,
		Records: len(payload.Records), Attachments: len(payload.Attachments),
		WithAttachments: true,
	})
	body := gcm.Seal(nil, nonce, gz.Bytes(), aad)

	out := make([]byte, 0, len(magic)+4+len(aad)+len(nonce)+len(body))
	out = append(out, magic...)
	var l [4]byte
	binary.LittleEndian.PutUint32(l[:], uint32(len(aad)))
	out = append(out, l[:]...)
	out = append(out, aad...)
	out = append(out, nonce...)
	return append(out, body...), nil
}

// Open 解一份加密文件。口令错、文件被改、版本过高都会返回对应的错误。
func Open(file []byte, password string) (Payload, Header, error) {
	var zero Payload
	if len(file) < len(magic)+4 || string(file[:len(magic)]) != magic {
		return zero, Header{}, ErrFormat
	}
	hlen := int(binary.LittleEndian.Uint32(file[len(magic) : len(magic)+4]))
	rest := file[len(magic)+4:]
	if hlen <= 0 || len(rest) < hlen+nonceSize {
		return zero, Header{}, ErrFormat
	}
	headJSON := rest[:hlen]
	nonce := rest[hlen : hlen+nonceSize]
	body := rest[hlen+nonceSize:]

	var h Header
	if err := json.Unmarshal(headJSON, &h); err != nil {
		return zero, h, fmt.Errorf("%w: 头部解析失败", ErrFormat)
	}
	if h.Version > Version {
		return zero, h, fmt.Errorf("%w（文件 %d > 本机 %d）", ErrFutureVersion, h.Version, Version)
	}
	if h.KDF != kdfName || h.Cipher != cipherName || len(h.Salt) != saltSize || h.Iterations <= 0 {
		return zero, h, fmt.Errorf("%w: 算法参数不认识（%s/%s）", ErrFormat, h.KDF, h.Cipher)
	}
	key, err := deriveKeyWith(password, h.Salt, h.Iterations)
	if err != nil {
		return zero, h, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return zero, h, err
	}
	plain, err := gcm.Open(nil, nonce, body, headJSON)
	if err != nil {
		// GCM 认证失败只有两种可能：口令不对，或者字节被动过。
		// 这里统一按口令不对报（更常见的情况），但保留 ErrFormat 作为可判别的另一半。
		return zero, h, fmt.Errorf("%w（也可能是文件被改动：%w）", ErrWrongPassword, ErrFormat)
	}
	zr, err := gzip.NewReader(bytes.NewReader(plain))
	if err != nil {
		return zero, h, fmt.Errorf("%w: 解压失败", ErrFormat)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return zero, h, fmt.Errorf("%w: 读取解压流", ErrFormat)
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return zero, h, fmt.Errorf("%w: 内容解析失败", ErrFormat)
	}
	if p.Records == nil {
		p.Records = []store.Entity{}
	}
	return p, h, nil
}

func deriveKey(password string, salt []byte) ([]byte, error) {
	return deriveKeyWith(password, salt, iterations)
}

func deriveKeyWith(password string, salt []byte, iters int) ([]byte, error) {
	key, err := pbkdf2.Key(sha256.New, password, salt, iters, keySize)
	if err != nil {
		return nil, fmt.Errorf("backup: 派生密钥: %w", err)
	}
	return key, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("backup: 建 AES: %w", err)
	}
	return cipher.NewGCM(block)
}

func headerBytes(h Header) []byte {
	raw, err := json.Marshal(h)
	if err != nil {
		// 头部字段全是可序列化的标量，走到这里属于编程错误
		panic("backup: 头部序列化失败: " + err.Error())
	}
	return raw
}

// Fingerprint 给一份文件的短校验串（口令无关），CLI 与界面显示用。
func Fingerprint(file []byte) string {
	sum := sha256.Sum256(file)
	return fmt.Sprintf("%x", sum[:6])
}
