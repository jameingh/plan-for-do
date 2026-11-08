// Package id 生成可排序的唯一 ID。
//
// ID 由高位的毫秒时间戳（base36）和随机后缀拼成，字典序约等于创建顺序；
// 它不能替代 updated_at 做同步冲突判定。
package id

import (
	"crypto/rand"
	"strconv"
	"strings"
	"time"
)

const digits = "0123456789abcdefghijklmnopqrstuvwxyz"

// New 返回 base36 毫秒时间戳 + "-" + 10 位随机字符。
func New() string {
	var raw [10]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("id: crypto/rand unavailable: " + err.Error())
	}
	suffix := make([]byte, len(raw))
	for i, v := range raw {
		suffix[i] = digits[int(v)%len(digits)]
	}
	return strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + string(suffix)
}

// Timestamp 解析 ID 里的创建时间；无法解析时返回 ok=false。
func Timestamp(raw string) (time.Time, bool) {
	head, _, found := strings.Cut(raw, "-")
	if !found {
		return time.Time{}, false
	}
	ms, err := strconv.ParseInt(head, 36, 64)
	if err != nil || ms <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}

// Valid 校验 ID 形状，用于检查同步通道送来的外部数据。
func Valid(raw string) bool {
	if len(raw) < 12 || len(raw) > 40 {
		return false
	}
	_, ok := Timestamp(raw)
	return ok
}
