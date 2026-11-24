'use strict';

/**
 * Base SQLite local del proceso principal sobre sql.js (WASM embebido).
 *
 * Electron 33 no expone node:sqlite, así que el motor es sql.js en memoria y la
 * durabilidad se logra exportando a disco de forma atómica. Un único escritor:
 * el renderer (IPC) y el hub LAN (adaptador síncrono) comparten la misma cola y
 * solo el dueño de la transacción abierta puede escribir hasta COMMIT/ROLLBACK.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SQL_LENGTH = 200000;
const MAX_PARAMS = 1000;
const MAX_PARAM_STRING = 100000;
const MAX_PARAM_B64 = Math.ceil((MAX_PARAM_STRING / 3) * 4) + 16;
const MAX_ERROR_LENGTH = 200;
const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
const SOURCES = new Set(['renderer', 'hub']);
const OPERATIONS = new Set(['exec', 'run', 'all', 'status']);

let sqlModulePromise = null;

function loadSql() {
  if (!sqlModulePromise) {
    const initSqlJs = require('sql.js/dist/sql-wasm-inline.js');
    sqlModulePromise = Promise.resolve(initSqlJs()).catch((error) => {
      sqlModulePromise = null;
      throw error;
    });
  }
  return sqlModulePromise;
}

class DbRequestError extends Error {}

function shortError(error) {
  const raw = error instanceof Error ? error.message : String(error === undefined ? '' : error);
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_ERROR_LENGTH) : 'error desconocido';
}

function failure(error) {
  return { ok: false, error: shortError(error) };
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * fsync del directorio tras el rename: en Windows no siempre se puede abrir un
 * directorio como archivo, así que es best-effort y nunca invalida el guardado.
 */
function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Windows/volúmenes sin soporte: el rename ya es atómico en el mismo volumen.
  }
}

/**
 * Escritura atómica de una imagen completa: temporal + fsync + rename. Si algo
 * falla, el archivo anterior queda intacto y el temporal se elimina.
 */
function writeFileAtomic(target, bytes) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.restore-${process.pid}-${Date.now()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    fsyncDir(dir);
  } catch (error) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      // ya cerrado
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // sin temporal pendiente
    }
    throw error;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeTransaction(sql) {
  const trimmed = sql.trim().replace(/;+$/, '').trim();
  if (!trimmed) return null;
  const head = /^(BEGIN|COMMIT|END|ROLLBACK)\b/i.exec(trimmed);
  if (!head) {
    // Una sentencia de control detrás de un punto y coma rompería el marcado del dueño.
    if (/;\s*(BEGIN|COMMIT|END|ROLLBACK)\b/i.test(trimmed)) {
      throw new DbRequestError('El control de transacción debe enviarse en una sola sentencia.');
    }
    return null;
  }
  if (trimmed.includes(';')) {
    throw new DbRequestError('El control de transacción debe enviarse en una sola sentencia.');
  }
  const keyword = head[1].toLowerCase();
  if (keyword === 'begin') return 'begin';
  if (keyword === 'rollback') return 'rollback';
  return 'commit';
}

function normalizeParam(value) {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value.length > MAX_PARAM_STRING) throw new DbRequestError('Un parámetro de texto es demasiado largo.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DbRequestError('Parámetro numérico inválido.');
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (isPlainObject(value) && typeof value.b64 === 'string') {
    if (value.b64.length > MAX_PARAM_B64) throw new DbRequestError('Un parámetro binario es demasiado grande.');
    return new Uint8Array(Buffer.from(value.b64, 'base64'));
  }
  throw new DbRequestError('Tipo de parámetro no permitido.');
}

function validateRequest(request) {
  if (!isPlainObject(request)) throw new DbRequestError('Solicitud inválida.');
  const op = request.op;
  if (typeof op !== 'string' || !OPERATIONS.has(op)) {
    throw new DbRequestError('Operación no permitida.');
  }
  if (op === 'status') return { op };
  const sql = request.sql;
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new DbRequestError('La consulta SQL está vacía.');
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw new DbRequestError('La consulta SQL supera el límite de 200000 caracteres.');
  }
  const rawParams = request.params === undefined || request.params === null ? [] : request.params;
  if (!Array.isArray(rawParams)) throw new DbRequestError('Los parámetros deben ser una lista.');
  if (rawParams.length > MAX_PARAMS) throw new DbRequestError('Demasiados parámetros en la consulta.');
  return { op, sql, params: rawParams.map(normalizeParam) };
}

