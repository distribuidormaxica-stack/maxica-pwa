'use strict';

const RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxyD8Jzh_Kjx27G3Tec_xIq6NFBY1S0j-9prQiJh5N8LUGMaRl7kdhc4lS55v05P7yIsg/exec';
const TRUSTED_APPS_SCRIPT_ORIGIN = /^https:\/\/(?:[a-z0-9-]+-script\.|script\.)googleusercontent\.com$/;
const VAULT_KEY = 'maxica-rutas-offline-jornada-v1';
const PROTOCOL_VERSION = 1;
const KEY_ROUNDS = 310000;
const MINIMUM_PHRASE_LENGTH = 10;
const MAX_SNAPSHOT_CHARS = 1000000;
const formatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short'
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ui = id => document.getElementById(id);
const frame = ui('frame');
const fallback = ui('standalone');
fallback.href = RUTAS_URL;

let currentView = 'saved';
let frameRequested = false;
let activePort = null;
let readyWorker = false;
let deferredInstall = null;
let vault = null;
let hasSealedJourney = false;
let keyEpoch = 0;
let writes = Promise.resolve();

function readEnvelope() {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) return null;
  const envelope = JSON.parse(raw);
  if (envelope.version !== PROTOCOL_VERSION ||
      !/^[a-f0-9]{32}$/.test(envelope.salt) ||
      !/^[a-f0-9]{24}$/.test(envelope.iv) ||
      typeof envelope.data !== 'string' || envelope.data.length > MAX_SNAPSHOT_CHARS * 6) {
    throw new Error('Formato de jornada no válido');
  }
  return {raw, envelope};
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  return Uint8Array.from(hex.match(/.{2}/g), pair => parseInt(pair, 16));
}

function encodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  return btoa(binary);
}

function deriveKeys(phrase, salt) {
  return crypto.subtle.importKey('raw', encoder.encode(phrase), 'PBKDF2', false, ['deriveKey'])
    .then(async material => {
      const derivation = {name:'PBKDF2', salt, iterations:KEY_ROUNDS, hash:'SHA-256'};
      const algorithm = {name:'AES-GCM', length:256};
      const [readKey, writeKey] = await Promise.all([
        crypto.subtle.deriveKey(derivation, material, algorithm, false, ['decrypt']),
        crypto.subtle.deriveKey(derivation, material, algorithm, false, ['encrypt'])
      ]);
      return {readKey, writeKey};
    });
}

function validateSnapshot(input) {
  if (!input || !input.journey || !Array.isArray(input.journey.clientes) ||
      !Array.isArray(input.visits) || input.journey.clientes.length > 5000 ||
      input.visits.length > 5000) throw new Error('Resumen inválido');

  function field(value, maximum, required = false) {
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
      throw new Error('Campo de jornada inválido');
    }
    return value.trim();
  }

  const updatedAt = field(input.updatedAt, 40, true);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Fecha del resumen inválida');
  const snapshot = {
    seller: field(input.seller, 200, true).normalize('NFC'),
    journey: {
      fecha: field(input.journey.fecha, 50, true),
      dia: field(input.journey.dia || '', 50),
      clientes: input.journey.clientes.map(row => ({
        cliente: field(row.cliente, 350, true),
        zona: field(row.zona || '', 180),
        visitado: row.visitado === true
      }))
    },
    visits: input.visits.map(row => {
      if (!['pendiente', 'por_revisar', 'sincronizada'].includes(row.estado)) {
        throw new Error('Estado de visita inválido');
      }
      return {
        id: field(row.id, 150, true),
        cliente: field(row.cliente, 350, true),
        tipo: field(row.tipo || '', 150),
        fecha: field(row.fecha || '', 50),
        estado: row.estado
      };
    }),
    updatedAt
  };
  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_CHARS) throw new Error('Resumen demasiado grande');
  return snapshot;
}

async function openSnapshot(current, phrase) {
  const {raw, envelope} = current;
  const salt = fromHex(envelope.salt);
  const keys = await deriveKeys(phrase, salt);
  const data = Uint8Array.from(atob(envelope.data), char => char.charCodeAt(0));
  const snapshot = await decryptSnapshot(keys.readKey, fromHex(envelope.iv), data);
  return {raw, salt, ...keys, snapshot};
}

