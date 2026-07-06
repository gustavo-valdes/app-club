// ---------- Estado del cliente ----------
const state = {
  socket: null,
  myId: null,
  myClientId: null, // ID privado persistente (para saber "es mío" en los mensajes, sobrevive a reconexiones)
  myName: '',
  lobby: [],           // lista de salas (del servidor)
  joinedRooms: {},      // roomId -> room completo (mensajes, usuarios, video, host)
  activeRoomId: 'general',
  ytPlayer: null,
  ytApiReady: false,   // el script de YouTube ya cargó
  ytPlayerReady: false, // el YT.Player ya está construido y listo
  ytMuted: true, // arranca silenciado: el autoplay CON sonido lo bloquean los navegadores
  pendingVideoForActiveRoom: null,
  lobbyOpen: true,   // panel izquierdo (salas) — toggleable
  pdfPanelOpen: false, // panel derecho (PDF) — toggleable
  pdfSeenUrls: new Set(), // urls de pdf que ya "auto-abrimos" una vez (para no reabrir si el usuario lo cerró)
  pdfDoc: null,        // PDFDocumentProxy actualmente cargado (pdf.js)
  pdfDocUrl: null,      // URL del PDF actualmente cargado en pdfDoc
  pdfNumPages: null,
  // Página y zoom son 100% locales por usuario (no se sincronizan por el server).
  // Se guardan por URL de PDF para no perder el lugar si cambias de pestaña y vuelves.
  pdfViewState: {}, // url -> { page, zoom }
  pdfRenderedKey: null, // `${url}|${page}|${zoom}` ya pintado en el canvas (evita repintar de más)
  pdfRenderTask: null,   // render en curso de pdf.js (se puede cancelar)
  pdfUploading: false,
  pendingAttachment: null, // { url, fileName, mimeType, size } — ya subido, esperando a que se envíe el mensaje
  attachUploading: false,
};

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
}

// ---------- Identidad persistente (para recuperar el rol de host tras un refresh) ----------
// El ID privado de 50 dígitos lo genera y controla el SERVIDOR, no el navegador.
// Aquí solo lo guardamos (si ya lo tenemos) para poder demostrarle al servidor,
// en la próxima conexión, "soy la misma persona de antes".
function getStoredClientId() {
  return localStorage.getItem('club_lectura_uid') || null;
}
function storeClientId(id) {
  localStorage.setItem('club_lectura_uid', id);
}

const EMOJIS = ['📚','😊','😂','❤️','😢','😮','👏','🔥','🎉','🤔','😍','📖','✨','🥲','😅','😱','👍','👎','💔','☕','🌙','🐛','🦋','🕯️','🍂','🧵','😴','🥳','🙃','😭','💬','🫶'];

// ---------- Utilidades ----------
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function toast(msg) {
  const t = el('div', null, escapeHtml(msg));
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: '#5c3d2e', color: '#fff', padding: '12px 20px', borderRadius: '999px',
    boxShadow: '0 6px 18px rgba(0,0,0,0.2)', zIndex: 999, fontFamily: 'Quicksand, sans-serif',
    fontSize: '0.9rem', maxWidth: '80vw', textAlign: 'center',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal').innerHTML = '';
}
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

// ---------- Nickname / arranque ----------
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('club_lectura_nombre');
  if (saved) {
    $('#nickname-input').value = saved;
  }
  $('#nickname-submit').addEventListener('click', submitNickname);
  $('#nickname-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNickname(); });
});

