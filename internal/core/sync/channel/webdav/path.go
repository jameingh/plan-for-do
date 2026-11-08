package webdav

import (
	"fmt"
	"strings"
)

// WebDAV 路径按「原始名字 → 传输用 URL」单向转换：
// 配置里的 path 一律视为未编码的原始路径（中文、空格照写），本包在拼 URL 时
// 恰好编码一次；解析远端 href 时恰好解码一次。绝不对疑似已编码的字符串
// 再跑一遍编码器，因此不存在双重编码（%20 变 %2520）的问题。

// shouldEscape 报告字节 c 在路径段里是否必须 percent-encode。
// 只放行 RFC 3986 unreserved（ALPHA / DIGIT / "-" "." "_" "~"），
// 其余（含 "%"、空格、多字节 UTF-8、保留字符）全部转义，最保守也最安全。
func shouldEscape(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z':
		return false
	case c >= 'A' && c <= 'Z':
		return false
	case c >= '0' && c <= '9':
		return false
	case c == '-' || c == '.' || c == '_' || c == '~':
		return false
	}
	return true
}

const hexUpper = "0123456789ABCDEF"

// escapeSegment 对单个路径段做 percent-encode（UTF-8 逐字节）。
func escapeSegment(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if shouldEscape(c) {
			b.WriteByte('%')
			b.WriteByte(hexUpper[c>>4])
			b.WriteByte(hexUpper[c&0x0f])
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// unescapeSegment 反向解码单个路径段；非法 % 序列报错而不是猜测。
func unescapeSegment(s string) (string, error) {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '%' {
			b.WriteByte(c)
			continue
		}
		if i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2]) {
			return "", fmt.Errorf("webdav: 非法 percent 编码序列: %q", s[i:])
		}
		v := hexVal(s[i+1])<<4 | hexVal(s[i+2])
		b.WriteByte(byte(v))
		i += 2
	}
	return b.String(), nil
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// encodePath 把原始路径（可含多级目录、中文、空格）编码成 URL 路径片段。
// 空段被丢弃；".." 段直接拒绝——同步目录不该向上跳。
func encodePath(p string) (string, error) {
	segs, err := splitRawPath(p)
	if err != nil {
		return "", err
	}
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		out = append(out, escapeSegment(s))
	}
	return strings.Join(out, "/"), nil
}

// decodePath 把 URL 路径片段还原成原始路径。
func decodePath(p string) (string, error) {
	segs := splitHTTPath(p)
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		dec, err := unescapeSegment(s)
		if err != nil {
			return "", err
		}
		out = append(out, dec)
	}
	return strings.Join(out, "/"), nil
}

// splitRawPath 按 "/" 切原始路径，去掉空段与 "."，拒绝 ".."。
func splitRawPath(p string) ([]string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	var out []string
	for _, s := range strings.Split(p, "/") {
		switch s {
		case "", ".":
			continue
		case "..":
			return nil, fmt.Errorf("webdav: 路径不允许向上跳: %q", p)
		}
		out = append(out, s)
	}
	return out, nil
}

// splitHTTPath 按 "/" 切 URL 路径，保留段内容但不解析 "."/".."
// （远端 href 里出现什么段就按什么段解码）。
func splitHTTPath(p string) []string {
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}
