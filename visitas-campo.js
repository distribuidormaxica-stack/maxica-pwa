(function () {
  'use strict';

  const BASE = 'maxica-rutas-visitas-v1';
  const CLAVES = 'claves';
  const VISITAS = 'visitas';
  const POR_CUENTA = 'cuenta';
  const RECIBOS_RECIENTES = 50;
  const CUENTA = /^[a-f0-9]{64}$/;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const ESTADOS = new Set(['pendiente', 'sincronizada', 'por_revisar']);
  const codificador = new TextEncoder();
  const decodificador = new TextDecoder();
  let baseAbierta;
  let claveAbierta;

  function abrir() {
    if (!baseAbierta) {
      baseAbierta = new Promise((resolver, rechazar) => {
        const solicitud = indexedDB.open(BASE, 1);
        solicitud.onupgradeneeded = () => {
          const base = solicitud.result;
          base.createObjectStore(CLAVES);
          base.createObjectStore(VISITAS, {keyPath: 'id'}).createIndex(POR_CUENTA, 'cuenta');
        };
        solicitud.onerror = () => rechazar(solicitud.error);
        solicitud.onblocked = () => rechazar(new Error('El almacenamiento de visitas está ocupado.'));
        solicitud.onsuccess = () => {
          const base = solicitud.result;
          base.onversionchange = () => {
            base.close();
            baseAbierta = undefined;
            claveAbierta = undefined;
          };
          resolver(base);
        };
      }).catch(error => {
        baseAbierta = undefined;
        throw error;
      });
    }
    return baseAbierta;
  }

  async function transaccion(almacen, modo, operacion) {
    const base = await abrir();
    return new Promise((resolver, rechazar) => {
      const transaccion = base.transaction(almacen, modo);
      let resultado;
      transaccion.oncomplete = () => resolver(resultado);
      transaccion.onabort = () => rechazar(transaccion.error || new Error('El teléfono no pudo guardar las visitas.'));
      operacion(transaccion.objectStore(almacen), valor => { resultado = valor; });
    });
  }

  function claveCifrado() {
    if (!claveAbierta) {
      claveAbierta = (async () => {
        const existente = await transaccion(CLAVES, 'readonly', (almacen, devolver) => {
          const lectura = almacen.get('visitas');
          lectura.onsuccess = () => devolver(lectura.result);
        });
        if (existente) return existente;
        const nueva = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
        return transaccion(CLAVES, 'readwrite', (almacen, devolver) => {
          const lectura = almacen.get('visitas');
          lectura.onsuccess = () => {
            const clave = lectura.result || nueva;
            if (!lectura.result) almacen.add(clave, 'visitas');
            devolver(clave);
          };
        });
      })().catch(error => {
        claveAbierta = undefined;
        throw error;
      });
    }
    return claveAbierta;
  }

  function validarCuenta(cuenta) {
    if (typeof cuenta !== 'string' || !CUENTA.test(cuenta)) throw new Error('La ruta guardada no está vinculada a una cuenta.');
  }

  function validarId(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('El identificador de la visita no es válido.');
  }

  function prepararVisita(entrada) {
    const {
      id, capturadaEn, vendedor, cliente, tipoGestion, motivoNoCompra = '', nota = '',
      enRuta = true, lat = 0, lng = 0, productosFoco = [], competidor = '', precioCompetidor = ''
    } = entrada || {};
    validarId(id);
    const fecha = new Date(capturadaEn);
    if (typeof capturadaEn !== 'string' || !Number.isFinite(fecha.getTime()) || fecha.toISOString() !== capturadaEn) {
      throw new Error('La fecha de captura no es válida.');
    }
    if (![vendedor, cliente, tipoGestion].every(valor => typeof valor === 'string' && valor.trim()) ||
        ![motivoNoCompra, nota, competidor, precioCompetidor].every(valor => typeof valor === 'string') ||
        typeof enRuta !== 'boolean' || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180 || !Array.isArray(productosFoco)) {
      throw new Error('Revisa los datos de la visita antes de guardarla.');
    }
    const productos = productosFoco.map(fila => {
      const {producto, cantidad} = fila || {};
      if (typeof producto !== 'string' || !producto.trim() || !Number.isFinite(cantidad) || cantidad <= 0) {
        throw new Error('Revisa los productos de la visita.');
      }
      return {producto, cantidad};
    });
    return {id, capturadaEn, vendedor, cliente, tipoGestion, motivoNoCompra, nota, enRuta, lat, lng,
      productosFoco: productos, competidor, precioCompetidor};
  }

  function parametros(cuenta, id, iv) {
    return {name: 'AES-GCM', iv, additionalData: codificador.encode(JSON.stringify([cuenta, id]))};
  }

  async function cifrar(cuenta, registro, revision) {
    const id = registro.visita.id;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const datos = await crypto.subtle.encrypt(parametros(cuenta, id, iv), await claveCifrado(),
      codificador.encode(JSON.stringify(registro)));
    return {id, cuenta, iv, datos, revision};
  }

  async function descifrar(fila) {
    const datos = await crypto.subtle.decrypt(parametros(fila.cuenta, fila.id, fila.iv), await claveCifrado(), fila.datos);
    const registro = JSON.parse(decodificador.decode(datos));
    if (registro?.visita?.id !== fila.id || !ESTADOS.has(registro.estado) || typeof registro.mensaje !== 'string') {
      throw new Error('No se pudo comprobar una visita guardada en este teléfono.');
    }
    return registro;
  }

  function visible({visita, estado, mensaje}) {
    return {visita, estado, mensaje};
  }

  async function guardar(cuenta, entrada) {
    validarCuenta(cuenta);
    const visita = prepararVisita(entrada);
    const registro = {visita, estado: 'pendiente', mensaje: ''};
    const fila = await cifrar(cuenta, registro, 1);
    const existente = await transaccion(VISITAS, 'readwrite', (almacen, devolver) => {
      const lectura = almacen.get(fila.id);
      lectura.onsuccess = () => {
        if (!lectura.result) almacen.add(fila);
        devolver(lectura.result);
      };
    });
    if (!existente) return visible(registro);
    if (existente.cuenta === cuenta) {
      const anterior = await descifrar(existente);
      if (JSON.stringify(anterior.visita) === JSON.stringify(visita)) return visible(anterior);
    }
    throw new Error('Ya existe una visita con este identificador y otros datos.');
  }

  async function confirmar(cuenta, id, estado, mensaje = '') {
    validarCuenta(cuenta);
    validarId(id);
    if (!['sincronizada', 'por_revisar'].includes(estado) || typeof mensaje !== 'string') {
      throw new Error('La respuesta de sincronización no es válida.');
    }

    while (true) {
      const fila = await transaccion(VISITAS, 'readonly', (almacen, devolver) => {
        const lectura = almacen.get(id);
        lectura.onsuccess = () => devolver(lectura.result);
      });
      if (!fila || fila.cuenta !== cuenta) return null;
      const registro = await descifrar(fila);
      if (registro.estado === 'sincronizada' || registro.estado === estado) return visible(registro);
      const siguiente = {...registro, estado, mensaje};
      if (estado === 'sincronizada') siguiente.confirmadaEn = new Date().toISOString();
      const cifrada = await cifrar(cuenta, siguiente, fila.revision + 1);
      const guardada = await transaccion(VISITAS, 'readwrite', (almacen, devolver) => {
        const lectura = almacen.get(id);
        lectura.onsuccess = () => {
          const coincide = lectura.result?.cuenta === cuenta && lectura.result.revision === fila.revision;
          if (coincide) almacen.put(cifrada);
          devolver(coincide);
        };
      });
      if (guardada) return visible(siguiente);
    }
  }

  async function listar(cuenta) {
    validarCuenta(cuenta);
    const filas = await transaccion(VISITAS, 'readonly', (almacen, devolver) => {
      const lectura = almacen.index(POR_CUENTA).getAll(cuenta);
      lectura.onsuccess = () => devolver(lectura.result);
    });
    const visitas = await Promise.all(filas.map(async fila => ({fila, registro: await descifrar(fila)})));
    const recibos = visitas.filter(({registro}) => registro.estado === 'sincronizada');
    recibos.sort((a, b) => (b.registro.confirmadaEn || '').localeCompare(a.registro.confirmadaEn || ''));
    const antiguas = new Set(recibos.slice(RECIBOS_RECIENTES).map(({fila}) => fila));
    if (antiguas.size) {
      await transaccion(VISITAS, 'readwrite', almacen => {
        antiguas.forEach(fila => {
          const lectura = almacen.get(fila.id);
          lectura.onsuccess = () => {
            if (lectura.result?.cuenta === cuenta && lectura.result.revision === fila.revision) almacen.delete(fila.id);
          };
        });
      });
    }
    return visitas.filter(({fila}) => !antiguas.has(fila)).map(({registro}) => visible(registro))
      .sort((a, b) => a.visita.capturadaEn.localeCompare(b.visita.capturadaEn));
  }

  window.visitasCampo = Object.freeze({listar, guardar, confirmar});
})();