function submitNickname() {
  const name = $('#nickname-input').value.trim() || 'Lector Anónimo';
  localStorage.setItem('club_lectura_nombre', name);
  $('#nickname-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  initApp(name);
}

// ---------- Inicialización socket ----------
function initApp(name) {
  state.myName = name;
  $('#my-name-badge').textContent = `👤 ${name}`;

  const socket = io();
  state.socket = socket;

  socket.on('connect', () => {
    state.myId = socket.id;
    socket.emit('user:hello', { name, clientId: getStoredClientId() });
  });

  socket.on('user:registered', ({ clientId, name: registeredName }) => {
    storeClientId(clientId);
    localStorage.setItem('club_lectura_nombre', registeredName);
    state.myClientId = clientId;
    state.myName = registeredName;
    $('#my-name-badge').textContent = `👤 ${registeredName}`;
    // Los mensajes ya renderizados pudieron haberse pintado antes de saber
    // nuestro clientId real; los volvemos a pintar para que "es mío" quede bien.
    renderRoomView();
  });

  socket.on('user:name-taken', ({ name: takenName }) => {
    toast(`El nombre "${takenName}" ya lo está usando alguien más en esta sesión. Elige otro.`);
    $('#app').classList.add('hidden');
    $('#nickname-screen').classList.remove('hidden');
    $('#nickname-input').value = '';
    $('#nickname-input').focus();
    socket.disconnect();
  });

  ensureCountdownTicker();

  socket.on('lobby:update', (list) => {
    state.lobby = list;
    renderLobby();
  });

  socket.on('room:joined', (room) => {
    state.joinedRooms[room.id] = room;
    if (Object.keys(state.joinedRooms).length === 1) state.activeRoomId = room.id;
    renderTabs();
    renderRoomView();
  });

  socket.on('room:update', (room) => {
    if (state.joinedRooms[room.id]) {
      state.joinedRooms[room.id] = room;
      if (state.activeRoomId === room.id) renderRoomView();
      renderTabs();
    }
  });

  socket.on('chat:message', ({ roomId, message }) => {
    const room = state.joinedRooms[roomId];
    if (!room) return;
    room.messages.push(message);
    if (state.activeRoomId === roomId) appendMessage(message);
  });

  socket.on('chat:deleted', ({ roomId, messageId }) => {
    const room = state.joinedRooms[roomId];
    if (!room) return;
    const message = room.messages.find((m) => m.id === messageId);
    if (message) {
      message.deleted = true;
      message.text = '';
      message.attachment = null;
    }
    if (state.activeRoomId === roomId) {
      const node = $('#messages').querySelector(`[data-message-id="${messageId}"]`);
      if (node) node.replaceWith(buildMessageNode(message || { id: messageId, deleted: true, system: false, name: '' }));
    }
  });

  socket.on('room:closed', ({ roomId, title, reason }) => {
    delete state.joinedRooms[roomId];
    if (state.activeRoomId === roomId) state.activeRoomId = 'general';
    const msg = reason === 'host_timeout'
      ? `🚪 La sala "${title}" se cerró: el host no volvió a tiempo.`
      : `🚪 La sala "${title}" se cerró.`;
    toast(msg);
    renderTabs();
    renderRoomView();
  });

  socket.on('room:host-restored', (room) => {
    state.joinedRooms[room.id] = room;
    state.activeRoomId = room.id;
    toast(`👑 ¡Recuperaste el rol de host de "${room.title}"!`);
    renderTabs();
    renderRoomView();
  });

  socket.on('merge:invite', ({ fromRoomId, fromRoomTitle, fromHostName, targetRoomId, targetRoomTitle }) => {
    openModal(`
      <h3>🔗 Propuesta de fusión</h3>
      <p><strong>${escapeHtml(fromHostName)}</strong> quiere fusionar su sala <strong>"${escapeHtml(fromRoomTitle)}"</strong> con tu sala <strong>"${escapeHtml(targetRoomTitle)}"</strong>.</p>
      <p style="color:var(--text-soft); font-size:0.85rem;">Si aceptas, ambas salas se convertirán en una sola y tu sala pasará a formar parte de la de ellos.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="merge-decline">No, gracias</button>
        <button class="btn btn-primary" id="merge-accept">Fusionar 🔗</button>
      </div>
    `);
    $('#merge-decline').addEventListener('click', () => {
      state.socket.emit('room:merge:respond', { fromRoomId, targetRoomId, accept: false });
      closeModal();
    });
    $('#merge-accept').addEventListener('click', () => {
      state.socket.emit('room:merge:respond', { fromRoomId, targetRoomId, accept: true });
      closeModal();
    });
  });

  socket.on('merge:declined', ({ targetRoomTitle }) => {
    toast(`El host de "${targetRoomTitle}" declinó la fusión.`);
  });

  socket.on('room:merged', ({ room, mergedFromId }) => {
    delete state.joinedRooms[mergedFromId];
    state.joinedRooms[room.id] = room;
    if (state.activeRoomId === mergedFromId) state.activeRoomId = room.id;
    toast(`🔗 ¡Las salas se fusionaron! Ahora todos están en "${room.title}"`);
    renderTabs();
    renderRoomView();
  });

  socket.on('video:update', ({ roomId, video }) => {
    const room = state.joinedRooms[roomId];
    if (!room) return;
    room.video = video;
    if (state.activeRoomId === roomId) {
      // Nos aseguramos de que la sección esté visible antes de actualizar el player.
      $('#video-section').classList.remove('hidden');
      createOrUpdatePlayer(video);
    }
  });
}

// ---------- Toggle de paneles laterales ----------
$('#lobby-toggle-btn').addEventListener('click', () => {
  state.lobbyOpen = !state.lobbyOpen;
  $('#lobby-panel').classList.toggle('hidden', !state.lobbyOpen);
});

$('#pdf-panel-close-btn').addEventListener('click', () => {
  state.pdfPanelOpen = false;
  renderRoomView();
});

// Si esta es la primera vez que vemos este PDF (nuevo url) para la sala que
// tenemos activa ahora mismo, abrimos el panel automáticamente una vez. Si el
// usuario lo cierra después, no se vuelve a abrir solo para ese mismo PDF.
function maybeAutoOpenPdf(room) {
  if (!room.pdf || !room.pdf.url) return;
  if (state.pdfSeenUrls.has(room.pdf.url)) return;
  state.pdfSeenUrls.add(room.pdf.url);
  if (room.id === state.activeRoomId) {
    state.pdfPanelOpen = true;
  }
}

// ---------- Countdown de host ausente ----------
let countdownInterval = null;
function ensureCountdownTicker() {
  if (countdownInterval) return;
  countdownInterval = setInterval(() => {
    const room = getActiveRoom();
    if (room && !room.isGeneral && room.pendingClose && room.closeAt) {
      updateCountdownDisplay(room);
    }
  }, 1000);
}
function updateCountdownDisplay(room) {
  const elCountdown = document.getElementById('host-countdown');
  if (!elCountdown) return;
  const remainingMs = room.closeAt - Date.now();
  if (remainingMs <= 0) {
    elCountdown.textContent = '0:00';
    return;
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  elCountdown.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------- Render: Lobby ----------
function renderLobby() {
  const list = $('#room-list');
  list.innerHTML = '';
  state.lobby.forEach((room) => {
    const joined = !!state.joinedRooms[room.id];
    const card = el('div', 'room-card' + (room.isGeneral ? ' general' : ''));
    card.innerHTML = `
      <div class="room-card-top">
        <span class="room-card-title">${room.isGeneral ? '🌐 ' : '📕 '}${escapeHtml(room.title)}</span>
        ${room.hasPassword ? '<span title="Con password">🔒</span>' : ''}
      </div>
      <div class="room-card-meta">
        <span>👥 ${room.userCount}</span>
        ${room.hostName && !room.isGeneral ? `<span>· Host: ${escapeHtml(room.hostName)}</span>` : ''}
        ${room.pendingClose ? '<span>· ⏳ Host ausente</span>' : ''}
      </div>
    `;
    const btn = el('button', 'btn ' + (joined ? 'btn-secondary' : 'btn-primary'), joined ? 'Ir a la sala' : 'Unirse');
    btn.addEventListener('click', () => {
      if (joined) {
        state.activeRoomId = room.id;
        renderTabs();
        renderRoomView();
      } else if (room.hasPassword) {
        openPasswordModal(room);
      } else {
        joinRoom(room.id, null);
      }
    });
    card.appendChild(btn);
    list.appendChild(card);
  });
}

function openPasswordModal(room) {
  openModal(`
    <h3>🔒 "${escapeHtml(room.title)}"</h3>
    <p>Esta sala tiene password. Pídeselo a quien la creó.</p>
    <input id="pw-input" type="password" placeholder="Password" />
    <p id="pw-error" style="color:#b23; font-size:0.85rem; display:none;"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="pw-cancel">Cancelar</button>
      <button class="btn btn-primary" id="pw-confirm">Entrar</button>
    </div>
  `);
  $('#pw-cancel').addEventListener('click', closeModal);
  $('#pw-confirm').addEventListener('click', () => {
    joinRoom(room.id, $('#pw-input').value, (err) => {
      $('#pw-error').textContent = err;
      $('#pw-error').style.display = 'block';
    });
  });
}

function joinRoom(roomId, password, onError) {
  state.socket.emit('room:join', { roomId, password }, (res) => {
    if (res.ok) {
      state.joinedRooms[res.room.id] = res.room;
      state.activeRoomId = res.room.id;
      closeModal();
      renderTabs();
      renderRoomView();
    } else if (onError) {
      onError(res.error);
    } else {
      toast(res.error);
    }
  });
}

$('#create-room-btn').addEventListener('click', () => {
  const title = $('#new-room-title').value.trim();
  const password = $('#new-room-password').value;
  if (!title) return toast('Ponle un título a tu sala (el nombre del libro) 📖');
  state.socket.emit('room:create', { title, password: password || null }, (res) => {
    if (res.ok) {
      state.joinedRooms[res.room.id] = res.room;
      state.activeRoomId = res.room.id;
      $('#new-room-title').value = '';
      $('#new-room-password').value = '';
      renderTabs();
      renderRoomView();
    } else {
      toast(res.error);
    }
  });
});

// ---------- Render: Tabs ----------
function renderTabs() {
  const tabsEl = $('#room-tabs');
  tabsEl.innerHTML = '';
  Object.values(state.joinedRooms).forEach((room) => {
    const tab = el('div', 'tab' + (room.id === state.activeRoomId ? ' active' : ''));
    tab.innerHTML = `<span>${room.isGeneral ? '🌐' : '📕'} ${escapeHtml(room.title)}</span>`;
    tab.addEventListener('click', () => {
      state.activeRoomId = room.id;
      renderTabs();
      renderRoomView();
    });
    if (!room.isGeneral) {
      const x = el('span', 'close-x', ' ✕');
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        state.socket.emit('room:leave', { roomId: room.id });
        delete state.joinedRooms[room.id];
        if (state.activeRoomId === room.id) state.activeRoomId = 'general';
        renderTabs();
        renderRoomView();
      });
      tab.appendChild(x);
    }
    tabsEl.appendChild(tab);
  });
}

// ---------- Render: Room view ----------
function getActiveRoom() {
  return state.joinedRooms[state.activeRoomId];
}

function renderRoomView() {
  const room = getActiveRoom();
  if (!room) return;
  const iAmHost = room.hostId === state.myId;
  // El host puede abrir el panel de PDF aunque todavía no haya subido nada
  // (para poder subir el primero); cualquier otra persona solo si ya hay uno.
  const canUsePdfPanel = (room.pdf && room.pdf.url) || (iAmHost && !room.isGeneral);
  maybeAutoOpenPdf(room);

  $('#room-title').textContent = (room.isGeneral ? '🌐 ' : '📕 ') + room.title;
  if (room.isGeneral) {
    $('#room-host-info').textContent = 'Sala pública permanente · abierta a todos los lectores';
  } else if (room.pendingClose) {
    $('#room-host-info').textContent = `⏳ El host (${room.hostName}) se desconectó y aún no vuelve.`;
  } else {
    $('#room-host-info').textContent = `Host actual: ${room.hostName}${iAmHost ? ' (¡eres tú!)' : ''}`;
  }

  // Banner de sala en espera de que el host vuelva
  const banner = $('#pending-close-banner');
  if (!room.isGeneral && room.pendingClose && room.closeAt) {
    banner.classList.remove('hidden');
    banner.innerHTML = `<span>⏳ El host se desconectó. Si no vuelve, la sala se cierra en <strong id="host-countdown"></strong>.</span>`;
    updateCountdownDisplay(room);
  } else {
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }

  // Acciones
  const actions = $('#room-actions');
  actions.innerHTML = '';

  if (canUsePdfPanel) {
    const pdfToggleBtn = el('button', 'btn btn-mini', state.pdfPanelOpen ? '📄 Ocultar PDF' : '📄 Ver PDF');
    pdfToggleBtn.addEventListener('click', () => {
      state.pdfPanelOpen = !state.pdfPanelOpen;
      renderRoomView();
    });
    actions.appendChild(pdfToggleBtn);
  }

  if (!room.isGeneral) {
    if (iAmHost) {
      const transferBtn = el('button', 'btn btn-mini', '👑 Transferir host');
      transferBtn.addEventListener('click', () => openTransferModal(room));
      actions.appendChild(transferBtn);

      const mergeBtn = el('button', 'btn btn-mini', '🔗 Fusionar sala');
      mergeBtn.addEventListener('click', () => openMergeModal(room));
      actions.appendChild(mergeBtn);

      const afkBox = el('div', 'afk-box');
      afkBox.innerHTML = `<label>⏳ Si me desconecto, esperar</label>`;
      const afkInput = el('input');
      afkInput.type = 'number';
      afkInput.min = '1';
      afkInput.max = '120';
      afkInput.value = room.afkMinutes || 5;
      const afkUnit = el('span', null, 'min');
      const afkSaveBtn = el('button', 'btn btn-mini', '💾');
      afkSaveBtn.title = 'Guardar timer AFK';
      afkSaveBtn.addEventListener('click', () => {
        const minutes = parseInt(afkInput.value, 10) || 5;
        state.socket.emit('room:set-afk', { roomId: room.id, minutes });
        toast(`⏳ Timer AFK guardado: ${minutes} min`);
      });
      afkBox.appendChild(afkInput);
      afkBox.appendChild(afkUnit);
      afkBox.appendChild(afkSaveBtn);
      actions.appendChild(afkBox);
    }
    const leaveBtn = el('button', 'btn btn-mini', '🚪 Salir');
    leaveBtn.addEventListener('click', () => {
      state.socket.emit('room:leave', { roomId: room.id });
      delete state.joinedRooms[room.id];
      state.activeRoomId = 'general';
      renderTabs();
      renderRoomView();
    });
    actions.appendChild(leaveBtn);
  }

  // Caja para poner video (solo host, solo salas no generales)
  const videoSetBox = $('#video-set-box');
  if (iAmHost && !room.isGeneral) {
    videoSetBox.classList.remove('hidden');
  } else {
    videoSetBox.classList.add('hidden');
  }

  // Sección video
  renderVideoSection(room, iAmHost);

  // Panel de PDF: la visibilidad real depende de si el usuario lo tiene
  // abierto o cerrado (state.pdfPanelOpen), además de si puede usarlo.
  const pdfPanelVisible = canUsePdfPanel && state.pdfPanelOpen;
  $('#pdf-panel').classList.toggle('hidden', !pdfPanelVisible);
  $('#pdf-resize-handle').classList.toggle('hidden', !pdfPanelVisible);

  const pdfSetBox = $('#pdf-set-box');
  if (iAmHost && !room.isGeneral) {
    pdfSetBox.classList.remove('hidden');
  } else {
    pdfSetBox.classList.add('hidden');
  }

  // Sección PDF
  renderPdfSection(room);

  // Mensajes
  $('#messages').innerHTML = '';
  room.messages.forEach(appendMessage);

  // Usuarios
  const usersStrip = $('#users-strip');
  usersStrip.innerHTML = '';
  room.users.forEach((u) => {
    const isHost = u.id === room.hostId;
    const chip = el('span', 'chip' + (isHost ? ' chip-host' : ''), `${isHost ? '👑 ' : ''}${escapeHtml(u.name)}`);
    usersStrip.appendChild(chip);
  });
}

function appendMessage(message) {
  const container = $('#messages');
  const room = getActiveRoom();
  if (!room) return;
  container.appendChild(buildMessageNode(message));
  container.scrollTop = container.scrollHeight;
}

// Arma el <div> de un mensaje. Se usa tanto al pintarlo por primera vez como
// al reemplazarlo en el lugar cuando alguien lo borra (chat:deleted).
function buildMessageNode(message) {
  const wrap = el('div');
  wrap.dataset.messageId = message.id;

  if (message.system) {
    wrap.className = 'msg system';
    wrap.textContent = message.text;
    return wrap;
  }

  const mine = message.senderId === state.myClientId;
  wrap.className = 'msg' + (mine ? ' mine' : '') + (message.deleted ? ' deleted' : '');

  const header = el('div', 'msg-header');
  header.appendChild(el('span', 'msg-name', escapeHtml(message.name)));
  if (mine && !message.deleted) {
    const delBtn = el('button', 'msg-delete-btn', '🗑️');
    delBtn.title = 'Eliminar mensaje';
    delBtn.addEventListener('click', () => {
      if (!confirm('¿Eliminar este mensaje para todos?')) return;
      state.socket.emit('chat:delete', { roomId: state.activeRoomId, messageId: message.id });
    });
    header.appendChild(delBtn);
  }
  wrap.appendChild(header);

  if (message.deleted) {
    wrap.appendChild(el('span', 'msg-text msg-text-deleted', '🗑️ mensaje eliminado'));
    return wrap;
  }

  if (message.text) {
    wrap.appendChild(el('span', 'msg-text', escapeHtml(message.text)));
  }
  if (message.attachment) {
    wrap.appendChild(buildAttachmentNode(message.attachment));
  }

  return wrap;
}

function buildAttachmentNode(attachment) {
  const isImage = (attachment.mimeType || '').startsWith('image/');
  const link = el('a', isImage ? 'msg-attachment-img-link' : 'msg-attachment-file');
  link.href = attachment.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  if (isImage) {
    const img = el('img', 'msg-attachment-img');
    img.src = attachment.url;
    img.alt = attachment.fileName || 'imagen';
    link.appendChild(img);
  } else {
    const sizeLabel = attachment.size ? ` (${formatFileSize(attachment.size)})` : '';
    link.textContent = `📎 ${attachment.fileName || 'archivo'}${sizeLabel}`;
  }
  return link;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Transferir host ----------
function openTransferModal(room) {
  const others = room.users.filter((u) => u.id !== state.myId);
  if (!others.length) return toast('No hay nadie más en la sala para transferir el rol.');
  const options = others.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  openModal(`
    <h3>👑 Transferir rol de host</h3>
    <p>Elige quién será el nuevo host de "${escapeHtml(room.title)}". Si sales sin transferir, ¡la sala desaparece!</p>
    <select id="transfer-select">${options}</select>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="transfer-cancel">Cancelar</button>
      <button class="btn btn-primary" id="transfer-confirm">Transferir</button>
    </div>
  `);
  $('#transfer-cancel').addEventListener('click', closeModal);
  $('#transfer-confirm').addEventListener('click', () => {
    const targetUserId = $('#transfer-select').value;
    state.socket.emit('host:transfer', { roomId: room.id, targetUserId });
    closeModal();
  });
}

// ---------- Fusionar salas ----------
function openMergeModal(room) {
  const candidates = state.lobby.filter((r) => !r.isGeneral && r.id !== room.id);
  if (!candidates.length) return toast('No hay otras salas de libros para fusionar todavía.');
  const options = candidates.map((r) => `<option value="${r.id}">${escapeHtml(r.title)}</option>`).join('');
  openModal(`
    <h3>🔗 Fusionar con otra sala</h3>
    <p>Elige con qué sala quieres fusionar "${escapeHtml(room.title)}" (por ejemplo, la sala de una secuela).</p>
    <select id="merge-select">${options}</select>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="merge-cancel">Cancelar</button>
      <button class="btn btn-primary" id="merge-send">Enviar propuesta</button>
    </div>
  `);
  $('#merge-cancel').addEventListener('click', closeModal);
  $('#merge-send').addEventListener('click', () => {
    const targetRoomId = $('#merge-select').value;
    state.socket.emit('room:merge:request', { fromRoomId: room.id, targetRoomId });
    toast('Propuesta de fusión enviada. Esperando respuesta del otro host...');
    closeModal();
  });
}

// ---------- Chat: enviar mensajes ----------
$('#send-btn').addEventListener('click', sendMessage);
$('#message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text && !state.pendingAttachment) return;
  state.socket.emit('chat:send', { roomId: state.activeRoomId, text, attachment: state.pendingAttachment });
  input.value = '';
  state.pendingAttachment = null;
  renderAttachmentPreview();
}

// ---------- Adjuntar archivo / imagen ----------
const MAX_CHAT_FILE_SIZE = 15 * 1024 * 1024; // 15 MB, igual que el límite del server

$('#attach-btn').addEventListener('click', () => {
  if (state.attachUploading) return;
  $('#attach-file-input').click();
});

$('#attach-file-input').addEventListener('change', async () => {
  const fileInput = $('#attach-file-input');
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (file.size > MAX_CHAT_FILE_SIZE) {
    toast('Ese archivo pesa más de 15 MB.');
    fileInput.value = '';
    return;
  }

  state.attachUploading = true;
  toast('Subiendo archivo...');

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('clientId', state.myClientId || '');

    const res = await fetch('/api/upload-chat-file', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.ok) {
      toast(data.error || 'No se pudo subir el archivo.');
      return;
    }

    state.pendingAttachment = { url: data.url, fileName: data.fileName, mimeType: data.mimeType, size: data.size };
    renderAttachmentPreview();
  } catch (err) {
    toast('Error de red subiendo el archivo. Intenta de nuevo.');
  } finally {
    state.attachUploading = false;
    fileInput.value = '';
  }
});

function renderAttachmentPreview() {
  const box = $('#attachment-preview');
  if (!state.pendingAttachment) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const att = state.pendingAttachment;
  const isImage = (att.mimeType || '').startsWith('image/');
  box.classList.remove('hidden');
  box.innerHTML = '';
  box.appendChild(el('span', 'attachment-preview-label', `${isImage ? '🖼️' : '📎'} ${escapeHtml(att.fileName)}`));
  const removeBtn = el('button', 'btn btn-mini', '✕ Quitar');
  removeBtn.addEventListener('click', () => {
    state.pendingAttachment = null;
    renderAttachmentPreview();
  });
  box.appendChild(removeBtn);
}

// ---------- Emoji picker ----------
const emojiPopup = $('#emoji-popup');
EMOJIS.forEach((emoji) => {
  const span = el('span', null, emoji);
  span.addEventListener('click', () => {
    const input = $('#message-input');
    input.value += emoji;
    input.focus();
  });
  emojiPopup.appendChild(span);
});
$('#emoji-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPopup.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!emojiPopup.contains(e.target) && e.target.id !== 'emoji-btn') {
    emojiPopup.classList.add('hidden');
  }
});

