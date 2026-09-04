const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 8080;
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxDHH9STm6mvXbcVPz9ntExC_uaI5IojfYGw6MRv5J8ays6hbJXRa_rKItE2__Mn7nq/exec";

// Armazenamento do estado dos Totens e Administradores
const totems = {};
const adminSockets = new Set();

/* =========================================================
   SISTEMA DE PERSISTÊNCIA VIA GOOGLE APPS SCRIPT (DRIVE)
========================================================= */
async function loadDatabase() {
  try {
    const response = await fetch(APPS_SCRIPT_URL);
    const data = await response.json();
    const savedTotems = data.totens || {};

    Object.keys(savedTotems).forEach((id) => {
      totems[id] = {
        ...savedTotems[id],
        online: false, // Inicia offline até conectar
        ws: null
      };
    });
    console.log('Banco de dados remoto (Google Drive) carregado com sucesso.');
  } catch (e) {
    console.error('Erro ao ler banco de dados no Google Drive:', e);
  }
}

async function saveDatabase() {
  try {
    const dataToSave = { totens: {} };
    Object.keys(totems).forEach((id) => {
      // Removemos a conexão WebSocket (ws) para salvar apenas os dados do totem
      const { ws, online, ...rest } = totems[id];
      dataToSave.totens[id] = rest;
    });

    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dataToSave)
    });
    console.log('Dados sincronizados com o Google Drive.');
  } catch (e) {
    console.error('Erro ao salvar no Google Drive:', e);
  }
}

// Carrega os dados do Drive assim que o servidor inicia
loadDatabase();

function generateUniqueId() {
  return 'totem_' + Math.random().toString(36).substr(2, 9);
}

// Transmitir lista atualizada de totens para todos os Painéis Administrativos
function notifyAdminTotemList() {
  const totemList = {};
  Object.keys(totems).forEach((id) => {
    totemList[id] = {
      id: id,
      name: totems[id].name || totems[id].storeName || id,
      storeName: totems[id].storeName || totems[id].name || 'Novo Totem',
      configured: totems[id].configured,
      online: totems[id].online,
      orientation: totems[id].orientation || 'portrait',
      mediaType: totems[id].mediaType || 'image',
      mediaUrl: totems[id].mediaUrl || '',
      tickerText: totems[id].tickerText || '',
      tickerIcon: totems[id].tickerIcon || '',
      lastCommands: totems[id].lastCommands || {}
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

// Servidor HTTP para servir arquivos estáticos e Rotas API
const server = http.createServer((req, res) => {
  if (req.url === '/api/totems' || req.url === '/api/dados') {
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify(totems), 'utf-8');
  }

  let filePath = '';

  if (req.url === '/' || req.url === '/player') {
    filePath = path.join(__dirname, 'index.html');
  } else if (req.url === '/admin') {
    filePath = path.join(__dirname, 'admin.html');
  } else {
    filePath = path.join(__dirname, req.url);
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
  };

  const contentType = mimeTypes[extname] || 'text/html';

  const fs = require('fs');
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 - Página Não Encontrada</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Erro no servidor: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Instância do WebSocket Server
const wss = new WebSocket.Server({ server });

/* =========================================================
   HEARTBEAT
========================================================= */
function noop() {}

function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();

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
      const data = JSON.parse(message.toString());

      switch (data.type) {

        /* 1. REGISTRO DO PAINEL ADMINISTRATIVO */
        case 'register_admin':
          clientType = 'admin';
          adminSockets.add(ws);
          console.log('Painel Administrativo conectado.');
          notifyAdminTotemList();
          break;

        /* 2. REGISTRO / RECONEXÃO DO TOTEM */
        case 'register_totem':
          clientType = 'totem';
          clientId = data.totemId || generateUniqueId();

          const existingTotem = totems[clientId] || {};

          const definedName = existingTotem.name || existingTotem.storeName || data.storeName || 'Novo Totem';

          totems[clientId] = {
            ...existingTotem,
            id: clientId,
            ws: ws,
            name: definedName,
            storeName: definedName,
            configured: true,
            online: true,
            orientation: existingTotem.orientation || data.orientation || 'portrait',
            mediaType: existingTotem.mediaType || 'image',
            mediaUrl: existingTotem.mediaUrl || '',
            tickerText: existingTotem.tickerText || '',
            tickerIcon: existingTotem.tickerIcon || '',
            lastCommands: existingTotem.lastCommands || {}
          };

          console.log(`Totem conectado: ID [${clientId}] - Nome: "${totems[clientId].name}"`);

          saveDatabase();

          ws.send(JSON.stringify({
            type: 'totem_registered',
            totemId: clientId,
            state: totems[clientId]
          }));

          if (totems[clientId].lastCommands) {
            Object.values(totems[clientId].lastCommands).forEach((cmdData) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(cmdData));
              }
            });
          }

          notifyAdminTotemList();
          break;

        /* 3. COMANDOS DO PAINEL ENVIADOS PARA O TOTEM */
        case 'totem_command':
          if (clientType === 'admin' && totems[data.totemId]) {
            const targetTotem = totems[data.totemId];

            if (data.name) {
              targetTotem.name = data.name;
              targetTotem.storeName = data.name;
            }
            if (data.orientation) {
              targetTotem.orientation = data.orientation;
            }
            if (data.mediaUrl !== undefined) {
              targetTotem.mediaUrl = data.mediaUrl;
              targetTotem.mediaType = data.mediaType || targetTotem.mediaType;
            }
            if (data.tickerText !== undefined) {
              targetTotem.tickerText = data.tickerText;
              targetTotem.tickerIcon = data.tickerIcon || '';
            }

            const commandKey = data.command || data.action || (data.mediaUrl !== undefined ? 'media' : data.tickerText !== undefined ? 'ticker' : data.orientation ? 'orientation' : 'name');
            targetTotem.lastCommands[commandKey] = data;

            saveDatabase();

            if (targetTotem.ws && targetTotem.ws.readyState === WebSocket.OPEN) {
              targetTotem.ws.send(JSON.stringify(data));
              console.log(`Comando enviado para o totem: ${data.totemId}`);
            }

            notifyAdminTotemList();
          }
          break;

        /* 4. EXCLUIR TOTEM DO BANCO DE DADOS */
        case 'delete_totem':
          if (clientType === 'admin' && totems[data.totemId]) {
            console.log(`Totem removido pelo admin: ${data.totemId}`);
            
            if (totems[data.totemId].ws) {
              totems[data.totemId].ws.close();
            }

            delete totems[data.totemId];
            saveDatabase();

            notifyAdminTotemList();
          }
          break;

        default:
          console.warn('Tipo de mensagem não reconhecido:', data.type);
      }
    } catch (err) {
      console.error('Erro ao processar mensagem no servidor:', err);
    }
  });

  /* TRATAMENTO DE DESCONEXÃO */
  ws.on('close', () => {
    if (clientType === 'totem' && clientId && totems[clientId]) {
      console.log(`Totem desconectado: ${clientId}`);
      totems[clientId].online = false;
      totems[clientId].ws = null;
      notifyAdminTotemList();
    } else if (clientType === 'admin') {
      adminSockets.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('Erro de conexão WebSocket:', error);
  });
});

server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Servidor Totem Mídia rodando na porta: ${PORT}`);
  console.log(` Banco de dados remoto (Google Drive) ativo!`);
  console.log(`===================================================`);
});
