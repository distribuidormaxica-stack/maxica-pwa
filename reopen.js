'use strict';

const RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxyD8Jzh_Kjx27G3Tec_xIq6NFBY1S0j-9prQiJh5N8LUGMaRl7kdhc4lS55v05P7yIsg/exec';
const TRUSTED_APPS_SCRIPT_ORIGIN = /^https:\/\/(?:[a-z0-9-]+-script\.|script\.)googleusercontent\.com$/;
const DEVICE_DB = 'maxica-rutas-offline-v2';
const DEVICE_CHANGED = 'maxica-rutas-device-changed-v2';
const PROTOCOL_VERSION = 1;
const MAX_SNAPSHOT_CHARS = 1000000;
const formatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short'
});
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
let keyEpoch = 0;
let writes = Promise.resolve();
let readingDevice = true;
let storageError = false;
let lockingDevice = false;

function openDeviceStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('device');
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Almacenamiento de jornada ocupado'));
  });
}

function updateDevice(db, update) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('device', 'readwrite');
    const store = transaction.objectStore('device');
    const request = store.get('local');
    let result;
    request.onsuccess = () => {
      try {
        const current = request.result;
        result = update(current);
        if (result !== current) store.put(result, 'local');
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('No se guardó la jornada'));
  });
}

async function newDeviceKeys(locked = false) {
  const material = crypto.getRandomValues(new Uint8Array(32));
  try {
    const [readKey, writeKey] = await Promise.all([
      crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['decrypt']),
      crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt'])
    ]);
    return {session:crypto.randomUUID(), readKey, writeKey, locked, envelope:null};
  } finally {
    material.fill(0);
  }
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

async function decryptSnapshot(readKey, iv, cipher) {
  const bytes = await crypto.subtle.decrypt({name:'AES-GCM', iv}, readKey, cipher);
  return validateSnapshot(JSON.parse(decoder.decode(bytes)));
}

async function recoverDevice(record, epoch) {
  const envelope = record?.envelope;
  const snapshot = envelope && !record.locked
    ? await decryptSnapshot(record.readKey, envelope.iv, envelope.cipher) : null;
  if (epoch !== keyEpoch) return;
  vault = record ? {record, snapshot} : null;
  storageError = false;
  refreshSavedView();
  refreshNotice();
}

function notifyDeviceChange() {
  try { localStorage.setItem(DEVICE_CHANGED, crypto.randomUUID()); } catch (_) {}
}

function showNotice(message) {
  ui('notice').textContent = message;
  fallback.hidden = navigator.onLine === false;
}

function refreshNotice() {
  if (storageError) {
    showNotice('El navegador no pudo acceder a la copia de este dispositivo.');
  } else if (vault?.snapshot && navigator.onLine === false) {
    showNotice('Sin señal · Consultando la última jornada guardada.');
  } else if (vault?.snapshot && readyWorker) {
    showNotice('Jornada guardada · Puedes cerrar Rutas y volver a abrirla sin señal.');
  } else if (vault?.snapshot) {
    showNotice('Jornada guardada · El navegador aún no confirmó que la aplicación pueda abrirse sin señal.');
  } else if (navigator.onLine === false) {
    showNotice('Sin señal.');
  } else {
    showNotice('Prepara tu jornada desde Rutas para consultarla sin señal.');
  }
}

function refreshSavedView() {
  const snapshot = vault?.snapshot;
  ui('empty').hidden = Boolean(snapshot);
  ui('snapshot').hidden = !snapshot;
  let texto = 'En este dispositivo aún no hay una jornada disponible sin señal.';
  if (readingDevice) texto = 'Buscando la jornada de este dispositivo…';
  else if (storageError) texto = 'No se pudo abrir la jornada. Comprueba que el almacenamiento del navegador esté habilitado.';
  else if (vault?.record.locked) texto = 'Cerraste sesión. Inicia sesión en Rutas para preparar la jornada de nuevo.';
  ui('empty-message').textContent = texto;
  if (snapshot) drawSnapshot(snapshot);
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
  const epoch = keyEpoch;
  if (lockingDevice) return;
  writes = writes.then(async () => {
    if (activePort !== port || epoch !== keyEpoch) return;
    try {
      const validCipher = message.iv instanceof Uint8Array && message.iv.length === 12 &&
        message.cipher instanceof ArrayBuffer && message.cipher.byteLength >= 16 &&
        message.cipher.byteLength <= MAX_SNAPSHOT_CHARS * 4;
      if (!validCipher || 'payload' in message) {
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'invalid-ciphertext'});
        return;
      }
      const db = await deviceReady;
      const targetVault = vault;
      if (!db || !targetVault || activePort !== port || epoch !== keyEpoch) return;

      const current = await updateDevice(db, record => record);
      if (!current || current.session !== targetVault.record.session) {
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'session'});
        return;
      }
      const snapshot = await decryptSnapshot(current.readKey, message.iv, message.cipher);
      const previous = current.envelope && !current.locked
        ? current.envelope.id === targetVault.record.envelope?.id && targetVault.snapshot
          ? targetVault.snapshot
          : await decryptSnapshot(current.readKey, current.envelope.iv, current.envelope.cipher)
        : null;
      if (activePort !== port || epoch !== keyEpoch) return;
      if (previous && snapshot.seller !== previous.seller) {
        showNotice('La jornada guardada pertenece a otro vendedor. Cambia de sesión en Rutas antes de guardar.');
        port.postMessage({type:'saved', id:message.id, ok:false, reason:'different-seller'});
        return;
      }
      if (previous && Date.parse(previous.updatedAt) > Date.parse(snapshot.updatedAt)) {
        port.postMessage({type:'saved', id:message.id, ok:true});
        return;
      }
      const envelope = {id:crypto.randomUUID(), iv:message.iv, cipher:message.cipher};
      const stored = await updateDevice(db, record => {
        if (activePort !== port || epoch !== keyEpoch || record?.session !== current.session ||
            record.envelope?.id !== current.envelope?.id) return record;
        return {...record, locked:false, envelope};
      });
      if (activePort !== port || epoch !== keyEpoch) return;
      const ok = stored?.envelope?.id === envelope.id;
      if (ok) {
        vault = {record:stored, snapshot};
        storageError = false;
        refreshSavedView();
        refreshNotice();
        notifyDeviceChange();
      }
      port.postMessage({type:'saved', id:message.id, ok});
    } catch (_) {
      port.postMessage({type:'saved', id:message.id, ok:false, reason:'storage'});
      showNotice('No se pudo actualizar la jornada guardada. La última copia sigue disponible.');
    }
  });
}

