/* ------------------------------- state ---------------------------------- */
const store = {
  get(k, d){ try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
let threads = store.get("chat.threads", []);
let currentId = store.get("chat.current", null);
let streaming = null;

const $ = (id) => document.getElementById(id);
const log = $("log"), scroll = $("scroll");

/* ------------------------ scroll-to-bottom button ------------------------- */
const isNearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
function updateScrollBottomBtn(){ $("scrollBottom").hidden = isNearBottom(); }
scroll.addEventListener("scroll", updateScrollBottomBtn);
$("scrollBottom").onclick = () => { scroll.scrollTop = scroll.scrollHeight; };
new MutationObserver(updateScrollBottomBtn).observe(log, { childList: true, subtree: true, characterData: true });

/* ------------------------------- theme ----------------------------------- */
// theme is null ("follow system") or an explicit "light"/"dark" override.
let theme = store.get("chat.theme", null);
function applyTheme(t){
  theme = t;
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  store.set("chat.theme", t);
  const isDark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("themeToggle").textContent = isDark ? "☀️" : "🌙";
  $("themeToggle").title = isDark ? "ライト表示に切り替え" : "ダーク表示に切り替え";
}
applyTheme(theme);
$("themeToggle").onclick = () => {
  const isDark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(isDark ? "light" : "dark");
};

function newThread(){
  const t = { id: crypto.randomUUID(), title: "新しいチャット", messages: [], at: Date.now() };
  threads.unshift(t); currentId = t.id; persist(); setSidebarTab("home"); render(); return t;
}
// Only call this where "no thread selected" should actually start a new
// Home chat (send(), sendClaudeCode() right after quick-start sets
// currentId, etc). Anywhere that's just checking "is thread X the one
// currently on screen" — including from async callbacks like SSE handlers,
// which can fire while the user is looking at an empty tab — compare
// against currentId directly instead; routing that through current() would
// silently create and switch to a fresh Home thread as a side effect of an
// unrelated background event.
function current(){ return threads.find(t => t.id === currentId) || newThread(); }
let historySyncTimer = null;
// Only true once init() has confirmed it could actually read the server's
// backup file. If that read failed (corrupt file, server error, offline),
// persist() below must NOT sync to the server: doing so would overwrite a
// possibly-recoverable backup with whatever (possibly empty) state this tab
// happens to have — silently destroying the exact data this feature exists
// to protect. Flipped to true after a confirmed-successful GET /api/history.
let historyBackupHealthy = false;
function persist(){
  const light = threads.slice(0, 100).map(t => ({
    ...t,
    messages: t.messages.map(m => ({
      ...m,
      files: (m.files ?? []).map(({ name, kind, format, size, path }) => ({ name, kind, format, size, path }))
    }))
  }));
  store.set("chat.threads", light);
  store.set("chat.current", currentId);
  if (!historyBackupHealthy) return;
  // Mirror to the server-side backup file too, debounced so rapid-fire
  // persist() calls don't hammer disk I/O — localStorage above already
  // covers the "instant" case.
  clearTimeout(historySyncTimer);
  historySyncTimer = setTimeout(() => {
    fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threads: light, current: currentId }),
    }).then((res) => {
      // A failed write here is a durability problem, not a cosmetic one —
      // this backup is what's supposed to survive a cleared browser cache,
      // so silently pretending it succeeded would defeat the whole feature.
      if (!res.ok) showSetupBanner("会話履歴のサーバー保存に失敗しました。この端末のブラウザ内には残っていますが、サーバー側のバックアップは最新ではありません。");
    }).catch(() => {
      showSetupBanner("会話履歴のサーバー保存に失敗しました。この端末のブラウザ内には残っていますが、サーバー側のバックアップは最新ではありません。");
    });
  }, 500);
}

/* ---------------------------- markdown ---------------------------------- */
const esc = (s) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
// A small, dependency-free approximate highlighter — not per-language
// grammars (that'd mean bundling a real highlighter into this single-file
// app), just universal patterns that read well across most languages.
const HL_KEYWORDS = new Set(`const let var function return if else for while switch case break continue
  class extends new this super import export from default async await try catch finally throw
  typeof instanceof in of do null true false undefined void delete yield static get set public
  private protected interface implements enum type namespace as readonly abstract def elif except
  pass lambda with self fn impl let mut pub use mod struct trait match loop package func var const
  int string bool float double void char long short unsigned signed`.split(/\s+/).filter(Boolean));
function highlightCode(code){
  const re = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [full, blockC, lineC1, lineC2, str, num, word] = m;
    if (blockC || lineC1 || lineC2) out += `<span class="tok-c">${esc(full)}</span>`;
    else if (str) out += `<span class="tok-s">${esc(full)}</span>`;
    else if (num) out += `<span class="tok-n">${esc(full)}</span>`;
    else if (word && HL_KEYWORDS.has(word)) out += `<span class="tok-k">${esc(full)}</span>`;
    else out += esc(full);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}