// ---------- Video: poner link ----------
$('#video-set-btn').addEventListener('click', () => {
  const url = $('#video-url-input').value.trim();
  if (!url) return;
  state.socket.emit('video:set', { roomId: state.activeRoomId, url });
  $('#video-url-input').value = '';
});

$('#video-play-btn').addEventListener('click', () => {
  const room = getActiveRoom();
  if (!room || !state.ytPlayer) return;
  const time = state.ytPlayer.getCurrentTime ? state.ytPlayer.getCurrentTime() : 0;
  state.socket.emit('video:control', { roomId: room.id, action: 'play', time });
});
$('#video-pause-btn').addEventListener('click', () => {
  const room = getActiveRoom();
  if (!room || !state.ytPlayer) return;
  const time = state.ytPlayer.getCurrentTime ? state.ytPlayer.getCurrentTime() : 0;
  state.socket.emit('video:control', { roomId: room.id, action: 'pause', time });
});
$('#video-mute-btn').addEventListener('click', () => {
  if (!state.ytPlayer) return;
  state.ytMuted = !state.ytMuted;
  if (state.ytMuted) {
    state.ytPlayer.mute();
    $('#video-mute-btn').textContent = '🔊 Activar sonido (solo para mí)';
  } else {
    state.ytPlayer.unMute();
    $('#video-mute-btn').textContent = '🔇 Silenciar (solo para mí)';
  }
});

