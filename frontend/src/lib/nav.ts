// nav.ts —— 清单本 / 分类 / 标签三份「元数据」的共享读取。
//
// 清单页、视图页、四象限都要这三份数据来画色点、标签和下拉；以前各页自己写一遍
// `Promise.all([Lists, Categories, Labels])` + 一个 dead 标志，抄三次就会漂。
// 抽成一个 hook，失败时留空数组而不是抛错——元数据读不到不该让整页白屏。

import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Category, Label, PlList } from "../api/types";

export interface Nav {
  lists: PlList[];
  categories: Category[];
  labels: Label[];
}

const EMPTY: Nav = { lists: [], categories: [], labels: [] };

/** booted 之后取一次，revision（内核 data:changed）递增时重取。 */
export function useNav(booted: boolean, revision: number): Nav {
  const [nav, setNav] = useState<Nav>(EMPTY);
  useEffect(() => {
    if (!booted) return;
    let dead = false;
    Promise.all([api.Lists(), api.Categories(), api.Labels()])
      .then(([lists, categories, labels]) => !dead && setNav({ lists, categories, labels }))
      .catch(() => undefined);
    return () => { dead = true; };
  }, [booted, revision]);
  return nav;
}