async function decryptSnapshot(readKey, iv, cipher) {
  const bytes = await crypto.subtle.decrypt({name:'AES-GCM', iv}, readKey, cipher);
  return validateSnapshot(JSON.parse(decoder.decode(bytes)));
}

function persistSnapshot(state, snapshot, iv, cipher) {
  if (state.epoch !== keyEpoch) return false;
  if (state.snapshot && state.snapshot.seller !== snapshot.seller) return false;
  if (state.snapshot && Date.parse(snapshot.updatedAt) < Date.parse(state.snapshot.updatedAt)) return true;
  const raw = JSON.stringify({
    version: PROTOCOL_VERSION, salt: toHex(state.salt), iv: toHex(iv),
    data: encodeBytes(new Uint8Array(cipher))
  });
  const previous = localStorage.getItem(VAULT_KEY);
  if (previous !== state.raw) throw new Error('Otra ventana actualizó la jornada');
  localStorage.setItem(VAULT_KEY, raw);
  state.raw = raw;
  state.snapshot = snapshot;
  return true;
}

function showNotice(message) {
  ui('notice').textContent = message;
  fallback.hidden = navigator.onLine === false;
}

function refreshNotice() {
  if (navigator.onLine === false) {
    showNotice('Sin señal · Puedes consultar la última jornada guardada.');
  } else if (currentView === 'saved' && !vault && hasSealedJourney) {
    showNotice('La jornada de este dispositivo está protegida. Desbloquéala para consultarla.');
  } else if (activePort && !vault) {
    showNotice('Abre «Ver jornada guardada» para configurar o desbloquear el guardado en este dispositivo.');
  } else if (vault && vault.snapshot && readyWorker) {
    showNotice('Jornada guardada · Puedes cerrar Rutas y volver a abrirla sin señal.');
  } else if (vault && vault.snapshot) {
    showNotice('Jornada guardada · El navegador aún no confirmó que la aplicación pueda abrirse sin señal.');
  } else {
    showNotice('Prepara tu jornada desde Rutas para consultarla sin señal.');
  }
}

function refreshSavedView() {
  let sealed;
  let storageError = false;
  try { sealed = readEnvelope(); } catch (_) { storageError = true; }
  hasSealedJourney = Boolean(sealed);
  const unlocked = Boolean(vault && vault.snapshot);
  const settingUp = !sealed && !storageError;
  const showForm = !vault && !storageError && Boolean(sealed || activePort);
  ui('empty').hidden = unlocked || showForm;
  ui('key-form').hidden = !showForm;
  ui('snapshot').hidden = !unlocked;
  ui('empty-message').textContent = storageError
    ? 'No se pudo leer la jornada en este navegador. Comprueba que el almacenamiento local esté habilitado.'
    : vault && !vault.snapshot
      ? 'La frase está lista. Vuelve a Rutas y guarda tu jornada.'
      : 'En este dispositivo aún no hay una jornada disponible sin señal.';
  if (showForm) {
    ui('key-title').textContent = settingUp ? 'Proteger jornada en este dispositivo' : 'Desbloquear jornada';
    ui('key-help').textContent = settingUp
      ? 'Crea una frase de al menos 10 caracteres. Usa una distinta del PIN de Rutas. La necesitarás para abrir la jornada sin señal.'
      : 'Escribe la frase que creaste al guardar la jornada en este dispositivo.';
    ui('repeat-phrase').hidden = !settingUp;
    ui('repeat-label').hidden = !settingUp;
    ui('repeat-phrase').required = settingUp;
    ui('key-submit').textContent = settingUp ? 'Crear frase de acceso' : 'Desbloquear';
  }
  if (unlocked) drawSnapshot(vault.snapshot);
  else {
    for (const id of ['seller','updated','journey-day','route-summary','visit-summary']) ui(id).textContent = '';
    for (const id of ['clients','visits','reviews']) ui(id).replaceChildren();
  }
}

function setView(view) {
  currentView = view;
  ui('saved').hidden = view !== 'saved';
  ui('welcome').hidden = view !== 'welcome';
  frame.hidden = view !== 'live';
  ui('saved-button').setAttribute('aria-pressed', String(view === 'saved'));
  ui('live-button').setAttribute('aria-pressed', String(view === 'live'));
  if (view === 'saved') refreshSavedView();
}

function showLive(retry = false) {
  if (navigator.onLine === false && !frameRequested) {
    setView('saved');
    return;
  }
  if (!frameRequested || (retry && !activePort && navigator.onLine !== false)) {
    frameRequested = true;
    frame.src = RUTAS_URL;
  }
  setView('live');
}

