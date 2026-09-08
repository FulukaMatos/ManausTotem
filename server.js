const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbztrmvWWd8dBI5IOeYu2nwb6Tb9dhFVFL_xVpR2OtbYBKAzgNt6h9ZZKIacxGOsYbeh/exec";

// =========================================================
// ESTADO EM MEMÓRIA
// =========================================================

const totems = {};
const adminSockets = new Set();

// Fila para impedir que dois salvamentos simultâneos
// sobrescrevam o estado mais novo no Google Drive.
let saveQueue = Promise.resolve();

// =========================================================
// PERSISTÊNCIA — GOOGLE APPS SCRIPT / GOOGLE DRIVE
// =========================================================

async function loadDatabase() {
  try {
    console.log("==============================================");
    console.log("Carregando banco de dados do Google Drive...");
    console.log("==============================================");

    const response = await fetch(APPS_SCRIPT_URL);

    console.log("Status HTTP do carregamento:", response.status);

    if (!response.ok) {
      throw new Error(
        `Google Apps Script respondeu com HTTP ${response.status}`
      );
    }

    const data = await response.json();
    const savedTotems = data.totens || {};

    Object.keys(savedTotems).forEach((id) => {
      totems[id] = {
        ...savedTotems[id],
        online: false,
        ws: null
      };
    });

    console.log(
      `Banco remoto carregado. Totens encontrados: ${Object.keys(savedTotems).length}`
    );

    if (Object.keys(savedTotems).length > 0) {
      console.log(
        "Totens carregados:",
        JSON.stringify(savedTotems, null, 2)
      );
    }

  } catch (error) {
    console.error("❌ ERRO AO LER BANCO DE DADOS:");
    console.error(error);

    console.warn(
      "O servidor continuará funcionando com o banco em memória."
    );
  }
}

// =========================================================
// SALVAMENTO REAL
// =========================================================

async function _saveDatabase() {

  const dataToSave = {
    totens: {}
  };

  Object.keys(totems).forEach((id) => {

    // Não salva WebSocket nem status online.
    const {
      ws,
      online,
      ...rest
    } = totems[id];

    dataToSave.totens[id] = rest;
  });

  console.log("==============================================");
  console.log("Enviando dados para o Google Apps Script...");
  console.log("==============================================");

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify(dataToSave)
  });

  const respostaTexto = await response.text();

  console.log(
    "Status HTTP do salvamento:",
    response.status
  );

  console.log(
    "Resposta do Apps Script:",
    respostaTexto
  );

  if (!response.ok) {
    throw new Error(
      `Google Apps Script respondeu com HTTP ${response.status}: ${respostaTexto}`
    );
  }

  let resposta;

  try {

    resposta = JSON.parse(
      respostaTexto
    );

  } catch (error) {

    throw new Error(
      `Resposta do Apps Script não é JSON válido: ${respostaTexto}`
    );
  }

  if (resposta.sucesso === false) {

    throw new Error(
      resposta.erro ||
      "O Google Apps Script informou que não conseguiu salvar."
    );
  }

  console.log(
    "✅ DADOS SALVOS NO GOOGLE DRIVE COM SUCESSO!"
  );
}

// =========================================================
// FILA DE SALVAMENTO
// =========================================================

function saveDatabase() {

  saveQueue = saveQueue
    .then(() => _saveDatabase())
    .catch((error) => {

      console.error(
        "=============================================="
      );

      console.error(
        "❌ ERRO AO SALVAR NO GOOGLE DRIVE"
      );

      console.error(
        "=============================================="
      );

      console.error(error);
    });

  return saveQueue;
}

// =========================================================
// ID ÚNICO
// =========================================================

function generateUniqueId() {

  return (
    "totem_" +
    Math.random()
      .toString(36)
      .substr(2, 9)
  );
}

// =========================================================
// ENVIA LISTA DOS TOTENS PARA OS ADMINS
// =========================================================

