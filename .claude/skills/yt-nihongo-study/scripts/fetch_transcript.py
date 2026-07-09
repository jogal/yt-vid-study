#!/usr/bin/env python3
"""YouTube 動画の日本語字幕とメタデータを取得するスクリプト。

入力は URL（または動画ID）のみ。字幕とメタ情報をまとめた Markdown を
標準出力に書き出し、必要なら JSON も保存する。Claude はこの出力を読んで
学習ノートに要約する。

使い方:
    python3 fetch_transcript.py <URL> [--lang ja] [--out-dir notes] [--json]

依存: yt-dlp, youtube-transcript-api
    pip install yt-dlp youtube-transcript-api
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def extract_video_id(url_or_id: str) -> str:
    """様々な YouTube URL 形式から動画IDを抽出する。"""
    s = url_or_id.strip()
    # そのまま11文字のIDならそのまま返す
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", s):
        return s
    patterns = [
        r"(?:v=|/v/|youtu\.be/|/embed/|/shorts/|/live/)([0-9A-Za-z_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, s)
        if m:
            return m.group(1)
    raise ValueError(f"動画IDを抽出できませんでした: {url_or_id}")


def fmt_ts(seconds: float) -> str:
    """秒を [hh:mm:ss] 形式に変換する。"""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:d}:{s:02d}"


def get_metadata(url: str) -> dict:
    """yt-dlp でメタデータ（タイトル・チャンネル・長さ等）を取得する。"""
    try:
        from yt_dlp import YoutubeDL
    except ImportError:
        return {}
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] メタデータ取得に失敗: {e}", file=sys.stderr)
        return {}
    return {
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("channel_url") or info.get("uploader_url"),
        "duration": info.get("duration"),
        "upload_date": info.get("upload_date"),
        "view_count": info.get("view_count"),
        "description": (info.get("description") or "")[:2000],
        "webpage_url": info.get("webpage_url") or url,
        "chapters": [
            {"title": c.get("title"), "start": c.get("start_time")}
            for c in (info.get("chapters") or [])
        ],
    }


def get_transcript(video_id: str, langs: list[str]) -> tuple[list[dict], str]:
    """youtube-transcript-api で字幕を取得する。

    戻り値: (segments, 実際に使われた言語コード)
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    transcript_list = api.list(video_id)

    # 1) 手動字幕を優先、2) 自動生成、3) 翻訳可能なものを日本語へ翻訳
    chosen = None
    used_lang = None
    try:
        chosen = transcript_list.find_manually_created_transcript(langs)
        used_lang = chosen.language_code
    except Exception:  # noqa: BLE001
        pass
    if chosen is None:
        try:
            chosen = transcript_list.find_generated_transcript(langs)
            used_lang = chosen.language_code
        except Exception:  # noqa: BLE001
            pass
    if chosen is None:
        # 任意の字幕を取得し、可能なら日本語へ翻訳
        for t in transcript_list:
            try:
                if "ja" in langs and t.is_translatable:
                    chosen = t.translate("ja")
                    used_lang = f"{t.language_code}->ja(翻訳)"
                else:
                    chosen = t
                    used_lang = t.language_code
                break
            except Exception:  # noqa: BLE001
                continue
    if chosen is None:
        raise RuntimeError("利用可能な字幕が見つかりませんでした。")

    fetched = chosen.fetch()
    segments = [
        {"start": snip.start, "duration": snip.duration, "text": snip.text}
        for snip in fetched
    ]
    return segments, used_lang


def render_markdown(meta: dict, segments: list[dict], used_lang: str, url: str) -> str:
    """メタデータ＋タイムスタンプ付き字幕を Markdown にまとめる。"""
    lines: list[str] = []
    title = meta.get("title") or "(タイトル不明)"
    lines.append(f"# 元動画: {title}")
    lines.append("")
    lines.append(f"- URL: {meta.get('webpage_url') or url}")
    if meta.get("uploader"):
        lines.append(f"- チャンネル: {meta['uploader']}")
    if meta.get("duration"):
        lines.append(f"- 長さ: {fmt_ts(meta['duration'])}")
    if meta.get("upload_date"):
        d = meta["upload_date"]
        lines.append(f"- 公開日: {d[:4]}-{d[4:6]}-{d[6:]}")
    lines.append(f"- 字幕言語: {used_lang}")
    lines.append("")
    if meta.get("chapters"):
        lines.append("## 動画チャプター（投稿者設定）")
        for c in meta["chapters"]:
            st = fmt_ts(c["start"]) if c.get("start") is not None else "?"
            lines.append(f"- [{st}] {c.get('title')}")
        lines.append("")
    lines.append("## タイムスタンプ付き字幕")
    lines.append("")
    for seg in segments:
        ts = fmt_ts(seg["start"])
        text = seg["text"].replace("\n", " ").strip()
        if text:
            lines.append(f"[{ts}] {text}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="YouTube 字幕＋メタデータ取得")
    ap.add_argument("url", help="YouTube の URL または動画ID")
    ap.add_argument(
        "--lang",
        default="ja",
        help="優先字幕言語（カンマ区切り、既定: ja）。例: ja,ja-JP,en",
    )
    ap.add_argument("--out-dir", default="notes", help="出力ディレクトリ（既定: notes）")
    ap.add_argument("--json", action="store_true", help="JSON も保存する")
    args = ap.parse_args()

    try:
        video_id = extract_video_id(args.url)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2

    langs = [x.strip() for x in args.lang.split(",") if x.strip()]
    # ja を指定したら ja-JP も自動的に候補に含める
    if "ja" in langs and "ja-JP" not in langs:
        langs.insert(langs.index("ja") + 1, "ja-JP")

    meta = get_metadata(args.url)
    try:
        segments, used_lang = get_transcript(video_id, langs)
    except Exception as e:  # noqa: BLE001
        print(f"[error] 字幕を取得できませんでした: {e}", file=sys.stderr)
        print(
            "[hint] 字幕が無効な動画の可能性があります。"
            "別の動画で試すか、--lang を変えてください。",
            file=sys.stderr,
        )
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    md = render_markdown(meta, segments, used_lang, args.url)
    transcript_path = out_dir / f"{video_id}_transcript.md"
    transcript_path.write_text(md, encoding="utf-8")

    if args.json:
        json_path = out_dir / f"{video_id}_data.json"
        json_path.write_text(
            json.dumps(
                {"video_id": video_id, "meta": meta, "used_lang": used_lang, "segments": segments},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"[ok] JSON 保存: {json_path}", file=sys.stderr)

    print(f"[ok] 字幕保存: {transcript_path}  （{len(segments)} セグメント / 言語: {used_lang}）", file=sys.stderr)
    # Markdown 本文を標準出力へ（Claude が読む）
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