function dateText(value, fallbackText) {
  if (!value) return fallbackText;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? formatter.format(timestamp) : value;
}

function rowItem(name, detail, badgeName, badgeClass) {
  const li = document.createElement('li');
  const heading = document.createElement('div');
  heading.className = 'item-head';
  const nameNode = document.createElement('strong');
  nameNode.textContent = name;
  heading.append(nameNode);
  if (badgeName) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass;
    badge.textContent = badgeName;
    heading.append(badge);
  }
  li.append(heading);
  if (detail) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = detail;
    li.append(sub);
  }
  return li;
}

function drawSnapshot(snapshot) {
  const {journey, visits, seller, updatedAt} = snapshot;
  ui('journey-day').textContent = [journey.dia, journey.fecha].filter(Boolean).join(' · ');
  ui('seller').textContent = seller;
  ui('updated').textContent = 'Última actualización · ' + dateText(updatedAt);
  const completed = journey.clientes.filter(row => row.visitado).length;
  ui('route-summary').textContent = completed + ' de ' + journey.clientes.length + ' clientes visitados';
  ui('clients').replaceChildren(...journey.clientes.map(row =>
    rowItem(row.cliente, row.zona, row.visitado ? 'Visitado' : '', 'visitado')));

  const sorted = visits.slice().sort((a, b) => (Date.parse(b.fecha) || 0) - (Date.parse(a.fecha) || 0));
  const queued = sorted.filter(row => row.estado === 'pendiente');
  const reviews = sorted.filter(row => row.estado === 'por_revisar');
  ui('visit-summary').textContent = queued.length === 0 ? 'No hay visitas pendientes en esta copia.' :
    queued.length === 1 ? '1 visita pendiente de sincronizar.' : queued.length + ' visitas pendientes de sincronizar.';
  function visitRow(row, badge) {
    const detail = [row.tipo, dateText(row.fecha, 'Sin fecha registrada')].filter(Boolean).join(' · ');
    return rowItem(row.cliente, detail, badge, row.estado);
  }
  ui('visits').replaceChildren(...queued.map(row => visitRow(row, 'Pendiente')));
  ui('review-details').hidden = reviews.length === 0;
  ui('reviews').replaceChildren(...reviews.map(row => visitRow(row, 'Por revisar')));
}

function isRutasFrame(source) {
  const target = frame.contentWindow;
  if (!target || !source || source === window) return false;
  try {
    let checked = source;
    for (let i = 0; checked && i < 6; i++) {
      if (checked === target) return true;
      const parent = checked.parent;
      if (parent === checked || parent === window) return false;
      checked = parent;
    }
  } catch (_) {}
  return false;
}

function onSnapshot(port, message) {
  writes = writes.then(async () => {
    if (activePort !== port) return;
    try {
      const targetVault = vault;
      if (!targetVault) {
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'locked'});
        return;
      }
      const validCipher = message.iv instanceof Uint8Array && message.iv.length === 12 &&
        message.cipher instanceof ArrayBuffer && message.cipher.byteLength >= 16 &&
        message.cipher.byteLength <= MAX_SNAPSHOT_CHARS * 4;
      if (!validCipher || 'payload' in message) {
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'invalid-ciphertext'});
        return;
      }
      const snapshot = await decryptSnapshot(targetVault.readKey, message.iv, message.cipher);
      if (vault !== targetVault || activePort !== port) return;
      if (targetVault.snapshot && snapshot.seller !== targetVault.snapshot.seller) {
        showNotice('La jornada guardada pertenece a otro vendedor. Cambia de sesión en Rutas antes de guardar.');
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'different-seller'});
        return;
      }
      const ok = persistSnapshot(targetVault, snapshot, message.iv, message.cipher);
      port.postMessage({type:'saved', id:message.id, ok});
      refreshSavedView();
      refreshNotice();
    } catch (_) {
      port.postMessage({type:'saved', id:message.id, ok:false, reason:'storage'});
      showNotice('No se pudo actualizar la jornada guardada. La última copia sigue disponible.');
    }
  });
}

function lockSnapshot() {
  keyEpoch++;
  vault = null;
  if (activePort) activePort.postMessage({type:'lock'});
  ui('phrase').value = '';
  ui('repeat-phrase').value = '';
  ui('key-error').textContent = '';
  refreshSavedView();
  refreshNotice();
}