// Artifacts風のプレビュー。ロックダウンしたiframe内で描画できるマークアップ
// （HTML/SVG/XML）だけを対象にする — Reactの実行やコード実行は行わない。
// 詳細と、外部通信を遮断している理由は togglePreview() のコメントを参照。
const PREVIEWABLE_LANGS = new Set(["html", "svg", "xml"]);
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
function md(src){
  const blocks = [];
  let s = src.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    const body = code.replace(/\n$/, "");
    const previewBtn = PREVIEWABLE_LANGS.has(lang.toLowerCase())
      ? `<button class="preview" data-src="${b64(body)}">プレビュー</button>`
      : "";
    blocks.push(`<pre data-lang="${esc(lang)}"><div class="pre-head"><span class="pre-lang">${esc(lang || "text")}</span><span class="head-actions">${previewBtn}<button class="copy">コピー</button></span></div><code>${highlightCode(body)}</code></pre><div class="preview-pane" hidden></div>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  const inline = (x) => x
    .replace(/`([^`]+)`/g, (_m,c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  for (const raw of s.split("\n")) {
    const line = raw.trimEnd();
    if (/^\u0000\d+\u0000$/.test(line.trim())) { if(list){out.push(`</${list}>`);list=null;} out.push(line.trim()); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { if(list){out.push(`</${list}>`);list=null;} out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^(---|\*\*\*)\s*$/.test(line)) { if(list){out.push(`</${list}>`);list=null;} out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if(list!=="ul"){ if(list)out.push(`</${list}>`); out.push("<ul>"); list="ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if(list!=="ol"){ if(list)out.push(`</${list}>`); out.push("<ol>"); list="ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { if(list){out.push(`</${list}>`);list=null;} out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!line.trim()) { if(list){out.push(`</${list}>`);list=null;} continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_m,i) => blocks[i]);
}

/* ----------------------------- rendering -------------------------------- */
const ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>`;
const ICON_CODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_REWIND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-9.36L3 7"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`;
const ICON_SPARKLE = `<svg viewBox="0 0 24 24" fill="currentColor"><g><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(45 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(90 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(135 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(180 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(225 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(270 12 12)"/><path d="M12 12C12 12 13.2 5 12 1C10.8 5 12 12 12 12Z" transform="rotate(315 12 12)"/></g></svg>`;
function fmtRelativeTime(ts){
  if (!ts) return "";
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}日前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dateGroupLabel(ts){
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = startOfDay(new Date(ts));
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays <= 0) return "本日";
  if (diffDays === 1) return "昨日";
  if (diffDays <= 7) return "過去7日間";
  if (diffDays <= 30) return "過去30日間";
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

let threadSearchQuery = "";
let showArchived = false;
let selectMode = false;
let selectedIds = new Set();
// "home" = plain Bedrock chat, "code" = Claude Code chat — kept as separate
// top-level sections (like the official Claude app's own chat/Code split)
// since the two backends have different requirements (model ID vs local CLI)
// and mixing them in one list was the direct cause of a support back-and-forth.
//
// The two routes also bill in completely different places, which is invisible
// from the chat itself — so every entry point into a thread says so plainly
// rather than leaving it to the README.
const ROUTE_NOTE_HOME = "💬 <b>ホーム</b>: Amazon Bedrock を直接呼び出します（課金: AWS の Bedrock 利用料）";
const ROUTE_NOTE_CODE = "🛠 <b>Code</b>: ローカルの <code>claude</code> CLI 経由です（課金: Claude Code 側。ホームの Bedrock 直課金とは別に発生します）";
let sidebarTab = store.get("chat.sidebarTab", "home");
// Whether the local `claude` CLI the Code path spawns is actually routed
// through Bedrock — set from /api/config once init() has fetched it. The
// server resolves this from the CLI's own settings files as well as the
// environment variable (see code-agent/cli-config.js), so configuring it the
// documented way — the CLI's settings.json — no longer trips the warning.
// Defaults to true (no warning) until that fetch resolves, so a slow config
// load doesn't itself trigger a false warning.
let codeUsesBedrock = true;
let codeBedrockSource = null; // "settings" = explicitly turned off there, null = nothing found either way
let codeBedrockDetail = null; // where that came from, so the warning can point at the actual file
let codeBedrockWarningShown = false;
function setSidebarTab(tab){
  sidebarTab = tab;
  store.set("chat.sidebarTab", tab);
  showArchived = false;
  exitSelectMode();
  $("tabHome").classList.toggle("active", tab === "home");
  $("tabCode").classList.toggle("active", tab === "code");
  $("newchat").hidden = tab !== "home";
  $("newChatCode").hidden = tab !== "code";

  if (tab === "code" && !codeUsesBedrock && !codeBedrockWarningShown) {
    codeBedrockWarningShown = true;
    // Two genuinely different situations, so two different messages. When
    // nothing was found anywhere it says "確認できませんでした" rather than
    // "設定されていません" — a wrapper script or the CLI's registry-based
    // policy source could still route through Bedrock invisibly (see
    // code-agent/cli-config.js), and overstating an unknown as a definite
    // misconfiguration trains people to dismiss the warning.
    const head = codeBedrockSource === "settings"
      ? "claude CLI の設定で Bedrock 経由が明示的に無効化されています。"
      : "claude CLI が Bedrock 経由かどうか確認できませんでした（環境変数 CLAUDE_CODE_USE_BEDROCK も、CLI の settings.json も設定されていません）。";
    showSetupBanner(
      head
      + "Codeタブでの操作は Anthropic に直接通信している可能性があります。社内ポリシーでBedrock経由のみ許可されている場合は、claude CLI 側の設定を確認してください。"
      + (codeBedrockDetail ? `（${codeBedrockDetail}）` : "")
    );
  }

  // The main panel follows the tab too — otherwise switching tabs only
  // updates the sidebar list while the chat pane keeps showing whatever was
  // open before, which looks like both tabs share the same conversation.
  const cur = threads.find(t => t.id === currentId);
  const curMatchesTab = cur && !cur.archived && (cur.kind === "claude-code") === (tab === "code");
  if (!curMatchesTab) {
    const candidates = threads.filter(t => !t.archived && (t.kind === "claude-code") === (tab === "code"));
    currentId = candidates.reduce((best, t) => (!best || t.at > best.at ? t : best), null)?.id ?? null;
    persist();
  }
  render();
}
$("tabHome").onclick = () => setSidebarTab("home");
$("tabCode").onclick = () => setSidebarTab("code");
/** Prefers a thread matching the currently active sidebar tab (home/code)
 *  when picking what to fall back to after deleting/archiving the open
 *  thread — otherwise the main panel could jump to the other kind while the
 *  sidebar still shows the tab you were on, which is exactly the kind of
 *  mismatch this whole tab split exists to avoid. */
function pickFallbackThread(excludeId){
  const sameTab = threads.find(x => x.id !== excludeId && !x.archived && (x.kind === "claude-code") === (sidebarTab === "code"));
  if (sameTab) return sameTab.id;
  return threads.find(x => x.id !== excludeId && !x.archived)?.id ?? null;
}
function threadMatchesSearch(th, q){
  if (th.title.toLowerCase().includes(q)) return true;
  return th.messages.some(m => m.content?.toLowerCase().includes(q));
}
function threadRow(th){
  const isCode = th.kind === "claude-code";
  const el = document.createElement("div");
  el.className = "thread" + (isCode ? " code" : "") + (th.id === currentId ? " active" : "") + (selectMode ? " selectable" : "");
  el.innerHTML = (selectMode
    ? `<input type="checkbox" class="thread-check"${selectedIds.has(th.id) ? " checked" : ""} />`
    : `<span class="icon-sq">${isCode ? ICON_CODE : ICON_HOME}</span>`)
    + `<span class="t"></span>`
    + (th.pinned ? `<span class="pin-mark" title="ピン留め済み">📌</span>` : "")
    + (selectMode ? "" : `<button class="thread-menu-btn" title="その他">⋯</button><button class="del" title="削除">${ICON_TRASH}</button>`);
  el.querySelector(".t").textContent = th.title;
  if (selectMode) {
    el.onclick = () => {
      if (selectedIds.has(th.id)) selectedIds.delete(th.id); else selectedIds.add(th.id);
      renderThreadList(); updateBulkBar();
    };
  } else {
    el.onclick = () => { currentId = th.id; persist(); render(); };
    el.querySelector(".thread-menu-btn").onclick = (e) => { e.stopPropagation(); openThreadMenu(th.id, e.currentTarget); };
    el.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      const wasCurrent = currentId === th.id;
      threads = threads.filter(x => x.id !== th.id);
      if (wasCurrent) currentId = pickFallbackThread(th.id);
      persist(); if (!threads.length) newThread(); else render();
    };
  }
  return el;
}
function renderThreadList(){
  threads.sort((a, b) => b.at - a.at); // most recently active first, like the official app
  $("threads").innerHTML = "";
  const q = threadSearchQuery.trim().toLowerCase();
  let pool = showArchived ? threads.filter(t => t.archived) : threads.filter(t => !t.archived);
  pool = pool.filter(t => (t.kind === "claude-code") === (sidebarTab === "code"));
  if (q) pool = pool.filter(th => threadMatchesSearch(th, q));

  if (showArchived) {
    for (const th of pool) $("threads").appendChild(threadRow(th));
  } else {
    const pinned = pool.filter(t => t.pinned);
    const rest = pool.filter(t => !t.pinned);
    if (pinned.length) {
      const label = document.createElement("div");
      label.className = "thread-group-label";
      label.textContent = "📌 ピン留め済み";
      $("threads").appendChild(label);
      for (const th of pinned) $("threads").appendChild(threadRow(th));
    }
    let lastGroup = null;
    for (const th of rest) {
      const group = dateGroupLabel(th.at);
      if (group !== lastGroup) {
        const label = document.createElement("div");
        label.className = "thread-group-label";
        label.textContent = group;
        $("threads").appendChild(label);
        lastGroup = group;
      }
      $("threads").appendChild(threadRow(th));
    }
  }
  if (!pool.length) {
    const msg = q ? "一致するチャットがありません" : showArchived ? "アーカイブされたチャットはありません" : "チャットがありません";
    $("threads").innerHTML = `<div class="thread-empty">${esc(msg)}</div>`;
  }
  $("archiveToggle").textContent = showArchived ? "← 戻る" : "🗄 アーカイブ";
  $("archiveToggle").classList.toggle("active", showArchived);
  $("archiveToggle").title = showArchived ? "通常のチャット一覧に戻る" : "アーカイブ済みのチャットを表示";
}
$("threadSearch").addEventListener("input", () => {
  threadSearchQuery = $("threadSearch").value;
  renderThreadList();
});
$("archiveToggle").onclick = () => {
  showArchived = !showArchived;
  exitSelectMode();
  renderThreadList();
};
$("selectToggle").onclick = () => {
  selectMode = !selectMode;
  selectedIds.clear();
  $("selectToggle").classList.toggle("active", selectMode);
  $("bulkBar").hidden = !selectMode;
  updateBulkBar();
  renderThreadList();
};
function exitSelectMode(){
  selectMode = false;
  selectedIds.clear();
  $("selectToggle").classList.remove("active");
  $("bulkBar").hidden = true;
}
function updateBulkBar(){
  $("bulkCount").textContent = `${selectedIds.size}件選択中`;
  $("bulkDelete").disabled = selectedIds.size === 0;
}
$("bulkCancel").onclick = () => { exitSelectMode(); renderThreadList(); };
$("bulkDelete").onclick = () => {
  if (!selectedIds.size) return;
  if (!confirm(`${selectedIds.size}件のチャットを削除します。よろしいですか？`)) return;
  const wasCurrentDeleted = selectedIds.has(currentId);
  threads = threads.filter(t => !selectedIds.has(t.id));
  if (wasCurrentDeleted) currentId = pickFallbackThread(currentId);
  exitSelectMode();
  persist(); if (!threads.length) newThread(); else render();
};

/* -------------------------- thread kebab menu ---------------------------- */
let menuThreadId = null;
function openThreadMenu(threadId, anchorEl){
  const th = threads.find(x => x.id === threadId);
  if (!th) return;
  menuThreadId = threadId;
  const menu = $("threadMenu");
  menu.querySelector('[data-action="pin"]').textContent = th.pinned ? "📌 ピン留めを解除" : "📌 ピン留め";
  menu.querySelector('[data-action="archive"]').textContent = th.archived ? "🗄 アーカイブを解除" : "🗄 アーカイブ";
  const rect = anchorEl.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${rect.left}px`;
}
function closeThreadMenu(){ $("threadMenu").hidden = true; menuThreadId = null; }
document.addEventListener("click", (e) => {
  if (!$("threadMenu").hidden && !$("threadMenu").contains(e.target)) closeThreadMenu();
});
$("threadMenu").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !menuThreadId) return;
  const th = threads.find(x => x.id === menuThreadId);
  if (th) {
    if (btn.dataset.action === "pin") {
      th.pinned = !th.pinned;
    } else if (btn.dataset.action === "archive") {
      th.archived = !th.archived;
      if (th.archived && currentId === th.id) currentId = pickFallbackThread(th.id);
    } else if (btn.dataset.action === "duplicate") {
      const copy = structuredClone(th);
      copy.id = crypto.randomUUID();
      copy.title = th.title + " のコピー";
      copy.at = Date.now();
      copy.pinned = false;
      copy.archived = false;
      if (copy.kind === "claude-code") { copy.sessionId = null; copy.workflow = null; }
      threads.unshift(copy);
      currentId = copy.id;
    }
    persist();
  }
  closeThreadMenu();
  if (!threads.length) newThread(); else render();
});

// Leading marker so a Code thread is identifiable from the header alone,
// without having to notice which sidebar tab happens to be selected.
// t.model comes from the CLI's own "started" event (see the SSE handler in
// ensureCcConnection) — not something this app lets the user pick — so it's
// only appended once a turn has actually run and reported it.
function ccInfoText(t){
  const mode = t.mode === "acceptEdits" ? "Accept edits" : "Plan only";
  return `🛠 Claude Code ・ ${t.repoLabel ?? t.repoPath} ・ ${mode}${t.model ? " ・ " + t.model : ""}`;
}
function render(){
  renderThreadList();
  const t = threads.find(x => x.id === currentId);

  if (t?.kind === "claude-code") { setCcSendBusy(ccBusy.has(t.id)); maybeReconnectClaudeCode(t); }
  else if (!streaming) setCcSendBusy(false);

  const ccInfo = $("ccInfo");
  if (t?.kind === "claude-code") {
    ccInfo.hidden = false;
    ccInfo.textContent = ccInfoText(t);
    ccInfo.title = "この会話はローカルの claude CLI 経由です。課金は Claude Code 側で、ホームの Bedrock 直課金とは別に発生します。";
  } else {
    ccInfo.hidden = true;
    ccInfo.title = "";
  }

  const isClaudeCodeThread = t?.kind === "claude-code";
  $("browse").hidden = isClaudeCodeThread;
  $("attach").hidden = isClaudeCodeThread;
  $("ccPlan").hidden = !isClaudeCodeThread;

  log.innerHTML = "";
  if (!t || !t.messages.length) {
    log.innerHTML = t?.kind === "claude-code"
      ? `<div class="empty"><h2>何を調べますか？</h2><p>「${esc(t.repoLabel ?? t.repoPath)}」についてClaude Codeに質問できます。</p>
         <div class="route-note">${ROUTE_NOTE_CODE}</div></div>`
      : `<div class="empty"><h2>何から始めますか？</h2><p>Amazon Bedrock 上の Claude に直接つながっています。</p>
         <div class="route-note">${ROUTE_NOTE_HOME}</div></div>`;
    updateContextBar(t);
    return;
  }
  t.messages.forEach((m, i) => {
    const el = bubble(m.role, m.content, m.thinking, m.files, m.tools, m.meta);
    log.appendChild(el);
    if (m.role === "assistant") {
      const isLast = m === t.messages[t.messages.length - 1];
      addMessageActions(el, m.content, { canRegenerate: isLast && t.kind !== "claude-code", threadId: t.id, at: m.at });
      if (m.content?.trim() && t.kind !== "claude-code") addCodeButton(el, m.content);
    } else if (m.role === "user") {
      addUserMessageActions(el, t, i);
    }
  });
  if (t.kind === "claude-code" && t.workflow) renderWorkflow(t.id, t.workflow); // redisplay last known state; SSE reconnect (above) corrects it if stale
  scroll.scrollTop = scroll.scrollHeight;
  updateContextBar(t);
}
function bubble(role, text, thinking, files, tools, meta){
  const el = document.createElement("div");
  el.className = "msg " + role;
  const chips = (files ?? []).map(f =>
    `<div class="chip"><span>${f.path ? "📁" : f.kind === "image" ? "🖼" : "📄"}</span><b>${esc(f.name)}</b><span>${fmtSize(f.size)}</span></div>`
  ).join("");
  el.innerHTML = `<div class="body"><div class="who">${role === "user" ? "あなた" : ICON_SPARKLE}</div>
    ${chips ? `<div class="files">${chips}</div>` : ""}
    <div class="think-slot"></div><div class="tools-slot"></div><div class="content"></div><div class="meta-slot"></div></div>`;
  setContent(el, text, thinking, false, tools, meta);
  return el;
}
/** Creates an empty assistant bubble already in its "考え中" (thinking) live
 *  state, so there's a visible sign of activity from the moment a turn is
 *  sent — not just once the first token/tool event actually arrives, which
 *  for Claude Code (spawning a CLI subprocess) can take several seconds. */
function appendAssistantPlaceholder(){
  const el = bubble("assistant", "", "");
  setContent(el, "", "", true);
  return el;
}
function addCodeButton(el, text){
  if (el.querySelector(".code-btn")) return;
  const btn = document.createElement("button");
  btn.className = "code-btn";
  btn.textContent = "🛠 Claude Codeに実装を依頼";
  btn.title = "この回答をもとに、Claude Codeへ1回だけ実装を依頼します（会話は継続しません）";
  btn.onclick = () => openCodeModal(text);
  el.querySelector(".body").appendChild(btn);
}
function makeActionBtn(icon, title, onClick){
  const btn = document.createElement("button");
  btn.className = "msg-action"; btn.title = title; btn.innerHTML = icon;
  btn.onclick = onClick;
  return btn;
}
function makeTimeLabel(at){
  const span = document.createElement("span");
  span.className = "msg-time";
  span.textContent = fmtRelativeTime(at);
  span.title = new Date(at).toLocaleString("ja-JP");
  return span;
}
/** Small "中断" button shown only while a reply is actively streaming — the
 *  same effect as the send button's stop-toggle, just reachable from the
 *  message itself. Removed automatically once the turn finishes (see the
 *  el.querySelector(".msg-actions")?.remove() calls right before each
 *  addMessageActions()/addUserMessageActions() call at completion). */
function addInterruptButton(el, onInterrupt){
  if (el.querySelector(".msg-actions")) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions live";
  bar.appendChild(makeActionBtn(ICON_STOP, "中断", () => { onInterrupt(); bar.remove(); }));
  el.querySelector(".body").appendChild(bar);
}
/** Hover-revealed copy/regenerate actions under a finished assistant reply.
 *  Regenerate is only offered for the thread's own latest reply in plain
 *  Bedrock chat — Claude Code turns are session-based (--resume, real tool
 *  calls/file edits already happened), so "regenerate" has no safe meaning
 *  there and is intentionally left out. */
function addMessageActions(el, text, opts){
  if (el.querySelector(".msg-actions") || !text?.trim()) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const copyBtn = makeActionBtn(ICON_COPY, "コピー", () => {
    navigator.clipboard.writeText(text);
    copyBtn.innerHTML = ICON_CHECK; setTimeout(() => copyBtn.innerHTML = ICON_COPY, 1200);
  });
  bar.appendChild(copyBtn);
  if (opts?.canRegenerate) bar.appendChild(makeActionBtn(ICON_REFRESH, "再生成", () => regenerateBedrock(opts.threadId)));
  if (opts?.at) bar.appendChild(makeTimeLabel(opts.at));
  el.querySelector(".body").appendChild(bar);
}
/** Hover-revealed copy/edit/rewind actions under a user bubble. Edit and
 *  rewind only make sense in plain Bedrock chat (Claude Code turns are
 *  session-based and can't be safely rewound), so those two are left out
 *  for claude-code threads — copy and the timestamp are always shown. */
function addUserMessageActions(el, t, msgIndex){
  if (el.querySelector(".msg-actions")) return;
  const m = t.messages[msgIndex];
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const copyBtn = makeActionBtn(ICON_COPY, "コピー", () => {
    navigator.clipboard.writeText(m.content);
    copyBtn.innerHTML = ICON_CHECK; setTimeout(() => copyBtn.innerHTML = ICON_COPY, 1200);
  });
  bar.appendChild(copyBtn);
  if (t.kind !== "claude-code") {
    bar.appendChild(makeActionBtn(ICON_EDIT, "編集して再送信", () => startEditMessage(el, t, msgIndex)));
    bar.appendChild(makeActionBtn(ICON_REWIND, "ここまで巻き戻す", () => rewindToMessage(t, msgIndex)));
  }
  if (m.at) bar.appendChild(makeTimeLabel(m.at));
  el.querySelector(".body").appendChild(bar);
}
/** Truncates history back to before this message and restores its original
 *  text into the composer — unlike edit-and-resend, nothing is sent
 *  automatically, so the user can change files/attachments or decide not to
 *  send at all. Bedrock chat only, same reasoning as edit/regenerate. */
function rewindToMessage(t, msgIndex){
  if (streaming) return;
  const m = t.messages[msgIndex];
  t.messages = t.messages.slice(0, msgIndex);
  persist();
  render();
  $("input").value = m.content;
  $("input").style.height = "auto";
  $("input").style.height = Math.min($("input").scrollHeight, 240) + "px";
  $("input").focus();
}
function startEditMessage(el, t, msgIndex){
  const m = t.messages[msgIndex];
  const contentEl = el.querySelector(".content");
  const original = contentEl.innerHTML;

  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = m.content;
  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "wf-btn"; cancelBtn.textContent = "キャンセル";
  const saveBtn = document.createElement("button");
  saveBtn.className = "wf-btn primary"; saveBtn.textContent = "送信";
  actions.append(cancelBtn, saveBtn);

  contentEl.innerHTML = "";
  contentEl.append(textarea, actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  cancelBtn.onclick = () => { contentEl.innerHTML = original; };
  const submit = async () => {
    const newText = textarea.value.trim();
    if (!newText || streaming) return;
    t.messages = t.messages.slice(0, msgIndex);
    t.messages.push({ role: "user", content: newText, files: m.files, at: Date.now() });
    t.at = Date.now();
    persist();
    render();
    await runBedrockTurn(t);
  };
  saveBtn.onclick = submit;
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Escape") cancelBtn.click();
  });
}
function setContent(el, text, thinking, live, tools, meta){
  const slot = el.querySelector(".think-slot");
  slot.innerHTML = thinking
    ? `<details class="think"${live ? " open" : ""}><summary>思考プロセス</summary><div>${md(thinking)}</div></details>`
    : "";
  const toolsSlot = el.querySelector(".tools-slot");
  if (toolsSlot) {
    toolsSlot.innerHTML = (tools ?? []).length
      ? `<div class="cc-tools">${tools.map(t => `<div>${toolIcon(t.tool)} ${esc(t.tool)}${t.target ? " " + esc(t.target) : ""}</div>`).join("")}</div>`
      : "";
  }
  const hasContent = !!(text && text.trim()) || !!(tools && tools.length);
  const contentEl = el.querySelector(".content");
  contentEl.innerHTML = live && !hasContent
    ? `<span class="thinking">考え中<span class="tdots"><i></i><i></i><i></i></span></span>`
    : md(text || "") + (live ? '<span class="caret"></span>' : "");
  // Long finished replies are collapsed behind a toggle so one huge answer
  // doesn't push the rest of the conversation off screen. Character count
  // (not rendered height) so this works even before the bubble is attached
  // to the DOM (bubble() calls setContent() before appendChild()).
  el.querySelector(".content-toggle")?.remove();
  contentEl.classList.remove("collapsed");
  if (!live && text && text.length > 1500) {
    contentEl.classList.add("collapsed");
    const toggle = document.createElement("button");
    toggle.className = "content-toggle";
    toggle.textContent = "続きを読む";
    toggle.onclick = () => {
      const collapsed = contentEl.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "続きを読む" : "折りたたむ";
    };
    contentEl.insertAdjacentElement("afterend", toggle);
  }
  const metaSlot = el.querySelector(".meta-slot");
  if (metaSlot) {
    const parts = [];
    if (meta?.usage) parts.push(fmtUsage(meta.usage));
    if (meta?.durationMs != null) parts.push(`所要時間 ${(meta.durationMs / 1000).toFixed(1)}秒`);
    if (meta?.costUsd != null) parts.push(`概算コスト $${meta.costUsd.toFixed(4)}`);
    const title = "入力/出力: このやり取りで実際に使われたトークン数。キャッシュ読込: プロンプトキャッシュから再利用された分（低コスト）。概算コストはClaude Code側の見積もりです。";
    metaSlot.innerHTML = parts.length ? `<div class="cs-meta" title="${esc(title)}">${esc(parts.join(" ・ "))}</div>` : "";
  }
  el.querySelectorAll("pre .copy").forEach(b => b.onclick = () => {
    navigator.clipboard.writeText(b.closest("pre").querySelector("code").textContent);
    b.textContent = "コピーしました"; setTimeout(() => b.textContent = "コピー", 1200);
  });
  el.querySelectorAll("pre .preview").forEach(b => b.onclick = () => togglePreview(b));
}

/** HTML/SVG/XMLのコードブロックをその場で描画する。
 *  sandbox="allow-scripts"（allow-same-originは付けない）に加えて、srcdocの先頭に
 *  Content-Security-Policy のmetaタグを必ず注入する。sandbox属性だけでは <img src> や
 *  <link> などの外部リソース読み込みは止まらず、「通信先はBedrockだけ」という
 *  このアプリの方針が崩れるため、この2つは必ずセットで維持すること。 */
function togglePreview(btn){
  const pane = btn.closest("pre").nextElementSibling;
  if (!pane || !pane.classList.contains("preview-pane")) return;
  if (!pane.hidden) {
    pane.hidden = true;
    pane.innerHTML = "";
    btn.classList.remove("active");
    btn.textContent = "プレビュー";
    return;
  }
  const src = decodeURIComponent(
    Array.prototype.map.call(atob(btn.dataset.src), c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  );
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">`;
  pane.innerHTML = `<div class="preview-bar"><span>プレビュー（サンドボックス内で実行・外部通信は行われません）</span></div>`;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts"); // 属性で直接指定する（allow-same-originは付けない）
  iframe.srcdoc = csp + src;
  pane.appendChild(iframe);
  pane.hidden = false;
  btn.classList.add("active");
  btn.textContent = "閉じる";
}

/* --------------------------- context usage bar --------------------------- */
// モデルごとの実際の上限をBedrock APIから取得する手段がないため、Claude系の
// 標準値を固定で使う既知の近似。
const CONTEXT_WINDOW = 200000;
function showContextUsage(usage){
  const wrap = $("ctxWrap");
  if (!usage) { wrap.hidden = true; return; }
  const used = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  if (!used) { wrap.hidden = true; return; }
  const pct = Math.min(100, (used / CONTEXT_WINDOW) * 100);
  const pctLabel = pct > 0 && pct < 1 ? "<1%" : Math.round(pct) + "%";
  wrap.hidden = false;
  wrap.title = `コンテキスト使用量: ${used.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} トークン (${pctLabel})`;
  $("ctxFill").style.width = Math.max(pct, pct > 0 ? 2 : 0) + "%";
  $("ctxPct").textContent = pctLabel;
  const bar = wrap.querySelector(".ctx-bar");
  bar.classList.toggle("warn", pct >= 60 && pct < 85);
  bar.classList.toggle("danger", pct >= 85);
}
function updateContextBar(t){
  const last = t?.messages?.slice().reverse().find(m => m.meta?.usage);
  if (!last) { $("ctxWrap").hidden = true; $("usage").textContent = ""; return; }
  $("usage").textContent = `in ${last.meta.usage.inputTokens} / out ${last.meta.usage.outputTokens} tok`;
  showContextUsage(last.meta.usage);
}
function toolIcon(name){
  const map = { Read:"📄", Edit:"✏️", Write:"📝", Bash:"⚡", Grep:"🔍", Glob:"📁", WebFetch:"🌐", WebSearch:"🌐", Task:"🧩" };
  return map[name] || "🔧";
}

/* ---------------------------- attachments ------------------------------- */
const IMAGE_FORMATS = { png:"png", jpg:"jpeg", jpeg:"jpeg", gif:"gif", webp:"webp" };
const DOC_FORMATS = { pdf:"pdf", doc:"doc", docx:"docx", xls:"xls", xlsx:"xlsx", csv:"csv", txt:"txt", md:"md", html:"html" };
const MAX_BYTES = 4.5 * 1024 * 1024;
let pending = [];

const fmtSize = (n) => n >= 1024*1024 ? (n/1024/1024).toFixed(1)+" MB" : Math.max(1, Math.round(n/1024))+" KB";
const fmtNum = (n) => (n ?? 0).toLocaleString("ja-JP");
function fmtUsage(u){
  if (!u) return "";
  const parts = [`入力 ${fmtNum(u.inputTokens)} ・ 出力 ${fmtNum(u.outputTokens)} トークン`];
  if (u.cacheReadTokens) parts.push(`キャッシュ読込 ${fmtNum(u.cacheReadTokens)} トークン`);
  if (u.cacheCreationTokens) parts.push(`キャッシュ作成 ${fmtNum(u.cacheCreationTokens)} トークン`);
  return parts.join(" ・ ");
}

const MAX_ZIP_BYTES = 24 * 1024 * 1024;

async function addFiles(list){
  for (const file of list) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "zip") {
      if (file.size > MAX_ZIP_BYTES) { flash(`${file.name} は24MBを超えています`); continue; }
      await openZip(file);
      continue;
    }
    const kind = IMAGE_FORMATS[ext] ? "image" : DOC_FORMATS[ext] ? "document" : null;
    if (!kind) { flash(`${file.name} は対応していない形式です`); continue; }
    if (file.size > MAX_BYTES) { flash(`${file.name} は 4.5MB を超えています`); continue; }
    const images = pending.filter(f => f.kind === "image").length;
    const docs = pending.length - images;
    if (kind === "image" && images >= 20) { flash("画像は20件までです"); continue; }
    if (kind === "document" && docs >= 5) { flash("文書は5件までです"); continue; }
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("読み込みに失敗しました"));
      r.readAsDataURL(file);
    }).catch(() => null);
    if (!data) { flash(`${file.name} を読み込めませんでした`); continue; }
    pending.push({ name: file.name, size: file.size, kind, format: kind === "image" ? IMAGE_FORMATS[ext] : DOC_FORMATS[ext], data });
  }
  renderTray();
}
function flash(msg){
  $("ctx").textContent = msg;
  setTimeout(() => { if ($("ctx").textContent === msg) $("ctx").textContent = ""; }, 4000);
}
// Unlike flash(), this stays up until closed — for setup problems (missing
// AWS credentials, no Bedrock access, etc.) that a 4-second toast would
// blow past before a first-time user even finishes reading it.
//
// A Set, not a single string: the AWS-setup check and the history-backup
// check both run during init() and can both legitimately fail at once
// (e.g. a totally fresh install with no AWS config AND no server reachable
// yet) — overwriting one warning with the other would silently hide a real
// problem the user still needs to act on.
const setupWarnings = new Set();
function showSetupBanner(msg){
  setupWarnings.add(msg);
  $("setupBannerText").innerHTML = [...setupWarnings].map(m => `<div>${esc(m)}</div>`).join("");
  $("setupBanner").hidden = false;
}
$("setupBannerClose").onclick = () => { setupWarnings.clear(); $("setupBanner").hidden = true; };
function renderTray(){
  $("tray").innerHTML = "";
  pending.forEach((f, i) => {
    const c = document.createElement("div");
    c.className = "chip";
    c.innerHTML = `<span title="${f.path ? "許可フォルダから参照" : "添付"}">${f.path ? "📁" : f.kind === "image" ? "🖼" : "📄"}</span><b></b><span>${fmtSize(f.size)}</span><button title="削除">×</button>`;
    c.querySelector("b").textContent = f.name;
    c.querySelector("button").onclick = () => { pending.splice(i, 1); renderTray(); };
    $("tray").appendChild(c);
  });
}
$("attach").onclick = () => $("file").click();
$("file").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
const composer = $("composer");
["dragenter","dragover"].forEach(ev => composer.addEventListener(ev, e => { e.preventDefault(); composer.classList.add("drop"); }));
["dragleave","drop"].forEach(ev => composer.addEventListener(ev, e => { e.preventDefault(); composer.classList.remove("drop"); }));
composer.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
$("input").addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

/* ------------------------- folders & picker ----------------------------- */
let indexed = [];

async function registerRoots(){
  const lines = $("roots").value.split("\n").map(s => s.trim()).filter(Boolean);
  const msg = $("rootsMsg");
  if (!lines.length) { indexed = []; msg.textContent = "未設定 — 📁ボタンで選べるようになります"; return; }
  try {
    const r = await fetch("/api/roots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots: lines })
    });
    const d = await r.json();
    const parts = [`${d.roots.length}件のフォルダを参照可能`];
    for (const b of d.rejected ?? []) parts.push(`${b.path}: ${b.reason}`);
    msg.textContent = parts.join(" / ");
    await loadIndex();
  } catch (err) {
    msg.textContent = `フォルダを登録できませんでした: ${err.message}`;
  }
}
async function loadIndex(){
  try {
    const d = await (await fetch("/api/files")).json();
    indexed = d.files ?? [];
    if (d.truncated) flash("件数が多いため一部のみ表示しています");
  } catch { indexed = []; }
}
function renderPicker(){
  const q = $("pq").value.trim().toLowerCase();
  const hits = indexed
    .filter(f => !q || f.rel.toLowerCase().includes(q))
    .slice(0, 60);
  const list = $("plist");
  list.innerHTML = "";
  if (!indexed.length) {
    list.innerHTML = `<div class="pempty">参照できるファイルがありません。⚙の設定でフォルダを登録してください。</div>`;
    return;
  }
  if (!hits.length) { list.innerHTML = `<div class="pempty">一致するファイルがありません。</div>`; return; }
  for (const f of hits) {
    const el = document.createElement("div");
    el.className = "pitem";
    el.innerHTML = `<span>${f.kind === "image" ? "🖼" : "📄"}</span><span class="n"></span><span class="r"></span><span class="s">${fmtSize(f.size)}</span>`;
    el.querySelector(".n").textContent = f.name;
    el.querySelector(".r").textContent = f.rel;
    el.onclick = () => {
      if (pending.some(p => p.path === f.path)) { flash("すでに選択済みです"); return; }
      pending.push({ name: f.name, size: f.size, kind: f.kind, path: f.path });
      renderTray();
      $("picker").classList.remove("open");
      $("input").focus();
    };
    list.appendChild(el);
  }
}
$("browse").onclick = async () => {
  const p = $("picker");
  p.classList.toggle("open");
  if (!p.classList.contains("open")) return;
  await loadIndex();
  $("pq").value = ""; renderPicker(); $("pq").focus();
};
$("pq").addEventListener("input", renderPicker);
$("roots").addEventListener("change", () => { store.set("chat.roots", $("roots").value); registerRoots(); });

