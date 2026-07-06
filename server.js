// Servidor de "Club de Lectura" — chat por salas (libros), con passwords,
// host, transferencia de host, fusión de salas y video de YouTube sincronizado.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Subida de PDFs (el host presenta un PDF para toda la sala) ----------
const PDF_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'pdfs');
fs.mkdirSync(PDF_UPLOAD_DIR, { recursive: true });

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PDF_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const unique = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${unique}.pdf`);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 }, // 40 MB
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    cb(isPdf ? null : new Error('Solo se permiten archivos PDF.'), isPdf);
  },
});

app.post('/api/upload-pdf', (req, res) => {
  pdfUpload.single('pdf')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'No se pudo subir el archivo.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No llegó ningún archivo.' });

    const { roomId, clientId } = req.body || {};
    const room = rooms.get(roomId);
    // Solo la identidad que es host registrado de la sala puede subir un PDF para todos.
    if (!room || !clientId || room.hostUserId !== clientId.toString()) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ ok: false, error: 'Solo el host de la sala puede subir un PDF.' });
    }

    const originalName = (req.file.originalname || 'documento.pdf').toString().slice(0, 120);
    const url = `/uploads/pdfs/${req.file.filename}`;
    res.json({ ok: true, url, fileName: originalName });
  });
});

// ---------- Subida de archivos adjuntos del chat (imágenes u otros) ----------
const CHAT_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'chat');
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CHAT_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const unique = crypto.randomBytes(8).toString('hex');
      const ext = path.extname(file.originalname || '').slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `${Date.now()}-${unique}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

app.post('/api/upload-chat-file', (req, res) => {
  chatUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'No se pudo subir el archivo.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No llegó ningún archivo.' });

    const { clientId } = req.body || {};
    // Cualquier identidad registrada (ya pasó por user:hello) puede adjuntar
    // archivos al chat; la pertenencia a la sala se valida de nuevo al enviar
    // el mensaje (chat:send), igual que con el texto.
    if (!clientId || !privateIdToName.has(clientId.toString())) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ ok: false, error: 'Identidad no reconocida.' });
    }

    const originalName = (req.file.originalname || 'archivo').toString().slice(0, 150);
    const url = `/uploads/chat/${req.file.filename}`;
    res.json({ ok: true, url, fileName: originalName, mimeType: req.file.mimetype, size: req.file.size });
  });
});

// ---------- Estado en memoria ----------
// rooms: Map<roomId, room>
// room = {
//   id, title, isGeneral, hostId, hostName, passwordHash,
//   users: Map<socketId, {id, name}>,
//   messages: [{id, name, text, ts, system}],
//   video: {videoId, isPlaying, time, updatedAt},
//   createdAt
// }
const rooms = new Map();

const DEFAULT_AFK_MINUTES = 5;
const PRIVATE_ID_LENGTH = 50;

// ---------- Identidad de usuarios (privada, solo la conoce el servidor) ----------
// El servidor asigna a cada persona un ID privado de 50 dígitos que nunca se le
// muestra a otros usuarios (solo se usa internamente para saber "quién es quién"
// entre reconexiones, por ejemplo si el host actualiza la página). Los nombres
// también son únicos: una vez tomado, nadie más puede usarlo mientras el server
// siga corriendo. Todo esto vive solo en memoria y se reinicia si el proceso
// del servidor se reinicia (cerrar la terminal, redeploy en Railway/Render, etc).
const nameToPrivateId = new Map(); // nombre (en minúsculas) -> id privado
const privateIdToName = new Map(); // id privado -> nombre (como lo escribió el usuario)

function generatePrivateId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < PRIVATE_ID_LENGTH; i++) id += Math.floor(Math.random() * 10);
  } while (privateIdToName.has(id));
  return id;
}

