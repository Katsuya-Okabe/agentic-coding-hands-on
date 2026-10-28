const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const NAME_MAX = 20; // ユーザー名の最大文字数
const DM_MAX = 3; // DM に参加できる最大人数（自分を含む）
const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "🔥", "✅"];

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(UPLOAD_DIR));

// ---- インメモリの状態 ----
const users = new Map(); // name -> { name, status, customStatus, flow, favorites:Set, sockets:Set }
const channels = new Map(); // id -> { id, name, kind: public|group|dm, members:[] | null }
const messages = []; // { id, channelId, author, text, parentId, file, docId, pinned, mentions, reactions, editedAt, deleted, createdAt }
const docs = new Map(); // id -> { id, channelId, title, content, version, updatedBy, updatedAt }
const files = new Map(); // id -> { id, name, size, mime, url }
const reads = new Map(); // channelId -> Map(name -> 最後に読んだメッセージの時刻)

const id = () => crypto.randomUUID();

// メンション確認用のチャットボット。常にオンラインで、既読の人数には数えない
const BOT = "VibeBot";
users.set(BOT, {
  name: BOT,
  bot: true,
  status: "online",
  customStatus: "@VibeBot でメンションを試せます",
  flow: { kind: "none", detail: "" },
  favorites: new Set(),
  sockets: new Set(),
});

for (const name of ["general", "random"]) {
  channels.set(name, { id: name, name, kind: "public", members: null });
}