/* ------------------------------- zip picker ------------------------------ */
// zipはサーバー側でもディスクに書かず、メモリ上に短時間だけ保持される
// （server.js の zipStore を参照）。ここでは一覧→選択→個別展開の2段構成。
let zipToken = null;
let zipEntries = [];
const zipSelected = new Set();

async function openZip(file){
  $("ctx").textContent = `${file.name} を展開中…`;
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("読み込みに失敗しました"));
    r.readAsDataURL(file);
  }).catch(() => null);
  if (!data) { flash(`${file.name} を読み込めませんでした`); return; }

  try {
    const r = await fetch("/api/zip/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, data })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (!d.token) { flash(d.message || "対応する形式のファイルが見つかりませんでした"); return; }
    zipToken = d.token;
    zipEntries = d.entries;
    zipSelected.clear();
    $("zipName").textContent = file.name;
    $("zq").value = "";
    renderZipPicker();
    $("zipPicker").classList.add("open");
    $("ctx").textContent = "";
  } catch (err) {
    flash(`zipを開けませんでした: ${err.message}`);
  }
}

function renderZipPicker(){
  const q = $("zq").value.trim().toLowerCase();
  const hits = zipEntries.filter(e => !q || e.name.toLowerCase().includes(q)).slice(0, 200);
  const list = $("zlist");
  list.innerHTML = "";
  $("zipMsg").textContent = `${zipEntries.length}件 / ${zipSelected.size}件選択中`;
  if (!hits.length) { list.innerHTML = `<div class="pempty">一致するファイルがありません。</div>`; return; }
  for (const e of hits) {
    const el = document.createElement("div");
    el.className = "pitem";
    const checked = zipSelected.has(e.entryName);
    el.innerHTML = `<span>${checked ? "☑" : "☐"}</span><span class="n"></span><span class="s">${fmtSize(e.size)}</span>`;
    el.querySelector(".n").textContent = e.displayName || e.entryName;
    el.onclick = () => {
      if (zipSelected.has(e.entryName)) zipSelected.delete(e.entryName);
      else zipSelected.add(e.entryName);
      renderZipPicker();
    };
    list.appendChild(el);
  }
}
$("zq").addEventListener("input", renderZipPicker);
$("zipPicker").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement === $("zq")) e.preventDefault();
});
$("zipAdd").onclick = () => addSelectedZipEntries();
$("zipCancel").onclick = () => { zipSelected.clear(); $("zipPicker").classList.remove("open"); };