const GENERAL_ID = 'general';
rooms.set(GENERAL_ID, {
  id: GENERAL_ID,
  title: 'Salón General',
  isGeneral: true,
  hostId: null,
  hostUserId: null,
  hostName: null,
  passwordHash: null,
  users: new Map(),
  messages: [
    systemMessage('¡Bienvenido/a al Salón General! Aquí todos los lectores pueden charlar de cualquier libro.')
  ],
  video: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
  // La página y el zoom del PDF ya NO se sincronizan entre usuarios: cada quien
  // navega su propia copia localmente. El servidor solo dice CUÁL pdf está activo.
  pdf: { url: null, fileName: null, updatedAt: Date.now() },
  createdAt: Date.now(),
  afkMinutes: DEFAULT_AFK_MINUTES,
  pendingClose: false,
  closeAt: null,
  closeTimer: null,
});

function systemMessage(text) {
  return { id: cryptoId(), senderId: null, name: 'Sistema', text, ts: Date.now(), system: true };
}

function cryptoId() {
  return crypto.randomBytes(8).toString('hex');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/live\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // Si ya parece un ID de 11 caracteres, úsalo directo
  if (/^[\w-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

// Solo aceptamos adjuntos cuya url venga de nuestra propia carpeta de subidas
// (así un cliente no puede inyectar un link arbitrario disfrazado de adjunto).
function sanitizeAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const url = (att.url || '').toString();
  if (!url.startsWith('/uploads/chat/')) return null;
  return {
    url,
    fileName: (att.fileName || 'archivo').toString().slice(0, 150),
    mimeType: (att.mimeType || '').toString().slice(0, 100),
    size: Number(att.size) || 0,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    title: room.title,
    isGeneral: room.isGeneral,
    hasPassword: !!room.passwordHash,
    hostId: room.hostId,
    hostName: room.hostName,
    pendingClose: !!room.pendingClose,
    closeAt: room.closeAt || null,
    afkMinutes: room.afkMinutes || DEFAULT_AFK_MINUTES,
    users: Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name })),
    userCount: room.users.size,
    messages: room.messages,
    video: room.video,
    pdf: room.pdf,
    createdAt: room.createdAt,
  };
}

function lobbyList() {
  return Array.from(rooms.values())
    .sort((a, b) => (b.isGeneral ? 1 : 0) - (a.isGeneral ? 1 : 0) || a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      title: r.title,
      isGeneral: r.isGeneral,
      hasPassword: !!r.passwordHash,
      userCount: r.users.size,
      hostName: r.hostName,
      pendingClose: !!r.pendingClose,
      closeAt: r.closeAt || null,
    }));
}

function broadcastLobby() {
  io.emit('lobby:update', lobbyList());
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room:update', publicRoom(room));
}

// Si esta identidad (socket.data.clientId) es la dueña registrada del host de
// esta sala pero el socket actual no es el hostId vigente, la restaura como
// host. Se usa tanto al reconectar (user:hello, socket nuevo) como al volver a
// entrar a la sala con el MISMO socket (room:join, p. ej. tras usar "Salir").
function restoreHostIfOwner(socket, room) {
  if (!room || room.isGeneral) return false;
  if (!room.hostUserId || room.hostUserId !== socket.data.clientId) return false;
  if (room.hostId === socket.id) return false;

  const wasPending = room.pendingClose;
  if (room.closeTimer) clearTimeout(room.closeTimer);
  room.closeTimer = null;
  room.pendingClose = false;
  room.closeAt = null;
  room.hostId = socket.id;
  room.hostName = socket.data.name;
  room.users.set(socket.id, { id: socket.id, name: socket.data.name, clientId: socket.data.clientId });
  socket.join(room.id);
  socket.data.rooms.add(room.id);
  room.messages.push(systemMessage(
    wasPending
      ? `👑 ${socket.data.name} volvió y retomó el rol de host de esta sala.`
      : `👑 ${socket.data.name} reconectó y sigue siendo el host de esta sala.`
  ));
  return true;
}

