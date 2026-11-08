package webdav

import (
	"strings"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []string{
		"plain",
		"my plan/笔记目录",
		"中文 与 空格/sub dir",
		"100%",      // "%" 本身
		"已编码伪装%20",  // 含字面 %20：编码后必须变 %2520，解码回原样
		"a&b=c?d#e", // 保留字符
		"tab\t换行\n", // 控制字符
		`反斜杠\与"引号"`, // 特殊符号
		"emoji 📝",   // 4 字节 UTF-8
		"嵌套/多层/目录/带 空格/中文 名",
	}
	for _, raw := range cases {
		enc, err := encodePath(raw)
		if err != nil {
			t.Fatalf("encodePath(%q): %v", raw, err)
		}
		if strings.ContainsAny(enc, " \t\n\"&?#\\") {
			t.Errorf("编码结果仍含未转义字符 %q <- %q", enc, raw)
		}
		dec, err := decodePath(enc)
		if err != nil {
			t.Fatalf("decodePath(%q): %v", enc, err)
		}
		if dec != strings.ReplaceAll(raw, "\\", "/") && dec != raw {
			t.Errorf("往返不一致: %q -> %q -> %q", raw, enc, dec)
		}
	}
}

func TestEncodeNoDoubleEncoding(t *testing.T) {
	// 原始路径里的字面 "%20" 是名字的一部分（不是编码残留），
	// 恰好编码一次应变 "%2520"；再解回来还是 "%20"。
	enc, err := encodePath("a%20b")
	if err != nil {
		t.Fatal(err)
	}
	if enc != "a%2520b" {
		t.Fatalf("期望 a%%2520b，得到 %q（双重编码或缺失编码）", enc)
	}
	dec, err := decodePath(enc)
	if err != nil || dec != "a%20b" {
		t.Fatalf("decodePath: %q %v", dec, err)
	}
	// 空格与中文的编码形态符合 RFC 3986。
	enc, err = encodePath("同步 目录/x y")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(enc, "%20") || strings.Contains(enc, "+") {
		t.Fatalf("空格编码异常: %q", enc)
	}
}

func TestSplitRawPathRejectsDotDot(t *testing.T) {
	if _, err := splitRawPath("a/../b"); err == nil {
		t.Fatal("含 .. 的路径应被拒绝")
	}
	segs, err := splitRawPath("/a/./b//")
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 || segs[0] != "a" || segs[1] != "b" {
		t.Fatalf("切段错误: %#v", segs)
	}
}

func TestUnescapeRejectsBadSequence(t *testing.T) {
	for _, bad := range []string{"%zz", "%2", "%"} {
		if _, err := unescapeSegment(bad); err == nil {
			t.Errorf("非法序列 %q 应报错", bad)
		}
	}
}