async function addSelectedZipEntries(){
  if (!zipSelected.size) { $("zipPicker").classList.remove("open"); return; }
  const images = pending.filter(f => f.kind === "image").length;
  const docs = pending.length - images;
  let addedImages = 0, addedDocs = 0;
  for (const entryName of zipSelected) {
    const entry = zipEntries.find(e => e.entryName === entryName);
    if (!entry) continue;
    if (entry.kind === "image" && images + addedImages >= 20) { flash("画像は20件までです"); break; }
    if (entry.kind === "document" && docs + addedDocs >= 5) { flash("文書は5件までです"); break; }
    try {
      const r = await fetch("/api/zip/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: zipToken, entryName })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      pending.push({ name: d.name, size: d.size, kind: d.kind, format: d.format, data: d.data });
      if (entry.kind === "image") addedImages++; else addedDocs++;
    } catch (err) {
      flash(`${entryName} の展開に失敗しました: ${err.message}`);
    }
  }
  renderTray();
  $("zipPicker").classList.remove("open");
  $("input").focus();
}

/* --------------------------- style presets & memo ------------------------- */
// 応答スタイルとメモはサーバー側に保持せず、systemフィールドに結合するだけの
// 軽量実装（claude.aiの「記憶」機能の簡易版という位置づけ）。
const STYLE_PRESETS = {
  concise: "回答は要点だけを短く、簡潔に述べてください。前置きや冗長な説明は省いてください。",
  formal: "丁寧語・ビジネス文書調で、正式な文章として回答してください。",
  friendly: "話し言葉に近い、親しみやすくフレンドリーな口調で回答してください。",
  technical: "専門用語を厭わず、技術的な詳細を省略せずに回答してください。",
};
function buildSystemPrompt(){
  const parts = [];
  const preset = STYLE_PRESETS[$("stylePreset").value];
  if (preset) parts.push(preset);
  const memo = $("memo").value.trim();
  if (memo) parts.push(memo);
  const system = $("system").value.trim();
  if (system) parts.push(system);
  return parts.join("\n\n");
}

/* ------------------------------ sending --------------------------------- */
async function send(){
  if (streaming) { streaming.abort(); return; }
  const text = $("input").value.trim();
  if (!text && !pending.length) return;
  const modelId = $("model").value;
  if (!modelId) { flash("モデルIDを入力してください（画面上部の欄）"); return; }

  const t = current();
  t.messages.push({ role: "user", content: text, files: pending, at: Date.now() });
  if (t.messages.length === 1) t.title = (text || pending[0].name).slice(0, 34);
  t.at = Date.now();
  pending = []; renderTray();
  $("input").value = ""; $("input").style.height = "auto";
  render();

  await runBedrockTurn(t);
}

/** Sends whatever's already in t.messages (must end with a user turn) and
 *  streams the reply into a new bubble. Shared by send() (appends a fresh
 *  user message first) and regenerateBedrock() (drops the stale assistant
 *  reply and re-runs from the same user message). */
async function runBedrockTurn(t){
  const modelId = $("model").value;
  if (!modelId) { flash("モデルIDを入力してください（画面上部の欄）"); return; }

  const el = appendAssistantPlaceholder();
  log.appendChild(el);
  scroll.scrollTop = scroll.scrollHeight;

  let answer = "", thought = "", usage = null;
  // タイトル自動生成は「最初の一往復が終わったとき」だけ。ここで判定しておく
  // （finallyの時点ではassistantメッセージを積んでいて判別できないため）。
  const isFirstExchange = t.messages.length === 1 && t.messages[0].role === "user";
  streaming = new AbortController();
  $("send").classList.add("stop"); $("send").textContent = "■";
  addInterruptButton(el, () => streaming?.abort());

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: streaming.signal,
      body: JSON.stringify({
        modelId,
        system: buildSystemPrompt(),
        temperature: Number($("temp").value),
        maxTokens: Number($("maxtok").value),
        thinkingBudget: Number($("think").value),
        messages: t.messages.map(m => ({
          role: m.role,
          content: m.content,
          files: (m.files ?? []).filter(f => f.data || f.path)
        }))
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data:")) continue;
        const ev = JSON.parse(p.slice(5));
        if (ev.type === "text") answer += ev.text;
        else if (ev.type === "thinking") thought += ev.text;
        else if (ev.type === "usage") {
          usage = ev.usage;
          $("usage").textContent = `in ${ev.usage.inputTokens} / out ${ev.usage.outputTokens} tok`;
          showContextUsage(ev.usage);
        }
        else if (ev.type === "error") answer += `\n\n> ⚠ ${ev.message}`;
        const stick = isNearBottom();
        setContent(el, answer, thought, true);
        if (stick) scroll.scrollTop = scroll.scrollHeight;
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      el.querySelector(".content").innerHTML =
        `<div class="err">送信に失敗しました: ${esc(err.message)}<br>サーバーのコンソールログを確認してください。</div>`;
    }
  } finally {
    streaming = null;
    $("send").classList.remove("stop"); $("send").textContent = "➤";
    const meta = usage ? { usage } : undefined;
    setContent(el, answer, thought, false, null, meta);
    el.querySelector(".msg-actions")?.remove(); // drop the live "中断" bar before the real actions
    const now = Date.now();
    addMessageActions(el, answer, { canRegenerate: true, threadId: t.id, at: now });
    if (answer.trim()) addCodeButton(el, answer);
    if (answer || thought) t.messages.push({ role: "assistant", content: answer, thinking: thought, at: now, ...(meta ? { meta } : {}) });
    persist();
    updateContextBar(t);
    notifyTurnComplete(t.title, answer);
    $("input").focus();
    if (isFirstExchange && answer) generateTitle(t, modelId, t.messages[0].content, answer);
  }
}

/** 会話の最初の一往復から短いタイトルを作る。失敗しても既定の
 *  「先頭34文字」タイトルのままでよいので、エラーは黙って捨てる。
 *  リージョンロック対象外モデルの場合はサーバーが {title:null} を返す。 */
async function generateTitle(t, modelId, userText, assistantText){
  try {
    const r = await fetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, userText, assistantText })
    });
    const d = await r.json();
    if (d.title) { t.title = d.title; persist(); renderThreadList(); }
  } catch {}
}