// ---- ファイルアップロード ----
app.post("/api/upload", express.raw({ type: "*/*", limit: "25mb" }), (req, res) => {
  const name = path.basename(String(req.query.name || "file"));
  const fileId = id();
  const stored = `${fileId}${path.extname(name)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.body);
  const file = {
    id: fileId,
    name,
    size: req.body.length,
    mime: req.headers["content-type"] || "application/octet-stream",
    url: `/files/${stored}`,
  };
  files.set(fileId, file);
  res.json(file);
});

// ---- ヘルパー ----
function publicUser(u) {
  return {
    name: u.name,
    bot: !!u.bot,
    online: !!u.bot || u.sockets.size > 0,
    status: u.status,
    customStatus: u.customStatus,
    flow: u.flow,
  };
}

function canSee(channel, name) {
  return channel.kind === "public" || channel.members.includes(name);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, filter = () => true) {
  for (const u of users.values()) {
    if (!filter(u.name)) continue;
    for (const ws of u.sockets) send(ws, payload);
  }
}

function broadcastToChannel(channel, payload) {
  broadcast(payload, (name) => canSee(channel, name));
}

function channelMembers(channel) {
  return channel.kind === "public" ? [...users.keys()] : channel.members;
}

// 名前の検証。問題があればエラーメッセージを返す
function validateName(name) {
  if (!name) return "名前を入力してください";
  if ([...name].length > NAME_MAX) return `名前は${NAME_MAX}文字以内にしてください`;
  if (/[\s@＠]/.test(name)) return "名前に空白や @ は使えません";
  if (users.get(name)?.bot) return "その名前はボット用のため使えません";
  return null;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRegex = (name, flags = "") => new RegExp(`[@＠]${escapeRegex(name)}(?=$|[\\s、。,.!?！？:：)）])`, flags);

// 本文の @名前（全角の ＠ も可）から、チャンネルのメンバーへのメンションを取り出す
function findMentions(text, channel) {
  return channelMembers(channel).filter((name) => mentionRegex(name).test(text));
}

function setRead(channel, name, at) {
  if (!reads.has(channel.id)) reads.set(channel.id, new Map());
  const map = reads.get(channel.id);
  const ts = Math.min(Number(at) || 0, Date.now());
  if (ts <= (map.get(name) || 0)) return;
  map.set(name, ts);
  broadcastToChannel(channel, { type: "read", channelId: channel.id, name, at: ts });
}

function botReply(channel, original) {
  setTimeout(() => {
    const others = original.mentions.filter((n) => n !== BOT && n !== original.author);
    const snippet = original.text.replace(/\s+/g, " ").slice(0, 80);
    let text = `@${original.author} メンションを受け取りました 🤖\n「${snippet}」`;
    if (others.length) text += `\n${others.join("、")} さんにもメンションが届いています。`;
    postMessage(channel, { author: BOT, text, parentId: original.parentId, mentions: [original.author] });
  }, 800);
}

function broadcastUsers() {
  broadcast({ type: "users", users: [...users.values()].map(publicUser) });
}

function initPayload(name) {
  const visible = [...channels.values()].filter((c) => canSee(c, name));
  const ids = new Set(visible.map((c) => c.id));
  return {
    type: "init",
    you: name,
    limits: { nameMax: NAME_MAX, dmMax: DM_MAX, reactions: REACTIONS },
    users: [...users.values()].map(publicUser),
    channels: visible,
    messages: messages.filter((m) => ids.has(m.channelId)),
    docs: [...docs.values()].filter((d) => ids.has(d.channelId)),
    favorites: [...users.get(name).favorites],
    reads: Object.fromEntries([...ids].map((cid) => [cid, Object.fromEntries(reads.get(cid) || [])])),
  };
}

function postMessage(channel, fields) {
  const message = {
    id: id(),
    channelId: channel.id,
    parentId: null,
    text: "",
    file: null,
    docId: null,
    pinned: null, // { by, at }
    mentions: [],
    reactions: {}, // emoji -> [name]
    editedAt: null,
    deleted: false,
    createdAt: Date.now(),
    ...fields,
  };
  messages.push(message);
  broadcastToChannel(channel, { type: "message", message });
  // 自分の投稿は自分が読んだことにする
  if (!users.get(message.author)?.bot) setRead(channel, message.author, message.createdAt);
  return message;
}

function updateMessage(message) {
  broadcastToChannel(channels.get(message.channelId), { type: "messageUpdate", message });
}

// 名前を変えたら、その名前を参照しているデータをすべて書き換え、全員に最新の状態を送り直す
function renameUser(user, newName) {
  const oldName = user.name;
  const swap = (n) => (n === oldName ? newName : n);

  users.delete(oldName);
  user.name = newName;
  users.set(newName, user);

  for (const m of messages) {
    m.author = swap(m.author);
    if (m.pinned) m.pinned.by = swap(m.pinned.by);
    if (m.mentions.includes(oldName)) {
      m.mentions = m.mentions.map(swap);
      m.text = m.text.replace(mentionRegex(oldName, "g"), `@${newName}`);
    }
    for (const emoji of Object.keys(m.reactions)) m.reactions[emoji] = m.reactions[emoji].map(swap);
  }
  for (const c of channels.values()) {
    if (!c.members || !c.members.includes(oldName)) continue;
    c.members = c.members.map(swap);
    if (c.kind === "dm") c.name = c.members.join(" & ");
  }
  for (const map of reads.values()) {
    if (!map.has(oldName)) continue;
    map.set(newName, map.get(oldName));
    map.delete(oldName);
  }
  for (const d of docs.values()) d.updatedBy = swap(d.updatedBy);

  for (const u of users.values()) {
    for (const ws of u.sockets) send(ws, initPayload(u.name));
  }
}

function findDM(members) {
  const key = [...members].sort().join("\n");
  return [...channels.values()].find((c) => c.kind === "dm" && [...c.members].sort().join("\n") === key);
}

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let me = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "join") {
      const name = String(data.name || "").trim();
      const error = validateName(name);
      if (error) return send(ws, { type: "error", message: error, code: "join" });
      if (!users.has(name)) {
        users.set(name, {
          name,
          status: "online",
          customStatus: "",
          flow: { kind: "none", detail: "" },
          favorites: new Set(),
          sockets: new Set(),
        });
      }
      me = users.get(name);
      me.sockets.add(ws);
      send(ws, initPayload(name));
      broadcastUsers();
      return;
    }

    if (!me) return;

    switch (data.type) {
      case "status": {
        if (["online", "away", "busy"].includes(data.status)) me.status = data.status;
        if (typeof data.customStatus === "string") me.customStatus = data.customStatus.slice(0, 80);
        if (data.flow && typeof data.flow === "object") {
          me.flow = {
            kind: String(data.flow.kind || "none"),
            detail: String(data.flow.detail || "").slice(0, 80),
          };
        }
        broadcastUsers();
        break;
      }

      case "rename": {
        const name = String(data.name || "").trim();
        if (name === me.name) return;
        const error = validateName(name) || (users.has(name) ? "その名前はすでに使われています" : null);
        if (error) return send(ws, { type: "error", message: error });
        renameUser(me, name);
        break;
      }

      case "message": {
        const channel = channels.get(data.channelId);
        if (!channel || !canSee(channel, me.name)) return;
        const text = String(data.text || "").slice(0, 4000);
        const file = data.fileId ? files.get(data.fileId) || null : null;
        if (!text.trim() && !file) return;
        // スレッドは1段だけ。返信への返信は、元のスレッドに入れる
        const parent = messages.find((m) => m.id === data.parentId && m.channelId === channel.id);
        const parentId = parent ? parent.parentId || parent.id : null;
        const mentions = findMentions(text, channel);
        const message = postMessage(channel, { author: me.name, text, file, parentId, mentions });
        const botDM = channel.kind === "dm" && channel.members.length === 2 && channel.members.includes(BOT);
        if (mentions.includes(BOT) || botDM) botReply(channel, message);
        break;
      }

      case "edit": {
        const message = messages.find((m) => m.id === data.messageId);
        if (!message || message.author !== me.name || message.deleted) return;
        const text = String(data.text || "").slice(0, 4000);
        if (!text.trim() && !message.file && !message.docId) return;
        message.text = text;
        message.mentions = findMentions(text, channels.get(message.channelId));
        message.editedAt = Date.now();
        updateMessage(message);
        break;
      }

      case "delete": {
        const message = messages.find((m) => m.id === data.messageId);
        if (!message || message.author !== me.name || message.deleted) return;
        // 返信の流れが分かるよう、メッセージ自体は残して中身だけ消す
        Object.assign(message, { deleted: true, text: "", file: null, docId: null, mentions: [], reactions: {}, pinned: null });
        updateMessage(message);
        break;
      }

      case "react": {
        const message = messages.find((m) => m.id === data.messageId);
        if (!message || message.deleted || !REACTIONS.includes(data.emoji)) return;
        if (!canSee(channels.get(message.channelId), me.name)) return;
        const list = message.reactions[data.emoji] || [];
        const next = list.includes(me.name) ? list.filter((n) => n !== me.name) : [...list, me.name];
        if (next.length) message.reactions[data.emoji] = next;
        else delete message.reactions[data.emoji];
        updateMessage(message);
        break;
      }

      case "read": {
        const channel = channels.get(data.channelId);
        if (!channel || !canSee(channel, me.name)) return;
        setRead(channel, me.name, data.at);
        break;
      }

      case "favorite": {
        // お気に入りは本人だけのもの。本人の全タブに同期する
        const message = messages.find((m) => m.id === data.messageId);
        if (!message || !canSee(channels.get(message.channelId), me.name)) return;
        if (data.on) me.favorites.add(message.id);
        else me.favorites.delete(message.id);
        for (const s of me.sockets) send(s, { type: "favorites", ids: [...me.favorites] });
        break;
      }

      case "pin": {
        // ピン留めはチャンネルの全員に共有する
        const message = messages.find((m) => m.id === data.messageId);
        if (!message || message.deleted) return;
        if (!canSee(channels.get(message.channelId), me.name)) return;
        message.pinned = data.on ? { by: me.name, at: Date.now() } : null;
        updateMessage(message);
        break;
      }

      case "createGroup": {
        const members = [...new Set([me.name, ...(data.members || [])])].filter((n) => users.has(n));
        const name = String(data.name || "").trim().slice(0, 40) || members.join(", ");
        const channel = { id: id(), name, kind: "group", members };
        channels.set(channel.id, channel);
        broadcastToChannel(channel, { type: "channel", channel });
        send(ws, { type: "open", channelId: channel.id });
        break;
      }

      case "createChannel": {
        const name = String(data.name || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
        if (!name) return;
        const channel = { id: id(), name, kind: "public", members: null };
        channels.set(channel.id, channel);
        broadcastToChannel(channel, { type: "channel", channel });
        send(ws, { type: "open", channelId: channel.id });
        break;
      }

      case "openDM": {
        // with は1人（1対1の DM）か、複数人（グループ DM）
        const others = [].concat(data.with || []).map(String);
        const members = [...new Set([me.name, ...others])];
        if (others.some((n) => !users.has(n))) return;
        if (members.length > DM_MAX) {
          return send(ws, { type: "error", message: `DM に参加できるのは自分を含めて${DM_MAX}人までです` });
        }
        let channel = findDM(members);
        if (!channel) {
          channel = { id: `dm:${id()}`, name: members.join(" & "), kind: "dm", members };
          channels.set(channel.id, channel);
          broadcastToChannel(channel, { type: "channel", channel });
        }
        send(ws, { type: "open", channelId: channel.id });
        break;
      }

      case "createDoc": {
        const channel = channels.get(data.channelId);
        if (!channel || !canSee(channel, me.name)) return;
        const doc = {
          id: id(),
          channelId: channel.id,
          title: String(data.title || "").trim().slice(0, 80) || "無題のドキュメント",
          content: `# ${data.title || "無題のドキュメント"}\n\n`,
          version: 0,
          updatedBy: me.name,
          updatedAt: Date.now(),
        };
        docs.set(doc.id, doc);
        broadcastToChannel(channel, { type: "doc", doc });
        postMessage(channel, { author: me.name, text: "", docId: doc.id });
        send(ws, { type: "openDoc", docId: doc.id });
        break;
      }

      case "docEdit": {
        const doc = docs.get(data.docId);
        if (!doc) return;
        const channel = channels.get(doc.channelId);
        if (!canSee(channel, me.name)) return;
        doc.content = String(data.content ?? "").slice(0, 100000);
        doc.version += 1;
        doc.updatedBy = me.name;
        doc.updatedAt = Date.now();
        broadcastToChannel(channel, { type: "doc", doc, clientId: data.clientId });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!me) return;
    me.sockets.delete(ws);
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Vibe Chat: http://localhost:${PORT}`);
});
