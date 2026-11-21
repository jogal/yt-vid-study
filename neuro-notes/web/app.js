(() => {
  "use strict";
  const DATA = JSON.parse(document.getElementById("nn-data").textContent);
  const NOTES = DATA.notes;
  const BY_ID = new Map(NOTES.map((n) => [n.id, n]));
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------- storage (失敗しても動く)
  const store = {
    get(k, d) { try { const v = localStorage.getItem("nn." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("nn." + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------- normalize / search
  const norm = (s) => String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const squash = (s) => s.replace(/[\s・･\-‐−–—_/.]/g, "");

  for (const n of NOTES) {
    n._t = norm(n.title);
    n._ts = squash(n._t);
    n._a = n.aliases.map(norm);
    n._as = n._a.map(squash);
    n._g = n.tags.map(norm);
    n._b = norm(n.text);
    n._isTool = /class="tool"/.test(n.html);
  }

  function terms(q) {
    return norm(q).split(/\s+/).filter(Boolean);
  }

  function search(q) {
    const ts = terms(q);
    if (!ts.length) return [];
    const out = [];
    for (const n of NOTES) {
      let score = 0, ok = true, firstBody = -1;
      for (const t of ts) {
        const tq = squash(t) || t;
        let s = 0;
        if (n._t === t || n._ts === tq) s += 120;
        else if (n._t.startsWith(t) || n._ts.startsWith(tq)) s += 70;
        else if (n._t.includes(t) || n._ts.includes(tq)) s += 45;
        if (n._a.some((a, i) => a === t || n._as[i] === tq)) s += 60;
        else if (n._a.some((a, i) => a.includes(t) || n._as[i].includes(tq))) s += 28;
        if (n._g.some((g) => g === t)) s += 22;
        else if (n._g.some((g) => g.includes(t))) s += 10;
        const bi = n._b.indexOf(t);
        if (bi >= 0) {
          let c = 0, i = bi;
          while (i >= 0 && c < 10) { c++; i = n._b.indexOf(t, i + t.length); }
          s += 4 + c;
          if (firstBody < 0) firstBody = bi;
        }
        if (!s) { ok = false; break; }
        score += s;
      }
      if (ok) out.push({ n, score, firstBody });
    }
    out.sort((a, b) => b.score - a.score || a.n._t.localeCompare(b.n._t, "ja"));
    return out;
  }

  // 正規化前後の位置対応を作る（スニペットとハイライト用）
  function normMap(s) {
    let ns = "";
    const map = [];
    for (let i = 0; i < s.length; i++) {
      let ch = s[i];
      if (ch >= "\ud800" && ch <= "\udbff" && i + 1 < s.length) { ch += s[i + 1]; }
      const nch = norm(ch);
      for (let k = 0; k < nch.length; k++) map.push(i);
      ns += nch;
      if (ch.length === 2) i++;
    }
    map.push(s.length);
    return { ns, map };
  }

  function findRanges(text, ts) {
    const { ns, map } = normMap(text);
    const ranges = [];
    for (const t of ts) {
      let i = ns.indexOf(t);
      while (i >= 0) {
        ranges.push([map[i], map[i + t.length] ?? text.length]);
        i = ns.indexOf(t, i + t.length);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r.slice());
    }
    return merged;
  }

  function markText(text, ts) {
    const rs = findRanges(text, ts);
    let out = "", p = 0;
    for (const [a, b] of rs) { out += esc(text.slice(p, a)) + '<mark class="hit">' + esc(text.slice(a, b)) + "</mark>"; p = b; }
    return out + esc(text.slice(p));
  }

  function snippet(n, ts) {
    const text = n.text.replace(/\n/g, " ／ ");
    const rs = findRanges(text, ts);
    if (!rs.length) return esc(text.slice(0, 70)) + (text.length > 70 ? "…" : "");
    const start = Math.max(0, rs[0][0] - 28);
    const end = Math.min(text.length, start + 110);
    const part = text.slice(start, end);
    return (start > 0 ? "…" : "") + markText(part, ts) + (end < text.length ? "…" : "");
  }

  function highlightIn(root, ts) {
    if (!ts.length) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement.closest(".tool, script, style, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let first = null;
    for (const node of nodes) {
      const rs = findRanges(node.nodeValue, ts);
      if (!rs.length) continue;
      const frag = document.createDocumentFragment();
      let p = 0;
      for (const [a, b] of rs) {
        frag.append(node.nodeValue.slice(p, a));
        const m = document.createElement("mark");
        m.className = "hit";
        m.textContent = node.nodeValue.slice(a, b);
        frag.append(m);
        first = first || m;
        p = b;
      }
      frag.append(node.nodeValue.slice(p));
      node.replaceWith(frag);
    }
    return first;
  }

  // ---------------------------------------------------------- prefs
  const root = document.documentElement;
  const THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
    $("#themeBtn").title = "テーマ: " + ({ system: "端末に合わせる", light: "ライト", dark: "ダーク" }[t]);
  }
  const FONTS = ["m", "l", "xl"];
  function applyFont(f) {
    if (f === "m") root.removeAttribute("data-font"); else root.setAttribute("data-font", f);
  }
  let theme = store.get("theme", "system");
  let font = store.get("font", "m");
  applyTheme(theme);
  applyFont(font);
  $("#themeBtn").onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; applyTheme(theme); store.set("theme", theme); toast($("#themeBtn").title, 1600); };
  $("#fontBtn").onclick = () => { font = FONTS[(FONTS.indexOf(font) + 1) % 3]; applyFont(font); store.set("font", font); toast("文字サイズ: " + { m: "標準", l: "大", xl: "特大" }[font], 1400); };

  // ---------------------------------------------------------- favorites / recent
  let favs = store.get("fav", []).filter((id) => BY_ID.has(id));
  let recent = store.get("recent", []).filter((id) => BY_ID.has(id));
  const isFav = (id) => favs.includes(id);
  function toggleFav(id) {
    favs = isFav(id) ? favs.filter((x) => x !== id) : [id, ...favs];
    store.set("fav", favs);
  }
  function pushRecent(id) {
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, 12);
    store.set("recent", recent);
  }

  // ---------------------------------------------------------- header / search box
  $("#siteName").textContent = DATA.site.name;
  $("#siteSub").textContent = DATA.site.subtitle || "";
  const box = $("#searchBox");
  const q = $("#q");
  const mq = matchMedia("(max-width: 860px)");
  function placeSearch() { (mq.matches ? $("#searchMob") : $("#searchDesk")).append(box); box.hidden = false; }
  mq.addEventListener ? mq.addEventListener("change", placeSearch) : mq.addListener(placeSearch);
  placeSearch();

  let sel = -1;
  q.addEventListener("input", () => {
    sel = -1;
    $("#qClear").hidden = !q.value;
    $("#kbd").hidden = !!q.value;
    if (location.hash && location.hash !== "#") {
      history.pushState(null, "", location.pathname + location.search);
    }
    render();
  });
  q.addEventListener("keydown", (e) => {
    const links = [...document.querySelectorAll("#results a")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!links.length) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
      links.forEach((a, i) => a.classList.toggle("sel", i === sel));
      links[sel].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const a = links[sel >= 0 ? sel : 0];
      if (a) { e.preventDefault(); a.click(); q.blur(); }
    } else if (e.key === "Escape") {
      clearSearch();
    }
  });
  function clearSearch() {
    q.value = ""; $("#qClear").hidden = true; $("#kbd").hidden = false; render();
  }
  $("#qClear").onclick = () => { clearSearch(); q.focus(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); q.focus(); q.select();
    }
  });
  $("#brand").onclick = (e) => {
    e.preventDefault();
    q.value = ""; $("#qClear").hidden = true; $("#kbd").hidden = false;
    if (location.hash && location.hash !== "#") location.hash = ""; else render();
    window.scrollTo(0, 0);
  };

  // ---------------------------------------------------------- drawer
  const openDrawer = (on) => document.body.classList.toggle("drawer", on);
  $("#menuBtn").onclick = () => openDrawer(true);
  $("#scrim").onclick = () => openDrawer(false);

  // ---------------------------------------------------------- sidebar
  function renderSide(curId) {
    const open = store.get("open", null);
    const cur = BY_ID.get(curId);
    let h = "";
    const pins = NOTES.filter((n) => n.pin);
    if (pins.length) {
      h += `<div class="side-sec"><div class="side-h">よく使う</div>` +
        pins.map((n) => `<a href="#${n.id}" class="${n.id === curId ? "on" : ""}">${esc(n.title)}</a>`).join("") + `</div>`;
    }
    h += `<div class="side-sec"><div class="side-h">カテゴリ</div>`;
    for (const c of DATA.cats) {
      const isOpen = (cur && cur.catKey === c.key) || (open ? open.includes(c.key) : false);
      h += `<details data-k="${esc(c.key)}" ${isOpen ? "open" : ""}><summary><span>${esc(c.label)}</span><span class="cnt">${c.ids.length}</span></summary><div>` +
        c.ids.map((id) => { const n = BY_ID.get(id); return `<a href="#${id}" class="${id === curId ? "on" : ""} ${n.stub ? "stub-dot" : ""}">${esc(n.title)}</a>`; }).join("") +
        `</div></details>`;
    }
    h += `</div>`;
    const side = $("#side");
    side.innerHTML = h;
    side.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => {
      const keys = [...side.querySelectorAll("details[open]")].map((x) => x.dataset.k);
      store.set("open", keys);
    }));
    side.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => openDrawer(false)));
  }

  // ---------------------------------------------------------- views
  const view = $("#view");
  const fmtDate = (d) => (d || "").replace(/-/g, "/");

  function listHTML(ids, opt = {}) {
    if (!ids.length) return `<div class="empty">${opt.empty || "まだありません"}</div>`;
    return `<div class="list">` + ids.map((id) => {
      const n = BY_ID.get(id);
      return `<a href="#${id}"><span class="t">${esc(n.title)}${n.stub ? ' <span class="pill">書きかけ</span>' : ""}</span><span class="m">${esc(opt.meta === "date" ? fmtDate(n.updated) : n.cat)}</span></a>`;
    }).join("") + `</div>`;
  }

  function viewHome() {
    const pins = NOTES.filter((n) => n.pin);
    const upd = [...NOTES].sort((a, b) => (b.updated || "").localeCompare(a.updated || "")).slice(0, 6);
    let h = "";
    h += `<div class="h-sec">クイックアクセス</div><div class="quick">` +
      pins.map((n) => `<a class="qbtn ${n._isTool ? "is-tool" : ""}" href="#${n.id}"><b>${esc(n.title)}</b><span>${esc(n.aliases.filter((a) => !n._t.includes(norm(a))).slice(0, 2).join("・") || n.cat)}</span></a>`).join("") + `</div>`;
    if (favs.length) h += `<div class="h-sec">★ お気に入り</div>` + listHTML(favs);
    if (recent.length) h += `<div class="h-sec">最近見たノート</div>` + listHTML(recent.slice(0, 6));
    h += `<div class="h-sec">カテゴリ</div><div class="cats">` + DATA.cats.map((c) =>
      `<div class="cat-card"><h3><a href="#${c.hid}">${esc(c.label)}</a><small>${c.ids.length}</small></h3><ul>` +
      c.ids.map((id) => `<li><a href="#${id}">${esc(BY_ID.get(id).title)}</a></li>`).join("") + `</ul></div>`).join("") + `</div>`;
    if (DATA.tags.length) h += `<div class="h-sec">タグ</div><div class="chips">` + DATA.tags.map((t) => `<a class="tag" href="#${t.id}">#${esc(t.tag)} <small>${t.ids.length}</small></a>`).join("") + `</div>`;
    h += `<div class="h-sec">最近更新</div>` + listHTML(upd.map((n) => n.id), { meta: "date" });
    h += footHTML();
    view.innerHTML = h;
    document.title = DATA.site.name;
  }

  const CAT_BY_KEY = new Map(DATA.cats.map((c) => [c.key, c]));
  const CAT_BY_HASH = new Map(DATA.cats.map((c) => [c.hid, c]));
  const catHash = (key) => (CAT_BY_KEY.get(key) || {}).hid || "";
  const TAGS = new Map(DATA.tags.map((t) => [t.id, t]));

  function footHTML() {
    const sw = window.NN_PWA && "serviceWorker" in navigator;
    const ready = sw && navigator.serviceWorker.controller;
    const newLink = DATA.site.newBase ? ` ・ <a href="${esc(DATA.site.newBase)}" target="_blank" rel="noopener">新規ノートを作成（GitHub）</a>` : "";
    return `<div class="foot">
      <div>${NOTES.length} ノート ・ 最終ビルド ${esc(DATA.built)} ・ v${esc(window.NN_VERSION || "")}${newLink}</div>
      <div>オフライン利用: ${sw ? (ready ? '<span class="pill ok">準備完了</span>' : '<span class="pill">準備中（再読み込みで有効）</span>') : '<span class="pill warn">この表示では使えません</span>'}
      ・ スマホではブラウザの共有メニュー →「ホーム画面に追加」でアプリのように使えます。</div>
      <div>個人の学習用ノートです。薬剤の用量・適応は必ず添付文書・ガイドラインで確認してください。</div>
    </div>`;
  }

  function viewResults(qs) {
    const ts = terms(qs);
    const rs = search(qs);
    let h = `<div class="h-sec">「${esc(qs)}」の検索結果 ${rs.length} 件</div>`;
    if (!rs.length) {
      h += `<div class="empty">見つかりませんでした。略語・別名（例: GBS → ギラン・バレー）や、短い語で試してください。</div>`;
    } else {
      h += `<div class="list" id="results">` + rs.slice(0, 60).map(({ n }) =>
        `<a href="#${n.id}" data-hl="1"><span class="col"><span class="t">${markText(n.title, ts)}</span>` +
        `<span class="snip">${n.aliases.length ? '<span class="pill">' + markText(n.aliases.join("・"), ts) + "</span> " : ""}${snippet(n, ts)}</span></span>` +
        `<span class="m">${esc(n.cat)}</span></a>`).join("") + `</div>`;
    }
    view.innerHTML = h;
    view.querySelectorAll("a[data-hl]").forEach((a) => a.addEventListener("click", () => { pendingHL = ts; }));
    document.title = `検索: ${qs} – ${DATA.site.name}`;
  }

  let pendingHL = null;

  function viewNote(n) {
    const editUrl = DATA.site.editBase ? DATA.site.editBase + n.path.split("/").map(encodeURIComponent).join("/") : "";
    let h = `<div class="crumb"><a href="#">ホーム</a><span>›</span><a href="#${catHash(n.catKey)}">${esc(n.cat)}</a></div>`;
    h += `<div class="n-head"><h1>${esc(n.title)}</h1><button class="icon-btn star ${isFav(n.id) ? "on" : ""}" id="star" aria-pressed="${isFav(n.id)}" aria-label="お気に入り">${isFav(n.id) ? "★" : "☆"}</button></div>`;
    if (n.aliases.length) h += `<p class="aka">別名: ${n.aliases.map(esc).join("、")}</p>`;
    if (n.tags.length) h += `<div class="chips">` + n.tags.map((t, i) => `<a class="tag" href="#${n.tagIds[i]}">#${esc(t)}</a>`).join("") + `</div>`;
    if (n.stub) h += `<p class="stub-note"><span class="pill warn">書きかけ</span></p>`;
    if (n.heads.length >= 3) {
      h += `<details class="toc" ${mq.matches ? "" : "open"}><summary>目次</summary><ol>` +
        n.heads.map((x) => `<li class="l${x.level}"><a href="#${n.id}" data-h="${x.id}">${esc(x.text)}</a></li>`).join("") + `</ol></details>`;
    }
    h += `<article class="content" id="content">${n.html}</article>`;
    if (n.back.length) h += `<div class="h-sec">このノートを参照しているノート</div>` + listHTML(n.back);
    const rel = n.links.filter((id) => !n.back.includes(id));
    if (rel.length) h += `<div class="h-sec">リンク先</div>` + listHTML(rel);
    h += `<div class="n-meta"><span>更新 ${esc(fmtDate(n.updated))}</span><span>${esc(n.path)}</span>${editUrl ? `<a href="${esc(editUrl)}" target="_blank" rel="noopener">GitHub で編集</a>` : ""}</div>`;
    view.innerHTML = h;
    document.title = `${n.title} – ${DATA.site.name}`;

    // テーブルを横スクロール枠で包む
    view.querySelectorAll(".content table").forEach((t) => {
      const w = document.createElement("div"); w.className = "tbl"; t.replaceWith(w); w.append(t);
    });
    view.querySelectorAll(".content input[type=checkbox]").forEach((c) => { c.disabled = false; });
    view.querySelectorAll(".toc a[data-h]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); const t = document.getElementById(a.dataset.h); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("#star").onclick = () => {
      toggleFav(n.id); const on = isFav(n.id);
      $("#star").classList.toggle("on", on); $("#star").textContent = on ? "★" : "☆"; $("#star").setAttribute("aria-pressed", on);
      toast(on ? "お気に入りに追加しました" : "お気に入りから外しました", 1400);
    };
    view.querySelectorAll(".tool[data-tool]").forEach((el) => { const f = TOOLS[el.dataset.tool]; if (f) f(el); else el.textContent = "未対応のツール: " + el.dataset.tool; });
    pushRecent(n.id);
    if (pendingHL) {
      const first = highlightIn($("#content"), pendingHL);
      pendingHL = null;
      if (first) requestAnimationFrame(() => first.scrollIntoView({ block: "center" }));
      return true;
    }
    return false;
  }

  function viewList(title, ids, sub) {
    view.innerHTML = `<div class="crumb"><a href="#">ホーム</a></div><div class="n-head"><h1>${esc(title)}</h1></div>${sub ? `<p class="aka">${sub}</p>` : ""}` + listHTML(ids);
    document.title = `${title} – ${DATA.site.name}`;
  }

  function render() {
    const hash = decodeURIComponent(location.hash.slice(1));
    const qs = q.value.trim();
    let curId = null, keepScroll = false;
    if (!hash && qs) viewResults(qs);
    else if (BY_ID.has(hash)) { curId = hash; keepScroll = viewNote(BY_ID.get(hash)); }
    else if (CAT_BY_HASH.has(hash)) { const c = CAT_BY_HASH.get(hash); viewList(c.label, c.ids, `${c.ids.length} ノート`); }
    else if (TAGS.has(hash)) { const t = TAGS.get(hash); viewList("#" + t.tag, t.ids, `${t.ids.length} ノート`); }
    else viewHome();
    renderSide(curId);
    if (!keepScroll && !(qs && !hash)) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { if (location.hash && location.hash !== "#") { /* 検索語は残す（戻るで結果に戻れる） */ } render(); });

  // ---------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, ms = 3000, action) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button id="toastBtn">${esc(action.label)}</button>` : "");
    t.hidden = false;
    if (action) $("#toastBtn").onclick = () => { t.hidden = true; action.fn(); };
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); toast("コピーしました: " + text, 2200); }
    catch {
      const r = document.createRange(); const span = document.createElement("span"); span.textContent = text;
      btn.after(span); r.selectNodeContents(span); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      toast("自動コピーできないので、選択した文字をコピーしてください", 3000);
      setTimeout(() => span.remove(), 8000);
    }
  }

  // ---------------------------------------------------------- tools
  const TOOLS = {};
  const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

  TOOLS.rtpa = (el) => {
    const last = store.get("rtpa.w", 60);
    el.innerHTML = `<div class="tool-h"><b>rt-PA（アルテプラーゼ）0.6 mg/kg</b></div>
      <div class="tool-body">
        <div class="field">
          <label for="rtpaW">体重</label>
          <button class="btn step" data-d="-1" aria-label="1kg減らす">−</button>
          <input class="num" id="rtpaW" type="number" inputmode="decimal" min="20" max="200" step="0.5" value="${last}">
          <button class="btn step" data-d="1" aria-label="1kg増やす">＋</button>
          <span>kg</span>
        </div>
        <dl class="kv" id="rtpaOut"></dl>
        <p class="note-s" id="rtpaCap"></p>
        <details><summary>体重別 早見表（40〜100 kg）</summary><div class="tbl"><table class="dose-tbl" id="rtpaTbl"></table></div></details>
      </div>`;
    const w = $("#rtpaW", el);
    function calc(kg) {
      const eff = Math.min(kg, 100);
      const mg = eff * 0.6;
      const iu = mg * 58;            // 万IU
      const ml = iu / 60;            // 溶解後 60万IU/mL
      return { mg, iu, ml, bolus: ml * 0.1, inf: ml * 0.9 };
    }
    function upd() {
      const kg = parseFloat(w.value);
      const out = $("#rtpaOut", el);
      if (!(kg > 0)) { out.innerHTML = `<div><dt>体重を入力</dt><dd>—</dd></div>`; return; }
      store.set("rtpa.w", kg);
      const r = calc(kg);
      out.innerHTML = `
        <div class="main-v"><dt>総投与量</dt><dd>${r1(r.mg)}<small>mg</small></dd><dt>${Math.round(r.iu).toLocaleString()} 万IU</dt></div>
        <div class="main-v"><dt>総液量</dt><dd>${r1(r.ml)}<small>mL</small></dd></div>
        <div><dt>① ボーラス（10%・1〜2分）</dt><dd>${r1(r.bolus)}<small>mL</small></dd></div>
        <div><dt>② 持続（残り90%・60分）</dt><dd>${r1(r.inf)}<small>mL / 60分</small></dd><dt>= ${r1(r.inf)} mL/h</dt></div>`;
      $("#rtpaCap", el).textContent = kg > 100 ? "※ 体重 100 kg 超のため上限 60 mg（3,480万IU）で計算しています。" : "※ 0.6 mg/kg ＝ 34.8万IU/kg、溶解後 60万IU/mL として計算（0.58 mL/kg）。";
      let t = `<tr><th>体重 kg</th><th>総量 mg</th><th>総液量 mL</th><th>ボーラス mL</th><th>持続 mL/h</th></tr>`;
      for (let k = 40; k <= 100; k += 5) {
        const x = calc(k);
        t += `<tr class="${Math.round(kg / 5) * 5 === k ? "cur" : ""}"><td>${k}</td><td>${r1(x.mg)}</td><td>${r1(x.ml)}</td><td>${r1(x.bolus)}</td><td>${r1(x.inf)}</td></tr>`;
      }
      $("#rtpaTbl", el).innerHTML = t;
    }
    w.addEventListener("input", upd);
    el.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { w.value = Math.max(1, (parseFloat(w.value) || 60) + +b.dataset.d); upd(); }));
    upd();
  };

  const NIHSS = [
    ["1a", "意識水準", ["完全覚醒", "簡単な刺激で覚醒", "繰り返し刺激、強い刺激で覚醒", "完全に無反応"]],
    ["1b", "意識障害―質問（月・年齢）", ["両方正解", "片方正解", "両方不正解"]],
    ["1c", "意識障害―従命（開閉眼・離握手）", ["両方可", "片方可", "両方不可"]],
    ["2", "最良の注視", ["正常", "部分的注視麻痺", "完全注視麻痺"]],
    ["3", "視野", ["正常", "部分的半盲", "完全半盲", "両側性半盲"]],
    ["4", "顔面麻痺", ["正常", "軽度の麻痺", "部分的麻痺", "完全麻痺"]],
    ["5a", "上肢の運動（左）", ["90度*を10秒間保持可能（下垂なし）", "90度*を保持できるが、10秒以内に下垂", "90度*の挙上または保持ができない", "重力に抗して動かない", "全く動きがみられない"], true],
    ["5b", "上肢の運動（右）", ["90度*を10秒間保持可能（下垂なし）", "90度*を保持できるが、10秒以内に下垂", "90度*の挙上または保持ができない", "重力に抗して動かない", "全く動きがみられない"], true],
    ["6a", "下肢の運動（左）", ["30度を5秒間保持できる（下垂なし）", "30度を保持できるが、5秒以内に下垂", "重力に抗して動きがみられる", "重力に抗して動かない", "全く動きがみられない"], true],
    ["6b", "下肢の運動（右）", ["30度を5秒間保持できる（下垂なし）", "30度を保持できるが、5秒以内に下垂", "重力に抗して動きがみられる", "重力に抗して動かない", "全く動きがみられない"], true],
    ["7", "運動失調（麻痺で施行不能なら「なし」）", ["なし", "1肢", "2肢"], true],
    ["8", "感覚", ["障害なし", "軽度から中等度", "重度から完全"]],
    ["9", "最良の言語", ["失語なし", "軽度から中等度", "重度の失語", "無言、全失語"]],
    ["10", "構音障害", ["正常", "軽度から中等度", "重度"], true],
    ["11", "消去現象と注意障害", ["異常なし", "1つの感覚様式の不注意、または2点同時刺激に対する消去現象", "重度の半側不注意、または2つ以上の感覚様式に対する半側不注意"]],
  ];

  TOOLS.nihss = (el) => {
    const st = {};
    el.innerHTML = `<div class="tool-h sticky-total"><b>NIHSS</b><span class="note-s" id="nhLeft"></span>
      <span class="total"><strong id="nhTot">0</strong><span>/ 42 点</span></span></div>
      <div class="tool-body">` +
      NIHSS.map(([no, name, opts, un]) => `<div class="item" data-no="${no}"><div class="item-h"><span class="no">${no}</span><span>${esc(name)}</span><span class="sc" id="sc-${no}"></span></div><div class="opts">` +
        opts.map((o, i) => `<button class="opt" aria-pressed="false" data-v="${i}"><span class="v">${i}</span><span>${esc(o)}</span></button>`).join("") +
        (un ? `<button class="opt" aria-pressed="false" data-v="UN"><span class="v">UN</span><span>評価不能（0点）</span></button>` : "") +
        `</div></div>`).join("") +
      `<p class="note-s">* 座位では90度、仰臥位では45度。</p>
      <div class="btns"><button class="btn pri" id="nhCopy">結果をコピー</button><button class="btn" id="nhReset">リセット</button></div></div>`;
    function upd() {
      let tot = 0, left = 0;
      for (const [no] of NIHSS) {
        const v = st[no];
        if (v === undefined) left++;
        else if (v !== "UN") tot += v;
        $("#sc-" + no, el).textContent = v === undefined ? "" : v === "UN" ? "UN" : v + "点";
      }
      $("#nhTot", el).textContent = tot;
      $("#nhLeft", el).textContent = left ? `未評価 ${left}項目` : "全項目評価済み";
      return tot;
    }
    el.querySelectorAll(".item").forEach((it) => it.addEventListener("click", (e) => {
      const b = e.target.closest(".opt"); if (!b) return;
      const no = it.dataset.no; const v = b.dataset.v === "UN" ? "UN" : +b.dataset.v;
      if (st[no] === v) delete st[no]; else st[no] = v;
      it.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", String(st[no] !== undefined && x.dataset.v === String(st[no]))));
      upd();
    }));
    $("#nhReset", el).onclick = () => { for (const k in st) delete st[k]; el.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", "false")); upd(); };
    $("#nhCopy", el).onclick = (e) => {
      const tot = upd();
      const parts = NIHSS.map(([no]) => `${no}:${st[no] === undefined ? "-" : st[no]}`);
      copyText(`NIHSS ${tot}点（${parts.join(", ")}）`, e.currentTarget);
    };
    upd();
  };

  const GCS = [
    ["E", "開眼（Eye opening）", [[4, "自発的に開眼"], [3, "呼びかけにより開眼"], [2, "痛み刺激により開眼"], [1, "開眼しない"]]],
    ["V", "言語反応（Verbal response）", [[5, "見当識あり"], [4, "混乱した会話"], [3, "不適当な発語"], [2, "理解不能な音声"], [1, "発語なし"], ["T", "挿管・気切（評価不能）"]]],
    ["M", "運動反応（Motor response）", [[6, "命令に従う"], [5, "疼痛部位を認識する（払いのけ）"], [4, "痛みから逃避する（正常屈曲）"], [3, "異常屈曲（除皮質硬直）"], [2, "伸展（除脳硬直）"], [1, "動かない"]]],
  ];
  TOOLS.gcs = (el) => {
    const st = {};
    el.innerHTML = `<div class="tool-h sticky-total"><b>GCS</b><span class="note-s" id="gcsStr"></span>
      <span class="total"><strong id="gcsTot">–</strong><span>/ 15 点</span></span></div><div class="tool-body">` +
      GCS.map(([k, name, opts]) => `<div class="item" data-k="${k}"><div class="item-h"><span class="no">${k}</span><span>${esc(name)}</span></div><div class="opts">` +
        opts.map(([v, o]) => `<button class="opt" aria-pressed="false" data-v="${v}"><span class="v">${v}</span><span>${esc(o)}</span></button>`).join("") + `</div></div>`).join("") +
      `<div class="btns"><button class="btn pri" id="gcsCopy">結果をコピー</button><button class="btn" id="gcsReset">リセット</button></div></div>`;
    const str = () => `E${st.E ?? "?"}V${st.V ?? "?"}M${st.M ?? "?"}`;
    function upd() {
      const done = st.E !== undefined && st.V !== undefined && st.M !== undefined;
      const tot = done ? st.E + (st.V === "T" ? 0 : st.V) + st.M : null;
      $("#gcsTot", el).textContent = tot == null ? "–" : st.V === "T" ? tot + "T" : tot;
      $("#gcsStr", el).textContent = str();
      return tot;
    }
    el.querySelectorAll(".item").forEach((it) => it.addEventListener("click", (e) => {
      const b = e.target.closest(".opt"); if (!b) return;
      const k = it.dataset.k; const v = b.dataset.v === "T" ? "T" : +b.dataset.v;
      st[k] = v;
      it.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === String(v))));
      upd();
    }));
    $("#gcsReset", el).onclick = () => { delete st.E; delete st.V; delete st.M; el.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", "false")); upd(); };
    $("#gcsCopy", el).onclick = (e) => { const t = upd(); copyText(`GCS ${t == null ? "?" : t}${st.V === "T" ? "T" : ""}（${str()}）`, e.currentTarget); };
    upd();
  };

  // ---------------------------------------------------------- offline / PWA
  function netState() { $("#net").hidden = navigator.onLine; }
  addEventListener("online", netState); addEventListener("offline", netState); netState();

  if (window.NN_PWA && "serviceWorker" in navigator && location.protocol !== "file:") {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const ask = (w) => toast("ノートの新しい版があります", 0, { label: "更新する", fn: () => w.postMessage("skip") });
      if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w && w.addEventListener("statechange", () => {
          if (w.state === "installed") {
            if (navigator.serviceWorker.controller) ask(w);
            else toast("オフラインで使えるようになりました", 2500);
          }
        });
      });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(() => {});
  }

  render();
})();