// ---------- YouTube IFrame API ----------
// OJO: creamos el YT.Player de forma perezosa (solo cuando el contenedor ya es
// visible), porque construirlo mientras está oculto (display:none) puede hacer
// que el iframe no cargue bien en algunos navegadores (el video "no se ve").
let currentPlayerVideoId = null;

function onYouTubeIframeAPIReady() {
  state.ytApiReady = true;
  // Si ya había un video pendiente esperando el API, lo mostramos ahora.
  if (state.pendingVideoForActiveRoom) {
    createOrUpdatePlayer(state.pendingVideoForActiveRoom);
  }
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function createOrUpdatePlayer(video) {
  if (!state.ytApiReady || typeof YT === 'undefined' || !YT.Player) {
    state.pendingVideoForActiveRoom = video;
    return;
  }

  if (!state.ytPlayer) {
    // El contenedor ya debe estar visible (renderVideoSection lo desoculta antes de llamar aquí).
    state.ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      videoId: video.videoId,
      playerVars: { rel: 0, controls: 0, disablekb: 1, modestbranding: 1, fs: 0, mute: 1 },
      events: {
        onReady: (e) => {
          state.ytPlayerReady = true;
          currentPlayerVideoId = video.videoId;
          // Arranca SIEMPRE silenciado: los navegadores bloquean el autoplay con audio
          // si no hubo un clic muy reciente de esa persona, y eso hacía que el video
          // se viera negro/roto para todos menos quien acababa de hacer clic. Con
          // sonido apagado el autoplay siempre funciona; cada quien puede activarlo.
          e.target.mute();
          if (video.isPlaying) {
            e.target.playVideo();
          } else {
            e.target.pauseVideo();
          }
          if (video.time) e.target.seekTo(video.time, true);
        },
      },
    });
    return;
  }

  applyVideoState(video);
}

