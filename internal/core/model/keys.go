package model

// 复合主键：让「同一台设备之外的另一台做了同一件事」落进同一行。
//
// 随机 ID 在这里是有害的：两台设备同一天给同一习惯打卡会生成两条记录，同步后变成双份，
// 统计与「取消打卡」都要出错。确定性键把冲突收敛成一次 LWW 覆盖。

// OverrideID 是一条事项在某天的单日例外（打卡/跳过/顺延）的主键。
func OverrideID(itemID string, day Day) string { return "ovr:" + itemID + ":" + day }

// DailyClockID 是「每天一次」习惯某天打卡记录的主键；每天多次的习惯用随机 ID，
// 因为它一天内允许多条。
func DailyClockID(habitID string, day Day) string { return "clk:" + habitID + ":" + day }

// ClockDayPrefix 用于按习惯+天批量定位记录。
func ClockDayPrefix(habitID string) string { return "clk:" + habitID + ":" }