async function regenerateBedrock(threadId){
  if (streaming) return;
  const t = threads.find((x) => x.id === threadId);
  const last = t?.messages.at(-1);
  if (!last || last.role !== "assistant") return;
  t.messages.pop();
  if (currentId === threadId) render();
  await runBedrockTurn(t);
}

/* --------------------- Claude Code chat sessions (threads) --------------- */
// A "claude-code" thread is a continuing conversation backed by a real
// Claude Code session (see code-agent/sessions.js), as opposed to a
// "bedrock" thread's direct ConverseStream calls. The two never mix within
// one thread; kind is fixed at thread creation.

async function openNewClaudeCodeChat(){
  const sel = $("ccRepo");
  sel.innerHTML = `<option value="">読み込み中…</option>`;
  sel.disabled = true;
  $("ccNewStart").disabled = true;
  $("ccNewStatus").textContent = "";
  $("ccNewModal").hidden = false;
  try {
    const r = await fetch("/api/code/repos");
    const d = await r.json();
    const repos = d.repos ?? [];
    sel.innerHTML = "";
    if (!repos.length) {
      sel.innerHTML = `<option value="">許可フォルダが未登録です（⚙で登録してください）</option>`;
      $("ccNewStatus").textContent = "Repositoryがありません。⚙の設定で許可フォルダを登録してください。";
      $("ccNewStatus").className = "code-status err2";
      return;
    }
    for (const repo of repos) {
      const o = document.createElement("option");
      o.value = repo.path; o.textContent = `${repo.name} (${repo.path})`;
      sel.appendChild(o);
    }
    const lastRepo = store.get("chat.lastRepo", null);
    if (lastRepo && repos.some(r => r.path === lastRepo.path)) sel.value = lastRepo.path;
    $("ccMode").value = store.get("chat.lastMode", "plan");
    sel.disabled = false;
    $("ccNewStart").disabled = false;
  } catch (err) {
    sel.innerHTML = `<option value="">取得に失敗しました</option>`;
    $("ccNewStatus").textContent = `Repository一覧の取得に失敗しました: ${err.message}`;
    $("ccNewStatus").className = "code-status err2";
  }
}
function closeNewClaudeCodeChat(){
  $("ccNewModal").hidden = true;
}
function createClaudeCodeThread(repoPath, repoLabel, mode){
  const t = {
    id: crypto.randomUUID(), title: repoLabel.split(" (")[0], messages: [], at: Date.now(),
    kind: "claude-code", repoPath, repoLabel, mode, sessionId: null,
  };
  threads.unshift(t);
  store.set("chat.lastRepo", { path: repoPath, label: repoLabel });
  store.set("chat.lastMode", mode);
  return t;
}
function startClaudeCodeThread(){
  const repoPath = $("ccRepo").value;
  if (!repoPath) return;
  const repoLabel = $("ccRepo").selectedOptions[0]?.textContent ?? repoPath;
  const mode = $("ccMode").value;
  const t = createClaudeCodeThread(repoPath, repoLabel, mode);
  currentId = t.id; persist(); setSidebarTab("code"); render();
  closeNewClaudeCodeChat();
  if ($("input").value.trim()) sendClaudeCode();
  else $("input").focus();
}

// "type & hit send" quick-start for the Code tab, mirroring how Home just
// works with no setup: reuses the last repo/mode if we have one (or the
// only repo, if there's just one), so a Repository picker only interrupts
// the flow when it's genuinely ambiguous.
// True for the whole repo-lookup + thread-creation span, not just the
// fetch — without this, pressing Enter twice in quick succession (or Enter
// then clicking send) re-enters this function during the first call's
// `await fetch(...)`, before a thread even exists to guard against via the
// usual ccBusy/streaming checks, and creates two threads/sessions for one
// typed message.
let quickStartInFlight = false;
async function quickStartClaudeCode(){
  if (quickStartInFlight) return;
  const text = $("input").value.trim();
  if (!text) return;
  quickStartInFlight = true;
  try {
    const lastRepo = store.get("chat.lastRepo", null);
    let repoPath = null, repoLabel = null;
    try {
      const r = await fetch("/api/code/repos");
      const d = await r.json();
      const repos = d.repos ?? [];
      if (!repos.length) {
        flash("Repositoryが未登録です。⚙の設定で許可フォルダを登録してください");
        return;
      }
      const matched = lastRepo && repos.find(x => x.path === lastRepo.path);
      if (matched) { repoPath = matched.path; repoLabel = `${matched.name} (${matched.path})`; }
      else if (repos.length === 1) { repoPath = repos[0].path; repoLabel = `${repos[0].name} (${repos[0].path})`; }
    } catch {
      flash("Repository一覧の取得に失敗しました");
      return;
    }

    if (!repoPath) { openNewClaudeCodeChat(); return; } // ambiguous — let the user pick, typed text stays put

    const mode = store.get("chat.lastMode", "plan");
    const t = createClaudeCodeThread(repoPath, repoLabel, mode);
    currentId = t.id; persist(); setSidebarTab("code"); render();
    await sendClaudeCode();
  } finally {
    quickStartInFlight = false;
  }
}

// One persistent SSE connection per active thread, reused across turns so a
// resumed session's replay is only ever consumed once (see ensureCcConnection).
const ccConnections = new Map(); // threadId -> { sessionId, es, active, skipRemaining }
const ccBusy = new Set(); // thread ids currently awaiting a turn's completion

