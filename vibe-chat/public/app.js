(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = Markdown.escapeHtml;

  const FLOWS = {
    none: { icon: "", label: "なし", placeholder: "" },
    focus: { icon: "🎧", label: "集中モード（通知オフ）", placeholder: "例: 実装に集中" },
    brainstorm: { icon: "💡", label: "ブレスト中", placeholder: "例: 新機能の名前" },
    writing: { icon: "📄", label: "資料作成中", placeholder: "例: 週次レポート" },
    meeting: { icon: "🗣️", label: "会議中", placeholder: "例: 定例" },
    learning: { icon: "📚", label: "学習中", placeholder: "例: WebSocket" },
  };
  const STATUS_LABEL = { online: "オンライン", away: "離席中", busy: "取り込み中" };

  const state = {
    you: null,
    limits: { nameMax: 20, dmMax: 3, reactions: [] },
    users: [],
    channels: new Map(),
    messages: [],
    docs: new Map(),
    current: "general",
    favorites: new Set(), // 自分がお気に入りにしたメッセージ ID
    reads: {}, // channelId -> { name: 最後に読んだメッセージの時刻 }
    mentions: new Map(), // channelId -> 未読メンション数
    panel: null, // { type: "doc" | "favorites" | "pins", id }
    unread: new Map(),
    expanded: new Set(), // 返信を開いているスレッドの親メッセージ ID
    editing: null, // 編集中のメッセージ ID
    drafts: {}, // "reply:<id>" / "edit:<id>" -> 入力途中の文字列
    clientId: Math.random().toString(36).slice(2),
  };

  let ws = null;
  let pendingName = null;

  // ---------- 接続 ----------
  function connect(name) {
    pendingName = name;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    ws = socket;
    socket.onopen = () => sendWs({ type: "join", name });
    socket.onmessage = (e) => handle(JSON.parse(e.data));
    socket.onclose = () => {
      if (!pendingName) return;
      toast("接続が切れました。再接続しています…");
      setTimeout(() => connect(pendingName), 1500);
    };
  }

  function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function handle(data) {
    switch (data.type) {
      case "init":
        // 名前を変えたときも init が届くので、再接続用の名前を更新しておく
        state.you = data.you;
        pendingName = data.you;
        try { localStorage.setItem("vibe-chat-name", data.you); } catch {}
        state.limits = data.limits || state.limits;
        state.users = data.users;
        state.channels = new Map(data.channels.map((c) => [c.id, c]));
        state.messages = data.messages;
        state.docs = new Map(data.docs.map((d) => [d.id, d]));
        state.favorites = new Set(data.favorites || []);
        state.reads = data.reads || {};
        if (!state.channels.has(state.current)) state.current = "general";
        if (state.editing && !state.messages.some((m) => m.id === state.editing)) state.editing = null;
        $("#login").hidden = true;
        $("#app").hidden = false;
        renderAll();
        markRead();
        break;
      case "read":
        (state.reads[data.channelId] ||= {})[data.name] = data.at;
        if (data.channelId === state.current) renderMessages();
        break;
      case "users":
        state.users = data.users;
        renderSidebar();
        renderHeader();
        break;
      case "channel":
        state.channels.set(data.channel.id, data.channel);
        renderSidebar();
        break;
      case "open":
        openChannel(data.channelId);
        break;
      case "message":
        onMessage(data.message);
        break;
      case "messageUpdate":
        onMessageUpdate(data.message);
        break;
      case "favorites":
        state.favorites = new Set(data.ids);
        renderMessages();
        renderSidebar();
        renderPanel();
        break;
      case "doc":
        onDoc(data.doc, data.clientId);
        break;
      case "openDoc":
        openPanel("doc", data.docId);
        break;
      case "error":
        if (data.code === "join") {
          // ログインに失敗したら再接続せず、ログイン画面に戻す
          pendingName = null;
          ws.close();
        }
        toast(data.message);
        break;
    }
  }

  // ---------- ヘルパー ----------
  const me = () => state.users.find((u) => u.name === state.you) || {};
  const userByName = (name) => state.users.find((u) => u.name === name);
  const isOneOnOne = (c) => c.kind === "dm" && c.members.length <= 2;

  function colorFor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 65% 55%)`;
  }

  function avatar(name) {
    return `<span class="avatar" style="background:${colorFor(name)}">${esc(name.slice(0, 1).toUpperCase())}</span>`;
  }

  function dotClass(u) {
    if (!u || !u.online) return "dot offline";
    return `dot ${u.status}`;
  }

  function flowText(flow) {
    if (!flow || flow.kind === "none" || !FLOWS[flow.kind]) return "";
    const f = FLOWS[flow.kind];
    const d = flow.detail ? esc(flow.detail) : "";
    if (flow.kind === "brainstorm" && d) return `${f.icon} ${d}についてブレスト中`;
    if (flow.kind === "writing" && d) return `${f.icon} 資料「${d}」作成中`;
    return `${f.icon} ${f.label}${d ? `：${d}` : ""}`;
  }

  function dmOthers(c) {
    const others = c.members.filter((n) => n !== state.you);
    return others.length ? others : [state.you];
  }

  function channelLabel(c) {
    if (c.kind === "dm") return dmOthers(c).join("、");
    return c.name;
  }

  function channelPlace(c) {
    if (!c) return "";
    return c.kind === "public" ? `#${c.name}` : channelLabel(c);
  }

  // 1対1の DM（自分あての DM を含む）を探す
  function dmWith(name) {
    const key = [...new Set([state.you, name])].sort().join("\n");
    return [...state.channels.values()].find((c) => c.kind === "dm" && [...c.members].sort().join("\n") === key);
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderText(text, mentions = []) {
    let html = text.split("\n").map(Markdown.inline).join("<br>");
    if (mentions.length) {
      // 長い名前から順に当てて、短い名前が長い名前の一部に誤って一致しないようにする
      const names = [...mentions].sort((a, b) => b.length - a.length).map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      html = html.replace(new RegExp(`[@＠](${names.join("|")})`, "g"), (all, name) => {
        const mine = name === esc(state.you) ? " me" : "";
        return `<span class="mention${mine}">@${name}</span>`;
      });
    }
    return html;
  }

  // 送信者以外で、このメッセージまで読んだ人（ボットは数えない）
  function readers(m) {
    const r = state.reads[m.channelId] || {};
    return Object.entries(r)
      .filter(([name, ts]) => name !== m.author && ts >= m.createdAt && !(userByName(name) || {}).bot)
      .map(([name]) => name);
  }

  function markRead() {
    if (document.hidden || !state.you) return;
    const cid = state.current;
    const times = state.messages.filter((m) => m.channelId === cid).map((m) => m.createdAt);
    if (!times.length) return;
    const last = Math.max(...times);
    const mine = (state.reads[cid] || {})[state.you] || 0;
    if (last <= mine) return;
    (state.reads[cid] ||= {})[state.you] = last;
    sendWs({ type: "read", channelId: cid, at: last });
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- 描画 ----------
  function renderAll() {
    renderMe();
    renderSidebar();
    renderHeader();
    renderMessages();
    renderPanel();
  }

  function renderMe() {
    const u = me();
    $("#me-name").textContent = state.you;
    $("#me-dot").className = dotClass({ ...u, online: true });
    const parts = [STATUS_LABEL[u.status] || "オンライン"];
    if (u.customStatus) parts.push(esc(u.customStatus));
    const flow = flowText(u.flow);
    $("#me-status").innerHTML = parts.join(" · ") + (flow ? `<div class="flow-chip">${flow}</div>` : "");
    document.body.classList.toggle("focus-mode", u.flow && u.flow.kind === "focus");
  }

  function badge(channelId) {
    const mention = state.mentions.get(channelId);
    if (mention) return `<span class="badge mention-badge" title="未読のメンション">@${mention}</span>`;
    const n = state.unread.get(channelId);
    return n ? `<span class="badge">${n}</span>` : "";
  }

  function renderSidebar() {
    renderMe();
    const chans = [...state.channels.values()];
    const item = (c, icon) =>
      `<li class="${c.id === state.current ? "active" : ""}" data-channel="${esc(c.id)}">${icon} ${esc(channelLabel(c))}${badge(c.id)}</li>`;

    const favCount = favoriteMessages().length;
    $("#fav-count").textContent = favCount ? `(${favCount})` : "";
    $("#open-favorites").classList.toggle("active", !!state.panel && state.panel.type === "favorites");

    $("#channel-list").innerHTML = chans.filter((c) => c.kind === "public").map((c) => item(c, "#")).join("");

    $("#dm-list").innerHTML =
      chans.filter((c) => c.kind === "dm" && !isOneOnOne(c)).map((c) => item(c, "💬")).join("") ||
      '<li class="muted empty">「＋」で3人までの DM を作れます</li>';

    $("#group-list").innerHTML =
      chans.filter((c) => c.kind === "group").map((c) => item(c, "👥")).join("") || '<li class="muted empty">まだありません</li>';

    const sorted = [...state.users].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    $("#user-list").innerHTML = sorted
      .map((u) => {
        const dm = dmWith(u.name);
        const active = dm && dm.id === state.current ? "active" : "";
        const sub = [u.customStatus ? esc(u.customStatus) : "", flowText(u.flow)].filter(Boolean).join(" · ");
        return `<li class="user ${active}" data-user="${esc(u.name)}">
          <span class="${dotClass(u)}"></span>
          <div class="user-info">
            <div>${u.bot ? "🤖 " : ""}${esc(u.name)}${u.name === state.you ? ' <span class="muted">(あなた)</span>' : ""}${u.bot ? ' <span class="muted">(ボット)</span>' : ""}${dm ? badge(dm.id) : ""}</div>
            ${sub ? `<div class="muted small-text">${sub}</div>` : ""}
          </div>
        </li>`;
      })
      .join("");
  }

  function renderHeader() {
    const c = state.channels.get(state.current);
    if (!c) return;
    if (isOneOnOne(c)) {
      const other = userByName(channelLabel(c));
      $("#channel-title").innerHTML = `<span class="${dotClass(other)}"></span> ${esc(channelLabel(c))}`;
      const sub = other ? [other.online ? STATUS_LABEL[other.status] : "オフライン", other.customStatus && esc(other.customStatus), flowText(other.flow)] : [];
      $("#channel-sub").innerHTML = sub.filter(Boolean).join(" · ");
    } else if (c.kind === "dm") {
      $("#channel-title").textContent = `💬 ${channelLabel(c)}`;
      $("#channel-sub").innerHTML =
        `グループ DM（${c.members.length}人）· ` +
        c.members.map((n) => `<span class="${dotClass(userByName(n))}"></span> ${esc(n)}`).join("　");
    } else if (c.kind === "group") {
      $("#channel-title").textContent = `👥 ${c.name}`;
      $("#channel-sub").textContent = c.members.join(", ");
    } else {
      $("#channel-title").textContent = `# ${c.name}`;
      $("#channel-sub").textContent = "全員が参加できるチャンネル";
    }
    $("#input").placeholder = `${channelPlace(c)} へメッセージを送信（Enter で送信 / Shift+Enter で改行）`;
    $("#pin-count").textContent = pinnedMessages(c.id).length;
  }

  function favoriteMessages() {
    return state.messages.filter((m) => state.favorites.has(m.id)).sort((a, b) => b.createdAt - a.createdAt);
  }

  function pinnedMessages(channelId) {
    return state.messages.filter((m) => m.channelId === channelId && m.pinned).sort((a, b) => b.pinned.at - a.pinned.at);
  }

  function replies(parentId) {
    return state.messages.filter((m) => m.parentId === parentId);
  }

  function reactionsHtml(m) {
    const entries = Object.entries(m.reactions || {});
    if (!entries.length) return "";
    return `<div class="reactions">${entries
      .map(([emoji, names]) => {
        const mine = names.includes(state.you) ? "mine" : "";
        return `<button class="reaction ${mine}" data-react="${esc(emoji)}" data-msg="${esc(m.id)}" title="${esc(names.join("、"))}">${emoji} <span>${names.length}</span></button>`;
      })
      .join("")}</div>`;
  }

  function threadHtml(m) {
    const r = replies(m.id);
    const open = state.expanded.has(m.id);
    if (!r.length && !open) return "";
    let toggle;
    if (open) {
      toggle = `<button class="thread-toggle" data-toggle-thread="${esc(m.id)}">▼ ${r.length ? `${r.length}件の返信を閉じる` : "閉じる"}</button>`;
    } else {
      const people = [...new Set(r.map((x) => x.author))].slice(0, 4).map(avatar).join("");
      const last = r[r.length - 1];
      toggle = `<button class="thread-toggle" data-toggle-thread="${esc(m.id)}">▶ ${people} <strong>${r.length}件の返信</strong>
        <span class="muted small-text">最終返信 ${formatTime(last.createdAt)}</span></button>`;
    }
    if (!open) return toggle;
    const body = r.length ? r.map((x) => messageHtml(x, { context: "reply" })).join("") : '<div class="muted small-text thread-empty">まだ返信はありません</div>';
    return `${toggle}
      <div class="thread-inline">
        ${body}
        <form class="composer reply-composer" data-reply-form="${esc(m.id)}">
          <textarea rows="1" data-draft="reply:${esc(m.id)}" placeholder="スレッドに返信"></textarea>
          <button class="primary small">返信</button>
        </form>
      </div>`;
  }

  // context: "main"（チャンネル）/ "reply"（スレッド内の返信）/ "list"（お気に入り・ピン留めの一覧）
  function messageHtml(m, { context = "main" } = {}) {
    const mine = m.author === state.you;
    const editing = context !== "list" && state.editing === m.id;
    let body;
    if (m.deleted) {
      body = '<div class="text deleted">このメッセージは削除されました</div>';
    } else if (editing) {
      body = `<form class="edit-form" data-edit-form="${esc(m.id)}">
        <textarea rows="2" data-draft="edit:${esc(m.id)}"></textarea>
        <div class="edit-actions muted small-text">Enter で保存 · Esc でキャンセル
          <button type="button" class="ghost small" data-edit-cancel>キャンセル</button>
          <button class="primary small">保存</button>
        </div>
      </form>`;
    } else {
      body = m.text ? `<div class="text">${renderText(m.text, m.mentions || [])}</div>` : "";
      if (m.file) body += fileHtml(m.file);
      if (m.docId) {
        const doc = state.docs.get(m.docId);
        body += `<div class="doc-card" data-doc="${esc(m.docId)}">
          <span class="doc-icon">📝</span>
          <div><strong>${esc(doc ? doc.title : "ドキュメント")}</strong>
          <div class="muted small-text">共同編集ドキュメント · クリックで開く</div></div>
        </div>`;
      }
      body += reactionsHtml(m);
    }

    const fav = state.favorites.has(m.id);
    let actions = "";
    if (!m.deleted && !editing) {
      const canEdit = mine && context !== "list" && !(userByName(m.author) || {}).bot;
      actions = `<div class="msg-actions">
        <button class="ghost small" data-react-picker="${esc(m.id)}" title="リアクション">😊</button>
        <button class="ghost small ${fav ? "on" : ""}" data-fav="${esc(m.id)}" title="${fav ? "お気に入りから外す" : "お気に入りに追加"}">${fav ? "★" : "☆"}</button>
        <button class="ghost small ${m.pinned ? "on" : ""}" data-pin="${esc(m.id)}" title="${m.pinned ? "ピン留めを外す" : "チャンネルにピン留め"}">📌</button>
        ${context === "main" ? `<button class="ghost small" data-reply="${esc(m.id)}" title="スレッドで返信">💬 返信</button>` : ""}
        ${canEdit ? `<button class="ghost small" data-edit="${esc(m.id)}" title="編集">✏️</button>
        <button class="ghost small" data-delete="${esc(m.id)}" title="削除">🗑</button>` : ""}
      </div>`;
    }

    const marks = [
      m.editedAt && !m.deleted ? '<span class="muted small-text">(編集済み)</span>' : "",
      fav ? '<span class="fav-mark" title="お気に入り">★</span>' : "",
      m.pinned ? `<span class="pin-mark">📌 ${esc(m.pinned.by)} がピン留め</span>` : "",
    ].join("");
    const r = readers(m);
    const c = state.channels.get(m.channelId) || {};
    const receipt = r.length && !m.deleted
      ? `<span class="read-receipt" title="既読: ${esc(r.join("、"))}">${c.kind && isOneOnOne(c) ? "既読" : `既読 ${r.length}`}</span>`
      : "";
    const classes = ["message", m.pinned ? "pinned" : "", (m.mentions || []).includes(state.you) ? "mentioned" : ""].join(" ");
    return `<div class="${classes}" data-id="${esc(m.id)}">
      ${avatar(m.author)}
      <div class="msg-main">
        <div class="msg-head"><strong>${esc(m.author)}</strong><span class="muted small-text">${formatTime(m.createdAt)}</span>${marks}${receipt}</div>
        ${body}
        ${context === "main" ? threadHtml(m) : ""}
      </div>
      ${actions}
    </div>`;
  }

  function fileHtml(f) {
    const data = `data-file='${esc(JSON.stringify(f))}'`;
    if (f.mime.startsWith("image/")) {
      return `<div class="file-card image" ${data}><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"><div class="muted small-text">${esc(f.name)} · ${formatSize(f.size)}</div></div>`;
    }
    const icon = f.mime.startsWith("video/") ? "🎬" : f.mime.startsWith("audio/") ? "🎵" : f.mime === "application/pdf" ? "📕" : "📄";
    return `<div class="file-card" ${data}><span class="doc-icon">${icon}</span><div><strong>${esc(f.name)}</strong><div class="muted small-text">${formatSize(f.size)} · クリックでプレビュー</div></div></div>`;
  }

  function renderMessages() {
    const list = state.messages.filter((m) => m.channelId === state.current && !m.parentId);
    const box = $("#messages");
    // data-channel はサイドバーのクリック判定に使うので、ここでは別の名前で覚えておく
    const sameChannel = box.dataset.renderedChannel === state.current;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const prevScroll = box.scrollTop;

    // 描き直すと入力欄が作り直されるので、フォーカスとカーソル位置を覚えておく
    const active = document.activeElement;
    const focusKey = active && box.contains(active) && active.dataset.draft;
    const sel = focusKey ? [active.selectionStart, active.selectionEnd] : null;

    box.innerHTML = list.length
      ? list.map((m) => messageHtml(m)).join("")
      : `<div class="empty-state">まだメッセージはありません。最初のひとことをどうぞ 👋<br><span class="muted">ファイルはドラッグ＆ドロップで共有できます</span></div>`;

    for (const ta of box.querySelectorAll("textarea[data-draft]")) setupDraft(ta);
    if (focusKey) {
      const ta = box.querySelector(`textarea[data-draft="${CSS.escape(focusKey)}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(...sel);
        if (ac && ac.key === focusKey) ac.textarea = ta;
      }
    }

    if (!sameChannel || nearBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevScroll;
    box.dataset.renderedChannel = state.current;
  }

  // スレッドの返信欄と編集欄。入力途中の内容は描き直しても残す
  function setupDraft(ta) {
    const key = ta.dataset.draft;
    const [kind, id] = key.split(/:(.*)/s);
    if (key in state.drafts) ta.value = state.drafts[key];
    else if (kind === "edit") ta.value = state.drafts[key] = (state.messages.find((m) => m.id === id) || {}).text || "";
    ta.addEventListener("input", () => (state.drafts[key] = ta.value));
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    if (kind === "reply") bindEnterToSend(ta, () => sendReply(id), key);
    else {
      bindEnterToSend(ta, () => saveEdit(id), key);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !ac) cancelEdit();
      });
    }
  }

  function sendReply(parentId) {
    const key = `reply:${parentId}`;
    const text = state.drafts[key] || "";
    if (!text.trim()) return;
    const parent = state.messages.find((m) => m.id === parentId);
    if (!parent) return;
    sendWs({ type: "message", channelId: parent.channelId, parentId, text });
    delete state.drafts[key];
    renderMessages();
    const ta = $(`textarea[data-draft="${CSS.escape(key)}"]`);
    if (ta) ta.focus();
  }

  function startEdit(id) {
    state.editing = id;
    delete state.drafts[`edit:${id}`];
    renderMessages();
    const ta = $(`textarea[data-draft="edit:${CSS.escape(id)}"]`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  function saveEdit(id) {
    const text = state.drafts[`edit:${id}`] ?? "";
    const m = state.messages.find((x) => x.id === id);
    if (!m) return cancelEdit();
    if (!text.trim() && !m.file && !m.docId) return toast("空のメッセージにはできません。消す場合は 🗑 で削除してください");
    if (text !== m.text) sendWs({ type: "edit", messageId: id, text });
    cancelEdit();
  }

  function cancelEdit() {
    if (state.editing) delete state.drafts[`edit:${state.editing}`];
    state.editing = null;
    closeMention();
    renderMessages();
  }

  function toggleThread(id, open = !state.expanded.has(id)) {
    if (open) state.expanded.add(id);
    else state.expanded.delete(id);
    renderMessages();
  }

  // ---------- 右パネル ----------
  function openPanel(type, id) {
    state.panel = { type, id };
    renderPanel();
  }

  function closePanel() {
    state.panel = null;
    renderPanel();
  }

  function renderPanel() {
    const panel = $("#panel");
    if (!state.panel) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    if (state.panel.type === "favorites") renderList("⭐ お気に入り", favoriteMessages(), "まだお気に入りはありません。メッセージの ☆ を押すと追加できます。");
    else if (state.panel.type === "pins") {
      const c = state.channels.get(state.current);
      renderList(`📌 ${channelPlace(c)} のピン留め`, pinnedMessages(c.id), "まだピン留めはありません。メッセージの 📌 を押すと、チャンネルの全員に共有されます。");
    } else renderDoc();
  }

  // お気に入り・ピン留めの一覧。クリックで元のメッセージへ移動する
  function renderList(title, list, emptyText) {
    $("#panel-title").textContent = title;
    $("#panel-body").innerHTML = list.length
      ? `<div class="panel-list">${list
          .map((m) => {
            const reply = m.parentId ? " · スレッドの返信" : "";
            return `<div class="list-item" data-jump="${esc(m.id)}">
              <div class="muted small-text list-where">${esc(channelPlace(state.channels.get(m.channelId)))}${reply}</div>
              ${messageHtml(m, { context: "list" })}
            </div>`;
          })
          .join("")}</div>`
      : `<div class="empty-state">${emptyText}</div>`;
  }

  function jumpTo(messageId) {
    const m = state.messages.find((x) => x.id === messageId);
    if (!m) return;
    if (m.channelId !== state.current) {
      state.current = m.channelId;
      state.unread.delete(m.channelId);
      state.mentions.delete(m.channelId);
      renderSidebar();
      renderHeader();
      markRead();
    }
    if (m.parentId) state.expanded.add(m.parentId);
    renderMessages();
    const el = document.querySelector(`#messages .message[data-id="${CSS.escape(m.id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("highlight");
    setTimeout(() => el.classList.remove("highlight"), 1600);
  }

  let docTimer = null;

  function renderDoc() {
    const doc = state.docs.get(state.panel.id);
    if (!doc) return closePanel();
    $("#panel-title").textContent = `📝 ${doc.title}`;
    const body = $("#panel-body");
    body.innerHTML = `
      <div class="doc-editor">
        <div class="doc-meta muted small-text" id="doc-meta"></div>
        <textarea id="doc-text" spellcheck="false"></textarea>
        <div class="doc-preview-label muted small-text">プレビュー</div>
        <div id="doc-preview" class="markdown"></div>
      </div>`;
    const ta = body.querySelector("#doc-text");
    ta.value = doc.content;
    updateDocView(doc);
    ta.addEventListener("input", () => {
      doc.content = ta.value;
      $("#doc-preview").innerHTML = Markdown.render(ta.value);
      clearTimeout(docTimer);
      docTimer = setTimeout(() => {
        sendWs({ type: "docEdit", docId: doc.id, content: ta.value, clientId: state.clientId });
      }, 120);
    });
  }

  function updateDocView(doc) {
    $("#doc-preview").innerHTML = Markdown.render(doc.content);
    $("#doc-meta").textContent = `最終更新: ${doc.updatedBy}（${formatTime(doc.updatedAt)}） · 変更はリアルタイムに同期されます`;
  }

  function onDoc(doc, clientId) {
    state.docs.set(doc.id, doc);
    if (!state.panel || state.panel.type !== "doc" || state.panel.id !== doc.id) {
      renderMessages();
      return;
    }
    const ta = $("#doc-text");
    if (clientId !== state.clientId && ta && ta.value !== doc.content) {
      // 他の人の編集を反映しつつ、自分のカーソル位置をできるだけ保つ
      const old = ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      let prefix = 0;
      while (prefix < old.length && prefix < doc.content.length && old[prefix] === doc.content[prefix]) prefix++;
      const delta = doc.content.length - old.length;
      const shift = (pos) => (pos > prefix ? Math.max(prefix, pos + delta) : pos);
      ta.value = doc.content;
      if (document.activeElement === ta) ta.setSelectionRange(shift(start), shift(end));
    }
    updateDocView(doc);
  }

  // ---------- メッセージ受信と通知 ----------
  function onMessage(m) {
    state.messages.push(m);
    const viewing = m.channelId === state.current && !document.hidden;
    if (m.author !== state.you && !viewing) {
      state.unread.set(m.channelId, (state.unread.get(m.channelId) || 0) + 1);
      if ((m.mentions || []).includes(state.you)) state.mentions.set(m.channelId, (state.mentions.get(m.channelId) || 0) + 1);
      notify(m);
    }
    if (m.channelId === state.current) {
      renderMessages();
      markRead();
    }
    renderSidebar();
  }

  function onMessageUpdate(m) {
    const i = state.messages.findIndex((x) => x.id === m.id);
    if (i === -1) return;
    state.messages[i] = m;
    if (m.deleted && state.editing === m.id) state.editing = null;
    if (m.channelId === state.current) {
      renderMessages();
      renderHeader();
    }
    if (state.panel && state.panel.type !== "doc") renderPanel();
  }

  function notify(m) {
    const flow = me().flow;
    if (flow && flow.kind === "focus") return; // 集中モード中は通知しない
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const where = channelPlace(state.channels.get(m.channelId));
    const text = m.text || (m.file ? `📎 ${m.file.name}` : "📝 ドキュメント");
    const title = (m.mentions || []).includes(state.you) ? `${m.author} からメンション（${where}）` : `${m.author}（${where}）`;
    new Notification(title, { body: text.slice(0, 120) });
  }

  // ---------- 操作 ----------
  function openChannel(id) {
    if (!state.channels.has(id)) return;
    state.current = id;
    state.unread.delete(id);
    state.mentions.delete(id);
    state.editing = null;
    closeMention();
    closeReactionPicker();
    if (state.panel && state.panel.type === "pins") state.panel = null;
    renderAll();
    markRead();
    $("#input").focus();
  }

  // ---------- リアクション ----------
  const picker = document.createElement("div");
  picker.id = "reaction-picker";
  picker.hidden = true;
  document.body.appendChild(picker);

  function openReactionPicker(button, messageId) {
    picker.innerHTML = state.limits.reactions
      .map((emoji) => `<button class="ghost" data-pick-emoji="${esc(emoji)}" data-msg="${esc(messageId)}">${emoji}</button>`)
      .join("");
    picker.hidden = false;
    const rect = button.getBoundingClientRect();
    const width = picker.offsetWidth;
    picker.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    picker.style.top = `${rect.bottom + 4 + picker.offsetHeight > window.innerHeight ? rect.top - picker.offsetHeight - 4 : rect.bottom + 4}px`;
  }

  function closeReactionPicker() {
    picker.hidden = true;
  }

  // ---------- メンションの入力補完 ----------
  const popup = document.createElement("div");
  popup.id = "mention-popup";
  popup.hidden = true;
  document.body.appendChild(popup);
  let ac = null; // { textarea, key, start, end, items, index }

  function mentionCandidates() {
    const c = state.channels.get(state.current);
    if (!c) return [];
    const names = c.kind === "public" ? state.users.map((u) => u.name) : c.members;
    return names.filter((n) => n !== state.you);
  }

  function updateMention(textarea, key) {
    const caret = textarea.selectionStart;
    const m = textarea.value.slice(0, caret).match(/(?:^|\s)[@＠]([^\s@＠]*)$/);
    if (!m) return closeMention();
    const q = m[1].toLowerCase();
    const items = mentionCandidates()
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q) || a.localeCompare(b))
      .slice(0, 8);
    if (!items.length) return closeMention();
    const keep = ac && ac.key === key ? Math.min(ac.index, items.length - 1) : 0;
    ac = { textarea, key, start: caret - m[1].length - 1, end: caret, items, index: keep };
    renderMention();
  }

  function renderMention() {
    popup.innerHTML =
      '<div class="mention-head muted small-text">チャンネルのメンバー</div>' +
      ac.items
        .map((name, i) => {
          const u = userByName(name) || {};
          const sub = u.online ? STATUS_LABEL[u.status] : "オフライン";
          return `<div class="mention-item ${i === ac.index ? "active" : ""}" data-mention-index="${i}">
            <span class="${dotClass(u)}"></span>${u.bot ? "🤖 " : ""}<strong>${esc(name)}</strong>
            <span class="muted small-text">${sub}</span>
          </div>`;
        })
        .join("");
    const rect = (ac.textarea.closest(".composer, .edit-form") || ac.textarea).getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    popup.style.width = `${Math.min(320, rect.width)}px`;
    popup.hidden = false;
  }

  function applyMention(i) {
    const { textarea: ta, start, end, items } = ac;
    const insert = `@${items[i]} `;
    ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
    const caret = start + insert.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    ta.dispatchEvent(new Event("input"));
    closeMention();
  }

  function closeMention() {
    ac = null;
    popup.hidden = true;
  }

  function attachMention(textarea, key) {
    textarea.addEventListener("input", () => updateMention(textarea, key));
    textarea.addEventListener("click", () => updateMention(textarea, key));
    textarea.addEventListener("blur", () => setTimeout(() => ac && ac.textarea === textarea && closeMention(), 150));
    textarea.addEventListener("keydown", (e) => {
      if (!ac || ac.textarea !== textarea || e.isComposing) return;
      const n = ac.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        ac.index = (ac.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        renderMention();
      } else if (e.key === "Enter" || e.key === "Tab") {
        applyMention(ac.index);
      } else if (e.key === "Escape") {
        closeMention();
      } else return;
      // 送信（Enter）やキャンセル（Esc）より先に処理して止める
      e.preventDefault();
      e.stopImmediatePropagation();
    });
  }

  popup.addEventListener("mousedown", (e) => {
    const item = e.target.closest("[data-mention-index]");
    if (!item || !ac) return;
    e.preventDefault();
    applyMention(Number(item.dataset.mentionIndex));
  });

  function bindEnterToSend(textarea, submit, key = "main") {
    attachMention(textarea, key);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    });
  }

  async function uploadFiles(fileList) {
    for (const file of fileList) {
      toast(`アップロード中: ${file.name}`);
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error(res.statusText);
        const info = await res.json();
        sendWs({ type: "message", channelId: state.current, fileId: info.id, text: "" });
      } catch (err) {
        toast(`アップロードに失敗しました: ${file.name}`);
      }
    }
  }

  async function preview(f) {
    $("#preview-title").textContent = f.name;
    $("#preview-download").href = f.url;
    $("#preview-download").setAttribute("download", f.name);
    const body = $("#preview-body");
    const ext = f.name.split(".").pop().toLowerCase();
    const textExt = ["txt", "md", "js", "ts", "json", "css", "html", "csv", "py", "yml", "yaml", "sh", "log"];
    if (f.mime.startsWith("image/")) body.innerHTML = `<img src="${esc(f.url)}">`;
    else if (f.mime.startsWith("video/")) body.innerHTML = `<video src="${esc(f.url)}" controls></video>`;
    else if (f.mime.startsWith("audio/")) body.innerHTML = `<audio src="${esc(f.url)}" controls></audio>`;
    else if (f.mime === "application/pdf") body.innerHTML = `<iframe src="${esc(f.url)}"></iframe>`;
    else if ((f.mime.startsWith("text/") || f.mime.includes("json") || textExt.includes(ext)) && f.size < 1024 * 1024) {
      const text = await (await fetch(f.url)).text();
      body.innerHTML = ext === "md" ? `<div class="markdown">${Markdown.render(text)}</div>` : `<pre>${esc(text)}</pre>`;
    } else body.innerHTML = `<div class="empty-state">このファイルはプレビューできません。ダウンロードしてご覧ください。</div>`;
    $("#preview-dialog").showModal();
  }

  function updateNameCount() {
    const n = [...$("#name-input").value.trim()].length;
    $("#name-count").textContent = `${n} / ${state.limits.nameMax}`;
    $("#name-count").classList.toggle("over", n > state.limits.nameMax);
  }

  function openStatusDialog() {
    const u = me();
    $("#name-input").value = state.you;
    $("#name-input").maxLength = state.limits.nameMax;
    updateNameCount();
    $("#status-select").value = u.status || "online";
    $("#custom-status").value = u.customStatus || "";
    $("#flow-detail").value = (u.flow && u.flow.detail) || "";
    const current = (u.flow && u.flow.kind) || "none";
    $("#flow-options").innerHTML = Object.entries(FLOWS)
      .map(([k, f]) => `<label class="flow-option"><input type="radio" name="flow" value="${k}" ${k === current ? "checked" : ""}> ${f.icon} ${f.label}</label>`)
      .join("");
    const updatePlaceholder = () => {
      const k = document.querySelector('input[name="flow"]:checked').value;
      $("#flow-detail").placeholder = FLOWS[k].placeholder || "";
      $("#flow-detail").disabled = k === "none";
    };
    $("#flow-options").onchange = updatePlaceholder;
    updatePlaceholder();
    $("#status-dialog").showModal();
  }

  function openDMDialog() {
    const max = state.limits.dmMax - 1;
    $("#dm-hint").textContent = `相手を${max}人まで選べます（1人なら1対1の DM になります）`;
    $("#dm-members").innerHTML =
      state.users
        .filter((u) => u.name !== state.you)
        .map((u) => `<label><input type="checkbox" value="${esc(u.name)}"> <span class="${dotClass(u)}"></span> ${u.bot ? "🤖 " : ""}${esc(u.name)}</label>`)
        .join("") || '<p class="muted">ほかのメンバーがまだいません</p>';
    const boxes = [...document.querySelectorAll("#dm-members input")];
    const limit = () => {
      const count = boxes.filter((b) => b.checked).length;
      for (const b of boxes) b.disabled = !b.checked && count >= max;
    };
    for (const b of boxes) b.addEventListener("change", limit);
    $("#dm-dialog").showModal();
  }

  // ---------- イベント ----------
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#login-name").value.trim();
    if (!name) return;
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    connect(name);
  });

  try {
    const saved = localStorage.getItem("vibe-chat-name");
    if (saved) $("#login-name").value = saved;
  } catch {}

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#input");
    if (!input.value.trim()) return;
    sendWs({ type: "message", channelId: state.current, text: input.value });
    input.value = "";
    input.style.height = "auto";
  });
  bindEnterToSend($("#input"), () => $("#composer").requestSubmit());

  // スレッドの返信欄と編集欄の「返信」「保存」ボタン
  $("#messages").addEventListener("submit", (e) => {
    e.preventDefault();
    const reply = e.target.closest("[data-reply-form]");
    if (reply) return sendReply(reply.dataset.replyForm);
    const edit = e.target.closest("[data-edit-form]");
    if (edit) saveEdit(edit.dataset.editForm);
  });

  $("#file-input").addEventListener("change", (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = "";
  });

  // ドラッグ＆ドロップ
  let dragDepth = 0;
  const main = $("#main");
  main.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth++;
    $("#drop").hidden = false;
  });
  main.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("#drop").hidden = true;
  });
  main.addEventListener("dragover", (e) => e.preventDefault());
  main.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("#drop").hidden = true;
    if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
  });

  // クリック操作をまとめて処理
  document.addEventListener("click", (e) => {
    const t = e.target;

    const pick = t.closest("[data-pick-emoji]");
    if (pick) {
      sendWs({ type: "react", messageId: pick.dataset.msg, emoji: pick.dataset.pickEmoji });
      return closeReactionPicker();
    }
    const pickerBtn = t.closest("[data-react-picker]");
    if (pickerBtn) return openReactionPicker(pickerBtn, pickerBtn.dataset.reactPicker);
    closeReactionPicker();

    const reaction = t.closest("[data-react]");
    if (reaction) return sendWs({ type: "react", messageId: reaction.dataset.msg, emoji: reaction.dataset.react });

    const fav = t.closest("[data-fav]");
    if (fav) return sendWs({ type: "favorite", messageId: fav.dataset.fav, on: !state.favorites.has(fav.dataset.fav) });

    const pin = t.closest("[data-pin]");
    if (pin) {
      const m = state.messages.find((x) => x.id === pin.dataset.pin);
      return sendWs({ type: "pin", messageId: pin.dataset.pin, on: !(m && m.pinned) });
    }

    const edit = t.closest("[data-edit]");
    if (edit) return startEdit(edit.dataset.edit);
    if (t.closest("[data-edit-cancel]")) return cancelEdit();

    const del = t.closest("[data-delete]");
    if (del) {
      if (confirm("このメッセージを削除しますか？")) sendWs({ type: "delete", messageId: del.dataset.delete });
      return;
    }

    const toggle = t.closest("[data-toggle-thread]");
    if (toggle) return toggleThread(toggle.dataset.toggleThread);

    const reply = t.closest("[data-reply]");
    if (reply) {
      toggleThread(reply.dataset.reply, true);
      const ta = $(`textarea[data-draft="reply:${CSS.escape(reply.dataset.reply)}"]`);
      if (ta) ta.focus();
      return;
    }

    const view = t.closest("[data-view]");
    if (view) {
      const type = view.dataset.view;
      if (state.panel && state.panel.type === type) closePanel();
      else openPanel(type);
      return renderSidebar();
    }

    // 一覧の中のファイルやドキュメントは、移動より先にそれ自体を開く
    const jump = t.closest("[data-jump]");
    if (jump && !t.closest("[data-file], [data-doc]")) return jumpTo(jump.dataset.jump);

    const ch = t.closest("li[data-channel]");
    if (ch) return openChannel(ch.dataset.channel);

    const user = t.closest("[data-user]");
    if (user) return sendWs({ type: "openDM", with: user.dataset.user });

    const doc = t.closest("[data-doc]");
    if (doc) return openPanel("doc", doc.dataset.doc);

    const file = t.closest("[data-file]");
    if (file) return preview(JSON.parse(file.dataset.file));
  });

  $("#panel-close").addEventListener("click", () => {
    closePanel();
    renderSidebar();
  });
  $("#edit-status").addEventListener("click", openStatusDialog);
  $("#name-input").addEventListener("input", updateNameCount);

  $("#status-dialog").addEventListener("close", () => {
    if ($("#status-dialog").returnValue !== "save") return;
    const kind = document.querySelector('input[name="flow"]:checked').value;
    sendWs({
      type: "status",
      status: $("#status-select").value,
      customStatus: $("#custom-status").value,
      flow: { kind, detail: kind === "none" ? "" : $("#flow-detail").value },
    });
    const name = $("#name-input").value.trim();
    if (name && name !== state.you) sendWs({ type: "rename", name });
  });

  $("#add-channel").addEventListener("click", () => {
    const name = prompt("新しいチャンネル名");
    if (name) sendWs({ type: "createChannel", name });
  });

  $("#add-dm").addEventListener("click", openDMDialog);
  $("#dm-dialog").addEventListener("close", () => {
    if ($("#dm-dialog").returnValue !== "start") return;
    const members = [...document.querySelectorAll("#dm-members input:checked")].map((i) => i.value);
    if (!members.length) return toast("相手を1人以上選んでください");
    sendWs({ type: "openDM", with: members });
  });

  $("#add-group").addEventListener("click", () => {
    $("#group-name").value = "";
    $("#group-members").innerHTML = state.users
      .filter((u) => u.name !== state.you)
      .map((u) => `<label><input type="checkbox" value="${esc(u.name)}"> <span class="${dotClass(u)}"></span> ${esc(u.name)}</label>`)
      .join("") || '<p class="muted">ほかのメンバーがまだいません</p>';
    $("#group-dialog").showModal();
  });

  $("#group-dialog").addEventListener("close", () => {
    if ($("#group-dialog").returnValue !== "create") return;
    const members = [...document.querySelectorAll("#group-members input:checked")].map((i) => i.value);
    if (!members.length) return toast("メンバーを1人以上選んでください");
    sendWs({ type: "createGroup", name: $("#group-name").value, members });
  });

  $("#new-doc").addEventListener("click", () => {
    const title = prompt("ドキュメントのタイトル", "議事メモ");
    if (title !== null) sendWs({ type: "createDoc", channelId: state.current, title });
  });

  window.addEventListener("resize", closeReactionPicker);
  $("#messages").addEventListener("scroll", closeReactionPicker);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    markRead();
    if (state.unread.has(state.current) || state.mentions.has(state.current)) {
      state.unread.delete(state.current);
      state.mentions.delete(state.current);
      renderSidebar();
    }
  });
})();
