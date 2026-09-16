const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 8080;

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxDHH9STm6mvXbcVPz9ntExC_uaI5IojfYGw6MRv5J8ays6hbJXRa_rKItE2__Mn7nq/exec";

const WS_URL = "wss://manaustotem.onrender.com";

let totems = {};
const adminSockets = new Set();
let saveQueue = Promise.resolve();

async function loadDatabase() {
  try {
    const resposta = await fetch(APPS_SCRIPT_URL);

    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }

    const dados = await resposta.json();

    totems = dados.totens || {};

    Object.keys(totems).forEach(id => {
      totems[id].online = false;
      totems[id].ws = null;
      totems[id].lastCommands =
        totems[id].lastCommands || {};
    });

    console.log("Banco carregado do Google Drive.");
  } catch (erro) {
    console.error("Erro ao carregar banco:", erro);
    totems = {};
  }
}

function saveDatabase() {
  saveQueue = saveQueue.then(async () => {
    try {
      const dados = {
        totens: {}
      };

      Object.keys(totems).forEach(id => {
        const t = { ...totems[id] };

        delete t.ws;
        delete t.online;

        dados.totens[id] = t;
      });

      const resposta = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(dados)
      });

      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
      }

      console.log("Banco salvo no Google Drive.");
    } catch (erro) {
      console.error("Erro ao salvar banco:", erro);
    }
  });

  return saveQueue;
}

function generateUniqueId() {
  return "totem_" +
    Math.random().toString(36).substring(2, 11);
}

function buildTotemList() {
  const lista = {};

  Object.keys(totems).forEach(id => {
    const t = totems[id];

    lista[id] = {
      id,
      name: t.name || "",
      storeName: t.storeName || "",
      configured: !!t.configured,
      online: !!t.online,
      orientation: t.orientation || "portrait",
      mediaType: t.mediaType || "image",
      mediaUrl: t.mediaUrl || "",
      tickerText: t.tickerText || "",
      tickerIcon: t.tickerIcon || "",
      lastCommands: t.lastCommands || {}
    };
  });

  return lista;
}

function notifyAdminTotemList() {
  const mensagem = JSON.stringify({
    type: "totem_list",
    totems: buildTotemList()
  });

  adminSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(mensagem);
    }
  });
}

function sendCanonicalState(ws, t) {
  ws.send(JSON.stringify({
    type: "totem_state",
    totemId: t.id,
    name: t.name || "",
    storeName: t.storeName || "",
    configured: !!t.configured,
    orientation: t.orientation || "portrait",
    mediaType: t.mediaType || "image",
    mediaUrl: t.mediaUrl || "",
    tickerText: t.tickerText || "Bem-vindo!",
    tickerIcon: t.tickerIcon || ""
  }));
}

function applyCommandToTotem(t, data) {
  if (data.name !== undefined) {
    t.name = data.name;
    t.storeName = data.name;
  }

  if (data.storeName !== undefined) {
    t.storeName = data.storeName;
  }

  if (data.orientation !== undefined) {
    t.orientation = data.orientation;
  }

  if (data.mediaUrl !== undefined) {
    t.mediaUrl = data.mediaUrl;
  }

  if (data.mediaType !== undefined) {
    t.mediaType = data.mediaType;
  }

  if (data.tickerText !== undefined) {
    t.tickerText = data.tickerText;
  }

  if (data.tickerIcon !== undefined) {
    t.tickerIcon = data.tickerIcon;
  }

  t.configured = true;
}

function safeContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const tipos = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  };

  return tipos[ext] ||
    "application/octet-stream";
}

const server = http.createServer((req, res) => {
  let filePath;

  if (
    req.url === "/api/totems" ||
    req.url === "/api/dados"
  ) {
    res.writeHead(200, {
      "Content-Type":
        "application/json; charset=utf-8"
    });

    return res.end(
      JSON.stringify(buildTotemList())
    );
  }

  if (
    req.url === "/" ||
    req.url === "/player"
  ) {
    filePath = path.join(
      __dirname,
      "index.html"
    );
  } else if (
    req.url === "/admin" ||
    req.url === "/admin.html"
  ) {
    filePath = path.join(
      __dirname,
      "admin.html"
    );
  } else {
    const requested =
      decodeURIComponent(
        req.url.split("?")[0]
      );

    filePath = path.join(
      __dirname,
      requested
    );
  }

  fs.readFile(
    filePath,
    (erro, conteudo) => {
      if (erro) {
        res.writeHead(404);
        return res.end(
          "Arquivo não encontrado"
        );
      }

      res.writeHead(200, {
        "Content-Type":
          safeContentType(filePath),
        "Cache-Control": "no-cache"
      });

      res.end(conteudo);
    }
  );
});