function ensureCcConnection(threadId, sessionId, skipCount){
  const existing = ccConnections.get(threadId);
  if (existing && existing.sessionId === sessionId) return existing;
  if (existing?.es) existing.es.close();

  const entry = { sessionId, es: null, active: null, skipRemaining: skipCount ?? 0 };
  const es = new EventSource(`/api/code/sessions/${encodeURIComponent(sessionId)}/events`);
  for (const type of ["started", "tool", "text", "completed", "error", "cancelled"]) {
    es.addEventListener(type, (e) => {
      // Opening/reopening this connection replays every past turn's events.
      // skipCount is the exact pre-turn event count the server captured
      // synchronously when this turn was submitted (see sendClaudeCode), so
      // there's no race between "how many to skip" and "the turn starting".
      if (entry.skipRemaining > 0) { entry.skipRemaining--; return; }
      const cur = entry.active;
      if (!cur) return; // no turn currently in flight for this connection
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.type === "started") {
        // Only the CLI knows which model it actually used (its own config/
        // login decides this, not this app) — capture it the first time and
        // reflect it in the header badge for whichever thread this is.
        if (evt.model) {
          const t = threads.find(x => x.id === threadId);
          if (t && t.model !== evt.model) {
            t.model = evt.model;
            persist();
            if (currentId === threadId) { $("ccInfo").textContent = ccInfoText(t); }
          }
        }
      } else if (evt.type === "tool") {
        cur.tools.push({ tool: evt.tool, target: evt.target });
        setContent(cur.el, cur.answer, cur.thought, true, cur.tools);
      } else if (evt.type === "text") {
        cur.answer += evt.text;
        setContent(cur.el, cur.answer, cur.thought, true, cur.tools);
      } else if (evt.type === "completed") {
        cur.meta = { usage: evt.usage, durationMs: evt.durationMs, costUsd: evt.costUsd };
        entry.active = null;
        cur.onDone();
      } else if (evt.type === "error") {
        cur.answer += (cur.answer ? "\n\n" : "") + `> ⚠ ${evt.message}`;
        cur.meta = { usage: evt.usage, durationMs: evt.durationMs };
        entry.active = null;
        cur.onDone();
      } else if (evt.type === "cancelled") {
        cur.answer += (cur.answer ? "\n\n" : "") + `> ⏹ 中断しました`;
        entry.active = null;
        cur.onDone();
      }
    });
  }
  // Workflow events are handled outside the skip-gated loop above: each one
  // carries the *complete* current workflow snapshot (not a delta), so
  // replaying old ones on reconnect is harmless — re-rendering to each
  // historical state in turn just lands on the true current one once the
  // replay catches up. No dedup bookkeeping needed.
  es.addEventListener("workflow", (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    renderWorkflow(threadId, evt.workflow);
  });
  entry.es = es;
  ccConnections.set(threadId, entry);
  return entry;
}

// Session ids we've already checked in this page load — a browser refresh
// clears this, but re-checking the same session on every render() would be
// wasteful, so each one is only reattached-to (or confirmed idle) once.
const ccChecked = new Set();

async function maybeReconnectClaudeCode(t){
  if (!t || t.kind !== "claude-code" || !t.sessionId || ccChecked.has(t.sessionId)) return;
  ccChecked.add(t.sessionId);
  let data;
  try {
    const res = await fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}`);
    if (!res.ok) { t.sessionId = null; persist(); return; } // gone server-side (e.g. restart) — next send starts a fresh session
    data = await res.json();
  } catch { return; }
  if (!data.busy) return; // idle — nothing in flight to reattach to

  ccBusy.add(t.id);
  if (currentId === t.id) setCcSendBusy(true);
  const el = appendAssistantPlaceholder();
  if (currentId === t.id) { log.appendChild(el); scroll.scrollTop = scroll.scrollHeight; }
  addInterruptButton(el, () => cancelClaudeCodeTurn(t));

  const conn = ensureCcConnection(t.id, t.sessionId, data.turnStartIndex);
  conn.active = {
    el, answer: "", thought: "", tools: [], meta: null,
    onDone(){
      ccBusy.delete(t.id);
      if (currentId === t.id) setCcSendBusy(false);
      setContent(el, this.answer, this.thought, false, this.tools, this.meta);
      el.querySelector(".msg-actions")?.remove();
      const now = Date.now();
      addMessageActions(el, this.answer, { at: now });
      t.messages.push({ role: "assistant", content: this.answer, thinking: this.thought, tools: this.tools, meta: this.meta, at: now });
      persist();
      notifyTurnComplete(t.title, this.answer);
    },
  };
}
function cancelClaudeCodeTurn(t){
  if (t.sessionId) fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/cancel`, { method: "POST" }).catch(() => {});
}

function setCcSendBusy(busy){
  $("send").classList.toggle("stop", busy);
  $("send").textContent = busy ? "■" : "➤";
}

/**
 * Shared by every action that sends a Claude Code turn (plain chat, Plan,
 * Approve, Request changes): wires up ccBusy/the send-as-stop button, waits
 * for the HTTP ack, attaches the SSE connection, and streams the response
 * live into `el`. resPromise is the already-issued fetch() for that turn's
 * specific endpoint — this only handles what's identical across all of them.
 */
async function attachCcTurn(t, el, resPromise){
  ccBusy.add(t.id);
  if (currentId === t.id) setCcSendBusy(true);
  addInterruptButton(el, () => cancelClaudeCodeTurn(t));

  const fail = (msg) => {
    ccBusy.delete(t.id);
    if (currentId === t.id) setCcSendBusy(false);
    setContent(el, msg, "", false, []);
    el.querySelector(".msg-actions")?.remove();
    t.messages.push({ role: "assistant", content: msg, at: Date.now() });
    persist();
    if (currentId === t.id) $("input").focus();
  };

  try {
    const res = await resPromise;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { fail(`⚠ ${(data.errors ?? [data.error ?? res.statusText]).join(" / ")}`); return; }
    if (!t.sessionId && data.sessionId) { t.sessionId = data.sessionId; persist(); }

    const conn = ensureCcConnection(t.id, t.sessionId, data.turnStartIndex);
    await new Promise((resolvePromise) => {
      conn.active = {
        el, answer: "", thought: "", tools: [], meta: null,
        onDone(){
          ccBusy.delete(t.id);
          if (currentId === t.id) setCcSendBusy(false);
          setContent(el, this.answer, this.thought, false, this.tools, this.meta);
          el.querySelector(".msg-actions")?.remove();
          const now = Date.now();
          addMessageActions(el, this.answer, { at: now });
          t.messages.push({ role: "assistant", content: this.answer, thinking: this.thought, tools: this.tools, meta: this.meta, at: now });
          persist();
          notifyTurnComplete(t.title, this.answer);
          if (currentId === t.id) $("input").focus();
          resolvePromise();
        },
      };
    });
  } catch (err) {
    fail(`⚠ 通信エラー: ${err.message}`);
  }
}

async function sendClaudeCode(){
  const t = current();
  if (ccBusy.has(t.id)) {
    // Send button doubles as Stop while this thread is mid-turn.
    cancelClaudeCodeTurn(t);
    return;
  }
  const text = $("input").value.trim();
  if (!text) return;
  if (pending.length) { flash("Claude Codeモードではファイル添付は使えません"); pending = []; renderTray(); }

  t.messages.push({ role: "user", content: text, at: Date.now() });
  if (t.messages.length === 1) t.title = text.slice(0, 34);
  t.at = Date.now();
  $("input").value = ""; $("input").style.height = "auto";
  render();

  const el = appendAssistantPlaceholder();
  log.appendChild(el);
  scroll.scrollTop = scroll.scrollHeight;

  const resPromise = t.sessionId
    ? fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      })
    : fetch("/api/code/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: t.repoPath, mode: t.mode, prompt: text }),
      });
  await attachCcTurn(t, el, resPromise);
}

/* ----------------------- Claude Code workflow (Plan) ---------------------- */
// Optional, explicit, layered on top of a chat session — see
// code-agent/sessions.js's CodeSessionManager docstring for the full
// planning -> plan_ready -> editing -> testing -> diff_ready -> done state
// diagram. Never entered by an ordinary chat message.

async function startClaudeCodeWorkflow(){
  const t = current();
  if (t.kind !== "claude-code") return;
  if (!t.sessionId) { flash("先に一度メッセージを送ってセッションを開始してください"); return; }
  if (ccBusy.has(t.id)) { flash("Claude Codeが応答中です…"); return; }
  const text = $("input").value.trim();
  if (!text) return;

  t.messages.push({ role: "user", content: text, at: Date.now() });
  t.at = Date.now();
  $("input").value = ""; $("input").style.height = "auto";
  render();

  const el = appendAssistantPlaceholder();
  log.appendChild(el);
  ensureWorkflowCard(t.id);
  scroll.scrollTop = scroll.scrollHeight;

  const resPromise = fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/plan`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: text }),
  });
  await attachCcTurn(t, el, resPromise);
}

async function approveWorkflowPlan(threadId){
  const t = threads.find((x) => x.id === threadId);
  if (!t?.sessionId || ccBusy.has(t.id)) return;
  const el = appendAssistantPlaceholder();
  if (currentId === threadId) { log.appendChild(el); scroll.scrollTop = scroll.scrollHeight; }
  await attachCcTurn(t, el, fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/workflow/approve`, { method: "POST" }));
}

async function requestWorkflowChanges(threadId, feedback){
  const t = threads.find((x) => x.id === threadId);
  if (!t?.sessionId || ccBusy.has(t.id) || !feedback.trim()) return;
  t.messages.push({ role: "user", content: feedback, at: Date.now() });
  t.at = Date.now();
  persist();
  if (currentId === threadId) render();
  const el = appendAssistantPlaceholder();
  if (currentId === threadId) { log.appendChild(el); scroll.scrollTop = scroll.scrollHeight; }
  await attachCcTurn(t, el, fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/workflow/revise`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedback }),
  }));
}

async function commitWorkflowAction(threadId, message){
  const t = threads.find((x) => x.id === threadId);
  if (!t?.sessionId || !message.trim()) return;
  try {
    const res = await fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/workflow/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) flash(`⚠ ${(data.errors ?? []).join(" / ")}`);
  } catch (err) {
    flash(`⚠ 通信エラー: ${err.message}`);
  }
}

async function discardWorkflowAction(threadId){
  const t = threads.find((x) => x.id === threadId);
  if (!t?.sessionId) return;
  if (!confirm("Claude Codeが行った変更を破棄します。よろしいですか？")) return;
  try {
    const res = await fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/workflow/discard`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) flash(`⚠ ${(data.errors ?? []).join(" / ")}`);
  } catch (err) {
    flash(`⚠ 通信エラー: ${err.message}`);
  }
}

