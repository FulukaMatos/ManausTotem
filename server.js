const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 8080;
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxDHH9STm6mvXbcVPz9ntExC_uaI5IojfYGw6MRv5J8ays6hbJXRa_rKItE2__Mn7nq/exec";
const WS_URL = "wss://manaustotem.onrender.com";
let totems = {};
const adminSockets = new Set();
let saveQueue = Promise.resolve();

async function loadDatabase() {
  try {
    const r = await fetch(APPS_SCRIPT_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    totems = d.totens || {};
    for (const id of Object.keys(totems)) normalizeTotem(totems[id], id);
    console.log("Banco carregado do Google Drive.");
  } catch (e) {
    console.error("Erro ao carregar banco:", e);
    totems = {};
  }
}
function normalizeTotem(t, id) {
  t.id = id;
  t.online = false;
  t.ws = null;
  t.name = t.name || "";
  t.storeName = t.storeName || "";
  t.orientation = t.orientation || "portrait";
  t.mediaType = t.mediaType || "image";
  t.mediaUrl = t.mediaUrl || "";
  t.tickerText = t.tickerText ?? "Bem-vindo!";
  t.tickerIcon = t.tickerIcon || "";
  t.audioEnabled = t.audioEnabled === true;
  t.lastCommands = t.lastCommands || {};
  return t;
}
function saveDatabase() {
  saveQueue = saveQueue.then(async () => {
    try {
      const out = { totens: {} };
      for (const id of Object.keys(totems)) {
        const t = { ...totems[id] };
        delete t.ws; delete t.online;
        out.totens[id] = t;
      }
      const r = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(out)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      console.log("Banco salvo no Google Drive.");
    } catch (e) { console.error("Erro ao salvar banco:", e); }
  });
  return saveQueue;
}
function generateUniqueId() {
  return "totem_" + Math.random().toString(36).substring(2, 11);
}
function publicTotem(t) {
  return {
    id: t.id, name: t.name || "", storeName: t.storeName || "",
    configured: !!t.configured, online: !!t.online,
    orientation: t.orientation || "portrait",
    mediaType: t.mediaType || "image", mediaUrl: t.mediaUrl || "",
    tickerText: t.tickerText || "", tickerIcon: t.tickerIcon || "",
    audioEnabled: t.audioEnabled === true, lastCommands: t.lastCommands || {}
  };
}
function buildTotemList() {
  const result = {};
  for (const id of Object.keys(totems)) result[id] = publicTotem(totems[id]);
  return result;
}
function notifyAdminTotemList() {
  const msg = JSON.stringify({ type: "totem_list", totems: buildTotemList() });
  for (const ws of adminSockets)
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function sendCanonicalState(ws, t) {
  ws.send(JSON.stringify({ type: "totem_state", ...publicTotem(t), totemId: t.id }));
}
function applyCommand(t, d) {
  for (const key of ["name","storeName","orientation","mediaType","mediaUrl","tickerText","tickerIcon"])
    if (d[key] !== undefined) t[key] = d[key];
  if (d.audioEnabled !== undefined) t.audioEnabled = d.audioEnabled === true;
  if (d.name !== undefined && d.storeName === undefined) t.storeName = d.name;
  t.configured = true;
}
function contentType(file) {
  return ({
    ".html":"text/html; charset=utf-8", ".js":"application/javascript; charset=utf-8",
    ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8",
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
    ".gif":"image/gif", ".svg":"image/svg+xml", ".mp4":"video/mp4", ".webm":"video/webm"
  })[path.extname(file).toLowerCase()] || "application/octet-stream";
}
const server = http.createServer((req, res) => {
  if (req.url === "/api/totems" || req.url === "/api/dados") {
    res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
    return res.end(JSON.stringify(buildTotemList()));
  }
  let file;
  const route = req.url.split("?")[0];
  if (route === "/" || route === "/player") file = path.join(__dirname, "index.html");
  else if (route === "/admin" || route === "/admin.html") file = path.join(__dirname, "admin.html");
  else file = path.join(__dirname, decodeURIComponent(route));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end("Acesso negado"); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end("Arquivo não encontrado"); }
    res.writeHead(200, {"Content-Type":contentType(file), "Cache-Control":"no-cache"});
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);
  const interval = setInterval(() => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  }, 30000);
  ws.on("message", async raw => {
    try {
      const d = JSON.parse(raw.toString());
      if (d.type === "ping") return ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({type:"pong"}));
      if (d.type === "register_admin") {
        ws.clientType = "admin"; adminSockets.add(ws);
        return ws.send(JSON.stringify({type:"totem_list", totems:buildTotemList()}));
      }
      if (d.type === "register_totem") {
        ws.clientType = "totem";
        const id = d.totemId || generateUniqueId();
        if (!totems[id]) totems[id] = normalizeTotem({configured:true}, id);
        const t = totems[id];
        if (t.ws && t.ws !== ws && t.ws.readyState === WebSocket.OPEN) t.ws.close();
        t.ws = ws; t.online = true; t.id = id;
        if (d.name) t.name = d.name;
        if (d.storeName) t.storeName = d.storeName;
        ws.totemId = id;
        await saveDatabase();
        ws.send(JSON.stringify({type:"totem_registered", totemId:id}));
        sendCanonicalState(ws, t); notifyAdminTotemList(); return;
      }
      if (d.type === "totem_command" && ws.clientType === "admin") {
        const t = totems[d.totemId]; if (!t) return;
        applyCommand(t, d);
        const key = d.commandKey || d.command || d.action || `cmd_${Date.now()}`;
        t.lastCommands[key] = publicTotem(t);
        await saveDatabase();
        if (t.ws && t.ws.readyState === WebSocket.OPEN) sendCanonicalState(t.ws, t);
        notifyAdminTotemList(); return;
      }
      if (d.type === "delete_totem" && ws.clientType === "admin") {
        const t = totems[d.totemId]; if (!t) return;
        if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.close();
        delete totems[d.totemId]; await saveDatabase(); notifyAdminTotemList();
      }
    } catch (e) { console.error("Erro na mensagem:", e); }
  });
  ws.on("close", () => {
    clearInterval(interval);
    if (ws.clientType === "admin") adminSockets.delete(ws);
    if (ws.clientType === "totem" && totems[ws.totemId]?.ws === ws) {
      totems[ws.totemId].online = false; totems[ws.totemId].ws = null; notifyAdminTotemList();
    }
  });
  ws.on("error", e => console.error("WebSocket erro:", e));
});
(async () => {
  await loadDatabase();
  server.listen(PORT, () => console.log(`Manaus Totem rodando na porta ${PORT} | WebSocket: ${WS_URL}`));
})();
