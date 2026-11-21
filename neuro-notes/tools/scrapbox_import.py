#!/usr/bin/env python3
"""Scrapbox のエクスポート JSON を Neuro Notes 用の Markdown に変換する。

使い方:
  1. Scrapbox のプロジェクト設定 → Page Data → Export Pages で JSON をダウンロード
     （ページ画面の「AI用コンテキスト」書き出し .txt も読める）
  2. python3 tools/scrapbox_import.py export.json
     （既定では notes/80_Scrapbox取込/ に書き出す。既存ファイルは上書きしない）

オプション:
  --out DIR        出力先（notes/ からの相対 or 絶対パス）
  --overwrite      同名ファイルを上書きする
  --dry-run        書き出さずに一覧だけ表示

変換ルール（主なもの）:
  [リンク]            → [[リンク]]
  [* 太字]            → **太字**     （行全体なら見出し: [**]→###, [***]以上→##）
  [/ 斜体] [- 打消]   → *斜体* ~~打消~~
  [https://… 表示名]  → [表示名](https://…)
  [https://…/x.png] / Gyazo → 画像
  #タグ               → そのまま（サイト側でタグになる）
  行頭インデント       → 箇条書き（深さを保持）
  code:ファイル名      → コードブロック
  table:名前           → Markdown の表
  > 引用               → 引用
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES = ROOT / "notes"

IMG_RE = re.compile(r"\.(png|jpe?g|gif|webp|svg)(\?.*)?$", re.I)
URL_RE = re.compile(r"https?://[^\s\]]+")


def line_text(x) -> str:
    return x["text"] if isinstance(x, dict) else str(x)


def indent_of(s: str) -> tuple[int, str]:
    m = re.match(r"^[ \t]*", s)  # Scrapbox の字下げは半角スペース/タブのみ
    return len(m.group(0)), s[m.end():]


def gyazo(url: str) -> str | None:
    m = re.match(r"https?://(?:i\.)?gyazo\.com/([0-9a-f]{32})", url)
    return f"https://gyazo.com/{m.group(1)}/raw" if m else None


def convert_bracket(inner: str) -> str:
    """[ ... ] の中身を Markdown に変換"""
    # 装飾記法
    m = re.match(r"^([*\-/_!#%^~]+)\s+(.*)$", inner)
    if m:
        marks, body = m.group(1), convert_inline(m.group(2))
        if set(marks) == {"*"}:
            return f"**{body}**"
        if "-" in marks:
            body = f"~~{body}~~"
        if "/" in marks:
            body = f"*{body}*"
        if "*" in marks:
            body = f"**{body}**"
        return body
    if inner.startswith("$ "):
        return f"`{inner[2:]}`"
    if inner.endswith(".icon") or re.search(r"\.icon\*\d+$", inner):
        return ""
    urls = URL_RE.findall(inner)
    if urls:
        url = urls[0]
        label = inner.replace(url, "").strip()
        g = gyazo(url)
        if g or IMG_RE.search(url):
            return f"![{label}]({g or url})"
        return f"[{label or url}]({url})" if label else f"<{url}>"
    return f"[[{inner}]]"


BRACKET_RE = re.compile(r"\[([^\[\]]+)\]")


def convert_inline(s: str) -> str:
    # `code` 部分は変換しない
    parts = re.split(r"(`[^`]*`)", s)
    out = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) >= 2:
            out.append(p)
            continue
        p = BRACKET_RE.sub(lambda m: convert_bracket(m.group(1)), p)
        # 裸の URL
        p = re.sub(r"(?<![(<\[])(https?://[^\s)<>\]]+)", lambda m: f"<{m.group(1)}>", p)
        out.append(p)
    return "".join(out)


def heading_of(text: str) -> str | None:
    m = re.fullmatch(r"\[(\*{2,})\s+(.+)\]", text.strip())
    if not m:
        return None
    level = "##" if len(m.group(1)) >= 3 else "###"
    return f"{level} {convert_inline(m.group(2))}"


def convert_page(page: dict) -> tuple[str, str, list[str]]:
    lines = [line_text(x) for x in page.get("lines", [])]
    title = page.get("title") or (lines[0] if lines else "無題")
    body_lines = lines[1:] if lines and lines[0] == title else lines
    out: list[str] = []
    tags: list[str] = []
    i = 0
    prev_list = False
    while i < len(body_lines):
        raw = body_lines[i]
        ind, text = indent_of(raw)
        # code:
        m = re.match(r"^code:(.*)$", text)
        if m:
            lang = Path(m.group(1).strip()).suffix.lstrip(".") or ""
            block = []
            i += 1
            while i < len(body_lines):
                ind2, t2 = indent_of(body_lines[i])
                if ind2 <= ind and body_lines[i].strip():
                    break
                block.append(body_lines[i][ind + 1:] if ind2 > ind else "")
                i += 1
            out += ["", f"```{lang}", *block, "```", ""]
            prev_list = False
            continue
        # table:
        m = re.match(r"^table:(.*)$", text)
        if m:
            rows = []
            i += 1
            while i < len(body_lines):
                ind2, t2 = indent_of(body_lines[i])
                if ind2 <= ind or not body_lines[i].strip():
                    break
                rows.append([convert_inline(c.strip()) for c in body_lines[i][ind + 1:].split("\t")])
                i += 1
            if rows:
                w = max(len(r) for r in rows)
                rows = [r + [""] * (w - len(r)) for r in rows]
                name = m.group(1).strip()
                if name:
                    out += ["", f"**{name}**"]
                out += ["", "| " + " | ".join(rows[0]) + " |", "|" + "---|" * w]
                out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
                out.append("")
            prev_list = False
            continue

        tags += re.findall(r"(?:^|\s)#([^\s#\[\]]+)", text)
        if not text.strip():
            out.append("")
            prev_list = False
        elif ind == 0:
            h = heading_of(text)
            if h:
                out += ["", h]
                prev_list = False
            elif text.startswith(">"):
                out.append("> " + convert_inline(text[1:].strip()))
                prev_list = False
            else:
                if prev_list:
                    out.append("")
                out.append(convert_inline(text))
                prev_list = False
        else:
            if not prev_list and out and out[-1].strip():
                out.append("")
            out.append("  " * (ind - 1) + "- " + convert_inline(text))
            prev_list = True
        i += 1

    body = "\n".join(out).strip() + "\n"
    body = re.sub(r"\n{3,}", "\n\n", body)
    return title, body, list(dict.fromkeys(tags))


def safe_name(title: str) -> str:
    s = re.sub(r'[\\/:*?"<>|#\s]+', "-", title).strip("-.")
    return (s or "untitled")[:80]


PAGE_RE = re.compile(r'^<Page title="(.*?)"([^>]*)>\n(.*?)</Page>', re.S | re.M)


def parse_smart_context(text: str) -> list[dict]:
    """Cosense の「smart-context」書き出し（.txt）をページ一覧に変換する"""
    pages = []
    for m in PAGE_RE.finditer(text):
        title = html_unescape(m.group(1))
        um = re.search(r'updated="([^"]*)"', m.group(2))
        upd = um.group(1) if um else None
        ts = int(datetime.fromisoformat(upd.replace("Z", "+00:00")).timestamp()) if upd else None
        lines = m.group(3).rstrip("\n").split("\n")
        pages.append({"title": title, "updated": ts, "lines": lines})
    return pages


def html_unescape(s: str) -> str:
    import html
    return html.unescape(s)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("json")
    ap.add_argument("--out", default="80_Scrapbox取込")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    raw = Path(a.json).read_text(encoding="utf-8")
    if raw.lstrip().startswith(("{", "[")):
        data = json.loads(raw)
        pages = data.get("pages", data if isinstance(data, list) else [])
    else:
        pages = parse_smart_context(raw)
    out_dir = Path(a.out)
    if not out_dir.is_absolute():
        out_dir = NOTES / out_dir
    if not a.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    n_new = n_skip = 0
    for p in pages:
        title, body, tags = convert_page(p)
        upd = p.get("updated")
        fm = ["---", f"title: {json.dumps(title, ensure_ascii=False)}"]
        if tags:
            fm.append("tags: [" + ", ".join(json.dumps(t, ensure_ascii=False) for t in tags) + "]")
        if upd:
            fm.append("updated: " + datetime.fromtimestamp(int(upd)).strftime("%Y-%m-%d"))
        fm.append("source: scrapbox")
        fm.append("---")
        path = out_dir / (safe_name(title) + ".md")
        if path.exists() and not a.overwrite:
            n_skip += 1
            continue
        if a.dry_run:
            print(f"[dry-run] {path.relative_to(ROOT)}  ({len(body)}字)")
        else:
            path.write_text("\n".join(fm) + "\n" + body, encoding="utf-8")
        n_new += 1
    print(f"✓ {n_new} ページ変換" + (f"、既存のため {n_skip} ページをスキップ（--overwrite で上書き）" if n_skip else "")
          + f" → {out_dir.relative_to(ROOT) if out_dir.is_relative_to(ROOT) else out_dir}")


if __name__ == "__main__":
    sys.exit(main())
