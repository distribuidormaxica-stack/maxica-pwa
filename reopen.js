'use strict';

const RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxyD8Jzh_Kjx27G3Tec_xIq6NFBY1S0j-9prQiJh5N8LUGMaRl7kdhc4lS55v05P7yIsg/exec';
const TRUSTED_APPS_SCRIPT_ORIGIN = /^https:\/\/(?:[a-z0-9-]+-script\.|script\.)googleusercontent\.com$/;
const DEVICE_DB = 'maxica-rutas-offline-v2';
const DEVICE_CHANGED = 'maxica-rutas-device-changed-v2';
const COLA_CHANGED = 'maxica-rutas-cola-campo-v1';
const PROTOCOL_VERSION = 1;
const MAX_SNAPSHOT_CHARS = 1000000;
const CUENTA_VISITAS = /^[a-f0-9]{64}$/;
const formatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short'
});
const diaCaracasCampo = new Intl.DateTimeFormat('en-GB', {
  timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit'
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
let colaCampo = [];
let cuentaCola = '';
let lecturaCola = 0;
let cuentaMarco = '';
let marcoSoloParaEnvio = false;
let enviandoCola = false;
let envioPendiente = null;
let cuentaParaReintentar = '';
let mensajeCampo = '';
let contextoVisita = null;
let intentoVisita = null;
let guardandoCampo = false;
let gpsCampo = null;

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
    accountId: CUENTA_VISITAS.test(input.accountId || '') ? input.accountId : '',
    gestion: {
      tipos: listaGestion(input.gestion?.tipos, 35),
      motivos: listaGestion(input.gestion?.motivos, 60),
      productosFoco: listaGestion(input.gestion?.productosFoco, 150)
    },
    journey: {
      fecha: field(input.journey.fecha, 50, true),
      dia: field(input.journey.dia || '', 50),
      clientes: input.journey.clientes.map(row => ({
        cliente: field(row.cliente, 350, true),
        zona: field(row.zona || '', 180),
        visitado: row.visitado === true,
        enRuta: row.enRuta !== false
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

  function listaGestion(items, max) {
    return Array.isArray(items) ? [...new Set(items.slice(0, max).map(item => field(item, 350, true)))] : [];
  }
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
  actualizarColaCampo();
}

function notifyDeviceChange() {
  try { localStorage.setItem(DEVICE_CHANGED, crypto.randomUUID()); } catch (_) {}
}

function showNotice(message) {
  ui('notice').textContent = message;
  fallback.hidden = navigator.onLine === false || currentView !== 'live' || Boolean(activePort);
}

function refreshNotice() {
  document.body.classList.toggle('rutas-abierta', currentView === 'live' && Boolean(activePort));
  if (storageError) {
    showNotice('El navegador no pudo acceder a la copia de este dispositivo.');
  } else if (vault?.snapshot && navigator.onLine === false) {
    showNotice(vault.snapshot.accountId && vault.snapshot.gestion.tipos.length ?
      'Sin señal · Puedes registrar visitas en la jornada guardada.' : 'Sin señal · Consultando la última jornada guardada.');
  } else if (vault?.snapshot && readyWorker) {
    showNotice('Jornada guardada · Puedes cerrar Rutas y volver a abrirla sin señal.');
  } else if (vault?.snapshot) {
    showNotice('Jornada guardada · El navegador aún no confirmó que la aplicación pueda abrirse sin señal.');
  } else if (navigator.onLine === false) {
    showNotice('Sin señal.');
  } else if (currentView === 'live' && activePort) {
    showNotice('Para preparar la copia, entra en Ruta y pulsa «Preparar jornada sin conexión».');
  } else {
    showNotice('');
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
    for (const id of ['clients','visits','reviews','lista-recibos-campo']) ui(id).replaceChildren();
  }
}

function setView(view) {
  currentView = view;
  ui('saved').hidden = view !== 'saved';
  ui('welcome').hidden = view !== 'welcome';
  frame.hidden = view !== 'live';
  ui('saved-button').setAttribute('aria-pressed', String(view === 'saved'));
  ui('live-button').setAttribute('aria-pressed', String(view === 'live'));
  ui('live-button').textContent = view === 'live' ? 'Rutas' : frameRequested ? 'Volver a Rutas' : 'Abrir Rutas';
  if (view === 'saved') refreshSavedView();
  refreshNotice();
}

function showLive() {
  if (navigator.onLine === false && !frameRequested) {
    setView('saved');
    return;
  }
  if (!frameRequested) abrirMarcoRutas(false);
  marcoSoloParaEnvio = false;
  setView('live');
}

function abrirMarcoRutas(enSegundoPlano) {
  frameRequested = true;
  marcoSoloParaEnvio = enSegundoPlano;
  frame.src = RUTAS_URL;
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
  const locales = cuentaCola === snapshot.accountId ? colaCampo : [];
  const vistos = new Set(locales.filter(item => item.estado !== 'por_revisar' &&
    diaCaracasCampo.format(new Date(item.visita.capturadaEn)) === journey.fecha).map(item => item.visita.cliente));
  const completed = journey.clientes.filter(row => row.visitado || vistos.has(row.cliente)).length;
  ui('route-summary').textContent = completed + ' de ' + journey.clientes.length + ' clientes visitados';
  ui('clients').replaceChildren(...journey.clientes.map(row =>
    rowItem(row.cliente, row.zona, row.visitado || vistos.has(row.cliente) ? 'Visitado' : '', 'visitado')));

  const puedeRegistrar = Boolean(snapshot.accountId && snapshot.gestion.tipos.length && journey.clientes.length);
  ui('boton-visita').hidden = !puedeRegistrar;
  ui('preparar-captura').hidden = puedeRegistrar || !journey.clientes.length;

  const todas = new Map(visits.map(row => [row.id, row]));
  for (const item of locales) {
    const v = item.visita;
    todas.set(v.id, {id:v.id, cliente:v.cliente, tipo:v.tipoGestion, fecha:v.capturadaEn, estado:item.estado, mensaje:item.mensaje});
  }
  const sorted = [...todas.values()].sort((a, b) => (Date.parse(b.fecha) || 0) - (Date.parse(a.fecha) || 0));
  const queued = sorted.filter(row => row.estado === 'pendiente');
  const reviews = sorted.filter(row => row.estado === 'por_revisar');
  const recibos = sorted.filter(row => row.estado === 'sincronizada').slice(0, 10);
  ui('visit-summary').textContent = queued.length === 0 ? 'No hay visitas pendientes en esta copia.' :
    queued.length === 1 ? '1 visita pendiente de sincronizar.' : queued.length + ' visitas pendientes de sincronizar.';
  function visitRow(row, badge) {
    const detail = [row.tipo, dateText(row.fecha, 'Sin fecha registrada'), row.mensaje].filter(Boolean).join(' · ');
    return rowItem(row.cliente, detail, badge, row.estado);
  }
  ui('visits').replaceChildren(...queued.map(row => visitRow(row, 'Pendiente')));
  ui('review-details').hidden = reviews.length === 0;
  ui('reviews').replaceChildren(...reviews.map(row => visitRow(row, 'Por revisar')));
  ui('recibos-campo').hidden = recibos.length === 0;
  ui('lista-recibos-campo').replaceChildren(...recibos.map(row => visitRow(row, 'Sincronizada')));
  mostrarEnvioCampo();
}

function mostrarEnvioCampo() {
  const pendientes = cuentaCola === vault?.snapshot?.accountId && colaCampo.some(item => item.estado === 'pendiente');
  let mensaje = mensajeCampo;
  if (enviandoCola && pendientes) mensaje = 'Sincronizando visitas…';
  else if (pendientes && navigator.onLine === false) mensaje = 'Guardadas en este teléfono. Se enviarán cuando vuelva la señal.';
  else if (pendientes && !mensaje && cuentaMarco !== cuentaCola) mensaje = 'Si Rutas pide entrar, usa la misma cuenta para enviar las visitas.';
  const aviso = ui('avisos-campo');
  aviso.textContent = mensaje;
  aviso.hidden = !mensaje;
  const boton = ui('boton-sincronizar');
  boton.hidden = !pendientes;
  boton.disabled = enviandoCola || navigator.onLine === false;
}

async function actualizarColaCampo(activar = true) {
  const accountId = vault?.snapshot?.accountId || '';
  const turno = ++lecturaCola;
  if (accountId !== cuentaCola) {
    cuentaCola = accountId;
    colaCampo = [];
    mensajeCampo = '';
    refreshSavedView();
  }
  if (!accountId) return;
  try {
    const lista = await window.visitasCampo.listar(accountId);
    if (turno !== lecturaCola || vault?.snapshot?.accountId !== accountId) return;
    colaCampo = lista;
    refreshSavedView();
    if (activar && lista.some(item => item.estado === 'pendiente')) procesarColaCampo();
  } catch (_) {
    if (turno === lecturaCola) {
      mensajeCampo = 'No se pudieron leer las visitas de este dispositivo.';
      mostrarEnvioCampo();
    }
  }
}

function notificarColaCampo() {
  try { localStorage.setItem(COLA_CHANGED, crypto.randomUUID()); } catch (_) {}
}

function llenarSelectCampo(select, items, inicial) {
  select.replaceChildren(new Option(inicial, ''), ...items.map(valor => new Option(valor, valor)));
}

function abrirCapturaCampo() {
  const copia = vault?.snapshot;
  if (!copia?.accountId || !copia.gestion.tipos.length || !copia.journey.clientes.length) return;
  contextoVisita = copia;
  intentoVisita = null;
  gpsCampo = null;
  ui('form-campo').reset();
  llenarSelectCampo(ui('campo-cliente'), copia.journey.clientes.map(fila => fila.cliente), 'Elige un cliente');
  llenarSelectCampo(ui('campo-tipo'), copia.gestion.tipos, 'Elige el tipo de gestión');
  llenarSelectCampo(ui('campo-motivo'), copia.gestion.motivos, 'Sin motivo seleccionado');
  ui('campo-productos').replaceChildren(...copia.gestion.productosFoco.map(producto => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '1000000';
    input.step = '1';
    input.inputMode = 'numeric';
    input.dataset.producto = producto;
    label.append(producto, input);
    return label;
  }));
  ui('campo-error').textContent = '';
  ajustarCamposVisita();
  ui('dialog-campo').showModal();
  if (navigator.permissions?.query && navigator.geolocation) {
    navigator.permissions.query({name:'geolocation'}).then(permiso => {
      if (permiso.state !== 'granted' || contextoVisita !== copia) return;
      navigator.geolocation.getCurrentPosition(pos => {
        if (contextoVisita === copia) gpsCampo = {lat:pos.coords.latitude,lng:pos.coords.longitude,fecha:pos.timestamp};
      }, () => {}, {maximumAge:60000,timeout:2500});
    }).catch(() => {});
  }
}

function ajustarCamposVisita() {
  const tipo = ui('campo-tipo').value;
  const rechazo = tipo === 'Rechazo compra';
  const venta = tipo === 'Venta presencial' || tipo === 'Venta por telefono';
  ui('campo-motivo-fila').hidden = !rechazo || !contextoVisita?.gestion.motivos.length;
  ui('campo-competencia').hidden = !rechazo;
  ui('campo-productos-fila').hidden = !venta || !contextoVisita?.gestion.productosFoco.length;
}

async function guardarCapturaCampo(evento) {
  evento.preventDefault();
  if (guardandoCampo) return;
  const copia = contextoVisita;
  const cliente = copia?.journey.clientes.find(row => row.cliente === ui('campo-cliente').value);
  const tipo = ui('campo-tipo').value;
  if (!cliente || !copia.gestion.tipos.includes(tipo) || vault?.snapshot?.accountId !== copia.accountId) {
    ui('campo-error').textContent = 'Vuelve a abrir la visita desde tu jornada guardada.';
    return;
  }
  const ahora = new Date();
  const rechazo = tipo === 'Rechazo compra';
  const venta = tipo === 'Venta presencial' || tipo === 'Venta por telefono';
  const gps = tipo !== 'Venta por telefono' && gpsCampo && ahora.getTime()-gpsCampo.fecha <= 120000 ? gpsCampo : null;
  const visita = intentoVisita || {
    id:crypto.randomUUID(), capturadaEn:ahora.toISOString(), vendedor:copia.seller, cliente:cliente.cliente,
    tipoGestion:tipo, motivoNoCompra:rechazo ? ui('campo-motivo').value : '', nota:ui('campo-nota').value.trim(),
    enRuta:cliente.enRuta && diaCaracasCampo.format(ahora) === copia.journey.fecha, lat:gps?.lat || 0, lng:gps?.lng || 0,
    productosFoco:venta ? Array.from(ui('campo-productos').querySelectorAll('input')).filter(i => Number(i.value)>0)
      .map(i => ({producto:i.dataset.producto,cantidad:Number(i.value)})) : [],
    competidor:rechazo ? ui('campo-competidor').value.trim() : '', precioCompetidor:rechazo ? ui('campo-precio').value.trim() : ''
  };
  intentoVisita = visita;
  guardandoCampo = true;
  ui('campo-guardar').disabled = true;
  ui('campo-cancelar').disabled = true;
  ui('campo-error').textContent = '';
  try {
    const item = await window.visitasCampo.guardar(copia.accountId, visita);
    ui('dialog-campo').close();
    if (cuentaCola === copia.accountId && vault?.snapshot?.accountId === copia.accountId) {
      ++lecturaCola;
      colaCampo = [...colaCampo.filter(r => r.visita.id !== visita.id),item];
      mensajeCampo = item.estado === 'pendiente' ? 'Visita guardada en este teléfono.' : '';
      refreshSavedView();
    }
    notificarColaCampo();
    actualizarColaCampo();
    procesarColaCampo();
  } catch (_) {
    ui('campo-error').textContent = 'No se pudo guardar la visita. Vuelve a intentar sin cerrar el formulario.';
  } finally {
    guardandoCampo = false;
    ui('campo-guardar').disabled = false;
    ui('campo-cancelar').disabled = false;
  }
}

function cerrarEnvioPendiente(resultado) {
  if (!envioPendiente) return;
  const actual = envioPendiente;
  envioPendiente = null;
  clearTimeout(actual.timer);
  actual.resolve(resultado);
}

function enviarVisitaCampo(port, accountId, visit) {
  return new Promise(resolve => {
    const requestId = crypto.randomUUID();
    envioPendiente = {port,requestId,visitId:visit.id,resolve,
      timer:setTimeout(() => cerrarEnvioPendiente({status:'reintentar'}),25000)};
    try { port.postMessage({type:'sincronizar-visita',requestId,accountId,visit}); }
    catch (_) { cerrarEnvioPendiente({status:'reintentar'}); }
  });
}

async function procesarColaCampo(reconectar = false) {
  if (navigator.onLine === false || enviandoCola) { mostrarEnvioCampo(); return; }
  const port = activePort;
  const accountId = cuentaMarco;
  if (!port || !accountId) {
    if (cuentaCola && colaCampo.some(item => item.estado === 'pendiente') &&
        (!frameRequested || (reconectar && !port && marcoSoloParaEnvio && currentView === 'saved'))) {
      abrirMarcoRutas(true);
      if (currentView === 'saved') ui('live-button').textContent = 'Volver a Rutas';
    }
    mostrarEnvioCampo();
    return;
  }
  enviandoCola = true;
  cuentaParaReintentar = '';
  mostrarEnvioCampo();
  try {
    const registros = await window.visitasCampo.listar(accountId);
    const pendientes = registros.filter(item => item.estado === 'pendiente');
    for (const item of pendientes) {
      if (port !== activePort || accountId !== cuentaMarco || navigator.onLine === false) break;
      const resultado = await enviarVisitaCampo(port,accountId,item.visita);
      if (port !== activePort || accountId !== cuentaMarco) break;
      if (resultado.status === 'sincronizada' || resultado.status === 'por_revisar') {
        await window.visitasCampo.confirmar(accountId,item.visita.id,resultado.status,resultado.message || '');
        if (accountId === cuentaCola) mensajeCampo = resultado.status === 'sincronizada' ? 'Visita sincronizada.' : 'Hay una visita por revisar.';
        notificarColaCampo();
      } else {
        if (resultado.status !== 'autenticacion') cuentaParaReintentar = accountId;
        if (accountId === cuentaCola) mensajeCampo = resultado.status === 'autenticacion' ?
          'Vuelve a iniciar sesión con la misma cuenta para sincronizar.' : 'La visita sigue pendiente. Rutas volverá a intentar el envío.';
        break;
      }
    }
  } catch (_) {
    cuentaParaReintentar = accountId;
    if (accountId === cuentaCola) mensajeCampo = 'La visita sigue pendiente. Intenta sincronizar de nuevo.';
  } finally {
    enviandoCola = false;
    if (cuentaCola === accountId) actualizarColaCampo(false);
    mostrarEnvioCampo();
    if (cuentaMarco && cuentaMarco !== accountId) procesarColaCampo();
  }
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
      if (previous && (snapshot.seller !== previous.seller ||
          (previous.accountId && snapshot.accountId !== previous.accountId))) {
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
        actualizarColaCampo();
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
  cuentaMarco = '';
  cerrarEnvioPendiente({status:'reintentar'});
  const target = vault?.record.session;
  if (vault) vault = {...vault, snapshot:null};
  port.postMessage({type:'lock'});
  refreshSavedView();
  refreshNotice();
  actualizarColaCampo(false);
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
  cerrarEnvioPendiente({status:'reintentar'});
  cuentaMarco = '';
  const port = channel.port1;
  activePort = port;
  port.onmessage = event => {
    const incoming = event.data;
    if (activePort !== port || !incoming) return;
    if (incoming.type === 'lock') {
      lockSnapshot(port);
    } else if (incoming.type === 'snapshot' && typeof incoming.id === 'string' && incoming.id.length <= 120) {
      onSnapshot(port, incoming);
    } else if (incoming.type === 'sesion-visitas' && CUENTA_VISITAS.test(incoming.accountId || '')) {
      if (cuentaMarco !== incoming.accountId) cerrarEnvioPendiente({status:'reintentar'});
      cuentaMarco = incoming.accountId;
      procesarColaCampo();
    } else if (incoming.type === 'resultado-visita' && envioPendiente?.port === port &&
        incoming.requestId === envioPendiente.requestId && incoming.visitId === envioPendiente.visitId &&
        ['sincronizada','por_revisar','autenticacion','reintentar'].includes(incoming.status)) {
      cerrarEnvioPendiente({status:incoming.status,message:typeof incoming.message === 'string' ? incoming.message.slice(0,350) : ''});
    }
  };
  event.source.postMessage({type:'maxica:rutas-connect', version:PROTOCOL_VERSION}, event.origin, [channel.port2]);
  refreshSavedView();
  refreshNotice();
  requestSnapshot(port);
});

let viewChosen = false;
ui('live-button').addEventListener('click', () => { viewChosen = true; showLive(); });
ui('saved-button').addEventListener('click', () => { viewChosen = true; setView('saved'); });
ui('boton-visita').addEventListener('click', abrirCapturaCampo);
ui('campo-tipo').addEventListener('change', ajustarCamposVisita);
ui('campo-cancelar').addEventListener('click', () => ui('dialog-campo').close());
ui('dialog-campo').addEventListener('cancel', evento => { if (guardandoCampo) evento.preventDefault(); });
ui('dialog-campo').addEventListener('close', () => { contextoVisita = null; intentoVisita = null; });
ui('form-campo').addEventListener('submit', guardarCapturaCampo);
ui('boton-sincronizar').addEventListener('click', () => { mensajeCampo = ''; procesarColaCampo(true); });
window.addEventListener('offline', () => {
  if (!activePort || currentView !== 'live') setView('saved');
  refreshNotice();
  mostrarEnvioCampo();
});
window.addEventListener('online', () => { mensajeCampo = ''; refreshNotice(); procesarColaCampo(true); });
setInterval(() => {
  if (!document.hidden && (cuentaParaReintentar || colaCampo.some(item => item.estado === 'pendiente'))) procesarColaCampo(true);
}, 30000);
window.addEventListener('storage', async event => {
  if (event.key === COLA_CHANGED) { actualizarColaCampo(); return; }
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
      cuentaMarco = '';
      cerrarEnvioPendiente({status:'reintentar'});
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
      actualizarColaCampo(false);
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
