// 备忘录的内核镜像实现（mock 后端用）。
//
// 这份文件的存在意义只有一个：浏览器里 `npm run dev`（没有 Wails 壳）时，
// 备忘录页要能跑出与真内核**逐条一致**的行为，界面自检才不会被假数据骗。
// 规则改动必须同步改 internal/core/service/memo.go，两边对不上时以 Go 为准。
import type {
  Attachment,
  ClockTime,
  Memo,
  MemoFileKind,
  MemoFolder,
  MemoInput,
  MemoItem,
  MemoRequest,
  MemoSort,
  MemoStats,
} from "./types";

export const MAX_MEMO_FOLDER_NAME = 6;
const PREVIEW_RUNES = 2000;

type MemoDB = { memoFolders: MemoFolder[]; memos: Memo[] };

export function memoPlainText(h: string): string {
  const withBreaks = h.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)\s*\/?>/gi, "\n");
  return withBreaks
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function memoPreview(h: string): string {
  const s = memoPlainText(h).replace(/[\s ]+/g, " ").trim();
  return s.length > PREVIEW_RUNES ? s.slice(0, PREVIEW_RUNES) : s;
}

export function memoHasContent(h: string): boolean {
  return memoPreview(h).trim() !== "";
}

/** 与 Go 侧 MemoList 同一条排序：置顶永远在前，其余按创建/修改时间倒序；回收站按删除时间倒序。 */
function sortMemos(list: MemoItem[], sort: MemoSort, showDeleted: boolean, pinnedFirst: boolean): MemoItem[] {
  // 回收站按创建时间倒序；搜索时丢掉置顶优先级——两条都和参考站的比较器一致
  const key = (m: Memo) => (sort === 1 && !showDeleted ? m.updatedAt : m.createdAt);
  return list.sort((a, b) => {
    if (pinnedFirst && a.memo.isTop !== b.memo.isTop) return a.memo.isTop ? -1 : 1;
    const ka = key(a.memo), kb = key(b.memo);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.memo.id < b.memo.id ? -1 : 1;
  });
}

