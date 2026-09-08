const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 8080;

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbztrmvWWd8dBI5IOeYu2nwb6Tb9dhFVFL_xVpR2OtbYBKAzgNt6h9ZZKIacxGOsYbeh/exec";

// Armazenamento do estado dos Totens e Administradores
const totems = {};
const adminSockets = new Set();

/* =========================================================
   SISTEMA DE PERSISTÊNCIA VIA GOOGLE APPS SCRIPT (DRIVE)
========================================================= */

async function loadDatabase() {
  try {
    console.log('==============================================');
    console.log('Carregando banco de dados do Google Drive...');
    console.log('==============================================');

    const response = await fetch(APPS_SCRIPT_URL);

    console.log('Status HTTP do carregamento:', response.status);

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
      `Banco de dados remoto carregado com sucesso. Totens encontrados: ${Object.keys(savedTotems).length}`
    );

    console.log('Totens carregados:', JSON.stringify(savedTotems, null, 2));

  } catch (e) {
    console.error('❌ ERRO AO LER BANCO DE DADOS NO GOOGLE DRIVE:');
    console.error(e);
  }
}


async function saveDatabase() {
  try {
    const dataToSave = { totens: {} };

    Object.keys(totems).forEach((id) => {

      // Não salvamos a conexão WebSocket nem o status online
      const { ws, online, ...rest } = totems[id];

      dataToSave.totens[id] = rest;
    });

    console.log('==============================================');
    console.log('Enviando dados para o Google Apps Script...');
    console.log('==============================================');

    console.log(
      JSON.stringify(dataToSave, null, 2)
    );

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(dataToSave)
    });

    const respostaTexto = await response.text();

    console.log('==============================================');
    console.log('Resposta do Google Apps Script');
    console.log('==============================================');

    console.log('Status HTTP:', response.status);
    console.log('Resposta:', respostaTexto);

    if (!response.ok) {
      throw new Error(
        `Google Apps Script respondeu com HTTP ${response.status}: ${respostaTexto}`
      );
    }

    try {

      const resposta = JSON.parse(respostaTexto);

      if (resposta.sucesso === false) {

        throw new Error(
          resposta.erro ||
          'O Google Apps Script informou que não conseguiu salvar.'
        );

      }

      console.log('✅ DADOS SALVOS NO GOOGLE DRIVE COM SUCESSO!');

    } catch (erroJson) {

      console.log(
        '⚠️ A resposta não pôde ser interpretada como JSON.'
      );

      console.log(
        'Resposta recebida:',
        respostaTexto
      );
    }

  } catch (e) {

    console.error('==============================================');
    console.error('❌ ERRO AO SALVAR NO GOOGLE DRIVE');
    console.error('==============================================');

    console.error(e);

  }
}


// Carrega os dados do Drive assim que o servidor inicia
loadDatabase();


function generateUniqueId() {
  return 'totem_' + Math.random().toString(36).substr(2, 9);
}


/* =========================================================
   TRANSMITIR LISTA ATUALIZADA PARA OS PAINÉIS
========================================================= */

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
        'Novo Totem',

      configured:
        totems[id].configured,

      online:
        totems[id].online,

      orientation:
        totems[id].orientation ||
        'portrait',

      mediaType:
        totems[id].mediaType ||
        'image',

      mediaUrl:
        totems[id].mediaUrl ||
        '',

      tickerText:
        totems[id].tickerText ||
        '',

      tickerIcon:
        totems[id].tickerIcon ||
        '',

      lastCommands:
        totems[id].lastCommands ||
        {}
    };
  });


  const payload = JSON.stringify({

    type: 'totem_list',

    totems: totemList

  });


  adminSockets.forEach((adminWs) => {

    if (adminWs.readyState === WebSocket.OPEN) {

      adminWs.send(payload);

    }

  });

}


/* =========================================================
   SERVIDOR HTTP
========================================================= */