async function cancelWorkflowAction(threadId){
  const t = threads.find((x) => x.id === threadId);
  if (!t?.sessionId) return;
  try {
    await fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/workflow/cancel`, { method: "POST" });
  } catch {}
}

function defaultCommitMessage(wf){
  const firstLine = (wf.plan || "").split("\n").find((l) => l.trim()) || "";
  return firstLine.replace(/^#+\s*/, "").trim().slice(0, 72);
}

function ensureWorkflowCard(threadId){
  let card = document.getElementById(`wfCard-${threadId}`);
  if (card) return card;
  card = document.createElement("div");
  card.className = "wf-card";
  card.id = `wfCard-${threadId}`;
  card.innerHTML = `
    <div class="wf-head"><b>📋 実装ワークフロー</b><span class="wf-badge" id="wfBadge-${threadId}"></span></div>
    <div class="wf-steps" id="wfSteps-${threadId}"></div>
    <div class="wf-body" id="wfBody-${threadId}"></div>
  `;
  if (currentId === threadId) { log.appendChild(card); scroll.scrollTop = scroll.scrollHeight; }
  return card;
}

const WF_STEPS = [
  { key: "planning", label: "計画" },
  { key: "editing", label: "実装" },
  { key: "testing", label: "テスト" },
  { key: "diff_ready", label: "レビュー" },
  { key: "done", label: "完了" },
];
const WF_STATUS_RANK = { planning: 0, plan_ready: 0, editing: 1, testing: 2, diff_ready: 3, done: 4 };
const WF_STATUS_LABELS = {
  planning: "計画中", plan_ready: "承認待ち", editing: "実装中", testing: "テスト実行中",
  diff_ready: "レビュー待ち", done: "完了", discarded: "破棄済み", failed: "失敗", cancelled: "キャンセル済み",
};

function renderWorkflowSteps(wf){
  const bad = ["failed", "cancelled", "discarded"].includes(wf.status);
  const rank = WF_STATUS_RANK[wf.status] ?? 0;
  return WF_STEPS.map((s, i) => {
    let cls = "wf-step", mark = "○";
    if (!bad) {
      if (i < rank) { cls += " done"; mark = "✓"; }
      else if (i === rank) { cls += " current"; mark = "●"; }
    }
    return `<div class="${cls}"><span class="m">${mark}</span><span>${esc(s.label)}</span></div>`;
  }).join("");
}

function renderWorkflowBody(threadId, wf){
  const t = threads.find((x) => x.id === threadId);
  const bodyEl = document.getElementById(`wfBody-${threadId}`);
  if (!bodyEl) return;

  if (wf.status === "planning") {
    bodyEl.innerHTML = `<div class="wf-note">計画を検討しています…</div>`;
  } else if (wf.status === "plan_ready") {
    bodyEl.innerHTML = `
      <div class="wf-plan">${md(wf.plan || "")}</div>
      ${wf.error ? `<div class="err">${esc(wf.error)}</div>` : ""}
      <div class="wf-feedback"><textarea id="wfFeedback-${threadId}" placeholder="修正内容を入力（修正を依頼する場合）"></textarea></div>
      <div class="wf-actions">
        <button class="wf-btn" data-action="cancel">キャンセル</button>
        <button class="wf-btn" data-action="revise">修正を依頼</button>
        <button class="wf-btn primary" data-action="approve">実装を開始</button>
      </div>`;
  } else if (wf.status === "editing") {
    bodyEl.innerHTML = `<div class="wf-note">計画に沿って実装しています…（Repository: <code>${esc(wf.branch || "")}</code>）</div>`;
  } else if (wf.status === "testing") {
    bodyEl.innerHTML = `<div class="wf-note">テストを実行しています…</div>`;
  } else if (wf.status === "diff_ready") {
    const test = wf.test;
    const testHtml = !test ? "" : !test.ran
      ? `<div class="wf-test">テストは実行されませんでした（${esc(test.reason || "")}）</div>`
      : `<div class="wf-test ${test.passed ? "pass" : "fail"}">${test.passed ? "✓" : "✕"} ${esc(test.label)}${test.timedOut ? "（タイムアウト）" : ""}
           <details><summary>出力を見る</summary><pre>${esc(test.output || "(出力なし)")}</pre></details></div>`;
    const files = wf.diff?.changedFiles ?? [];
    const diffHtml = `<div class="wf-diff">変更ファイル: ${files.length ? files.map(esc).join(", ") : "(なし)"}${wf.diff?.shortStat ? ` (${esc(wf.diff.shortStat)})` : ""}
      ${files.length ? `<button class="wf-link" data-action="showDiff" type="button">差分を表示</button><pre class="wf-fulldiff" id="wfFullDiff-${threadId}" hidden></pre>` : ""}</div>`;
    bodyEl.innerHTML = `
      ${testHtml}
      ${diffHtml}
      ${wf.error ? `<div class="err">${esc(wf.error)}</div>` : ""}
      <div class="wf-feedback"><textarea id="wfFeedback-${threadId}" placeholder="修正内容を入力（修正を依頼する場合）"></textarea></div>
      <div class="field"><label>Commit message</label><textarea id="wfCommitMsg-${threadId}" rows="2">${esc(defaultCommitMessage(wf))}</textarea></div>
      <div class="wf-actions">
        <button class="wf-btn" data-action="discard">破棄</button>
        <button class="wf-btn" data-action="revise">修正を依頼</button>
        <button class="wf-btn primary" data-action="commit">Commitする</button>
      </div>`;
  } else if (wf.status === "done") {
    bodyEl.innerHTML = `<div class="wf-note ok">✓ Commitしました${wf.commitHash ? `（<code>${esc(wf.commitHash)}</code>）` : ""}</div>`;
  } else if (wf.status === "discarded") {
    bodyEl.innerHTML = `<div class="wf-note">変更を破棄しました。</div>`;
  } else if (wf.status === "cancelled") {
    bodyEl.innerHTML = `<div class="wf-note">キャンセルしました。</div>`;
  } else if (wf.status === "failed") {
    bodyEl.innerHTML = `
      <div class="err">${esc(wf.error || "エラーが発生しました")}</div>
      <div class="wf-actions">${wf.branch ? '<button class="wf-btn" data-action="discard">後片付け（ブランチを破棄）</button>' : '<button class="wf-btn" data-action="cancel">閉じる</button>'}</div>`;
  }

  bodyEl.querySelectorAll("[data-action]").forEach((btn) => {
    const action = btn.dataset.action;
    if (action === "showDiff") {
      btn.onclick = async () => {
        const pre = document.getElementById(`wfFullDiff-${threadId}`);
        if (!pre) return;
        if (!pre.hidden) { pre.hidden = true; return; }
        pre.hidden = false;
        pre.textContent = "読み込み中…";
        try {
          const d = await (await fetch(`/api/code/sessions/${encodeURIComponent(t.sessionId)}/diff`)).json();
          pre.textContent = (d.diff || "").trim() || "(差分なし)";
        } catch (err) {
          pre.textContent = `取得に失敗しました: ${err.message}`;
        }
      };
      return;
    }
    btn.onclick = () => {
      const feedback = document.getElementById(`wfFeedback-${threadId}`)?.value?.trim() || "";
      if (action === "approve") approveWorkflowPlan(threadId);
      else if (action === "revise") {
        if (!feedback) { flash("修正内容を入力してください"); return; }
        requestWorkflowChanges(threadId, feedback);
      } else if (action === "cancel") cancelWorkflowAction(threadId);
      else if (action === "discard") discardWorkflowAction(threadId);
      else if (action === "commit") {
        const msg = document.getElementById(`wfCommitMsg-${threadId}`)?.value?.trim();
        if (!msg) { flash("コミットメッセージを入力してください"); return; }
        commitWorkflowAction(threadId, msg);
      }
    };
  });
}

function renderWorkflow(threadId, wf){
  if (!wf) return;
  const t = threads.find((x) => x.id === threadId);
  if (t) t.workflow = wf; // best-effort mirror so switching threads redisplays the latest known state

  ensureWorkflowCard(threadId);
  const badge = document.getElementById(`wfBadge-${threadId}`);
  const stepsEl = document.getElementById(`wfSteps-${threadId}`);
  if (badge) {
    badge.textContent = WF_STATUS_LABELS[wf.status] || wf.status;
    badge.className = "wf-badge " + (wf.status === "done" ? "done" : ["failed", "discarded", "cancelled"].includes(wf.status) ? "bad" : "active");
  }
  if (stepsEl) stepsEl.innerHTML = renderWorkflowSteps(wf);
  renderWorkflowBody(threadId, wf);
  if (currentId === threadId) scroll.scrollTop = scroll.scrollHeight;
}

/* ------------------------- Claude Code integration ----------------------- */
// State machine: CHAT -> CODE_REQUEST_MODAL -> STARTING -> CODE_STARTED
//                                            \-> ERROR -> (back to CODE_REQUEST_MODAL)
// Cancel from CODE_REQUEST_MODAL returns to CHAT. Nothing here auto-sends;
// "実装開始" is the human's explicit approval of the (editable) prompt below.
let codeModalState = "CHAT";

function showCodeStatus(msg, isError){
  const el = $("codeStatus");
  el.textContent = msg || "";
  el.className = "code-status" + (isError ? " err2" : "");
}
function setCodeExecuteBusy(busy, label){
  $("codeExecute").disabled = busy;
  $("codeExecute").textContent = label || "実装開始";
}

async function loadCodeRepos(){
  const sel = $("codeRepo");
  sel.innerHTML = `<option value="">読み込み中…</option>`;
  sel.disabled = true;
  try {
    const r = await fetch("/api/code/repos");
    const d = await r.json();
    const repos = d.repos ?? [];
    sel.innerHTML = "";
    if (!repos.length) {
      sel.innerHTML = `<option value="">許可フォルダが未登録です（⚙で登録してください）</option>`;
      showCodeStatus("Repositoryがありません。⚙の設定で許可フォルダを登録してください。", true);
      setCodeExecuteBusy(true);
      return;
    }
    for (const repo of repos) {
      const o = document.createElement("option");
      o.value = repo.path; o.textContent = `${repo.name} (${repo.path})`;
      sel.appendChild(o);
    }
    sel.disabled = false;
    setCodeExecuteBusy(false);
  } catch (err) {
    sel.innerHTML = `<option value="">取得に失敗しました</option>`;
    showCodeStatus(`Repository一覧の取得に失敗しました: ${err.message}`, true);
    setCodeExecuteBusy(true);
  }
}

async function openCodeModal(promptText){
  codeModalState = "CODE_REQUEST_MODAL";
  $("codePrompt").value = promptText || "";
  $("codeMode").value = "plan";
  showCodeStatus("");
  setCodeExecuteBusy(false, "実装開始");
  $("codeModal").hidden = false;
  await loadCodeRepos();
}
function closeCodeModal(){
  codeModalState = "CHAT";
  $("codeModal").hidden = true;
}

// Creates a new Claude Code chat thread and starts it directly in the Plan ->
// Approval -> Edit -> Test -> Diff -> Approval -> Commit workflow (via
// POST /api/code/sessions/plan), so a one-shot "実装を依頼" request gets the
// exact same safety loop — and the exact same chat + workflow-card UI — as
// starting a plan mid-conversation with 📋, rather than a separate, untracked
// fire-and-forget run.
async function executeCodeRequest(){
  const repoPath = $("codeRepo").value;
  const repoLabel = $("codeRepo").selectedOptions[0]?.textContent ?? repoPath;
  const prompt = $("codePrompt").value.trim();
  const mode = $("codeMode").value;
  if (!repoPath) { showCodeStatus("Repositoryを選択してください", true); return; }
  if (!prompt) { showCodeStatus("Implementation Promptを入力してください", true); return; }

  codeModalState = "STARTING";
  setCodeExecuteBusy(true, "起動中…");
  showCodeStatus("Claude Codeを起動しています…");

  const t = {
    id: crypto.randomUUID(), title: prompt.slice(0, 34), messages: [], at: Date.now(),
    kind: "claude-code", repoPath, repoLabel, mode, sessionId: null,
  };
  t.messages.push({ role: "user", content: prompt, at: Date.now() });
  threads.unshift(t); currentId = t.id; persist(); setSidebarTab("code"); render();
  closeCodeModal();

  const el = appendAssistantPlaceholder();
  log.appendChild(el);
  ensureWorkflowCard(t.id);
  scroll.scrollTop = scroll.scrollHeight;

  const resPromise = fetch("/api/code/sessions/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, prompt, mode }),
  });
  await attachCcTurn(t, el, resPromise);
}

$("codeCancel").onclick = closeCodeModal;
$("codeExecute").onclick = executeCodeRequest;
$("codeModal").addEventListener("click", (e) => { if (e.target.id === "codeModal") closeCodeModal(); });
$("ccNewCancel").onclick = closeNewClaudeCodeChat;
$("ccNewStart").onclick = startClaudeCodeThread;
$("ccNewModal").addEventListener("click", (e) => { if (e.target.id === "ccNewModal") closeNewClaudeCodeChat(); });
$("shortcutsClose").onclick = () => { $("shortcutsModal").hidden = true; };
$("shortcutsModal").addEventListener("click", (e) => { if (e.target.id === "shortcutsModal") $("shortcutsModal").hidden = true; });
document.addEventListener("keydown", (e) => {
  // The thread kebab menu only auto-closes on outside click; keyboard-only
  // flows (e.g. Enter to send) never fire a click, so it could otherwise
  // stay stuck open indefinitely across turns. Any keypress dismisses it.
  if (!$("threadMenu").hidden) closeThreadMenu();
  if (e.key === "Escape") {
    if (!$("codeModal").hidden) closeCodeModal();
    if (!$("ccNewModal").hidden) closeNewClaudeCodeChat();
    if (!$("shortcutsModal").hidden) $("shortcutsModal").hidden = true;
    return;
  }
  if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    e.preventDefault();
    $("shortcutsModal").hidden = false;
  }
});

/* ------------------------------- wiring --------------------------------- */
function submitCurrent(){
  const t = threads.find(x => x.id === currentId);
  if (t?.kind === "claude-code") { sendClaudeCode(); return; }
  if (sidebarTab === "code") { quickStartClaudeCode(); return; }
  send();
}
$("send").onclick = submitCurrent;
$("input").addEventListener("keydown", e => {
  if (!$("tplPicker").hidden) {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); document.querySelector(".tpl-picker-item")?.click(); return; }
    if (e.key === "Escape") { $("tplPicker").hidden = true; return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitCurrent(); }
});
$("input").addEventListener("input", e => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 240) + "px";
});

/* ------------------------- prompt templates (/) --------------------------- */
let promptTemplates = store.get("chat.templates", []);
function renderTemplatesSettings(){
  const list = $("templatesList");
  list.innerHTML = "";
  if (!promptTemplates.length) {
    list.innerHTML = `<div class="thread-empty">まだテンプレートがありません</div>`;
    return;
  }
  promptTemplates.forEach((tpl, i) => {
    const row = document.createElement("div");
    row.className = "template-row";
    row.innerHTML = `<b></b><span></span><button class="tpl-del" title="削除">${ICON_TRASH}</button>`;
    row.querySelector("b").textContent = tpl.name;
    row.querySelector("span").textContent = tpl.text;
    row.querySelector(".tpl-del").onclick = () => {
      promptTemplates.splice(i, 1);
      store.set("chat.templates", promptTemplates);
      renderTemplatesSettings();
    };
    list.appendChild(row);
  });
}
$("tplAdd").onclick = () => {
  const name = $("tplName").value.trim();
  const text = $("tplText").value.trim();
  if (!name || !text) return;
  promptTemplates.push({ name, text });
  store.set("chat.templates", promptTemplates);
  $("tplName").value = ""; $("tplText").value = "";
  renderTemplatesSettings();
};
renderTemplatesSettings();

/* --------------------------- turn-complete notify -------------------------- */
let notifySound = store.get("chat.notifySound", false);
let notifyDesktop = store.get("chat.notifyDesktop", false);
$("notifySound").checked = notifySound;
$("notifyDesktop").checked = notifyDesktop && Notification?.permission === "granted";
$("notifySound").onchange = () => {
  notifySound = $("notifySound").checked;
  store.set("chat.notifySound", notifySound);
};
$("notifyDesktop").onchange = async () => {
  if ($("notifyDesktop").checked) {
    const perm = await Notification.requestPermission().catch(() => "denied");
    if (perm !== "granted") { $("notifyDesktop").checked = false; notifyDesktop = false; store.set("chat.notifyDesktop", false); return; }
  }
  notifyDesktop = $("notifyDesktop").checked;
  store.set("chat.notifyDesktop", notifyDesktop);
};
function playNotifySound(){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch {}
}
function notifyTurnComplete(title, body){
  if (notifySound) playNotifySound();
  if (notifyDesktop && document.hidden && Notification?.permission === "granted") {
    try { new Notification(title, { body: (body || "").slice(0, 120) }); } catch {}
  }
}

function updateTplPicker(){
  const val = $("input").value;
  if (!val.startsWith("/") || !promptTemplates.length) { $("tplPicker").hidden = true; return; }
  const q = val.slice(1).toLowerCase();
  const matches = promptTemplates.filter(tpl => tpl.name.toLowerCase().includes(q));
  if (!matches.length) { $("tplPicker").hidden = true; return; }
  $("tplPickerList").innerHTML = "";
  for (const tpl of matches) {
    const row = document.createElement("div");
    row.className = "tpl-picker-item";
    row.innerHTML = "<b></b><span></span>";
    row.querySelector("b").textContent = tpl.name;
    row.querySelector("span").textContent = tpl.text;
    row.onclick = () => {
      $("input").value = tpl.text;
      $("tplPicker").hidden = true;
      $("input").dispatchEvent(new Event("input"));
      $("input").focus();
    };
    $("tplPickerList").appendChild(row);
  }
  $("tplPicker").hidden = false;
}
$("input").addEventListener("input", updateTplPicker);
document.addEventListener("click", (e) => {
  if (!$("tplPicker").hidden && !$("tplPicker").contains(e.target) && e.target !== $("input")) $("tplPicker").hidden = true;
});
$("newchat").onclick = () => newThread();
$("newChatCode").onclick = openNewClaudeCodeChat;
$("ccPlan").onclick = startClaudeCodeWorkflow;
$("toggle").onclick = () => $("sidebar").classList.toggle("hidden");
$("gear").onclick = () => $("settings").classList.toggle("open");
$("export").onclick = () => {
  // Deliberately not current() here: its newThread() fallback would create
  // and switch to a brand-new Home chat out from under someone who's on the
  // Code tab with nothing selected yet, just because they clicked "save".
  const t = threads.find(x => x.id === currentId);
  if (!t || !t.messages.length) { flash("書き出す会話がありません"); return; }
  const body = t.messages.map(m => `## ${m.role === "user" ? "あなた" : "Claude"}\n\n${m.content}`).join("\n\n---\n\n");
  const url = URL.createObjectURL(new Blob([`# ${t.title}\n\n${body}\n`], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url; a.download = `${t.title.replace(/[\\/:*?"<>|]/g, "_")}.md`; a.click();
  URL.revokeObjectURL(url);
};
for (const [id, key] of [["system","chat.system"],["temp","chat.temp"],["maxtok","chat.maxtok"],["think","chat.think"],["memo","chat.memo"],["stylePreset","chat.stylePreset"]]) {
  const saved = store.get(key, null);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener("change", () => store.set(key, $(id).value));
}

(async function init(){
  // Server-side history backup: browser localStorage stays the fast path,
  // but corporate PCs periodically get their browser cache/site data wiped
  // (common when the machine slows down), which would otherwise lose every
  // conversation. Prefer the server copy if it has anything; otherwise, if
  // this browser already has local history but the server file doesn't
  // exist yet, push it up once so future clears are covered too.
  try {
    const res = await fetch("/api/history");
    if (res.ok) {
      const data = await res.json();
      // Only from here on is it safe to let persist() write to the server —
      // see historyBackupHealthy's definition for why an unconfirmed read
      // must never be followed by a write.
      historyBackupHealthy = true;
      if (data.threads?.length) {
        threads = data.threads;
        currentId = data.current;
        store.set("chat.threads", threads);
        store.set("chat.current", currentId);
      } else if (threads.length) {
        persist();
      }
    } else {
      console.warn("[history] server backup unavailable (HTTP " + res.status + ") — this session will not overwrite it");
      showSetupBanner("会話履歴のサーバーバックアップを読み込めませんでした。データ保護のため、このセッションではサーバーへの保存を一時的に無効にしています（ブラウザ内には引き続き保存されます）。");
    }
  } catch {
    console.warn("[history] server backup unreachable — this session will not overwrite it");
    showSetupBanner("会話履歴のサーバーバックアップに接続できませんでした。データ保護のため、このセッションではサーバーへの保存を一時的に無効にしています（ブラウザ内には引き続き保存されます）。");
  }
  const savedRoots = store.get("chat.roots", "");
  if (savedRoots) { $("roots").value = savedRoots; registerRoots(); }
  let regionLocked = false;
  try {
    const cfg = await (await fetch("/api/config")).json();
    regionLocked = !!cfg.regionLocked;
    codeUsesBedrock = !!cfg.codeUsesBedrock;
    codeBedrockSource = cfg.codeBedrockSource ?? null;
    codeBedrockDetail = cfg.codeBedrockDetail ?? null;
    $("foot").textContent = `${cfg.region}${regionLocked ? " · 東京限定" : ""}${cfg.proxy ? " · proxy" : ""}${cfg.caBundle ? " · ca" : ""}`;
  } catch { $("foot").textContent = "server offline"; }
  // 東京リージョン運用時は、クロスリージョン推論プロファイル(global./apac./us.)が
  // サーバー側で拒否される。手入力にフォールバックする場合もそれを明示する。
  const modelPlaceholder = regionLocked
    ? "モデルIDを入力 (jp.anthropic.* または anthropic.* のみ)"
    : "モデルIDを入力 (例: apac.anthropic.claude-...)";
  const sel = $("model");
  try {
    const r = await fetch("/api/models");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    sel.innerHTML = "";
    for (const m of data.models) {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.name;
      sel.appendChild(o);
    }
    const saved = store.get("chat.model", null);
    if (saved && data.models.some(m => m.id === saved)) sel.value = saved;
    sel.onchange = () => store.set("chat.model", sel.value);
  } catch (err) {
    sel.outerHTML = `<input id="model" placeholder="${modelPlaceholder}" />`;
    const saved = store.get("chat.model", "");
    $("model").value = saved;
    $("model").onchange = () => store.set("chat.model", $("model").value);
    $("ctx").textContent = "モデル一覧の取得に失敗（IDを直接入力してください）";
    showSetupBanner(err.message || "モデル一覧を取得できませんでした。");
  }
  setSidebarTab(sidebarTab);
  if (!threads.length) newThread(); else render();
  $("input").focus();
})();