io.on('connection', (socket) => {
  socket.data.name = 'Lector';
  socket.data.rooms = new Set();

  socket.on('user:hello', ({ name, clientId }) => {
    const requestedName = (name || 'Lector').toString().trim().slice(0, 24) || 'Lector';
    const requestedKey = requestedName.toLowerCase();

    let finalId = null;
    let finalName = null;

    if (clientId && privateIdToName.has(clientId.toString())) {
      // Ya conocemos este ID privado (venía guardado en el navegador de esta persona):
      // reusamos su identidad tal cual, sin importar qué nombre haya escrito ahora.
      finalId = clientId.toString();
      finalName = privateIdToName.get(finalId);
    } else if (nameToPrivateId.has(requestedKey)) {
      // El nombre ya está en uso por otra identidad (y este cliente no traía el ID
      // correspondiente) -> no lo dejamos entrar con ese nombre.
      socket.emit('user:name-taken', { name: requestedName });
      return;
    } else {
      // Identidad nueva: el servidor genera el ID privado (nunca se muestra a otros usuarios).
      finalId = generatePrivateId();
      finalName = requestedName;
      nameToPrivateId.set(requestedKey, finalId);
      privateIdToName.set(finalId, finalName);
    }

    socket.data.name = finalName;
    socket.data.clientId = finalId;
    socket.emit('user:registered', { clientId: finalId, name: finalName });

    // ¿Hay alguna sala donde esta identidad sigue siendo el host (p. ej. actualizó
    // la página)? No exigimos que la sala ya esté en "pendingClose": así evitamos
    // una condición de carrera si la reconexión llega antes de que el servidor
    // termine de procesar la desconexión del socket anterior.
    for (const room of rooms.values()) {
      if (restoreHostIfOwner(socket, room)) {
        socket.emit('room:host-restored', publicRoom(room));
        broadcastRoom(room.id);
        broadcastLobby();
      }
    }

    // Auto-unir a Sala General
    const general = rooms.get(GENERAL_ID);
    general.users.set(socket.id, { id: socket.id, name: finalName, clientId: finalId });
    socket.join(GENERAL_ID);
    socket.data.rooms.add(GENERAL_ID);
    general.messages.push(systemMessage(`${finalName} se unió al salón.`));

    socket.emit('lobby:update', lobbyList());
    socket.emit('room:joined', publicRoom(general));
    broadcastRoom(GENERAL_ID);
    broadcastLobby();
  });

  socket.on('lobby:list', (cb) => {
    cb && cb(lobbyList());
  });

  socket.on('room:create', ({ title, password }, cb) => {
    title = (title || '').toString().trim().slice(0, 60);
    if (!title) return cb && cb({ ok: false, error: 'El título del libro no puede estar vacío.' });

    const id = cryptoId();
    const room = {
      id,
      title,
      isGeneral: false,
      hostId: socket.id,
      hostUserId: socket.data.clientId,
      hostName: socket.data.name,
      passwordHash: password ? hashPassword(password) : null,
      users: new Map([[socket.id, { id: socket.id, name: socket.data.name, clientId: socket.data.clientId }]]),
      messages: [systemMessage(`${socket.data.name} creó la sala "${title}" y es el host.`)],
      video: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
      pdf: { url: null, fileName: null, updatedAt: Date.now() },
      createdAt: Date.now(),
      afkMinutes: DEFAULT_AFK_MINUTES,
      pendingClose: false,
      closeAt: null,
      closeTimer: null,
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.rooms.add(id);

    cb && cb({ ok: true, room: publicRoom(room) });
    broadcastLobby();
  });

  socket.on('room:join', ({ roomId, password }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: 'La sala ya no existe.' });
    if (room.passwordHash && room.passwordHash !== hashPassword(password || '')) {
      return cb && cb({ ok: false, error: 'Password incorrecto.' });
    }

    // Si esta identidad es la dueña del host de esta sala (p. ej. usó "Salir" y
    // ahora vuelve a entrar con el mismo socket, sin refrescar la página),
    // recupera el rol de host en vez de entrar como miembro normal.
    const restoredAsHost = restoreHostIfOwner(socket, room);

    if (!restoredAsHost) {
      room.users.set(socket.id, { id: socket.id, name: socket.data.name, clientId: socket.data.clientId });
      socket.join(roomId);
      socket.data.rooms.add(roomId);
      room.messages.push(systemMessage(`${socket.data.name} se unió a la sala.`));
    }

    cb && cb({ ok: true, room: publicRoom(room) });
    if (restoredAsHost) socket.emit('room:host-restored', publicRoom(room));
    broadcastRoom(roomId);
    broadcastLobby();
  });

  socket.on('room:leave', ({ roomId }) => {
    leaveRoom(socket, roomId, false);
  });

  socket.on('chat:send', ({ roomId, text, attachment }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;
    text = (text || '').toString().slice(0, 500);
    const safeAttachment = sanitizeAttachment(attachment);
    if (!text.trim() && !safeAttachment) return;
    // senderId usa el ID privado persistente (no el socket.id, que cambia en cada
    // reconexión) para que "¿es mío este mensaje?" siga siendo cierto aunque la
    // persona se haya ido y vuelto a entrar a la sala.
    const message = {
      id: cryptoId(), senderId: socket.data.clientId, name: socket.data.name, text, ts: Date.now(),
      system: false, deleted: false, attachment: safeAttachment,
    };
    room.messages.push(message);
    if (room.messages.length > 300) room.messages.shift();
    io.to(roomId).emit('chat:message', { roomId, message });
  });

  // Un mensaje solo lo puede borrar quien lo mandó (comparando por clientId,
  // no por socket.id, para que siga funcionando tras reconexiones). Se hace
  // "soft delete": se limpia el texto/adjunto pero el mensaje sigue existiendo
  // en el historial como un placeholder, para no romper el orden del chat.
  socket.on('chat:delete', ({ roomId, messageId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const message = room.messages.find((m) => m.id === messageId);
    if (!message || message.system || message.deleted) return;
    if (message.senderId !== socket.data.clientId) return;
    message.deleted = true;
    message.text = '';
    message.attachment = null;
    io.to(roomId).emit('chat:deleted', { roomId, messageId });
  });

  socket.on('host:transfer', ({ roomId, targetUserId }) => {
    const room = rooms.get(roomId);
    if (!room || room.isGeneral || room.hostId !== socket.id) return;
    const target = room.users.get(targetUserId);
    if (!target) return;
    room.hostId = target.id;
    room.hostUserId = target.clientId || null;
    room.hostName = target.name;
    room.messages.push(systemMessage(`${socket.data.name} transfirió el rol de host a ${target.name}.`));
    broadcastRoom(roomId);
    broadcastLobby();
  });

  socket.on('room:set-afk', ({ roomId, minutes }) => {
    const room = rooms.get(roomId);
    if (!room || room.isGeneral || room.hostId !== socket.id) return;
    const clamped = Math.max(1, Math.min(120, Math.round(Number(minutes) || DEFAULT_AFK_MINUTES)));
    room.afkMinutes = clamped;
    room.messages.push(systemMessage(`⏳ ${socket.data.name} configuró el timer AFK en ${clamped} min.`));
    broadcastRoom(roomId);
  });

  socket.on('room:merge:request', ({ fromRoomId, targetRoomId }) => {
    const fromRoom = rooms.get(fromRoomId);
    const targetRoom = rooms.get(targetRoomId);
    if (!fromRoom || !targetRoom || fromRoom.isGeneral || targetRoom.isGeneral) return;
    if (fromRoom.hostId !== socket.id) return;
    if (!targetRoom.hostId) return;
    io.to(targetRoom.hostId).emit('merge:invite', {
      fromRoomId,
      fromRoomTitle: fromRoom.title,
      fromHostName: socket.data.name,
      targetRoomId,
      targetRoomTitle: targetRoom.title,
    });
  });

  socket.on('room:merge:respond', ({ fromRoomId, targetRoomId, accept }) => {
    const fromRoom = rooms.get(fromRoomId);
    const targetRoom = rooms.get(targetRoomId);
    if (!fromRoom || !targetRoom) return;
    if (targetRoom.hostId !== socket.id) return; // solo el host invitado puede responder

    if (!accept) {
      if (fromRoom.hostId) {
        io.to(fromRoom.hostId).emit('merge:declined', { targetRoomTitle: targetRoom.title });
      }
      return;
    }

    // Fusionar: targetRoom se une dentro de fromRoom. fromRoom.host sigue siendo host.
    fromRoom.title = `${fromRoom.title} + ${targetRoom.title}`;
    fromRoom.messages.push(
      systemMessage(`🔗 Las salas "${fromRoom.title.split(' + ')[0]}" y "${targetRoom.title}" se fusionaron.`)
    );

    for (const [sid, user] of targetRoom.users.entries()) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.leave(targetRoom.id);
        s.join(fromRoom.id);
        s.data.rooms.delete(targetRoom.id);
        s.data.rooms.add(fromRoom.id);
      }
      fromRoom.users.set(sid, user);
    }

    const mergedFromId = targetRoom.id;
    rooms.delete(targetRoom.id);
    io.to(fromRoom.id).emit('room:merged', { room: publicRoom(fromRoom), mergedFromId });
    broadcastRoom(fromRoom.id);
    broadcastLobby();
  });

  socket.on('video:set', ({ roomId, url }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const videoId = extractYouTubeId(url);
    if (!videoId) return;
    room.video = { videoId, isPlaying: true, time: 0, updatedAt: Date.now() };
    room.messages.push(systemMessage(`🎬 ${socket.data.name} puso un video para todos.`));
    broadcastRoom(roomId);
  });

  socket.on('video:control', ({ roomId, action, time }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || !room.video.videoId) return;
    if (action === 'play') {
      room.video.isPlaying = true;
      room.video.time = time || 0;
    } else if (action === 'pause') {
      room.video.isPlaying = false;
      room.video.time = time || 0;
    } else if (action === 'seek') {
      room.video.time = time || 0;
    }
    room.video.updatedAt = Date.now();
    io.to(roomId).emit('video:update', { roomId, video: room.video });
  });

  // El host ya subió el archivo por HTTP (POST /api/upload-pdf); acá solo
  // avisa a la sala cuál es la URL resultante para que todos lo abran. La
  // página y el zoom NO viajan por acá: cada usuario navega su propia vista
  // del PDF de forma local, sin sincronizarse con nadie más.
  socket.on('pdf:set', ({ roomId, url, fileName }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    if (!url || typeof url !== 'string') return;
    room.pdf = { url, fileName: (fileName || '').toString().slice(0, 120) || null, updatedAt: Date.now() };
    room.messages.push(systemMessage(`📄 ${socket.data.name} compartió un PDF para todos${room.pdf.fileName ? `: "${room.pdf.fileName}"` : ''}.`));
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    for (const roomId of Array.from(socket.data.rooms || [])) {
      leaveRoom(socket, roomId, true);
    }
  });

  function leaveRoom(sock, roomId, isDisconnect) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.users.has(sock.id)) return;

    room.users.delete(sock.id);
    sock.leave(roomId);
    sock.data.rooms.delete(roomId);

    if (room.isGeneral) {
      room.messages.push(systemMessage(`${sock.data.name} salió del salón.`));
      broadcastRoom(roomId);
      broadcastLobby();
      return;
    }

    if (room.hostId === sock.id) {
      // El host se fue (desconexión o salida) -> damos un tiempo de gracia antes de cerrar la sala,
      // por si vuelve a conectarse (misma identidad persistente = mismo clientId).
      room.hostId = null;
      const minutes = room.afkMinutes || DEFAULT_AFK_MINUTES;
      const graceMs = minutes * 60 * 1000;
      room.pendingClose = true;
      room.closeAt = Date.now() + graceMs;
      room.messages.push(
        systemMessage(`⏳ ${sock.data.name} (host) se desconectó. Si no vuelve en ${minutes} min, la sala se cerrará.`)
      );
      broadcastRoom(roomId);
      broadcastLobby();

      if (room.closeTimer) clearTimeout(room.closeTimer);
      room.closeTimer = setTimeout(() => {
        const stillThere = rooms.get(roomId);
        if (stillThere && stillThere.pendingClose) {
          io.to(roomId).emit('room:closed', { roomId, reason: 'host_timeout', title: stillThere.title });
          rooms.delete(roomId);
          broadcastLobby();
        }
      }, graceMs);
    } else {
      room.messages.push(systemMessage(`${sock.data.name} salió de la sala.`));
      broadcastRoom(roomId);
      broadcastLobby();
    }
  }
});

server.listen(PORT, () => {
  console.log(`📚 Club de Lectura corriendo en http://localhost:${PORT}`);
});
