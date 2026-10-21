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
    users: [],
    channels: new Map(),
    messages: [],
    docs: new Map(),
    current: "general",
    favorites: new Set(), // 自分がお気に入りにしたメッセージ ID
    reads: {}, // channelId -> { name: 最後に読んだメッセージの時刻 }
    mentions: new Map(), // channelId -> 未読メンション数
    panel: null, // { type: "thread" | "doc" | "favorites" | "pins", id }
    unread: new Map(),
    clientId: Math.random().toString(36).slice(2),
  };

  let ws = null;
  let pendingName = null;

  // ---------- 接続 ----------
  function connect(name) {
    pendingName = name;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener("open", () => sendWs({ type: "join", name }));
    ws.addEventListener("message", (e) => handle(JSON.parse(e.data)));
    ws.addEventListener("close", () => {
      toast("接続が切れました。再接続しています…");
      setTimeout(() => connect(pendingName), 1500);
    });
  }

  function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function handle(data) {
    switch (data.type) {
      case "init":
        state.you = data.you;
        state.users = data.users;
        state.channels = new Map(data.channels.map((c) => [c.id, c]));
        state.messages = data.messages;
        state.docs = new Map(data.docs.map((d) => [d.id, d]));
        state.favorites = new Set(data.favorites || []);
        state.reads = data.reads || {};
        if (!state.channels.has(state.current)) state.current = "general";
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
        toast(data.message);
        break;
    }
  }

  // ---------- ヘルパー ----------
  const me = () => state.users.find((u) => u.name === state.you) || {};
  const userByName = (name) => state.users.find((u) => u.name === name);

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

  function channelLabel(c) {
    if (c.kind === "dm") return c.members.find((n) => n !== state.you) || state.you;
    return c.name;
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

    const favCount = favoriteMessages().length;
    $("#fav-count").textContent = favCount ? `(${favCount})` : "";
    $("#open-favorites").classList.toggle("active", !!state.panel && state.panel.type === "favorites");

    $("#channel-list").innerHTML = chans
      .filter((c) => c.kind === "public")
      .map((c) => `<li class="${c.id === state.current ? "active" : ""}" data-channel="${esc(c.id)}"># ${esc(c.name)}${badge(c.id)}</li>`)
      .join("");

    $("#group-list").innerHTML =
      chans
        .filter((c) => c.kind === "group")
        .map((c) => `<li class="${c.id === state.current ? "active" : ""}" data-channel="${esc(c.id)}">👥 ${esc(c.name)}${badge(c.id)}</li>`)
        .join("") || '<li class="muted empty">まだありません</li>';

    const sorted = [...state.users].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    $("#user-list").innerHTML = sorted
      .map((u) => {
        const dmId = `dm:${[state.you, u.name].sort().join(":")}`;
        const active = dmId === state.current ? "active" : "";
        const sub = [u.customStatus ? esc(u.customStatus) : "", flowText(u.flow)].filter(Boolean).join(" · ");
        return `<li class="user ${active}" data-user="${esc(u.name)}">
          <span class="${dotClass(u)}"></span>
          <div class="user-info">
            <div>${u.bot ? "🤖 " : ""}${esc(u.name)}${u.name === state.you ? ' <span class="muted">(あなた)</span>' : ""}${u.bot ? ' <span class="muted">(ボット)</span>' : ""}${badge(dmId)}</div>
            ${sub ? `<div class="muted small-text">${sub}</div>` : ""}
          </div>
        </li>`;
      })
      .join("");
  }

  function renderHeader() {
    const c = state.channels.get(state.current);
    if (!c) return;
    if (c.kind === "dm") {
      const other = userByName(channelLabel(c));
      $("#channel-title").innerHTML = `<span class="${dotClass(other)}"></span> ${esc(channelLabel(c))}`;
      const sub = other ? [other.online ? STATUS_LABEL[other.status] : "オフライン", other.customStatus && esc(other.customStatus), flowText(other.flow)] : [];
      $("#channel-sub").innerHTML = sub.filter(Boolean).join(" · ");
    } else if (c.kind === "group") {
      $("#channel-title").textContent = `👥 ${c.name}`;
      $("#channel-sub").textContent = c.members.join(", ");
    } else {
      $("#channel-title").textContent = `# ${c.name}`;
      $("#channel-sub").textContent = "全員が参加できるチャンネル";
    }
    $("#input").placeholder = `${c.kind === "public" ? "#" : ""}${channelLabel(c)} へメッセージを送信（Enter で送信 / Shift+Enter で改行）`;
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

  function messageHtml(m, { inThread = false } = {}) {
    let body = m.text ? `<div class="text">${renderText(m.text, m.mentions || [])}</div>` : "";
    if (m.file) body += fileHtml(m.file);
    if (m.docId) {
      const doc = state.docs.get(m.docId);
      body += `<div class="doc-card" data-doc="${esc(m.docId)}">
        <span class="doc-icon">📝</span>
        <div><strong>${esc(doc ? doc.title : "ドキュメント")}</strong>
        <div class="muted small-text">共同編集ドキュメント · クリックで開く</div></div>
      </div>`;
    }
    let thread = "";
    if (!inThread && !m.parentId) {
      const r = replies(m.id);
      if (r.length) {
        const people = [...new Set(r.map((x) => x.author))].slice(0, 4).map(avatar).join("");
        thread = `<button class="thread-link" data-thread="${esc(m.id)}">${people} 💬 ${r.length}件の返信</button>`;
      }
    }
    const fav = state.favorites.has(m.id);
    const actions = `<div class="msg-actions">
      <button class="ghost small ${fav ? "on" : ""}" data-fav="${esc(m.id)}" title="${fav ? "お気に入りから外す" : "お気に入りに追加"}">${fav ? "★" : "☆"}</button>
      <button class="ghost small ${m.pinned ? "on" : ""}" data-pin="${esc(m.id)}" title="${m.pinned ? "ピン留めを外す" : "チャンネルにピン留め"}">📌</button>
      ${!inThread ? `<button class="ghost small" data-thread="${esc(m.id)}" title="スレッドで返信">💬 返信</button>` : ""}
    </div>`;
    const marks = [
      fav ? '<span class="fav-mark" title="お気に入り">★</span>' : "",
      m.pinned ? `<span class="pin-mark">📌 ${esc(m.pinned.by)} がピン留め</span>` : "",
    ].join("");
    const r = readers(m);
    const dm = (state.channels.get(m.channelId) || {}).kind === "dm";
    const receipt = r.length
      ? `<span class="read-receipt" title="既読: ${esc(r.join("、"))}">${dm ? "既読" : `既読 ${r.length}`}</span>`
      : "";
    const classes = ["message", m.pinned ? "pinned" : "", (m.mentions || []).includes(state.you) ? "mentioned" : ""].join(" ");
    return `<div class="${classes}" data-id="${esc(m.id)}">
      ${avatar(m.author)}
      <div class="msg-main">
        <div class="msg-head"><strong>${esc(m.author)}</strong><span class="muted small-text">${formatTime(m.createdAt)}</span>${marks}${receipt}</div>
        ${body}
        ${thread}
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = list.length
      ? list.map((m) => messageHtml(m)).join("")
      : `<div class="empty-state">まだメッセージはありません。最初のひとことをどうぞ 👋<br><span class="muted">ファイルはドラッグ＆ドロップで共有できます</span></div>`;
    if (nearBottom || box.dataset.channel !== state.current) box.scrollTop = box.scrollHeight;
    box.dataset.channel = state.current;
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
    if (state.panel.type === "thread") renderThread();
    else if (state.panel.type === "favorites") renderList("⭐ お気に入り", favoriteMessages(), "まだお気に入りはありません。メッセージの ☆ を押すと追加できます。");
    else if (state.panel.type === "pins") {
      const c = state.channels.get(state.current);
      const where = c.kind === "public" ? `#${c.name}` : channelLabel(c);
      renderList(`📌 ${where} のピン留め`, pinnedMessages(c.id), "まだピン留めはありません。メッセージの 📌 を押すと、チャンネルの全員に共有されます。");
    } else renderDoc();
  }

  // お気に入り・ピン留めの一覧。クリックで元のメッセージへ移動する
  function renderList(title, list, emptyText) {
    $("#panel-title").textContent = title;
    $("#panel-body").innerHTML = list.length
      ? `<div class="thread">${list
          .map((m) => {
            const c = state.channels.get(m.channelId);
            const where = c ? (c.kind === "public" ? `#${esc(c.name)}` : esc(channelLabel(c))) : "";
            const reply = m.parentId ? " · スレッドの返信" : "";
            return `<div class="list-item" data-jump="${esc(m.id)}">
              <div class="muted small-text list-where">${where}${reply}</div>
              ${messageHtml(m, { inThread: true })}
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
      renderMessages();
      markRead();
    }
    if (m.parentId) return openPanel("thread", m.parentId);
    const el = document.querySelector(`#messages .message[data-id="${CSS.escape(m.id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("highlight");
    setTimeout(() => el.classList.remove("highlight"), 1600);
  }

  function renderThread() {
    const parent = state.messages.find((m) => m.id === state.panel.id);
    if (!parent) return closePanel();
    $("#panel-title").textContent = "スレッド";
    const body = $("#panel-body");
    const existing = body.querySelector("#thread-input");
    const draft = existing ? existing.value : "";
    body.innerHTML = `
      <div class="thread">
        ${messageHtml(parent, { inThread: true })}
        <div class="thread-divider">${replies(parent.id).length}件の返信</div>
        ${replies(parent.id).map((m) => messageHtml(m, { inThread: true })).join("")}
      </div>
      <form id="thread-form" class="composer">
        <textarea id="thread-input" rows="1" placeholder="スレッドに返信"></textarea>
        <button class="primary">返信</button>
      </form>`;
    const input = body.querySelector("#thread-input");
    input.value = draft;
    const thread = body.querySelector(".thread");
    thread.scrollTop = thread.scrollHeight;
    body.querySelector("#thread-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      sendWs({ type: "message", channelId: parent.channelId, parentId: parent.id, text: input.value });
      input.value = "";
    });
    bindEnterToSend(input, () => body.querySelector("#thread-form").requestSubmit());
    if (existing) input.focus();
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
    if (state.panel && state.panel.type === "thread" && (m.parentId === state.panel.id || m.id === state.panel.id)) renderThread();
    renderSidebar();
  }

  function onMessageUpdate(m) {
    const i = state.messages.findIndex((x) => x.id === m.id);
    if (i === -1) return;
    state.messages[i] = m;
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
    const c = state.channels.get(m.channelId);
    const where = c ? (c.kind === "public" ? `#${c.name}` : channelLabel(c)) : "";
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
    closeMention();
    if (state.panel && ["thread", "pins"].includes(state.panel.type)) state.panel = null;
    renderAll();
    markRead();
    $("#input").focus();
  }

  // ---------- メンションの入力補完 ----------
  const popup = document.createElement("div");
  popup.id = "mention-popup";
  popup.hidden = true;
  document.body.appendChild(popup);
  let ac = null; // { textarea, start, end, items, index }

  function mentionCandidates() {
    const c = state.channels.get(state.current);
    if (!c) return [];
    const names = c.kind === "public" ? state.users.map((u) => u.name) : c.members;
    return names.filter((n) => n !== state.you);
  }

  function updateMention(textarea) {
    const caret = textarea.selectionStart;
    const m = textarea.value.slice(0, caret).match(/(?:^|\s)[@＠]([^\s@＠]*)$/);
    if (!m) return closeMention();
    const q = m[1].toLowerCase();
    const items = mentionCandidates()
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q) || a.localeCompare(b))
      .slice(0, 8);
    if (!items.length) return closeMention();
    const keep = ac && ac.textarea === textarea ? Math.min(ac.index, items.length - 1) : 0;
    ac = { textarea, start: caret - m[1].length - 1, end: caret, items, index: keep };
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
    const rect = ac.textarea.closest(".composer").getBoundingClientRect();
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
    closeMention();
  }

  function closeMention() {
    ac = null;
    popup.hidden = true;
  }

  function attachMention(textarea) {
    textarea.addEventListener("input", () => updateMention(textarea));
    textarea.addEventListener("click", () => updateMention(textarea));
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
      // 送信（Enter）より先に処理して止める
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

  function bindEnterToSend(textarea, submit) {
    attachMention(textarea);
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

  function openStatusDialog() {
    const u = me();
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

  // ---------- イベント ----------
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#login-name").value.trim();
    if (!name) return;
    try { localStorage.setItem("vibe-chat-name", name); } catch {}
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
    const fav = e.target.closest("[data-fav]");
    if (fav) return sendWs({ type: "favorite", messageId: fav.dataset.fav, on: !state.favorites.has(fav.dataset.fav) });

    const pin = e.target.closest("[data-pin]");
    if (pin) {
      const m = state.messages.find((x) => x.id === pin.dataset.pin);
      return sendWs({ type: "pin", messageId: pin.dataset.pin, on: !(m && m.pinned) });
    }

    const view = e.target.closest("[data-view]");
    if (view) {
      const type = view.dataset.view;
      if (state.panel && state.panel.type === type) closePanel();
      else openPanel(type);
      return renderSidebar();
    }

    // 一覧の中のファイルやドキュメントは、移動より先にそれ自体を開く
    const jump = e.target.closest("[data-jump]");
    if (jump && !e.target.closest("[data-file], [data-doc], [data-thread]")) return jumpTo(jump.dataset.jump);

    const ch = e.target.closest("[data-channel]");
    if (ch) return openChannel(ch.dataset.channel);

    const user = e.target.closest("[data-user]");
    if (user) return sendWs({ type: "openDM", with: user.dataset.user });

    const thread = e.target.closest("[data-thread]");
    if (thread) return openPanel("thread", thread.dataset.thread);

    const doc = e.target.closest("[data-doc]");
    if (doc) return openPanel("doc", doc.dataset.doc);

    const file = e.target.closest("[data-file]");
    if (file) return preview(JSON.parse(file.dataset.file));
  });

  $("#panel-close").addEventListener("click", () => {
    closePanel();
    renderSidebar();
  });
  $("#edit-status").addEventListener("click", openStatusDialog);

  $("#status-dialog").addEventListener("close", () => {
    if ($("#status-dialog").returnValue !== "save") return;
    const kind = document.querySelector('input[name="flow"]:checked').value;
    sendWs({
      type: "status",
      status: $("#status-select").value,
      customStatus: $("#custom-status").value,
      flow: { kind, detail: kind === "none" ? "" : $("#flow-detail").value },
    });
  });

  $("#add-channel").addEventListener("click", () => {
    const name = prompt("新しいチャンネル名");
    if (name) sendWs({ type: "createChannel", name });
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