function renderVideoSection(room, iAmHost) {
  const section = $('#video-section');
  const hostControls = $('#video-controls-host');
  hostControls.classList.toggle('hidden', !iAmHost);

  if (!room.video || !room.video.videoId) {
    section.classList.add('hidden');
    return;
  }
  // Mostramos el contenedor ANTES de crear/actualizar el player.
  section.classList.remove('hidden');
  createOrUpdatePlayer(room.video);
}

function applyVideoState(video) {
  if (!video || !video.videoId) return;
  if (!state.ytPlayerReady || !state.ytPlayer || !state.ytPlayer.loadVideoById) {
    state.pendingVideoForActiveRoom = video;
    return;
  }
  if (currentPlayerVideoId !== video.videoId) {
    currentPlayerVideoId = video.videoId;
    if (video.isPlaying) {
      state.ytPlayer.loadVideoById(video.videoId, video.time || 0);
    } else {
      state.ytPlayer.cueVideoById(video.videoId, video.time || 0);
    }
    return;
  }
  try {
    const current = state.ytPlayer.getCurrentTime ? state.ytPlayer.getCurrentTime() : 0;
    if (Math.abs(current - (video.time || 0)) > 2) {
      state.ytPlayer.seekTo(video.time || 0, true);
    }
  } catch (e) { /* player aún no listo del todo */ }

  if (video.isPlaying) {
    state.ytPlayer.playVideo && state.ytPlayer.playVideo();
  } else {
    state.ytPlayer.pauseVideo && state.ytPlayer.pauseVideo();
  }
}

