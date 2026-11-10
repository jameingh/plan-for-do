// BrandMark.tsx —— 「功到」标志的共用组件。
//
// 一套身份：桌面图标（build/windows/icon.ico）、左栏头像、个人中心头像、
// 小尺寸方形头像，全部用同一枚「力」标志，不再混用「功」文字与旧蓝色渐变箭头。
//
// 用法：
//   <BrandMark size={32} variant="icon" />  绿底圆角方 + 白标志（应用图标同款）
//   <BrandMark size={32} variant="mark" />  透明底 + 品牌绿标志
//   <BrandMark size={32} variant="tile" />  品牌绿底 + 白标志（紧凑方块，用于小头像）

import markUrl from "../assets/gongdao-mark.svg";
import iconUrl from "../assets/gongdao-icon.svg";

export function BrandMark({
  size,
  variant = "icon",
  className,
}: {
  size: number;
  variant?: "icon" | "mark" | "tile";
  className?: string;
}) {
  if (variant === "mark") {
    return (
      <img
        className={className}
        src={markUrl}
        alt="功到"
        width={size}
        height={size}
        style={{ width: size, height: size, display: "block" }}
      />
    );
  }
  // icon：绿底圆角方（与桌面图标同款）
  // tile：纯方块（32px 以下圆角不可见，方块更实）
  return (
    <img
      className={className}
      src={iconUrl}
      alt="功到"
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block", borderRadius: variant === "tile" ? 6 : 8 }}
    />
  );
}