const wss = new WebSocket.Server({
  server
});

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", heartbeat);

  const interval = setInterval(() => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();

  }, 30000);

  ws.on("message", async mensagem => {
    try {
      const data =
        JSON.parse(mensagem.toString());

      switch (data.type) {

        case "ping":

          if (
            ws.readyState ===
            WebSocket.OPEN
          ) {
            ws.send(JSON.stringify({
              type: "pong"
            }));
          }

          break;


        case "register_admin":

          ws.clientType = "admin";

          adminSockets.add(ws);

          ws.send(JSON.stringify({
            type: "totem_list",
            totems: buildTotemList()
          }));

          break;


        case "register_totem": {

          ws.clientType = "totem";

          const clientId =
            data.totemId ||
            generateUniqueId();

          if (!totems[clientId]) {

            totems[clientId] = {
              id: clientId,
              name: "",
              storeName: "",
              configured: true,
              orientation: "portrait",
              mediaType: "image",
              mediaUrl: "",
              tickerText: "Bem-vindo!",
              tickerIcon: "",
              lastCommands: {}
            };
          }

          const t = totems[clientId];

          if (
            t.ws &&
            t.ws !== ws &&
            t.ws.readyState ===
            WebSocket.OPEN
          ) {
            try {
              t.ws.close();
            } catch {}
          }

          t.id = clientId;
          t.ws = ws;
          t.online = true;

          if (data.name) {
            t.name = data.name;
          }

          if (data.storeName) {
            t.storeName =
              data.storeName;
          }

          if (!t.orientation) {
            t.orientation = "portrait";
          }

          if (!t.mediaType) {
            t.mediaType = "image";
          }

          if (!t.mediaUrl) {
            t.mediaUrl = "";
          }

          if (!t.tickerText) {
            t.tickerText =
              "Bem-vindo!";
          }

          if (!t.lastCommands) {
            t.lastCommands = {};
          }

          ws.totemId = clientId;

          await saveDatabase();

          ws.send(JSON.stringify({
            type: "totem_registered",
            totemId: clientId
          }));

          sendCanonicalState(ws, t);

          notifyAdminTotemList();

          break;
        }


        case "totem_command": {

          if (ws.clientType !== "admin") {
            break;
          }

          const id = data.totemId;

          if (!id || !totems[id]) {
            break;
          }

          const t = totems[id];

          applyCommandToTotem(t, data);

          const commandKey =
            data.commandKey ||
            data.command ||
            data.action ||
            `cmd_${Date.now()}`;

          t.lastCommands[commandKey] = {
            type: "totem_command",
            orientation: t.orientation,
            mediaType: t.mediaType,
            mediaUrl: t.mediaUrl,
            tickerText: t.tickerText,
            tickerIcon: t.tickerIcon,
            name: t.name,
            storeName: t.storeName
          };

          await saveDatabase();

          if (
            t.ws &&
            t.ws.readyState ===
            WebSocket.OPEN
          ) {
            sendCanonicalState(
              t.ws,
              t
            );
          }

          notifyAdminTotemList();

          break;
        }


        case "delete_totem": {

          if (ws.clientType !== "admin") {
            break;
          }

          const id = data.totemId;

          if (!id || !totems[id]) {
            break;
          }

          const t = totems[id];

          if (
            t.ws &&
            t.ws.readyState ===
            WebSocket.OPEN
          ) {
            try {
              t.ws.close();
            } catch {}
          }

          delete totems[id];

          await saveDatabase();

          notifyAdminTotemList();

          break;
        }


        default:

          console.warn(
            "Tipo desconhecido:",
            data.type
          );
      }

    } catch (erro) {
      console.error(
        "Erro ao processar mensagem:",
        erro
      );
    }
  });


  ws.on("close", () => {

    clearInterval(interval);

    if (ws.clientType === "admin") {
      adminSockets.delete(ws);
    }

    if (ws.clientType === "totem") {

      const id = ws.totemId;

      if (
        id &&
        totems[id] &&
        totems[id].ws === ws
      ) {

        totems[id].online = false;
        totems[id].ws = null;

        notifyAdminTotemList();
      }
    }
  });


  ws.on("error", erro => {
    console.error(
      "WebSocket erro:",
      erro
    );
  });

});

async function start() {

  await loadDatabase();

  server.listen(PORT, () => {

    console.log(
      `Manaus Totem rodando na porta ${PORT}`
    );

    console.log(
      `WebSocket: ${WS_URL}`
    );

    console.log(
      "Banco Google Drive ativo."
    );
  });
}

start();