export function createMemoAPI(
  db: MemoDB,
  helpers: {
    call: <T>(fn: () => T) => Promise<T>;
    now: () => ClockTime;
    newID: () => string;
    emit: (what: string) => void;
    err: (m: string) => Error;
  },
) {
  const { call, now, newID, emit, err } = helpers;
  const touch = (m: Memo, at: string) => { m.updatedAt = at; };
  const find = (id: string): Memo => {
    const m = db.memos.find((x) => x.id === id);
    if (!m) throw err(`service: 对象不存在: memo ${id}`);
    return m;
  };

  return {
    MemoFolders: () =>
      call<MemoFolder[]>(() =>
        [...db.memoFolders].sort((a, b) => (a.sort !== b.sort ? a.sort - b.sort : a.id < b.id ? -1 : 1))),

    SaveMemoFolder: (input: { id?: string; name: string; sort?: number }) =>
      call<MemoFolder>(() => {
        const name = (input.name || "").trim();
        if (!name) throw err("service: 文件夹名不能为空");
        const cut = name.length > MAX_MEMO_FOLDER_NAME ? name.slice(0, MAX_MEMO_FOLDER_NAME) : name;
        const at = now();
        if (input.id) {
          const f = db.memoFolders.find((x) => x.id === input.id);
          if (!f) throw err(`service: 对象不存在: memoFolder ${input.id}`);
          f.name = cut;
          if (input.sort && input.sort > 0) f.sort = input.sort;
          f.updatedAt = at;
          emit("memoFolder");
          return f;
        }
        const f: MemoFolder = { id: newID(), name: cut, sort: input.sort || db.memoFolders.length, createdAt: at, updatedAt: at };
        db.memoFolders.push(f);
        emit("memoFolder");
        return f;
      }),

    // 删文件夹：其下备忘录一起进回收站（与 Go 侧 DeleteMemoFolder 一致）。
    DeleteMemoFolder: (folderID: string) =>
      call<number>(() => {
        const at = now();
        let n = 0;
        if (folderID) {
          for (const m of db.memos) {
            if (m.folderId !== folderID || m.trashedAt) continue;
            m.trashedAt = at;
            n++;
          }
        }
        db.memoFolders = db.memoFolders.filter((f) => f.id !== folderID);
        emit("memoFolder");
        return n;
      }),

    ReorderMemoFolders: (orderedIDs: string[]) =>
      call<void>(() => {
        const at = now();
        orderedIDs.forEach((id, i) => {
          const f = db.memoFolders.find((x) => x.id === id);
          if (f) { f.sort = i; f.updatedAt = at; }
        });
        emit("memoFolder");
      }),

    MemoList: (req: MemoRequest) =>
      call<MemoItem[]>(() => {
        const word = (req.search || "").trim().toLowerCase();
        const out: MemoItem[] = [];
        for (const m of db.memos) {
          if (req.showDeleted ? !m.trashedAt : !!m.trashedAt) continue;
          if (!req.showDeleted && req.folderId && m.folderId !== req.folderId) continue;
          const preview = memoPreview(m.html);
          if (word) {
            const hay = `${m.title}\n${preview}\n${memoPlainText(m.html)}`.toLowerCase();
            if (!hay.includes(word)) continue;
          }
          out.push({ memo: m, preview });
        }
        return sortMemos(out, req.sort ?? 0, !!req.showDeleted, !word);
      }),

    Memo: (memoID: string) => call<Memo>(() => find(memoID)),

    CreateMemo: (folderID: string) =>
      call<Memo>(() => {
        const at = now();
        const m: Memo = {
          id: newID(), folderId: folderID || "", title: "", html: "", backImage: "",
          fileType: -1 as MemoFileKind, fileId: "", isTop: false, createdAt: at, updatedAt: at,
        };
        db.memos.push(m);
        emit("memo");
        return m;
      }),

    SaveMemo: (input: MemoInput) =>
      call<Memo>(() => {
        const at = now();
        let m: Memo;
        if (input.id) {
          m = find(input.id);
        } else {
          m = {
            id: newID(), folderId: "", title: "", html: "", backImage: "",
            fileType: -1 as MemoFileKind, fileId: "", isTop: false, createdAt: at, updatedAt: at,
          };
          db.memos.push(m);
        }
        m.title = (input.title || "").trim();
        m.html = input.html || "";
        m.backImage = input.backImage || "";
        m.folderId = input.folderId || "";
        if (input.fileType >= 0) { m.fileType = input.fileType; m.fileId = input.fileId || ""; }
        touch(m, at);
        emit("memo");
        return m;
      }),

    SetMemoTop: (memoID: string, top: boolean) =>
      call<void>(() => {
        const m = find(memoID);
        if (m.isTop === top) return;
        m.isTop = top;
        touch(m, now());
        emit("memo");
      }),

    MoveMemoFolders: (memoIDs: string[], folderID: string) =>
      call<number>(() => {
        const at = now();
        let n = 0;
        for (const id of memoIDs) {
          const m = db.memos.find((x) => x.id === id);
          if (!m) continue;
          m.folderId = folderID || "";
          touch(m, at);
          n++;
        }
        emit("memo");
        return n;
      }),

    TrashMemos: (memoIDs: string[]) =>
      call<number>(() => {
        const at = now();
        let n = 0;
        for (const id of memoIDs) {
          const m = db.memos.find((x) => x.id === id);
          if (!m || m.trashedAt) continue; // 重复删除不计数，与 Go 一致
          m.trashedAt = at;
          n++;
        }
        emit("memo");
        return n;
      }),

    RestoreMemos: (memoIDs: string[]) =>
      call<number>(() => {
        const at = now();
        let n = 0;
        for (const id of memoIDs) {
          const m = db.memos.find((x) => x.id === id);
          if (!m || !m.trashedAt) continue;
          m.trashedAt = "";
          touch(m, at);
          n++;
        }
        emit("memo");
        return n;
      }),

    PurgeMemos: (memoIDs: string[]) =>
      call<number>(() => {
        let n = 0;
        for (const id of memoIDs) {
          const i = db.memos.findIndex((x) => x.id === id);
          if (i < 0) continue;
          db.memos.splice(i, 1);
          n++;
        }
        emit("memo");
        return n;
      }),

    MemoStats: () =>
      call<MemoStats>(() => {
        const s: MemoStats = { total: 0, trashed: 0 };
        for (const m of db.memos) {
          if (m.trashedAt) s.trashed++; else s.total++;
        }
        return s;
      }),

    // 浏览器没有 dataDir，path 直接放 data: URL（与事项图片同一套做法）。
    AddMemoFile: (memoID: string, name: string, dataBase64: string) =>
      call<[Attachment, number]>(() => {
        const raw = `data:application/octet-stream;base64,${dataBase64}`;
        if (dataBase64.length * 0.75 > 50 * 1024 * 1024) throw err("附件大小超过50M");
        const ext = (name.includes(".") ? name.split(".").pop() || "" : "").toLowerCase();
        const kind: MemoFileKind = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext) ? 0
          : ["mp4", "mov", "webm", "m4v", "avi", "mkv"].includes(ext) ? 1
            : ["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext) ? 3 : 2;
        const att: Attachment = {
          id: newID(), ownerKind: "memo", ownerId: memoID,
          path: raw, mime: kind === 0 ? `image/${ext}` : "application/octet-stream",
          size: Math.round((dataBase64.length * 3) / 4), createdAt: now(), updatedAt: now(),
        };
        emit("attachment");
        return [att, kind];
      }),
  };
}