function requestSnapshot() {
  if (!activePort || !vault) return;
  try {
    activePort.postMessage({type:'refresh', key:vault.writeKey});
  } catch (_) {
    showNotice('Este navegador no pudo conectar la copia guardada con Rutas.');
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  if (!message || message.type !== 'maxica:rutas-ready' || message.version !== PROTOCOL_VERSION ||
      !TRUSTED_APPS_SCRIPT_ORIGIN.test(event.origin) || !isRutasFrame(event.source)) return;

  const channel = new MessageChannel();
  if (activePort) activePort.close();
  const port = channel.port1;
  activePort = port;
  port.onmessage = event => {
    const incoming = event.data;
    if (activePort !== port || !incoming) return;
    if (incoming.type === 'lock') {
      lockSnapshot();
    } else if (incoming.type === 'snapshot' && typeof incoming.id === 'string' && incoming.id.length <= 120) {
      onSnapshot(port, incoming);
    }
  };
  event.source.postMessage({type:'maxica:rutas-connect', version:PROTOCOL_VERSION}, event.origin, [channel.port2]);
  refreshSavedView();
  refreshNotice();
  requestSnapshot();
});

ui('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = ui('key-error');
  const submit = ui('key-submit');
  const phrase = ui('phrase').value;
  const repeat = ui('repeat-phrase').value;
  ui('phrase').value = '';
  ui('repeat-phrase').value = '';
  error.textContent = '';
  submit.disabled = true;
  const epoch = keyEpoch;
  try {
    const stored = readEnvelope();
    let next;
    if (stored) {
      next = await openSnapshot(stored, phrase);
    } else {
      if (phrase.length < MINIMUM_PHRASE_LENGTH || phrase !== repeat) {
        error.textContent = 'Usa al menos 10 caracteres y repite la misma frase.';
        return;
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const keys = await deriveKeys(phrase, salt);
      next = {epoch, salt, ...keys, raw:null, snapshot:null};
    }
    if (epoch !== keyEpoch) return;
    next.epoch = epoch;
    vault = next;
    refreshSavedView();
    refreshNotice();
    requestSnapshot();
  } catch (_) {
    error.textContent = 'No se pudo abrir o guardar la jornada. Comprueba tu frase y el almacenamiento del navegador.';
  } finally {
    submit.disabled = false;
  }
});

ui('live-button').addEventListener('click', () => showLive(true));
ui('saved-button').addEventListener('click', () => setView('saved'));
window.addEventListener('offline', () => {
  if (!activePort || currentView !== 'live') setView('saved');
  refreshNotice();
});
window.addEventListener('online', refreshNotice);
window.addEventListener('storage', event => {
  if (event.key === VAULT_KEY || event.key === null) lockSnapshot();
});
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstall = event;
  ui('install-button').hidden = false;
});
ui('install-button').addEventListener('click', async () => {
  if (!deferredInstall) {
    if (!ui('install-help').open) ui('install-help').showModal();
    return;
  }
  const prompt = deferredInstall;
  deferredInstall = null;
  ui('install-button').hidden = true;
  await prompt.prompt();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  ui('install-button').hidden = true;
});
const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (appleTouch && !navigator.standalone) ui('install-button').hidden = false;

function verifyOfflineShell(worker) {
  if (!worker) return;
  const channel = new MessageChannel();
  const timer = setTimeout(() => channel.port1.close(), 3000);
  channel.port1.onmessage = event => {
    if (event.data?.type === 'maxica:rutas-worker-ready' && event.data.version === PROTOCOL_VERSION) {
      readyWorker = true;
      refreshNotice();
    }
    clearTimeout(timer);
    channel.port1.close();
  };
  worker.postMessage({type:'maxica:rutas-worker-status'}, [channel.port2]);
}

if ('serviceWorker' in navigator) {
  const serviceWorker = navigator.serviceWorker;
  serviceWorker.addEventListener('controllerchange', () => verifyOfflineShell(serviceWorker.controller));
  serviceWorker.register('./service-worker.js').then(() => serviceWorker.ready)
    .then(registration => verifyOfflineShell(registration.active))
    .catch(() => refreshNotice());
}

try { hasSealedJourney = Boolean(readEnvelope()); } catch (_) {}
if (navigator.onLine === false || hasSealedJourney) setView('saved');
else showLive();
refreshNotice();
