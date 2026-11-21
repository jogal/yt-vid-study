# yt-vid-study

YouTube 動画の **URL を1つ渡すだけ** で、プレゼンテーションや講義・解説動画の
要点を抽出し、構造化された**日本語の学習ノート**を自動生成する仕組み。

`yt-eigo-study`（英語学習向け）の考え方を、日本語動画・汎用の要約ノートに
拡張したものです。中身は Claude Code のスキル
[`yt-nihongo-study`](.claude/skills/yt-nihongo-study/) として実装されています。

## できること
- YouTube の URL から字幕（日本語優先、無ければ他言語→日本語翻訳）とメタデータを取得
- プレゼン・講義・解説の**要点をタイムスタンプ付きで抽出**
- TL;DR / 全体構成 / セクション別要点 / 重要用語 / 引用 / アクション … を
  含む学習ノートを日本語で生成

## 使い方（Claude Code）
Claude に YouTube の URL を貼って、こう頼むだけ:

> このプレゼンの要点をノートにまとめて
> https://www.youtube.com/watch?v=XXXXXXXXXXX

`yt-nihongo-study` スキルが自動的に起動し、字幕を取得して要約ノートを作ります。

### 手動で字幕だけ取得する場合
```bash
pip install yt-dlp youtube-transcript-api   # 初回のみ
python3 .claude/skills/yt-nihongo-study/scripts/fetch_transcript.py "<URL>" --lang ja
```

主なオプション:
- `--lang ja,en` … 優先字幕言語（カンマ区切り）
- `--out-dir notes` … 出力先ディレクトリ
- `--json` … 字幕＋メタデータの JSON も保存

## 出力
`notes/` に以下が保存されます（`<video_id>` は動画ID）:
- `<video_id>_transcript.md` … タイムスタンプ付き字幕
- `<video_id>_note.md` … 完成した学習ノート

## 依存関係
- Python 3.9+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) … メタデータ・チャプター取得
- [`youtube-transcript-api`](https://github.com/jdepoix/youtube-transcript-api) … 字幕取得

```bash
pip install -r requirements.txt
```

## 仕組み
1. URL から動画IDを抽出
2. `yt-dlp` でタイトル・チャンネル・長さ・チャプター等を取得
3. `youtube-transcript-api` で字幕を取得（手動→自動生成→翻訳の順にフォールバック）
4. タイムスタンプ付き字幕を Claude が読み、要約ノートに再構成

---

## Neuro Notes（脳神経内科 診療ノート）

[`neuro-notes/`](neuro-notes/) に、診療時に参照するノートサイト（オフライン対応 PWA）を置いています。
書き方・公開方法は [neuro-notes/README.md](neuro-notes/README.md) を参照。