function notifyAdminTotemList() {

  const totemList = {};

  Object.keys(totems).forEach((id) => {

    totemList[id] = {

      id: id,

      name:
        totems[id].name ||
        totems[id].storeName ||
        id,

      storeName:
        totems[id].storeName ||
        totems[id].name ||
        "Novo Totem",

      configured:
        totems[id].configured,

      online:
        totems[id].online,

      orientation:
        totems[id].orientation ||
        "portrait",

      mediaType:
        totems[id].mediaType ||
        "image",

      mediaUrl:
        totems[id].mediaUrl ||
        "",

      tickerText:
        totems[id].tickerText ||
        "",

      tickerIcon:
        totems[id].tickerIcon ||
        "",

      lastCommands:
        totems[id].lastCommands ||
        {}
    };
  });

  const payload = JSON.stringify({

    type: "totem_list",

    totems: totemList

  });

  adminSockets.forEach((adminWs) => {

    if (
      adminWs.readyState ===
      WebSocket.OPEN
    ) {

      try {

        adminWs.send(payload);

      } catch (error) {

        console.error(
          "Erro ao enviar lista para admin:",
          error
        );
      }
    }
  });
}

// =========================================================
// SERVIDOR HTTP
// =========================================================

const server = http.createServer(
  (req, res) => {

    // Remove parâmetros da URL.
    const requestPath =
      req.url.split("?")[0];

    // =======================================================
    // API
    // =======================================================

    if (
      requestPath === "/api/totems" ||
      requestPath === "/api/dados"
    ) {

      res.writeHead(200, {

        "Content-Type":
          "application/json; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*"

      });

      return res.end(
        JSON.stringify(totems),
        "utf-8"
      );
    }

    // =======================================================
    // ARQUIVOS
    // =======================================================

    let filePath;

    if (
      requestPath === "/" ||
      requestPath === "/player"
    ) {

      filePath =
        path.join(
          __dirname,
          "index.html"
        );

    }

    else if (
      requestPath === "/admin" ||
      requestPath === "/admin.html"
    ) {

      filePath =
        path.join(
          __dirname,
          "admin.html"
        );

    }

    else {

      // Evita caminhos perigosos.
      const safePath =
        path
          .normalize(requestPath)
          .replace(
            /^(\.\.[\/\\])+/, 
            ""
          );

      filePath =
        path.join(
          __dirname,
          safePath
        );
    }

    // =======================================================
    // MIME TYPES
    // =======================================================

    const extname =
      String(
        path.extname(filePath)
      ).toLowerCase();

    const mimeTypes = {

      ".html":
        "text/html; charset=utf-8",

      ".js":
        "text/javascript; charset=utf-8",

      ".css":
        "text/css; charset=utf-8",

      ".json":
        "application/json; charset=utf-8",

      ".png":
        "image/png",

      ".jpg":
        "image/jpeg",

      ".jpeg":
        "image/jpeg",

      ".gif":
        "image/gif",

      ".svg":
        "image/svg+xml",

      ".mp4":
        "video/mp4",

      ".webm":
        "video/webm",

      ".ico":
        "image/x-icon"
    };

    const contentType =
      mimeTypes[extname] ||
      "application/octet-stream";

    // =======================================================
    // LER ARQUIVO
    // =======================================================

    fs.readFile(
      filePath,
      (error, content) => {

        if (error) {

          if (
            error.code ===
            "ENOENT"
          ) {

            res.writeHead(
              404,
              {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            );

            return res.end(
              "<h1>404 - Página Não Encontrada</h1>",
              "utf-8"
            );
          }

          console.error(
            "Erro ao ler arquivo:",
            error
          );

          res.writeHead(
            500,
            {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          );

          return res.end(
            `Erro no servidor: ${error.code}`
          );
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              contentType,

            "Cache-Control":
              "no-cache"
          }
        );

        res.end(content);
      }
    );
  }
);

// =========================================================
// WEBSOCKET
// =========================================================

const wss =
  new WebSocket.Server({
    server
  });

// =========================================================
// HEARTBEAT
// =========================================================

function noop() {}

function heartbeat() {

  this.isAlive = true;
}

const heartbeatInterval =
  setInterval(
    () => {

      wss.clients.forEach(
        (ws) => {

          if (
            ws.isAlive === false
          ) {

            console.warn(
              "⚠️ WebSocket sem resposta. Encerrando conexão."
            );

            return ws.terminate();
          }

          ws.isAlive = false;

          try {

            ws.ping(noop);

          } catch (error) {

            console.error(
              "Erro ao enviar heartbeat:",
              error
            );
          }
        }
      );

    },
    30000
  );

wss.on(
  "close",
  () => {

    clearInterval(
      heartbeatInterval
    );
  }
);

// =========================================================
// CONEXÕES WEBSOCKET
// =========================================================

wss.on(
  "connection",
  (ws) => {

    ws.isAlive = true;

    ws.on(
      "pong",
      heartbeat
    );

    let clientType = null;

    let clientId = null;

    // =======================================================
    // RECEBE MENSAGENS
    // =======================================================

    ws.on(
      "message",
      (message) => {

        try {

          const data =
            JSON.parse(
              message.toString()
            );

          switch (data.type) {

            // =================================================
            // PING DO PLAYER
            // =================================================

            case "ping":

              if (
                ws.readyState ===
                WebSocket.OPEN
              ) {

                ws.send(
                  JSON.stringify({

                    type: "pong",

                    timestamp:
                      Date.now()

                  })
                );
              }

              break;

            // =================================================
            // ADMIN
            // =================================================

            case "register_admin":

              clientType =
                "admin";

              adminSockets.add(ws);

              console.log(
                "Painel Administrativo conectado."
              );

              notifyAdminTotemList();

              break;

            // =================================================
            // REGISTRO / RECONEXÃO DO TOTEM
            // =================================================

            case "register_totem": {

              clientType =
                "totem";

              clientId =
                data.totemId ||
                generateUniqueId();

              const existingTotem =
                totems[clientId] ||
                {};

              const definedName =
                existingTotem.name ||
                existingTotem.storeName ||
                data.storeName ||
                "Novo Totem";

              totems[clientId] = {

                ...existingTotem,

                id:
                  clientId,

                ws:
                  ws,

                name:
                  definedName,

                storeName:
                  definedName,

                configured:
                  true,

                online:
                  true,

                orientation:
                  existingTotem.orientation ||
                  data.orientation ||
                  "portrait",

                mediaType:
                  existingTotem.mediaType ||
                  data.mediaType ||
                  "image",

                mediaUrl:
                  existingTotem.mediaUrl ||
                  data.mediaUrl ||
                  "",

                tickerText:
                  existingTotem.tickerText ||
                  "",

                tickerIcon:
                  existingTotem.tickerIcon ||
                  "",

                lastCommands:
                  existingTotem.lastCommands ||
                  {}

              };

              console.log(
                `Totem conectado: ID [${clientId}] - Nome: "${totems[clientId].name}"`
              );

              // Salva estado.
              saveDatabase();

              // Envia estado atual.
              if (
                ws.readyState ===
                WebSocket.OPEN
              ) {

                ws.send(
                  JSON.stringify({

                    type:
                      "totem_registered",

                    totemId:
                      clientId,

                    state:
                      totems[clientId]

                  })
                );
              }

              // =================================================
              // REENVIA ÚLTIMOS COMANDOS
              // =================================================

              const lastCommands =
                totems[clientId]
                  .lastCommands ||
                {};

              Object.values(
                lastCommands
              ).forEach(
                (cmdData) => {

                  if (
                    ws.readyState ===
                    WebSocket.OPEN
                  ) {

                    ws.send(
                      JSON.stringify(
                        cmdData
                      )
                    );
                  }
                }
              );

              notifyAdminTotemList();

              break;
            }

            // =================================================
            // COMANDO ADMIN -> TOTEM
            // =================================================

            case "totem_command": {

              if (
                clientType !==
                  "admin" ||
                !totems[
                  data.totemId
                ]
              ) {

                break;
              }

              const targetTotem =
                totems[
                  data.totemId
                ];

              // =================================================
              // NOME
              // =================================================

              if (
                data.name !==
                undefined
              ) {

                targetTotem.name =
                  data.name;

                targetTotem.storeName =
                  data.name;
              }

              // =================================================
              // ORIENTAÇÃO
              // =================================================

              if (
                data.orientation !==
                undefined
              ) {

                targetTotem.orientation =
                  data.orientation;
              }

              // =================================================
              // MÍDIA
              // =================================================

              if (
                data.mediaUrl !==
                undefined
              ) {

                targetTotem.mediaUrl =
                  data.mediaUrl;

                if (
                  data.mediaType !==
                  undefined
                ) {

                  targetTotem.mediaType =
                    data.mediaType;
                }
              }

              // =================================================
              // TICKER
              // =================================================

              if (
                data.tickerText !==
                undefined
              ) {

                targetTotem.tickerText =
                  data.tickerText;

                targetTotem.tickerIcon =
                  data.tickerIcon ||
                  "";
              }

              // =================================================
              // IDENTIFICA COMANDO
              // =================================================

              const commandKey =

                data.command ||

                data.action ||

                (
                  data.mediaUrl !==
                  undefined

                    ? "media"

                    : data.tickerText !==
                      undefined

                      ? "ticker"

                      : data.orientation !==
                        undefined

                        ? "orientation"

                        : data.name !==
                          undefined

                          ? "name"

                          : "command"
                );

              targetTotem.lastCommands =
                targetTotem.lastCommands ||
                {};

              targetTotem.lastCommands[
                commandKey
              ] = data;

              // =================================================
              // SALVA NO GOOGLE DRIVE
              // =================================================

              saveDatabase();

              // =================================================
              // ENVIA AO TOTEM
              // =================================================

              if (
                targetTotem.ws &&
                targetTotem.ws.readyState ===
                  WebSocket.OPEN
              ) {

                targetTotem.ws.send(
                  JSON.stringify(data)
                );

                console.log(
                  `Comando enviado para o totem: ${data.totemId}`
                );

              } else {

                console.warn(
                  `Totem ${data.totemId} está offline. Comando ficou salvo para reconexão.`
                );
              }

              notifyAdminTotemList();

              break;
            }

            // =================================================
            // EXCLUIR TOTEM
            // =================================================

            case "delete_totem": {

              if (
                clientType !==
                  "admin" ||
                !totems[
                  data.totemId
                ]
              ) {

                break;
              }

              console.log(
                `Totem removido pelo admin: ${data.totemId}`
              );

              const socketToClose =
                totems[
                  data.totemId
                ].ws;

              delete totems[
                data.totemId
              ];

              if (
                socketToClose &&
                socketToClose.readyState ===
                  WebSocket.OPEN
              ) {

                socketToClose.close();
              }

              saveDatabase();

              notifyAdminTotemList();

              break;
            }

            // =================================================
            // DESCONHECIDO
            // =================================================

            default:

              console.warn(
                "Tipo de mensagem não reconhecido:",
                data.type
              );
          }

        } catch (error) {

          console.error(
            "Erro ao processar mensagem no servidor:",
            error
          );
        }
      }
    );

    // =======================================================
    // DESCONEXÃO
    // =======================================================

    ws.on(
      "close",
      () => {

        if (
          clientType ===
            "totem" &&
          clientId &&
          totems[clientId]
        ) {

          // IMPORTANTE:
          // Só derruba o Totem se este WebSocket
          // ainda for o WebSocket atual dele.
          //
          // Isso evita que uma conexão antiga,
          // fechando depois da reconexão,
          // coloque o Totem como offline.

          if (
            totems[clientId].ws ===
            ws
          ) {

            console.log(
              `Totem desconectado: ${clientId}`
            );

            totems[clientId].online =
              false;

            totems[clientId].ws =
              null;

            notifyAdminTotemList();

          } else {

            console.log(
              `Conexão antiga do totem ${clientId} encerrada. Conexão atual preservada.`
            );
          }

        }

        else if (
          clientType ===
          "admin"
        ) {

          adminSockets.delete(
            ws
          );

          console.log(
            "Painel Administrativo desconectado."
          );
        }
      }
    );

    // =======================================================
    // ERRO
    // =======================================================

    ws.on(
      "error",
      (error) => {

        console.error(
          "Erro de conexão WebSocket:",
          error
        );
      }
    );
  }
);

// =========================================================
// INICIALIZAÇÃO DO SERVIDOR
// =========================================================

async function iniciarServidor() {

  // Primeiro carrega o banco.
  // Depois inicia o servidor.

  await loadDatabase();

  server.listen(
    PORT,
    () => {

      console.log("");

      console.log(
        "==================================================="
      );

      console.log(
        ` Servidor Totem Mídia rodando na porta: ${PORT}`
      );

      console.log(
        " Banco remoto Google Drive conectado!"
      );

      console.log(
        " WebSocket ativo!"
      );

      console.log(
        "==================================================="
      );

      console.log("");
    }
  );
}

// =========================================================
// INICIAR
// =========================================================

iniciarServidor().catch(
  (error) => {

    console.error(
      "❌ Erro fatal ao iniciar o servidor:",
      error
    );

    process.exit(1);
  }
);
