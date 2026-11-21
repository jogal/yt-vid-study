#!/usr/bin/env python3
"""Neuro Notes ビルドスクリプト

notes/ 以下の Markdown を読み込み、検索・リンク・計算ツール込みの
オフライン対応 PWA（dist/）を生成する。

  python3 build.py            # dist/ にサイト一式を出力
  python3 build.py --preview  # dist/preview.html（単一ファイル版・SWなし）も出力

依存: markdown-it-py, mdit-py-plugins, linkify-it-py, PyYAML
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import date, datetime
from pathlib import Path

import yaml
from markdown_it import MarkdownIt
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin

ROOT = Path(__file__).resolve().parent
NOTES = ROOT / "notes"
WEB = ROOT / "web"
DIST = ROOT / "dist"

ASSET_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"}


# ---------------------------------------------------------------- utils
def norm(s: str) -> str:
    """検索・リンク解決用の正規化（全角半角・大小文字・カタカナ→ひらがな）。"""
    s = unicodedata.normalize("NFKC", s).lower()
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def note_id(title: str) -> str:
    return "n-" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]


def tag_id(tag: str) -> str:
    return "t-" + hashlib.sha1(norm(tag).encode("utf-8")).hexdigest()[:8]


def cat_label(dirname: str) -> str:
    return re.sub(r"^\d+[_\-\s]*", "", dirname) or dirname


def git_updated(path: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", str(path)],
            cwd=ROOT, capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        return out or None
    except Exception:
        return None


FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)


def split_front_matter(text: str) -> tuple[dict, str]:
    m = FM_RE.match(text)
    if not m:
        return {}, text
    meta = yaml.safe_load(m.group(1)) or {}
    return meta, text[m.end():]


def as_list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if str(x).strip()]
    return [s.strip() for s in str(v).split(",") if s.strip()]


# ---------------------------------------------------------------- markdown
class Ctx:
    """レンダリング中のノート情報（リンク・タグ収集用）"""

    def __init__(self, resolver, rel_dir: str):
        self.resolver = resolver
        self.rel_dir = rel_dir
        self.links: list[str] = []
        self.tags: list[str] = []


def wikilink_rule(state, silent):
    src, pos = state.src, state.pos
    if not src.startswith("[[", pos):
        return False
    end = src.find("]]", pos + 2)
    if end < 0:
        return False
    inner = src[pos + 2:end]
    if not inner.strip() or "\n" in inner:
        return False
    if not silent:
        target, _, label = inner.partition("|")
        tok = state.push("wikilink", "", 0)
        tok.meta = {"target": target.strip(), "label": (label or target).strip()}
    state.pos = end + 2
    return True


TAG_RE = re.compile(r"#([^\s#\[\]()<>「」、。,.!?！？:：;；/]+)")


def hashtag_rule(state, silent):
    src, pos = state.src, state.pos
    if src[pos] != "#":
        return False
    if pos > 0 and not src[pos - 1].isspace() and src[pos - 1] not in "（(、。":
        return False
    m = TAG_RE.match(src, pos)
    if not m:
        return False
    if not silent:
        tok = state.push("hashtag", "", 0)
        tok.meta = {"tag": m.group(1)}
    state.pos = m.end()
    return True


def make_md() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": True, "linkify": True, "breaks": True, "typographer": False})
    md.enable(["table", "strikethrough", "linkify"])
    md.use(footnote_plugin).use(tasklists_plugin)
    md.inline.ruler.before("link", "wikilink", wikilink_rule)
    md.inline.ruler.before("link", "hashtag", hashtag_rule)

    def r_wikilink(self, tokens, idx, options, env):
        ctx: Ctx = env["ctx"]
        meta = tokens[idx].meta
        target, label = meta["target"], meta["label"]
        nid = ctx.resolver(target)
        ctx.links.append(target)
        if nid:
            return f'<a class="wl" href="#{nid}">{html.escape(label)}</a>'
        return f'<span class="wl missing" title="未作成のノート">{html.escape(label)}</span>'

    def r_hashtag(self, tokens, idx, options, env):
        tag = tokens[idx].meta["tag"]
        env["ctx"].tags.append(tag)
        return f'<a class="tag" href="#{tag_id(tag)}">#{html.escape(tag)}</a>'

    md.add_render_rule("wikilink", r_wikilink)
    md.add_render_rule("hashtag", r_hashtag)

    default_fence = md.renderer.rules["fence"]

    def r_fence(self, tokens, idx, options, env):
        tok = tokens[idx]
        info = tok.info.strip()
        if info == "tool":
            name = tok.content.strip().split()[0] if tok.content.strip() else ""
            return f'<div class="tool" data-tool="{html.escape(name)}"></div>\n'
        return default_fence(tokens, idx, options, env)

    md.add_render_rule("fence", r_fence)

    default_link_open = md.renderer.rules.get("link_open")

    def r_link_open(self, tokens, idx, options, env):
        tok = tokens[idx]
        href = tok.attrGet("href") or ""
        if re.match(r"^https?://", href):
            tok.attrSet("target", "_blank")
            tok.attrSet("rel", "noopener")
        if default_link_open:
            return default_link_open(tokens, idx, options, env)
        return md.renderer.renderToken(tokens, idx, options, env)

    md.add_render_rule("link_open", r_link_open)

    def r_image(self, tokens, idx, options, env):
        tok = tokens[idx]
        src = tok.attrGet("src") or ""
        if not re.match(r"^(https?:|data:|/)", src):
            rel = (Path(env["ctx"].rel_dir) / src).as_posix()
            tok.attrSet("src", "files/" + rel)
        tok.attrSet("loading", "lazy")
        return md.renderer.image(tokens, idx, options, env)

    md.add_render_rule("image", r_image)
    return md


CALLOUT_RE = re.compile(
    r"<blockquote>\s*<p>\[!([^\]]+)\]\s*(?:<br\s*/?>)?\s*", re.S
)
CALLOUT_KIND = {"注意": "warn", "warning": "warn", "警告": "warn", "danger": "warn",
                "tip": "tip", "ポイント": "tip", "メモ": "note", "note": "note", "info": "note"}


def callouts(h: str) -> str:
    def rep(m):
        label = m.group(1).strip()
        kind = CALLOUT_KIND.get(label.lower(), CALLOUT_KIND.get(label, "note"))
        return (f'<blockquote class="callout {kind}"><p class="callout-title">'
                f'{html.escape(label)}</p><p>')
    return CALLOUT_RE.sub(rep, h)


def add_heading_ids(h: str, nid: str) -> tuple[str, list[dict]]:
    heads = []

    def rep(m):
        level, inner = m.group(1), m.group(2)
        text = re.sub(r"<[^>]+>", "", inner)
        hid = f"{nid}-h{len(heads) + 1}"
        heads.append({"id": hid, "level": int(level), "text": html.unescape(text)})
        return f'<h{level} id="{hid}">{inner}</h{level}>'

    return re.sub(r"<h([2-4])>(.*?)</h\1>", rep, h, flags=re.S), heads


def html_to_text(h: str) -> str:
    h = re.sub(r'<div class="tool"[^>]*></div>', " ", h)
    h = re.sub(r"<(br|/p|/li|/h\d|/tr|/td|/th|/summary)[^>]*>", "\n", h)
    t = html.unescape(re.sub(r"<[^>]+>", "", h))
    t = re.sub(r"[ \t　]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n", t).strip()


# ---------------------------------------------------------------- build
def load_notes():
    if not NOTES.exists():
        sys.exit("notes/ ディレクトリがありません")
    raw = []
    for p in sorted(NOTES.rglob("*.md")):
        rel = p.relative_to(NOTES)
        if any(part.startswith((".", "_")) for part in rel.parts):
            continue
        meta, body = split_front_matter(p.read_text(encoding="utf-8"))
        title = str(meta.get("title") or p.stem).strip()
        cat_dir = rel.parts[0] if len(rel.parts) > 1 else ""
        upd = meta.get("updated")
        if isinstance(upd, (date, datetime)):
            upd = upd.isoformat()[:10]
        raw.append({
            "path": rel.as_posix(),
            "title": title,
            "aliases": as_list(meta.get("aliases")),
            "tags": as_list(meta.get("tags")),
            "pin": bool(meta.get("pin")),
            "stub": str(meta.get("status", "")).lower() in ("stub", "draft", "書きかけ"),
            "cat_dir": cat_dir,
            "updated": str(upd) if upd else (git_updated(p) or datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()),
            "body": body,
        })
    return raw


def build(preview: bool = False) -> None:
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8")) if (ROOT / "config.yaml").exists() else {}
    raw = load_notes()

    # タイトル・別名 → id
    index: dict[str, str] = {}
    dup = []
    for n in raw:
        n["id"] = note_id(n["title"])
        key = norm(n["title"])
        if key in index:
            dup.append(n["title"])
        index[key] = n["id"]
    for n in raw:
        for a in n["aliases"]:
            index.setdefault(norm(a), n["id"])
    if dup:
        print("⚠ 同じタイトルのノートがあります:", ", ".join(dup), file=sys.stderr)

    def resolver(target: str):
        return index.get(norm(target))

    md = make_md()
    notes = []
    for n in raw:
        ctx = Ctx(resolver, str(Path(n["path"]).parent))
        h = md.render(n["body"], {"ctx": ctx})
        h = callouts(h)
        h, heads = add_heading_ids(h, n["id"])
        tags = list(dict.fromkeys(n["tags"] + ctx.tags))
        notes.append({
            "id": n["id"], "title": n["title"], "aliases": n["aliases"], "tags": tags,
            "cat": cat_label(n["cat_dir"]) if n["cat_dir"] else "未分類",
            "catKey": n["cat_dir"] or "zz",
            "pin": n["pin"], "stub": n["stub"], "updated": n["updated"], "path": n["path"],
            "html": h, "text": html_to_text(h), "heads": heads,
            "links": sorted({resolver(t) for t in ctx.links if resolver(t)} - {n["id"]}),
            "missing": sorted({t for t in ctx.links if not resolver(t)}),
        })

    back: dict[str, list[str]] = {}
    for n in notes:
        for l in n["links"]:
            back.setdefault(l, []).append(n["id"])
    for n in notes:
        n["back"] = back.get(n["id"], [])

    cats = []
    for key in sorted({n["catKey"] for n in notes}):
        items = sorted([n for n in notes if n["catKey"] == key], key=lambda x: norm(x["title"]))
        cats.append({"key": key, "hid": "c-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:8],
                     "label": items[0]["cat"], "ids": [n["id"] for n in items]})

    tags: dict[str, dict] = {}
    for n in notes:
        n["tagIds"] = []
        for t in n["tags"]:
            tid = tag_id(t)
            tags.setdefault(tid, {"id": tid, "tag": t, "ids": []})["ids"].append(n["id"])
            n["tagIds"].append(tid)

    data = {
        "site": {
            "name": cfg.get("site_name", "Neuro Notes"),
            "subtitle": cfg.get("subtitle", ""),
            "editBase": cfg.get("edit_base", ""),
            "newBase": cfg.get("new_base", ""),
        },
        "built": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "notes": notes,
        "cats": cats,
        "tags": sorted(tags.values(), key=lambda t: (-len(t["ids"]), norm(t["tag"]))),
    }
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    version = hashlib.sha1(payload.encode("utf-8") + b"".join(
        (WEB / f).read_bytes() for f in ("app.js", "app.css", "template.html", "sw.js"))).hexdigest()[:10]

    css = (WEB / "app.css").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    tpl = (WEB / "template.html").read_text(encoding="utf-8")

    def render(mode: str) -> str:
        page = tpl
        if mode == "preview":
            # Artifact プレビュー用: 文書の外枠・SW登録を外す
            page = re.sub(r"<!--HEAD_START-->.*?<!--HEAD_END-->", "", page, flags=re.S)
            page = re.sub(r"<!--PWA_START-->.*?<!--PWA_END-->", "", page, flags=re.S)
            page = page.replace("<!--DOC_END-->", "")
            page = re.sub(r"<!--BODY_OPEN-->.*?<!--/BODY_OPEN-->", "", page, flags=re.S)
        else:
            page = page.replace("<!--HEAD_START-->", "").replace("<!--HEAD_END-->", "")
            page = page.replace("<!--PWA_START-->", "").replace("<!--PWA_END-->", "")
            page = page.replace("<!--DOC_END-->", "</body>\n</html>")
            page = page.replace("<!--BODY_OPEN-->", "").replace("<!--/BODY_OPEN-->", "")
        return (page.replace("{{TITLE}}", html.escape(data["site"]["name"]))
                    .replace("{{VERSION}}", version)
                    .replace("/*{{CSS}}*/", css)
                    .replace("/*{{JS}}*/", js)
                    .replace("{{DATA}}", payload))

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)
    (DIST / "index.html").write_text(render("full"), encoding="utf-8")
    if preview:
        (DIST / "preview.html").write_text(render("preview"), encoding="utf-8")

    # 画像などの添付ファイル
    assets = []
    for p in NOTES.rglob("*"):
        if p.is_file() and p.suffix.lower() in ASSET_EXT:
            dst = DIST / "files" / p.relative_to(NOTES)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            assets.append("files/" + p.relative_to(NOTES).as_posix())

    for f in ("icon-192.png", "icon-512.png", "apple-touch-icon.png", "icon.svg"):
        if (WEB / f).exists():
            shutil.copy2(WEB / f, DIST / f)
    manifest = {
        "name": data["site"]["name"], "short_name": cfg.get("short_name", data["site"]["name"]),
        "start_url": "./", "scope": "./", "display": "standalone",
        "background_color": "#f5f7f8", "theme_color": "#1d4f63", "lang": "ja",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }
    (DIST / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    precache = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"] + assets
    sw = (WEB / "sw.js").read_text(encoding="utf-8")
    sw = sw.replace("__VERSION__", version).replace("__PRECACHE__", json.dumps(precache, ensure_ascii=False))
    (DIST / "sw.js").write_text(sw, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    (DIST / "robots.txt").write_text("User-agent: *\nDisallow: /\n")

    missing = sorted({m for n in notes for m in n["missing"]})
    print(f"✓ {len(notes)} ノート / {len(cats)} カテゴリ / 添付 {len(assets)} → {DIST.relative_to(ROOT)}/ (v{version})")
    if missing:
        print(f"  未作成リンク {len(missing)}: " + "、".join(missing))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="単一ファイルのプレビュー版も出力")
    build(ap.parse_args().preview)