const server = http.createServer((req, res) => {

  /* =======================================================
     API
  ======================================================= */

  if (
    req.url === '/api/totems' ||
    req.url === '/api/dados'
  ) {

    res.writeHead(200, {

      'Content-Type':
        'application/json; charset=utf-8',

      'Access-Control-Allow-Origin': '*'

    });

    return res.end(
      JSON.stringify(totems),
      'utf-8'
    );

  }


  let filePath = '';


  if (
    req.url === '/' ||
    req.url === '/player'
  ) {

    filePath =
      path.join(__dirname, 'index.html');

  }

  else if (req.url === '/admin') {

    filePath =
      path.join(__dirname, 'admin.html');

  }

  else {

    filePath =
      path.join(__dirname, req.url);

  }


  const extname =
    String(
      path.extname(filePath)
    ).toLowerCase();


  const mimeTypes = {

    '.html': 'text/html',

    '.js': 'text/javascript',

    '.css': 'text/css',

    '.json': 'application/json',

    '.png': 'image/png',

    '.jpg': 'image/jpg',

    '.jpeg': 'image/jpeg',

    '.gif': 'image/gif',

    '.svg': 'image/svg+xml',

    '.mp4': 'video/mp4',

    '.webm': 'video/webm'

  };


  const contentType =
    mimeTypes[extname] ||
    'text/html';


  const fs = require('fs');


  fs.readFile(
    filePath,
    (error, content) => {

      if (error) {

        if (error.code === 'ENOENT') {

          res.writeHead(
            404,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          res.end(
            '<h1>404 - Página Não Encontrada</h1>',
            'utf-8'
          );

        }

        else {

          res.writeHead(500);

          res.end(
            `Erro no servidor: ${error.code}`
          );

        }

      }

      else {

        res.writeHead(
          200,
          {
            'Content-Type':
              contentType
          }
        );

        res.end(
          content,
          'utf-8'
        );

      }

    }
  );

});


/* =========================================================
   WEBSOCKET SERVER
========================================================= */

const wss =
  new WebSocket.Server({
    server
  });


/* =========================================================
   HEARTBEAT
========================================================= */

function noop() {}


function heartbeat() {

  this.isAlive = true;

}


const interval =
  setInterval(() => {

    wss.clients.forEach((ws) => {

      if (ws.isAlive === false) {

        return ws.terminate();

      }

      ws.isAlive = false;

      ws.ping(noop);

    });

  }, 30000);


wss.on('close', () => {

  clearInterval(interval);

});


/* =========================================================
   GERENCIAMENTO DE CONEXÕES
========================================================= */

wss.on('connection', (ws) => {

  ws.isAlive = true;

  ws.on('pong', heartbeat);


  let clientType = null;

  let clientId = null;


  ws.on('message', (message) => {

    try {

      const data =
        JSON.parse(
          message.toString()
        );


      switch (data.type) {


        /* =================================================
           1. REGISTRO DO PAINEL ADMINISTRATIVO
        ================================================= */

        case 'register_admin':

          clientType = 'admin';

          adminSockets.add(ws);

          console.log(
            'Painel Administrativo conectado.'
          );

          notifyAdminTotemList();

          break;


        /* =================================================
           2. REGISTRO / RECONEXÃO DO TOTEM
        ================================================= */

        case 'register_totem':

          clientType = 'totem';

          clientId =
            data.totemId ||
            generateUniqueId();


          const existingTotem =
            totems[clientId] || {};


          const definedName =
            existingTotem.name ||
            existingTotem.storeName ||
            data.storeName ||
            'Novo Totem';


          totems[clientId] = {

            ...existingTotem,

            id: clientId,

            ws: ws,

            name: definedName,

            storeName: definedName,

            configured: true,

            online: true,

            orientation:
              existingTotem.orientation ||
              data.orientation ||
              'portrait',

            mediaType:
              existingTotem.mediaType ||
              'image',

            mediaUrl:
              existingTotem.mediaUrl ||
              '',

            tickerText:
              existingTotem.tickerText ||
              '',

            tickerIcon:
              existingTotem.tickerIcon ||
              '',

            lastCommands:
              existingTotem.lastCommands ||
              {}

          };


          console.log(
            `Totem conectado: ID [${clientId}] - Nome: "${totems[clientId].name}"`
          );


          // SALVA O ESTADO DO TOTEM
          saveDatabase();


          ws.send(
            JSON.stringify({

              type: 'totem_registered',

              totemId: clientId,

              state: totems[clientId]

            })
          );


          /* =================================================
             REENVIA OS ÚLTIMOS COMANDOS
          ================================================= */

          if (
            totems[clientId].lastCommands
          ) {

            Object.values(
              totems[clientId].lastCommands
            ).forEach(
              (cmdData) => {

                if (
                  ws.readyState ===
                  WebSocket.OPEN
                ) {

                  ws.send(
                    JSON.stringify(cmdData)
                  );

                }

              }
            );

          }


          notifyAdminTotemList();

          break;


        /* =================================================
           3. COMANDOS DO PAINEL PARA O TOTEM
        ================================================= */

        case 'totem_command':

          if (
            clientType === 'admin' &&
            totems[data.totemId]
          ) {

            const targetTotem =
              totems[data.totemId];


            /* =============================================
               NOME
            ============================================= */

            if (data.name) {

              targetTotem.name =
                data.name;

              targetTotem.storeName =
                data.name;

            }


            /* =============================================
               ORIENTAÇÃO
            ============================================= */

            if (data.orientation) {

              targetTotem.orientation =
                data.orientation;

            }


            /* =============================================
               MÍDIA
            ============================================= */

            if (
              data.mediaUrl !== undefined
            ) {

              targetTotem.mediaUrl =
                data.mediaUrl;

              targetTotem.mediaType =
                data.mediaType ||
                targetTotem.mediaType;

            }


            /* =============================================
               TICKER
            ============================================= */

            if (
              data.tickerText !== undefined
            ) {

              targetTotem.tickerText =
                data.tickerText;

              targetTotem.tickerIcon =
                data.tickerIcon || '';

            }


            /* =============================================
               IDENTIFICA O TIPO DO COMANDO
            ============================================= */

            const commandKey =
              data.command ||
              data.action ||
              (
                data.mediaUrl !== undefined
                  ? 'media'
                  : data.tickerText !== undefined
                    ? 'ticker'
                    : data.orientation
                      ? 'orientation'
                      : 'name'
              );


            targetTotem.lastCommands[
              commandKey
            ] = data;


            /* =============================================
               SALVA NO GOOGLE DRIVE
            ============================================= */

            saveDatabase();


            /* =============================================
               ENVIA PARA O TOTEM ONLINE
            ============================================= */

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

            }


            notifyAdminTotemList();

          }

          break;


        /* =================================================
           4. EXCLUIR TOTEM
        ================================================= */

        case 'delete_totem':

          if (
            clientType === 'admin' &&
            totems[data.totemId]
          ) {

            console.log(
              `Totem removido pelo admin: ${data.totemId}`
            );


            if (
              totems[data.totemId].ws
            ) {

              totems[data.totemId].ws.close();

            }


            delete totems[
              data.totemId
            ];


            // SALVA A EXCLUSÃO NO GOOGLE DRIVE
            saveDatabase();


            notifyAdminTotemList();

          }

          break;


        /* =================================================
           MENSAGEM DESCONHECIDA
        ================================================= */

        default:

          console.warn(
            'Tipo de mensagem não reconhecido:',
            data.type
          );

      }


    } catch (err) {

      console.error(
        'Erro ao processar mensagem no servidor:',
        err
      );

    }

  });


  /* =======================================================
     TRATAMENTO DE DESCONEXÃO
  ======================================================= */

  ws.on('close', () => {

    if (
      clientType === 'totem' &&
      clientId &&
      totems[clientId]
    ) {

      console.log(
        `Totem desconectado: ${clientId}`
      );


      totems[clientId].online =
        false;


      totems[clientId].ws =
        null;


      notifyAdminTotemList();

    }

    else if (
      clientType === 'admin'
    ) {

      adminSockets.delete(ws);

    }

  });


  /* =======================================================
     ERRO DE WEBSOCKET
  ======================================================= */

  ws.on('error', (error) => {

    console.error(
      'Erro de conexão WebSocket:',
      error
    );

  });

});


/* =========================================================
   INICIAR SERVIDOR
========================================================= */

server.listen(PORT, () => {

  console.log(
    `===================================================`
  );

  console.log(
    ` Servidor Totem Mídia rodando na porta: ${PORT}`
  );

  console.log(
    ` Banco de dados remoto (Google Drive) ativo!`
  );

  console.log(
    `===================================================`
  );

});

