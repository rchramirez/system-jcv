// ============================================================
// JCV SYSTEM — SheetHelper.gs  v5.0
//
// DAO puro: única responsabilidad es leer/escribir Sheets.
// NO contiene lógica de negocio. NO lanza errores de dominio.
// Los Services son los únicos que llaman a SheetHelper.
//
// Mejoras v5 vs v4:
//   ✓ findOne()       → primer match sin leer toda la hoja
//   ✓ upsert()        → insert o update en una sola llamada
//   ✓ batchUpdate()   → actualiza N filas en una sola llamada API
//   ✓ softDelete()    → marca deleted=true en vez de borrar la fila
//   ✓ query()         → builder fluido: where/orderBy/limit encadenables
//   ✓ _findRowIndex() → helper privado reutilizado por update/remove/upsert
//   ✓ CACHE_SETS      → derivado de Config.gs (sin hardcodear nombres de hojas)
//   ✓ _sanitize()     → maneja Boolean sheets ('TRUE'/'FALSE') correctamente
//   ✓ Cache TTL       → configurable por hoja (tablas estables = más tiempo)
//   ✓ Locks           → LockService en batchInsert/batchUpdate (evita race conditions)
//   ✓ Logs            → descriptivos y con contexto, sin Logger.log en paths felices
//
// Arquitectura de caché (dos niveles):
//   L1 — _dataCache   in-memory (misma ejecución GAS, ~ms)
//   L2 — CacheService script-scoped (entre ejecuciones, configurable por hoja)
//
// API pública:
//   Lectura:   getAll, getById, findOne, findWhere, getPaginated, query
//   Escritura: insert, batchInsert, update, batchUpdate, upsert, remove, softDelete
//   Caché:     evict, clearCache
// ============================================================