// ---------- PDF: subir archivo (solo host) ----------
$('#pdf-upload-btn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  const fileInput = $('#pdf-file-input');
  const file = fileInput.files && fileInput.files[0];
  if (!file) return toast('Elige primero un archivo PDF 📄');
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    return toast('Ese archivo no parece ser un PDF.');
  }
  if (state.pdfUploading) return;

  state.pdfUploading = true;
  const statusEl = $('#pdf-upload-status');
  statusEl.textContent = 'Subiendo...';

  try {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('roomId', room.id);
    formData.append('clientId', state.myClientId || '');

    const res = await fetch('/api/upload-pdf', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.ok) {
      statusEl.textContent = '';
      return toast(data.error || 'No se pudo subir el PDF.');
    }

    state.socket.emit('pdf:set', { roomId: room.id, url: data.url, fileName: data.fileName });
    statusEl.textContent = '';
    fileInput.value = '';
  } catch (err) {
    statusEl.textContent = '';
    toast('Error de red subiendo el PDF. Intenta de nuevo.');
  } finally {
    state.pdfUploading = false;
  }
});

// ---------- PDF: navegación y zoom (100% locales, no se sincronizan) ----------
function getPdfViewState(url) {
  if (!state.pdfViewState[url]) {
    state.pdfViewState[url] = { page: 1, zoom: 1 };
  }
  return state.pdfViewState[url];
}