async function lockSnapshot(port) {
  if (lockingDevice) return;
  lockingDevice = true;
  const epoch = ++keyEpoch;
  const target = vault?.record.session;
  if (vault) vault = {...vault, snapshot:null};
  port.postMessage({type:'lock'});
  refreshSavedView();
  refreshNotice();
  try {
    const db = await deviceReady;
    if (!db) return;
    const replacement = await newDeviceKeys(true);
    const stored = await updateDevice(db, record => !target || record?.session === target ? replacement : record);
    if (epoch !== keyEpoch) return;
    vault = stored ? {record:stored, snapshot:null} : null;
    refreshSavedView();
    refreshNotice();
    notifyDeviceChange();
    if (stored?.session === replacement.session && activePort) requestSnapshot(activePort);
  } catch (_) {
    storageError = true;
    refreshSavedView();
    refreshNotice();
  } finally {
    lockingDevice = false;
  }
}

async function requestSnapshot(port) {
  await deviceReady;
  if (activePort !== port || !vault || lockingDevice) return;
  try {
    port.postMessage({type:'refresh', key:vault.record.writeKey});
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
      lockSnapshot(port);
    } else if (incoming.type === 'snapshot' && typeof incoming.id === 'string' && incoming.id.length <= 120) {
      onSnapshot(port, incoming);
    }
  };
  event.source.postMessage({type:'maxica:rutas-connect', version:PROTOCOL_VERSION}, event.origin, [channel.port2]);
  refreshSavedView();
  refreshNotice();
  requestSnapshot(port);
});

let viewChosen = false;
ui('live-button').addEventListener('click', () => { viewChosen = true; showLive(true); });
ui('saved-button').addEventListener('click', () => { viewChosen = true; setView('saved'); });
window.addEventListener('offline', () => {
  if (!activePort || currentView !== 'live') setView('saved');
  refreshNotice();
});
window.addEventListener('online', refreshNotice);
window.addEventListener('storage', async event => {
  if (event.key !== DEVICE_CHANGED && event.key !== null) return;
  const epoch = keyEpoch;
  try {
    const db = await deviceReady;
    if (!db || epoch !== keyEpoch) return;
    const record = await updateDevice(db, current => current);
    if (epoch !== keyEpoch) return;
    if (record?.session !== vault?.record.session) {
      keyEpoch++;
      if (vault) vault = {...vault, snapshot:null};
      if (activePort) {
        activePort.postMessage({type:'lock'});
        activePort.close();
        activePort = null;
      }
      refreshSavedView();
      await recoverDevice(record, keyEpoch);
    } else {
      await recoverDevice(record, epoch);
    }
  } catch (_) {
    if (epoch === keyEpoch) {
      vault = null;
      storageError = true;
      refreshSavedView();
      refreshNotice();
    }
  }
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

setView('saved');
const deviceReady = (async () => {
  const epoch = keyEpoch;
  try {
    const db = await openDeviceStore();
    const candidate = await newDeviceKeys();
    const record = await updateDevice(db, current => current || candidate);
    readingDevice = false;
    await recoverDevice(record, epoch);
    if (!viewChosen && !vault?.snapshot && navigator.onLine !== false) showLive();
    return db;
  } catch (_) {
    readingDevice = false;
    storageError = true;
    refreshSavedView();
    refreshNotice();
    if (!viewChosen && navigator.onLine !== false) showLive();
    return null;
  }
})();