function plainValue(value) {
  if (value instanceof Uint8Array) return { b64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value.toString();
  }
  if (value === undefined) return null;
  return value;
}

function plainRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = plainValue(value);
  return out;
}

function fromBridgeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      isPlainObject(value) && typeof value.b64 === 'string'
        ? new Uint8Array(Buffer.from(value.b64, 'base64'))
        : value;
  }
  return out;
}

function createDbMain(options) {
  const opts = options || {};
  const filePath =
    typeof opts.filePath === 'string' && opts.filePath
      ? opts.filePath
      : path.join(process.cwd(), 'palmyra.db');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const configuredMax = Number(opts.maxBinaryBytes);
  const maxBinaryBytes =
    Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : MAX_BINARY_BYTES;
  const maxBase64Length = Math.ceil(maxBinaryBytes / 3) * 4 + 4;
  // El hub LAN puede estar sirviendo equipos: restaurar bajo sus pies dejaría
  // lecturas a medias, así que main inyecta aquí su estado real.
  const isHubBusy = typeof opts.isHubBusy === 'function' ? opts.isHubBusy : () => false;

  const state = {
    db: null,
    ready: false,
    lastError: '',
    lastWriteAt: 0,
    schemaVersion: 0
  };

  let initPromise = null;
  let txOwner = null;
  let dirty = false;
  let queueRunning = false;
  const jobs = [];
  const freeWaiters = [];

  function pragma(db, sql) {
    try {
      db.exec(sql);
    } catch (error) {
      log(`db: PRAGMA omitido (${sql}): ${shortError(error)}`);
    }
  }

  /** Misma secuencia de PRAGMA para una base recién abierta o restaurada. */
  function configureDb(db) {
    // sql.js ignora WAL, pero la misma secuencia viaja al almacén del hub.
    pragma(db, 'PRAGMA journal_mode = WAL');
    pragma(db, 'PRAGMA synchronous = NORMAL');
    pragma(db, 'PRAGMA busy_timeout = 5000');
    pragma(db, 'PRAGMA foreign_keys = OFF');
  }

  function isMemoryFile() {
    return /^:memory:/i.test(filePath);
  }

  function readUserVersion(db) {
    try {
      const result = db.exec('PRAGMA user_version');
      const first = result && result[0] && result[0].values && result[0].values[0];
      const version = Number(first ? first[0] : 0);
      return Number.isFinite(version) ? version : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Último `seq` del journal local, leído de la propia imagen para que el
   * respaldo binario se pueda comparar con el estado restaurado. Es best-effort:
   * una base ajena al contrato local no tiene `_meta`/`_changes` y devuelve 0.
   */
  function readLatestSeq(db) {
    let metaSeq = 0;
    let journalSeq = 0;
    try {
      const result = db.exec("SELECT value FROM _meta WHERE key = 'seq'");
      const first = result && result[0] && result[0].values && result[0].values[0];
      const parsed = Number(first ? first[0] : 0);
      if (Number.isFinite(parsed) && parsed > 0) metaSeq = parsed;
    } catch {
      // Imagen sin _meta: no se puede leer la secuencia declarada.
    }
    try {
      const result = db.exec('SELECT COALESCE(MAX(seq), 0) FROM _changes');
      const first = result && result[0] && result[0].values && result[0].values[0];
      const parsed = Number(first ? first[0] : 0);
      if (Number.isFinite(parsed) && parsed > 0) journalSeq = parsed;
    } catch {
      // Imagen sin journal: la secuencia real es la de _meta (o 0).
    }
    return Math.max(metaSeq, journalSeq);
  }

  async function openDatabase() {
    const SQL = await loadSql();
    let bytes = null;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const db = bytes && bytes.length > 0 ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
    state.db = db;

    configureDb(db);

    state.schemaVersion = readUserVersion(db);
    if (state.schemaVersion === 0) {
      pragma(db, 'PRAGMA user_version = 1');
      state.schemaVersion = readUserVersion(db);
      dirty = true;
    }
    if (!bytes || bytes.length === 0) dirty = true;

    state.ready = true;
    state.lastError = '';
    persist(false);
  }

  function init() {
    if (!initPromise) {
      initPromise = openDatabase().catch((error) => {
        state.ready = false;
        state.lastError = `No se pudo abrir la base local: ${shortError(error)}`;
        log(state.lastError);
        throw error;
      });
    }
    return initPromise;
  }

  function persist(force) {
    const db = state.db;
    if (!db) return false;
    // Exportar a mitad de transacción guardaría datos que aún pueden revertirse.
    if (txOwner) return false;
    if (!force && !dirty) return false;
    try {
      const data = db.export();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, filePath);
      dirty = false;
      state.lastWriteAt = Date.now();
      return true;
    } catch (error) {
      state.lastError = `No se pudo guardar la base local: ${shortError(error)}`;
      log(state.lastError);
      return false;
    }
  }

  function flush() {
    if (!state.db) return false;
    if (txOwner) {
      log('db: flush omitido mientras hay una transacción abierta.');
      return false;
    }
    return persist(true);
  }

  // ─── Imagen binaria (respaldo/restauración del archivo SQLite completo) ────

  /**
   * Decodifica y valida el tamaño ANTES de reservar memoria. La longitud base64
   * declara los bytes exactos: si el decodificado no coincide, el formato miente
   * (Buffer.from es tolerante y descarta caracteres inválidos).
   */
  function decodeSnapshotBase64(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new DbRequestError('La imagen binaria está vacía.');
    }
    if (value.length > maxBase64Length) {
      throw new DbRequestError('La imagen binaria supera el tamaño máximo permitido.');
    }
    if (value.length % 4 !== 0) {
      throw new DbRequestError('La imagen binaria no tiene un formato válido.');
    }
    let padding = 0;
    if (value.endsWith('==')) padding = 2;
    else if (value.endsWith('=')) padding = 1;
    const estimated = (value.length / 4) * 3 - padding;
    if (estimated <= 0 || estimated > maxBinaryBytes) {
      throw new DbRequestError('La imagen binaria supera el tamaño máximo permitido.');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== estimated) {
      throw new DbRequestError('La imagen binaria no tiene un formato válido.');
    }
    return bytes;
  }

  function exportSnapshot() {
    if (!state.db || !state.ready) {
      return { ok: false, unavailable: true, error: 'La base local no está disponible.' };
    }
    if (txOwner) {
      return {
        ok: false,
        busy: true,
        error: 'Hay una transacción abierta; cierra la operación en curso antes de exportar la imagen.'
      };
    }
    try {
      const bytes = Buffer.from(state.db.export());
      if (bytes.length === 0) {
        return { ok: false, error: 'La base local exportó una imagen vacía.' };
      }
      if (bytes.length > maxBinaryBytes) {
        return { ok: false, error: 'La base local supera el tamaño máximo permitido para la imagen binaria.' };
      }
      return {
        ok: true,
        bytesBase64: bytes.toString('base64'),
        size: bytes.length,
        sha256: sha256Hex(bytes),
        latestSeq: readLatestSeq(state.db)
      };
    } catch (error) {
      log(`db: no se pudo exportar la imagen binaria: ${shortError(error)}`);
      return { ok: false, error: 'No se pudo exportar la imagen binaria de la base local.' };
    }
  }

  /** `db.export()` entrega la imagen viva del MEMFS de sql.js (equivalente a VACUUM INTO). */
  function snapshotBinary() {
    if (!state.db || !state.ready) {
      return init().then(
        () => exportSnapshot(),
        () => ({ ok: false, unavailable: true, error: 'La base local no está disponible.' })
      );
    }
    return Promise.resolve(exportSnapshot());
  }

  /**
   * Restaura una imagen completa. Orden: validar forma/tamaño/hash → comprobar
   * que no haya hub ni transacción → abrir la imagen en memoria → escribir el
   * archivo real de forma atómica → reemplazar el motor y avisar reinicio.
   * Las rutas reales nunca salen en la respuesta.
   */
  function restoreBinary(request) {
    let bytes;
    try {
      if (!isPlainObject(request)) throw new DbRequestError('Solicitud de restauración inválida.');
      const expectedSha256 = request.expectedSha256;
      if (typeof expectedSha256 !== 'string' || !SHA256_HEX.test(expectedSha256)) {
        throw new DbRequestError('El hash SHA-256 del respaldo no tiene un formato válido.');
      }
      bytes = decodeSnapshotBase64(request.bytesBase64);
      if (!bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        throw new DbRequestError('El archivo no es una imagen SQLite válida.');
      }
      if (sha256Hex(bytes) !== expectedSha256) {
        throw new DbRequestError('El hash no coincide: el archivo cambió o está dañado.');
      }
    } catch (error) {
      return Promise.resolve(failure(error));
    }

    if (isHubBusy()) {
      return Promise.resolve({
        ok: false,
        busy: true,
        error: 'El hub LAN está atendiendo equipos; detén la red local antes de restaurar.'
      });
    }

    return loadSql().then(
      (SQL) =>
        schedule('renderer', () => {
          if (txOwner) {
            return {
              ok: false,
              busy: true,
              error: 'Hay una transacción abierta; no se puede restaurar la imagen en este momento.'
            };
          }
          let next = null;
          try {
            next = new SQL.Database(new Uint8Array(bytes));
            readUserVersion(next);
          } catch {
            try {
              if (next) next.close();
            } catch {
              // ya descartada
            }
            return { ok: false, error: 'La imagen no pudo abrirse como base SQLite.' };
          }
          try {
            if (!isMemoryFile()) writeFileAtomic(filePath, bytes);
          } catch (error) {
            try {
              next.close();
            } catch {
              // ya descartada
            }
            log(`db: no se pudo escribir la imagen restaurada: ${shortError(error)}`);
            return { ok: false, error: 'No se pudo escribir la base restaurada en el disco del equipo.' };
          }

          const previous = state.db;
          state.db = next;
          state.ready = true;
          state.lastError = '';
          state.lastWriteAt = Date.now();
          configureDb(next);
          state.schemaVersion = readUserVersion(next);
          let bumpedVersion = false;
          if (state.schemaVersion === 0) {
            pragma(next, 'PRAGMA user_version = 1');
            state.schemaVersion = readUserVersion(next);
            bumpedVersion = state.schemaVersion === 1;
          }
          const latestSeq = readLatestSeq(next);
          txOwner = null;
          dirty = false;
          // Si la apertura inicial falló, el motor restaurado ya es válido.
          initPromise = Promise.resolve();
          if (previous && previous !== next) {
            try {
              previous.close();
            } catch {
              // la instancia anterior queda para el recolector
            }
          }
          // El archivo se escribió con los bytes originales; si hubo que fijar
          // user_version en memoria, se reexporta para que disco y motor
          // coincidan y el siguiente arranque vea el mismo esquema.
          if (bumpedVersion && !isMemoryFile()) persist(true);
          resolveFreeWaiters();
          log('db: base local reemplazada desde imagen binaria; reinicio requerido.');
          return {
            ok: true,
            restartRequired: true,
            size: bytes.length,
            sha256: sha256Hex(bytes),
            latestSeq
          };
        }),
      (error) => {
        log(`db: motor SQLite no disponible para restaurar: ${shortError(error)}`);
        return { ok: false, error: 'El motor SQLite no está disponible para restaurar la imagen.' };
      }
    );
  }

  function status() {
    let sizeBytes = 0;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) sizeBytes = stat.size;
    } catch {
      sizeBytes = 0;
    }
    if (state.db) state.schemaVersion = readUserVersion(state.db);
    return {
      ready: state.ready && Boolean(state.db),
      driver: state.db ? 'sqljs' : 'unavailable',
      filePath,
      sizeBytes,
      schemaVersion: state.schemaVersion,
      lastWriteAt: state.lastWriteAt,
      lastError: state.lastError
    };
  }

  function requireDb() {
    if (!state.db || !state.ready) {
      throw new DbRequestError('La base local no está lista.');
    }
    return state.db;
  }

  function assertWriter(source) {
    if (txOwner && txOwner !== source) {
      throw new DbRequestError('La base está ocupada por una transacción abierta.');
    }
  }

  function execRequest(source, sql) {
    const db = requireDb();
    const control = describeTransaction(sql);
    if (control === 'begin') {
      if (txOwner) throw new DbRequestError('La base ya tiene una transacción abierta.');
      db.exec(sql);
      txOwner = source;
      return { ok: true, changes: db.getRowsModified() };
    }
    if (control === 'commit' || control === 'rollback') {
      assertWriter(source);
      db.exec(sql);
      const wasOwner = txOwner === source;
      txOwner = null;
      if (wasOwner && control === 'commit') persist(false);
      return { ok: true, changes: db.getRowsModified() };
    }
    assertWriter(source);
    db.exec(sql);
    dirty = true;
    if (!txOwner) persist(false);
    return { ok: true, changes: db.getRowsModified() };
  }

  function runRequest(source, sql, params) {
    assertWriter(source);
    const db = requireDb();
    const statement = db.prepare(sql);
    try {
      if (params.length > 0) statement.bind(params);
      statement.step();
    } finally {
      statement.free();
    }
    const changes = db.getRowsModified();
    dirty = true;
    if (!txOwner) persist(false);
    return { ok: true, changes };
  }

  function allRequest(source, sql, params) {
    assertWriter(source);
    const db = requireDb();
    const statement = db.prepare(sql);
    const rows = [];
    try {
      if (params.length > 0) statement.bind(params);
      while (statement.step()) rows.push(plainRow(statement.getAsObject()));
    } finally {
      statement.free();
    }
    return { ok: true, rows };
  }

  function execute(source, request) {
    try {
      if (request.op === 'status') return { ok: true, status: status() };
      if (request.op === 'exec') return execRequest(source, request.sql);
      if (request.op === 'run') return runRequest(source, request.sql, request.params);
      return allRequest(source, request.sql, request.params);
    } catch (error) {
      if (error instanceof DbRequestError) throw error;
      // El error del motor viene en inglés: se antepone un mensaje en español.
      throw new DbRequestError(`No se pudo completar la operación SQL: ${shortError(error)}`);
    }
  }

  function canRun(source) {
    return txOwner === null || txOwner === source;
  }

  function resolveFreeWaiters() {
    for (let index = freeWaiters.length - 1; index >= 0; index -= 1) {
      if (canRun(freeWaiters[index].source)) freeWaiters.splice(index, 1)[0].resolve();
    }
  }

  function pump() {
    resolveFreeWaiters();
    if (queueRunning || jobs.length === 0) return;
    const index = jobs.findIndex((job) => canRun(job.source));
    if (index === -1) return;
    const job = jobs.splice(index, 1)[0];
    queueRunning = true;
    let outcome;
    try {
      outcome = Promise.resolve(job.task());
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (value) => {
        queueRunning = false;
        job.resolve(value);
        pump();
      },
      (error) => {
        queueRunning = false;
        job.reject(error);
        pump();
      }
    );
  }

  function schedule(source, task) {
    return new Promise((resolve, reject) => {
      jobs.push({ source, task, resolve, reject });
      pump();
    });
  }

  function invoke(source, request) {
    try {
      if (typeof source !== 'string' || !SOURCES.has(source)) {
        return Promise.resolve({ ok: false, error: 'Origen no autorizado.' });
      }
      const normalized = validateRequest(request);
      if (normalized.op === 'status') return Promise.resolve({ ok: true, status: status() });
      return init().then(
        () =>
          schedule(source, () => {
            try {
              return execute(source, normalized);
            } catch (error) {
              return failure(error);
            }
          }),
        (error) => failure(error)
      );
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  }

  function runSync(source, request) {
    const normalized = validateRequest(request);
    if (!state.db || !state.ready) throw new DbRequestError('La base local no está lista.');
    if (!canRun(source)) throw new DbRequestError('La base está ocupada por una transacción abierta.');
    try {
      return execute(source, normalized);
    } catch (error) {
      state.lastError = shortError(error);
      throw error;
    }
  }

  /** El adaptador solo atiende al hub: espera a que ninguna transacción ajena siga abierta. */
  function whenFree() {
    if (canRun('hub')) return Promise.resolve();
    return new Promise((resolve) => {
      freeWaiters.push({ source: 'hub', resolve });
    });
  }

  function getAdapter() {
    return {
      exec(sql) {
        const result = runSync('hub', { op: 'exec', sql });
        if (!result.ok) throw new DbRequestError(result.error);
      },
      run(sql, params) {
        const result = runSync('hub', {
          op: 'run',
          sql,
          params: Array.from(params || [])
        });
        if (!result.ok) throw new DbRequestError(result.error);
        return { changes: result.changes };
      },
      all(sql, params) {
        const result = runSync('hub', {
          op: 'all',
          sql,
          params: Array.from(params || [])
        });
        if (!result.ok) throw new DbRequestError(result.error);
        return result.rows.map(fromBridgeRow);
      },
      close() {
        // La base es compartida con el renderer: cerrar el driver del hub no la cierra.
      },
      whenFree
    };
  }

  return {
    filePath,
    init,
    invoke,
    flush,
    status,
    getAdapter,
    snapshotBinary,
    restoreBinary
  };
}

module.exports = { createDbMain };
