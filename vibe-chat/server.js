const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(UPLOAD_DIR));

// ---- インメモリの状態 ----
const users = new Map(); // name -> { name, status, customStatus, flow, favorites:Set, sockets:Set }
const channels = new Map(); // id -> { id, name, kind: public|group|dm, members:[] | null }
const messages = []; // { id, channelId, author, text, parentId, file, docId, pinned, createdAt }
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

// 本文の @名前（全角の ＠ も可）から、チャンネルのメンバーへのメンションを取り出す
function findMentions(text, channel) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return channelMembers(channel).filter((name) =>
    new RegExp(`[@＠]${escape(name)}(?=$|[\\s、。,.!?！？:：)）])`).test(text),
  );
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
    createdAt: Date.now(),
    ...fields,
  };
  messages.push(message);
  broadcastToChannel(channel, { type: "message", message });
  // 自分の投稿は自分が読んだことにする
  if (!users.get(message.author)?.bot) setRead(channel, message.author, message.createdAt);
  return message;
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
      const name = String(data.name || "").trim().slice(0, 32);
      if (!name) return send(ws, { type: "error", message: "名前を入力してください" });
      if (users.get(name)?.bot) return send(ws, { type: "error", message: "その名前はボット用のため使えません" });
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

      case "message": {
        const channel = channels.get(data.channelId);
        if (!channel || !canSee(channel, me.name)) return;
        const text = String(data.text || "").slice(0, 4000);
        const file = data.fileId ? files.get(data.fileId) || null : null;
        if (!text.trim() && !file) return;
        const parent = messages.find((m) => m.id === data.parentId && m.channelId === channel.id);
        const mentions = findMentions(text, channel);
        const message = postMessage(channel, { author: me.name, text, file, parentId: parent ? parent.id : null, mentions });
        const botDM = channel.kind === "dm" && channel.members.includes(BOT);
        if (mentions.includes(BOT) || botDM) botReply(channel, message);
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
        if (!message) return;
        const channel = channels.get(message.channelId);
        if (!canSee(channel, me.name)) return;
        message.pinned = data.on ? { by: me.name, at: Date.now() } : null;
        broadcastToChannel(channel, { type: "messageUpdate", message });
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
        const other = String(data.with || "");
        if (!users.has(other)) return;
        const pair = [me.name, other].sort();
        const dmId = `dm:${pair.join(":")}`;
        let channel = channels.get(dmId);
        if (!channel) {
          channel = { id: dmId, name: pair.join(" & "), kind: "dm", members: [...new Set(pair)] };
          channels.set(dmId, channel);
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