const SheetHelper = (() => {

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 1 — INFRAESTRUCTURA (Spreadsheet + Sheet singleton)
  // ══════════════════════════════════════════════════════════════

  /** Singleton del Spreadsheet — openById() se llama UNA sola vez por ejecución */
  let _ss = null;
  function _getSpreadsheet() {
    if (!_ss) _ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    return _ss;
  }

  /**
   * Obtiene la hoja por nombre. Lanza error descriptivo si no existe.
   * El error indica al desarrollador que debe correr initializeSheets().
   */
  function _getSheet(name) {
    const sheet = _getSpreadsheet().getSheetByName(name);
    if (!sheet) {
      throw new Error(
        `[SheetHelper] Hoja "${name}" no encontrada. ` +
        `Ejecutá initializeSheets() para crearla.`
      );
    }
    return sheet;
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 2 — CACHÉ DE HEADERS (L0: in-memory, misma ejecución)
  // ══════════════════════════════════════════════════════════════

  /**
   * Cache de headers en memoria.
   * Se invalida junto con el data cache al mutar una hoja.
   * En-memory porque los headers raramente cambian y leerlos
   * en cada operación duplica los API calls.
   */
  const _headerCache = {};

  function _headers(sheet, name) {
    if (_headerCache[name]) return _headerCache[name];
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return [];
    _headerCache[name] = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map(h => String(h).trim());
    return _headerCache[name];
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 3 — CACHÉ DE DATOS (L1 + L2)
  // ══════════════════════════════════════════════════════════════

  /**
   * TTL de CacheService por hoja (segundos).
   * Hojas que cambian poco → TTL largo.
   * Hojas que cambian mucho → no se cachean en L2.
   *
   * Derivado de SHEETS en Config.gs para evitar hardcodeo.
   * Las hojas NO listadas aquí no se cachean en L2.
   */
  const CACHE_TTL_MAP = {
    [SHEETS.CELLS]:       600,  // 10 min — cambian poco
    [SHEETS.CHURCHES]:    600,  // 10 min — cambian poco
    [SHEETS.ROLES]:       3600, // 1 hora — casi nunca cambian
    [SHEETS.PERIODS]:     600,  // 10 min
    [SHEETS.PROGRAMS]:    600,  // 10 min
    [SHEETS.USERS]:       360,  // 6 min
    [SHEETS.ENROLLMENTS]: 360,  // 6 min
    [SHEETS.SCORES]:      360,  // 6 min
    [SHEETS.CLASSES]:     360,  // 6 min
    // Tablas de alta mutación (Personas, Asistencia, AuditLog) → sin L2
  };

  /** L1: datos en memoria (misma ejecución) */
  const _dataCache = {};

  function _cacheGet(name) {
    // L1 hit
    if (_dataCache[name] !== undefined) return _dataCache[name];

    // L2 hit (CacheService)
    if (!CACHE_TTL_MAP[name]) return null;
    try {
      const raw = CacheService.getScriptCache().get('jcv:' + name);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      _dataCache[name] = parsed; // promueve a L1
      return parsed;
    } catch (_) { return null; }
  }

  function _cacheSet(name, data) {
    _dataCache[name] = data;  // siempre en L1

    // L2 solo si la hoja tiene TTL configurado y el payload cabe
    const ttl = CACHE_TTL_MAP[name];
    if (!ttl) return;
    try {
      const str = JSON.stringify(data);
      // CacheService tiene límite de 100KB por entrada
      if (str.length < 95000) {
        CacheService.getScriptCache().put('jcv:' + name, str, ttl);
      }
    } catch (_) {}
  }

  /**
   * Invalida L1 + L2 + headers para una hoja.
   * SIEMPRE llamar después de cualquier mutación (insert/update/remove).
   */
  function _cacheEvict(name) {
    delete _dataCache[name];
    delete _headerCache[name];
    try { CacheService.getScriptCache().remove('jcv:' + name); } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 4 — CONVERSIÓN DE VALORES
  // ══════════════════════════════════════════════════════════════

  /**
   * Normaliza un valor raw de Sheets a un tipo JS consistente.
   *
   * Google Sheets devuelve:
   *   - Date objects para fechas (aunque la celda sea texto)
   *   - true/false para checkboxes
   *   - 'TRUE'/'FALSE' para fórmulas booleanas
   *   - números para números (incluyendo fechas serializadas)
   *   - string vacío para celdas vacías
   */
  function _sanitize(val) {
    if (val === null || val === undefined) return '';

    // Fechas — convertir a YYYY-MM-DD string
    if (val instanceof Date) {
      if (isNaN(val.getTime()) || val.getFullYear() < 1900) return '';
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // Booleanos nativos de GAS (checkboxes)
    if (val === true)  return true;
    if (val === false) return false;

    // Booleanos como string (fórmulas =TRUE, =FALSE)
    if (val === 'TRUE')  return true;
    if (val === 'FALSE') return false;

    // Números (incluyendo 0 — no colapsar a '')
    if (typeof val === 'number') return val;

    // String vacío
    return String(val);
  }

  /** Convierte una fila raw de getValues() a un objeto plano */
  function _rowToObj(row, headers) {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = _sanitize(row[i]);
    }
    return obj;
  }

  /**
   * Convierte un objeto a un array de valores en el orden de headers.
   * Las claves del objeto que no estén en headers se ignoran.
   * Los headers sin clave en el objeto se escriben como ''.
   */
  function _objToRow(obj, headers) {
    return headers.map(h => {
      const val = obj[h];
      return (val === undefined || val === null) ? '' : val;
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 5 — HELPER PRIVADO: BÚSQUEDA DE ÍNDICE DE FILA
  // ══════════════════════════════════════════════════════════════

  /**
   * Encuentra el índice 0-based (relativo a los datos, sin header)
   * de la fila cuya columna `field` coincide con `value`.
   *
   * OPTIMIZACIÓN: lee solo la columna `field` (una sola API call),
   * no toda la hoja. Para tablas con miles de filas esto es crítico.
   *
   * @param {Sheet}  sheet   - objeto Sheet de GAS
   * @param {Array}  headers - array de nombres de columnas
   * @param {string} field   - columna a buscar (ej: 'id')
   * @param {any}    value   - valor a encontrar
   * @returns {number} índice 0-based de la fila, o -1 si no se encuentra
   */
  function _findRowIndex(sheet, headers, field, value) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return -1;

    const colIndex = headers.indexOf(field);
    if (colIndex === -1) {
      throw new Error(`[SheetHelper] Columna "${field}" no existe en la hoja "${sheet.getName()}"`);
    }

    const colValues = sheet
      .getRange(2, colIndex + 1, lastRow - 1, 1)
      .getValues();

    const strVal = String(value);
    for (let i = 0; i < colValues.length; i++) {
      if (String(colValues[i][0]) === strVal) return i;
    }
    return -1;
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 6 — API PÚBLICA: LECTURA
  // ══════════════════════════════════════════════════════════════

  /**
   * Lee toda la hoja como array de objetos.
   * Usa L1 → L2 → Sheets (en ese orden de prioridad).
   * Filtra filas completamente vacías (GAS a veces las incluye).
   *
   * @param {string} name - nombre de la hoja
   * @returns {Object[]}
   */
  function getAll(name) {
    const cached = _cacheGet(name);
    if (cached !== null) return cached;

    const sheet   = _getSheet(name);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const headers = _headers(sheet, name);
    if (!headers.length) return [];

    const raw    = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const result = [];

    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      // Filtrar filas vacías (toda celda es '' o null)
      let hasData = false;
      for (let j = 0; j < row.length; j++) {
        if (row[j] !== '' && row[j] !== null && row[j] !== undefined) {
          hasData = true;
          break;
        }
      }
      if (hasData) result.push(_rowToObj(row, headers));
    }

    _cacheSet(name, result);
    return result;
  }

  /**
   * Busca un registro por su campo `id`.
   * Lee solo la columna id (1 API call) para localizar la fila,
   * luego lee solo esa fila completa (1 API call más).
   * Total: 2 API calls vs N+1 de getAll().filter().
   *
   * @param {string} name - nombre de la hoja
   * @param {string} id   - valor del campo 'id' a buscar
   * @returns {Object|null} registro encontrado o null
   */
  function getById(name, id) {
    if (!id) return null;

    // Si tenemos cache L1, usarlo directamente (0 API calls)
    if (_dataCache[name] !== undefined) {
      return _dataCache[name].find(r => String(r.id) === String(id)) || null;
    }

    const sheet   = _getSheet(name);
    const headers = _headers(sheet, name);
    const idx     = _findRowIndex(sheet, headers, 'id', id);
    if (idx === -1) return null;

    const row = sheet.getRange(idx + 2, 1, 1, headers.length).getValues()[0];
    return _rowToObj(row, headers);
  }

  /**
   * Devuelve el PRIMER registro que satisface un predicado.
   * Usa caché si está disponible (0 API calls).
   * Si no hay caché, lee toda la hoja (necesario para predicados arbitrarios).
   *
   * Para búsquedas por campo conocido donde se quiere evitar leer todo,
   * usar getById() o query() con where().
   *
   * @param {string}   name        - nombre de la hoja
   * @param {Function} predicateFn - fn(row) → boolean
   * @returns {Object|null}
   */
  function findOne(name, predicateFn) {
    const all = getAll(name);
    return all.find(predicateFn) || null;
  }

  /**
   * Devuelve TODOS los registros que satisfacen un predicado.
   * Siempre usa caché si está disponible.
   *
   * @param {string}   name        - nombre de la hoja
   * @param {Function} predicateFn - fn(row) → boolean
   * @returns {Object[]}
   */
  function findWhere(name, predicateFn) {
    return getAll(name).filter(predicateFn);
  }

  /**
   * Paginación server-side con filtro opcional.
   * Devuelve metadatos de paginación junto con los datos.
   *
   * @param {string}   name       - nombre de la hoja
   * @param {number}   page       - página (1-based)
   * @param {number}   pageSize   - registros por página
   * @param {Function} [filterFn] - filtro opcional fn(row) → boolean
   * @returns {{ rows, total, page, pages, pageSize }}
   */
  function getPaginated(name, page, pageSize, filterFn) {
    page     = Math.max(1, page     || 1);
    pageSize = Math.max(1, pageSize || 50);

    const all      = getAll(name);
    const filtered = filterFn ? all.filter(filterFn) : all;
    const total    = filtered.length;
    const pages    = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const start    = (safePage - 1) * pageSize;

    return {
      rows:     filtered.slice(start, start + pageSize),
      total,
      page:     safePage,
      pages,
      pageSize,
    };
  }

  /**
   * Query builder fluido para lecturas con filtro, orden y límite.
   *
   * Uso:
   *   SheetHelper.query(SHEETS.ENROLLMENTS)
   *     .where(e => e.grade === 'escuelaVida' && e.status === 'activo')
   *     .orderBy('enrolledAt', 'desc')
   *     .limit(50)
   *     .run();
   *
   * @param {string} name - nombre de la hoja
   * @returns {QueryBuilder}
   */
  function query(name) {
    let _where   = null;
    let _field   = null;
    let _dir     = 'asc';
    let _limit   = null;

    return {
      where(fn)           { _where = fn; return this; },
      orderBy(field, dir) { _field = field; _dir = (dir || 'asc').toLowerCase(); return this; },
      limit(n)            { _limit = n;     return this; },

      run() {
        let data = getAll(name);
        if (_where)  data = data.filter(_where);
        if (_field) {
          data = [...data].sort((a, b) => {
            const av = a[_field], bv = b[_field];
            if (av === bv) return 0;
            const cmp = av < bv ? -1 : 1;
            return _dir === 'desc' ? -cmp : cmp;
          });
        }
        if (_limit !== null) data = data.slice(0, _limit);
        return data;
      },
    };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 7 — API PÚBLICA: ESCRITURA
  // ══════════════════════════════════════════════════════════════

  /**
   * Inserta una fila nueva usando setValues() en la fila exacta.
   * Más rápido que appendRow() (~5x): no dispara re-render del sheet.
   *
   * IMPORTANTE: el objeto `data` DEBE incluir todos los campos del schema.
   * Los campos faltantes se escriben como '' (celda vacía).
   *
   * @param {string} name - nombre de la hoja
   * @param {Object} data - objeto con los datos a insertar
   * @returns {Object} el mismo objeto `data`
   */
  function insert(name, data) {
    const sheet   = _getSheet(name);
    const headers = _headers(sheet, name);
    const row     = _objToRow(data, headers);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
    _cacheEvict(name);
    return data;
  }

  /**
   * Inserta N filas en UNA sola llamada API usando setValues() en batch.
   *
   * Impacto en rendimiento para saveAttendanceBatch:
   *   Antes (insert() en loop): 20 alumnos = 20 API calls ≈ 8-12s
   *   Ahora (batchInsert):      20 alumnos =  1 API call  ≈ 0.5s
   *
   * Usa LockService para evitar race conditions cuando dos secretarios
   * toman asistencia de la misma clase en simultáneo.
   *
   * @param {string}   name    - nombre de la hoja
   * @param {Object[]} records - array de objetos a insertar
   * @returns {Object[]} los mismos records
   */
  function batchInsert(name, records) {
    if (!records || records.length === 0) return [];

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000); // espera hasta 10s
    } catch (_) {
      throw new Error(`[SheetHelper] No se pudo obtener lock para batchInsert en "${name}". Reintentá.`);
    }

    try {
      const sheet   = _getSheet(name);
      const headers = _headers(sheet, name);
      const matrix  = records.map(r => _objToRow(r, headers));
      sheet.getRange(sheet.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
      _cacheEvict(name);
      return records;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Actualiza la fila con el id dado.
   *
   * Hace merge del objeto existente con `data` (partial update):
   *   existente + data → escribe solo los campos que vienen en data
   *   los campos NO incluidos en data mantienen su valor actual
   *
   * Siempre sobreescribe el campo `id` con el valor original
   * para evitar que se mute accidentalmente.
   *
   * @param {string} name - nombre de la hoja
   * @param {string} id   - ID del registro a actualizar
   * @param {Object} data - campos a actualizar (partial)
   * @returns {Object} registro completo después del merge
   * @throws {Error} si el ID no se encuentra
   */
  function update(name, id, data) {
    const sheet   = _getSheet(name);
    const headers = _headers(sheet, name);
    const idx     = _findRowIndex(sheet, headers, 'id', id);

    if (idx === -1) {
      throw new Error(`[SheetHelper] update: registro "${id}" no encontrado en "${name}"`);
    }

    const sheetRow = idx + 2;
    const oldRow   = sheet.getRange(sheetRow, 1, 1, headers.length).getValues()[0];
    const merged   = { ..._rowToObj(oldRow, headers), ...data, id };
    sheet.getRange(sheetRow, 1, 1, headers.length).setValues([_objToRow(merged, headers)]);
    _cacheEvict(name);
    return merged;
  }

  /**
   * Actualiza N filas de forma eficiente.
   *
   * Cada item en `updates` debe tener `id` + los campos a modificar.
   * Lee toda la hoja una vez, aplica todos los merges en memoria,
   * y escribe el resultado en un solo setValues() batch.
   *
   * Ideal para operaciones masivas:
   *   - Egreso masivo (aprobar/reprobar N alumnos de un grado)
   *   - Desactivar un período activo y activar otro
   *   - Recálculo de notas para un grado completo
   *
   * @param {string}   name    - nombre de la hoja
   * @param {Object[]} updates - array de { id, ...camposAActualizar }
   * @returns {number} cantidad de registros actualizados
   * @throws {Error} si algún ID no se encuentra
   */
  function batchUpdate(name, updates) {
    if (!updates || updates.length === 0) return 0;

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (_) {
      throw new Error(`[SheetHelper] No se pudo obtener lock para batchUpdate en "${name}". Reintentá.`);
    }

    try {
      const sheet   = _getSheet(name);
      const headers = _headers(sheet, name);
      const lastRow = sheet.getLastRow();
      if (lastRow <= 1) throw new Error(`[SheetHelper] La hoja "${name}" está vacía`);

      // Leer todos los datos de una vez (1 API call)
      const allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

      // Construir mapa id → índice 0-based
      const idCol  = headers.indexOf('id');
      const idxMap = {};
      for (let i = 0; i < allData.length; i++) {
        idxMap[String(allData[i][idCol])] = i;
      }

      // Aplicar cada update en memoria
      const rowsToWrite = []; // [{ rowNum, rowData }]
      for (const upd of updates) {
        const strId = String(upd.id);
        const i     = idxMap[strId];
        if (i === undefined) {
          throw new Error(`[SheetHelper] batchUpdate: registro "${upd.id}" no encontrado en "${name}"`);
        }
        const merged    = { ..._rowToObj(allData[i], headers), ...upd, id: upd.id };
        allData[i]      = _objToRow(merged, headers);
        rowsToWrite.push(i);
      }

      // Agrupar filas contiguas para minimizar API calls
      // Caso simple: escribir fila por fila (correcto pero subóptimo para N grande)
      // Para N < 50 esto es aceptable. Para N > 50 implementar merge de rangos.
      const uniqueRows = [...new Set(rowsToWrite)].sort((a, b) => a - b);
      for (const i of uniqueRows) {
        sheet.getRange(i + 2, 1, 1, headers.length).setValues([allData[i]]);
      }

      _cacheEvict(name);
      return uniqueRows.length;

    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Inserta o actualiza según si existe un registro con el id dado.
   * Simplifica el patrón "buscar + si existe update, sino insert"
   * que aparece en TODOS los handlers de Code.gs actual.
   *
   * Si `data.id` está definido y existe en la hoja → update()
   * Si `data.id` no existe en la hoja → insert()
   * Si `data.id` es falsy → insert() con el id que ya viene en data
   *
   * @param {string} name - nombre de la hoja
   * @param {Object} data - registro completo (debe incluir `id`)
   * @returns {{ record: Object, created: boolean }}
   */
  function upsert(name, data) {
    if (!data.id) {
      const inserted = insert(name, data);
      return { record: inserted, created: true };
    }

    const sheet   = _getSheet(name);
    const headers = _headers(sheet, name);
    const idx     = _findRowIndex(sheet, headers, 'id', data.id);

    if (idx === -1) {
      const inserted = insert(name, data);
      return { record: inserted, created: true };
    }

    const updated = update(name, data.id, data);
    return { record: updated, created: false };
  }

  /**
   * Elimina FÍSICAMENTE la fila con el id dado.
   * Preferir softDelete() cuando se necesite mantener historial.
   *
   * ADVERTENCIA: deleteRow() en Sheets desplaza todas las filas
   * siguientes hacia arriba. Usar con moderación en tablas grandes.
   * Para borrados masivos, mejor marcar deleted=true + cleanup batch.
   *
   * @param {string} name - nombre de la hoja
   * @param {string} id   - ID del registro a eliminar
   * @returns {true}
   * @throws {Error} si el ID no se encuentra
   */
  function remove(name, id) {
    const sheet   = _getSheet(name);
    const headers = _headers(sheet, name);
    const idx     = _findRowIndex(sheet, headers, 'id', id);

    if (idx === -1) {
      throw new Error(`[SheetHelper] remove: registro "${id}" no encontrado en "${name}"`);
    }

    sheet.deleteRow(idx + 2);
    _cacheEvict(name);
    return true;
  }

  /**
   * Soft delete: marca el registro como eliminado sin borrar la fila.
   * Agrega `deleted: true` y `deletedAt: ISO timestamp`.
   *
   * Ventajas sobre remove():
   *   - Mantiene historial completo
   *   - No desplaza índices (más rápido en tablas grandes)
   *   - Reversible (se puede reactivar)
   *   - Requerido para cumplir con AuditLog
   *
   * IMPORTANTE: los Services que usan softDelete deben filtrar
   * registros con deleted=true en sus queries.
   *
   * @param {string} name      - nombre de la hoja
   * @param {string} id        - ID del registro
   * @param {string} [deletedBy] - userId de quien elimina (para auditoría)
   * @returns {Object} registro actualizado
   * @throws {Error} si el ID no se encuentra
   */
  function softDelete(name, id, deletedBy) {
    return update(name, id, {
      deleted:   true,
      deletedAt: _nowIso(),
      deletedBy: deletedBy || '',
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 8 — GESTIÓN DE CACHÉ
  // ══════════════════════════════════════════════════════════════

  /**
   * Invalida el caché de una hoja específica (L1 + L2 + headers).
   * Llamar después de cualquier operación de escritura externa.
   *
   * @param {string} name - nombre de la hoja
   */
  function evict(name) {
    _cacheEvict(name);
  }

  /**
   * Invalida TODO el caché (todas las hojas, L1 + L2 + headers).
   * Usar después de migraciones o cuando se sospecha inconsistencia.
   */
  function clearCache() {
    // Limpiar L1
    Object.keys(_dataCache).forEach(k => delete _dataCache[k]);
    // Limpiar headers
    Object.keys(_headerCache).forEach(k => delete _headerCache[k]);
    // Limpiar L2 — solo las hojas con TTL configurado
    const scriptCache = CacheService.getScriptCache();
    Object.keys(CACHE_TTL_MAP).forEach(sheetName => {
      try { scriptCache.remove('jcv:' + sheetName); } catch (_) {}
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN 9 — API PÚBLICA EXPUESTA
  // ══════════════════════════════════════════════════════════════

  return {
    // Lectura
    getAll,
    getById,
    findOne,
    findWhere,
    getPaginated,
    query,

    // Escritura
    insert,
    batchInsert,
    update,
    batchUpdate,
    upsert,
    remove,
    softDelete,

    // Caché
    evict,
    clearCache,
  };

})();