$('#pdf-prev-btn').addEventListener('click', () => {
  if (!state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  vs.page = Math.max(1, vs.page - 1);
  renderCurrentPdfPage();
});
$('#pdf-next-btn').addEventListener('click', () => {
  if (!state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  const max = state.pdfNumPages || vs.page;
  vs.page = Math.min(max, vs.page + 1);
  renderCurrentPdfPage();
});
const PDF_ZOOM_STEP = 0.05; // cada click suma/resta 5%

$('#pdf-zoom-in-btn').addEventListener('click', () => {
  if (!state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  vs.zoom = Math.min(4, +(vs.zoom + PDF_ZOOM_STEP).toFixed(2));
  renderCurrentPdfPage();
});
$('#pdf-zoom-out-btn').addEventListener('click', () => {
  if (!state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  vs.zoom = Math.max(0.1, +(vs.zoom - PDF_ZOOM_STEP).toFixed(2));
  renderCurrentPdfPage();
});
$('#pdf-zoom-reset-btn').addEventListener('click', () => {
  if (!state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  vs.zoom = 1;
  renderCurrentPdfPage();
});

// Volvemos a pintar (coalesceando varios eventos seguidos en un solo frame)
// cada vez que el ancho visible del panel puede haber cambiado: al resize de
// la ventana o mientras el usuario arrastra el divisor.
let pdfRerenderScheduled = false;
function scheduleRerenderPdf() {
  if (pdfRerenderScheduled) return;
  pdfRerenderScheduled = true;
  requestAnimationFrame(() => {
    pdfRerenderScheduled = false;
    if (state.pdfDoc && !$('#pdf-panel').classList.contains('hidden')) {
      renderCurrentPdfPage();
    }
  });
}
window.addEventListener('resize', scheduleRerenderPdf);

// ---------- PDF: panel redimensionable (arrastrando el divisor) ----------
(function setupPdfPanelResize() {
  const handle = $('#pdf-resize-handle');
  const panel = $('#pdf-panel');
  const STORAGE_KEY = 'club_lectura_pdf_panel_width';
  const MIN_WIDTH = 260;

  function maxWidth() {
    // Deja siempre al menos ~320px libres para el chat, sin importar qué tan
    // angosta esté la ventana.
    return Math.max(MIN_WIDTH, window.innerWidth - 320);
  }

  function applyWidth(px) {
    const clamped = Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), px)));
    panel.style.flex = `0 0 ${clamped}px`;
    panel.style.width = `${clamped}px`;
    localStorage.setItem(STORAGE_KEY, String(clamped));
    scheduleRerenderPdf();
  }

  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved) applyWidth(saved);

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  function startDrag(clientX) {
    dragging = true;
    startX = clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
  }
  function moveDrag(clientX) {
    if (!dragging) return;
    // El panel está a la derecha: mover el mouse hacia la izquierda lo agranda.
    const delta = startX - clientX;
    applyWidth(startWidth + delta);
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', (e) => { startDrag(e.clientX); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX));
  window.addEventListener('mouseup', endDrag);

  handle.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientX), { passive: true });
  window.addEventListener('touchmove', (e) => { if (dragging) moveDrag(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', endDrag);
})();

function renderPdfSection(room) {
  const section = $('#pdf-section');
  if (!room.pdf || !room.pdf.url) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  $('#pdf-filename').textContent = room.pdf.fileName || '';
  loadAndRenderPdf(room.pdf);
}

async function loadAndRenderPdf(pdf) {
  if (!pdf || !pdf.url || typeof pdfjsLib === 'undefined') return;

  if (state.pdfDocUrl !== pdf.url) {
    // Documento nuevo (o cambió de PDF): lo cargamos de cero.
    state.pdfDoc = null;
    state.pdfDocUrl = pdf.url;
    state.pdfNumPages = null;
    state.pdfRenderedKey = null;
    try {
      const loadingTask = pdfjsLib.getDocument(pdf.url);
      const doc = await loadingTask.promise;
      // Si mientras cargaba el host ya puso OTRO pdf, descartamos este resultado.
      if (state.pdfDocUrl !== pdf.url) return;
      state.pdfDoc = doc;
      state.pdfNumPages = doc.numPages;
      const vs = getPdfViewState(pdf.url);
      vs.page = Math.min(vs.page, doc.numPages);
    } catch (err) {
      toast('No se pudo cargar el PDF.');
      return;
    }
  }

  await renderCurrentPdfPage();
}

async function renderCurrentPdfPage() {
  if (!state.pdfDoc || !state.pdfDocUrl) return;
  const vs = getPdfViewState(state.pdfDocUrl);
  const key = `${state.pdfDocUrl}|${vs.page}|${vs.zoom}`;
  if (state.pdfRenderedKey === key) {
    updatePdfIndicators(vs);
    return;
  }

  // Si había un render en curso (p. ej. cambiaste de página/zoom rápido), lo cancelamos.
  if (state.pdfRenderTask) {
    try { state.pdfRenderTask.cancel(); } catch (e) { /* ya terminó */ }
    state.pdfRenderTask = null;
  }

  try {
    const page = await state.pdfDoc.getPage(vs.page);
    const canvas = $('#pdf-canvas');
    const wrap = canvas.parentElement;
    const unscaledViewport = page.getViewport({ scale: 1 });
    const fitWidthScale = Math.max((wrap.clientWidth || 320) / unscaledViewport.width, 0.05);
    const finalScale = fitWidthScale * vs.zoom;
    const viewport = page.getViewport({ scale: finalScale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    const renderTask = page.render({ canvasContext: ctx, viewport });
    state.pdfRenderTask = renderTask;
    await renderTask.promise;
    state.pdfRenderTask = null;
    state.pdfRenderedKey = key;
    updatePdfIndicators(vs);
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    toast('No se pudo mostrar esa página del PDF.');
  }
}

function updatePdfIndicators(vs) {
  const pageEl = $('#pdf-page-indicator');
  if (pageEl) {
    pageEl.textContent = state.pdfNumPages ? `Pág. ${vs.page} / ${state.pdfNumPages}` : `Pág. ${vs.page}`;
  }
  const zoomEl = $('#pdf-zoom-indicator');
  if (zoomEl) zoomEl.textContent = `${Math.round(vs.zoom * 100)}%`;
}
