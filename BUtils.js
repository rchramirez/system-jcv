// ============================================================
// JCV SYSTEM — Utils.gs
//
// Funciones puras y helpers compartidos.
// NO importa servicios. NO accede a Sheets directamente.
// Todos los archivos pueden importar desde aquí sin riesgo
// de dependencias circulares.
//
// Secciones:
//   1. Respuesta HTTP estándar   (_respond)
//   2. Generación de IDs         (_newId)
//   3. Validación                (_validate, _validateEnum)
//   4. Sanitización              (_sanitizeUser, _stripAudit)
//   5. Timestamps                (_now, _nowIso)
//   6. Cálculos académicos       (_calcAverage, _isComplete, _calcFinalScore)
//   7. Parsers                   (_parseMemberIds, _parseJson)
//   8. Audit helpers             (_buildAuditCreate, _buildAuditUpdate)
//   9. GViz query                (gvizQuery) — lectura masiva optimizada
// ============================================================

// ── 1. RESPUESTA ESTÁNDAR ────────────────────────────────────
/**
 * Envuelve cualquier función en un try/catch y devuelve
 * { ok: true, data } o { ok: false, error }.
 *
 * Uso en Controller:
 *   return _respond(() => PeopleService.getAll());
 *
 * @param {Function} fn - función a ejecutar
 * @returns {{ ok: boolean, data?: any, error?: string }}
 */
function _respond(fn) {
  try {
    const data = fn();
    return { ok: true, data };
  } catch (err) {
    Logger.log('[_respond] ' + err.message + '\n' + (err.stack || ''));
    return { ok: false, error: err.message };
  }
}

// ── 2. GENERACIÓN DE IDs ─────────────────────────────────────
/**
 * Genera un ID único con prefijo legible.
 * Combina timestamp base-36 + random base-36.
 * Colisión prácticamente imposible para volúmenes de Sheets.
 *
 * Ejemplos:
 *   _newId('p')   → 'plrz1k2ab8f3c'   (persona)
 *   _newId('enr') → 'enrlrz1k2bx9d'  (inscripción)
 *   _newId('al')  → 'allrz1k2bz1e'   (audit log)
 *
 * @param {string} prefix - prefijo corto (p, u, c, ch, enr, al…)
 * @returns {string}
 */
function _newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ── 3. VALIDACIÓN ────────────────────────────────────────────
/**
 * Valida que los campos requeridos existan y no sean vacíos.
 * Lanza Error descriptivo con el nombre del campo faltante.
 *
 * @param {Object}   data           - objeto a validar
 * @param {string[]} requiredFields - lista de claves requeridas
 * @throws {Error} si falta algún campo
 */
function _validate(data, requiredFields) {
  if (!data || typeof data !== 'object') {
    throw new Error('Se requiere un objeto de datos');
  }
  for (const f of requiredFields) {
    const val = data[f];
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error(`El campo "${f}" es requerido`);
    }
  }
}

/**
 * Valida que un valor sea miembro de una lista de valores válidos.
 *
 * @param {any}      value    - valor a validar
 * @param {any[]}    allowed  - array de valores permitidos
 * @param {string}   field    - nombre del campo (para mensaje de error)
 * @throws {Error}
 */
function _validateEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(
      `Valor inválido para "${field}": "${value}". ` +
      `Valores permitidos: ${allowed.join(', ')}`
    );
  }
}

/**
 * Valida que un ID exista y no sea vacío.
 *
 * @param {any}    id    - ID a validar
 * @param {string} field - nombre del campo
 * @throws {Error}
 */
function _validateId(id, field) {
  if (!id || String(id).trim() === '') {
    throw new Error(`Se requiere un ${field || 'id'} válido`);
  }
}

// ── 4. SANITIZACIÓN ──────────────────────────────────────────
/**
 * Elimina el campo password antes de enviar al frontend.
 * Nunca debe viajar el hash al cliente.
 *
 * @param {Object} user - objeto de usuario con password
 * @returns {Object} usuario sin password
 */
function _sanitizeUser(user) {
  if (!user) return user;
  const { password, ...safe } = user;
  return safe;
}

/**
 * Elimina los campos de auditoría de un objeto.
 * Útil para comparar datos sin ruido de metadatos.
 *
 * @param {Object} obj
 * @returns {Object}
 */
function _stripAudit(obj) {
  if (!obj) return obj;
  const AUDIT_KEYS = ['createdAt','createdBy','createdByName','updatedAt','updatedBy','updatedByName'];
  const result = { ...obj };
  AUDIT_KEYS.forEach(k => delete result[k]);
  return result;
}

// ── 5. TIMESTAMPS ────────────────────────────────────────────
/**
 * Retorna la fecha/hora actual como string ISO 8601.
 * Centralizado para facilitar mocking en tests futuros.
 *
 * @returns {string} e.g. '2025-04-05T14:30:00.000Z'
 */
function _nowIso() {
  return new Date().toISOString();
}

// ── 6. CÁLCULOS ACADÉMICOS ───────────────────────────────────
/**
 * Calcula el promedio de las notas de un registro de scores.
 * Ignora campos vacíos, null o NaN.
 *
 * @param {Object} scoreRow - objeto con SCORE_FIELDS como claves
 * @returns {number} promedio redondeado a 2 decimales, o 0 si no hay datos
 */
function _calcAverage(scoreRow) {
  if (!scoreRow) return 0;
  const vals = SCORE_FIELDS
    .map(f => parseFloat(scoreRow[f]))
    .filter(v => !isNaN(v));
  if (!vals.length) return 0;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 100) / 100;
}

/**
 * Determina si todos los campos de score tienen valor.
 * Un registro "completo" es el que tiene todas las notas cargadas.
 *
 * @param {Object} scoreRow
 * @returns {boolean}
 */
function _isComplete(scoreRow) {
  if (!scoreRow) return false;
  return SCORE_FIELDS.every(f => {
    const v = scoreRow[f];
    return v !== '' && v !== undefined && v !== null;
  });
}

/**
 * Calcula la nota de asistencia con sistema de descuento:
 *   BASE: 10
 *   − 1 por cada ausente injustificado
 *   − 1 por cada 3 tardes (floor)
 *   Justificados y Presentes no descuentan
 *   Resultado clampeado en [0, 10]
 *
 * @param {Object[]} attendanceRecords - registros de asistencia del alumno
 * @returns {number} nota entre 0 y 10
 */
function _calcAttendanceScore(attendanceRecords) {
  if (!Array.isArray(attendanceRecords) || !attendanceRecords.length) return 10;
  let ausentes = 0, tardes = 0;
  attendanceRecords.forEach(a => {
    if (a.type === 'Ausente')    ausentes++;
    else if (a.type === 'Tarde') tardes++;
  });
  const score = 10 - ausentes - Math.floor(tardes / 3);
  return Math.max(0, Math.min(10, score));
}

/**
 * Calcula el promedio de notas de cuestionarios entregados.
 *
 * @param {Object[]} questRecords - cuestionarios del alumno
 * @returns {number} promedio o 0 si no hay entregados
 */
function _calcQuestScore(questRecords) {
  if (!Array.isArray(questRecords) || !questRecords.length) return 0;
  const delivered = questRecords.filter(q => q.status === 'entregado');
  if (!delivered.length) return 0;
  const vals = delivered
    .map(q => parseFloat(q.score || q.nota))
    .filter(v => !isNaN(v));
  if (!vals.length) return 0;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 100) / 100;
}

// ── 7. PARSERS ───────────────────────────────────────────────
/**
 * Parsea memberIds desde una celda de Sheets (puede ser string JSON,
 * array ya parseado, o vacío) a un array de strings.
 * Robusto ante todos los edge cases que produce GAS.
 *
 * @param {any} raw - valor crudo de la celda
 * @returns {string[]}
 */
function _parseMemberIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  const str = String(raw).trim();
  if (!str || str === '[]') return [];
  try { return JSON.parse(str).filter(Boolean); } catch (_) { return []; }
}

/**
 * Parsea un string JSON de forma segura.
 * Devuelve el defaultValue si el string es inválido.
 *
 * @param {string} str          - JSON string a parsear
 * @param {any}    defaultValue - valor de retorno en caso de error
 * @returns {any}
 */
function _parseJson(str, defaultValue) {
  if (defaultValue === undefined) defaultValue = null;
  if (!str) return defaultValue;
  try { return JSON.parse(str); } catch (_) { return defaultValue; }
}

// ── 8. AUDIT HELPERS ─────────────────────────────────────────
/**
 * Construye los campos de auditoría para una CREACIÓN.
 * Llamado por Services al insertar un registro nuevo.
 *
 * Nota: hace UN lookup de usuario. Si necesitás crear muchos registros
 * en batch, resolvé el usuario antes y pasalo como parámetro opcional.
 *
 * @param {string}  userId   - ID del usuario que crea
 * @param {Object}  [user]   - objeto usuario ya resuelto (evita lookup extra)
 * @returns {Object} campos de auditoría
 */
function _buildAuditCreate(userId, user) {
  if (!user && userId) {
    try { user = SheetHelper.getById(SHEETS.USERS, userId); } catch (_) {}
  }
  const now = _nowIso();
  return {
    createdAt:      now,
    createdBy:      userId          || '',
    createdByName:  user ? user.name : '',
    updatedAt:      now,
    updatedBy:      userId          || '',
    updatedByName:  user ? user.name : '',
  };
}

/**
 * Construye los campos de auditoría para una ACTUALIZACIÓN.
 * Preserva createdAt/createdBy del registro existente.
 *
 * @param {Object}  existing - registro existente (para preservar created*)
 * @param {string}  userId   - ID del usuario que modifica
 * @param {Object}  [user]   - objeto usuario ya resuelto (evita lookup extra)
 * @returns {Object} campos de auditoría
 */
function _buildAuditUpdate(existing, userId, user) {
  if (!user && userId) {
    try { user = SheetHelper.getById(SHEETS.USERS, userId); } catch (_) {}
  }
  const now = _nowIso();
  return {
    createdAt:      (existing && existing.createdAt)      || now,
    createdBy:      (existing && existing.createdBy)      || '',
    createdByName:  (existing && existing.createdByName)  || '',
    updatedAt:      now,
    updatedBy:      userId          || '',
    updatedByName:  user ? user.name : '',
  };
}

// ── 9. GVIZ QUERY ────────────────────────────────────────────
/**
 * Ejecuta una consulta GViz (SQL-like) sobre una hoja del Spreadsheet.
 * Más eficiente que SheetHelper.getAll() para tablas grandes con WHERE.
 *
 * Casos de uso:
 *   - Filtrar inscripciones por grado: WHERE C = 'escuelaVida'
 *   - Traer solo columnas específicas: SELECT A,B,C
 *
 * IMPORTANTE: GViz tiene limitaciones:
 *   - No soporta IN() con lista dinámica
 *   - Los alias de columna deben declararse (LABEL C 'grade')
 *   - Para tablas pequeñas (<200 filas), SheetHelper + CacheService es más rápido
 *
 * @param {string} sheetName - nombre de la pestaña
 * @param {string} query     - consulta GViz (ej: 'SELECT * WHERE C = "x"')
 * @returns {Object[]} array de objetos con los resultados
 */
function gvizQuery(sheetName, query) {
  const url = [
    'https://docs.google.com/spreadsheets/d/',
    SPREADSHEET_ID,
    '/gviz/tq?sheet=',
    encodeURIComponent(sheetName),
    '&tq=',
    encodeURIComponent(query),
    '&headers=1',
  ].join('');

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (e) {
    throw new Error('gvizQuery fetch error para "' + sheetName + '": ' + e.message);
  }

  const text  = response.getContentText();
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);/);
  if (!match || !match[1]) return [];

  let json;
  try {
    json = JSON.parse(match[1]);
  } catch (_) {
    Logger.log('[gvizQuery] JSON parse error para "' + sheetName + '"');
    return [];
  }

  if (!json.table || !json.table.rows) return [];

  // Extraer headers — GViz a veces devuelve A,B,C en vez de los nombres reales
  let headers = json.table.cols.map(c => c.label || c.id);

  // Workaround: si los headers son A,B,C… usar la primera fila de datos como header
  const isAlpha = headers.length >= 2 &&
    headers.every((h, i) => h === String.fromCharCode(65 + i));

  if (isAlpha && json.table.rows.length > 0) {
    headers           = json.table.rows[0].c.map(cell => (cell ? String(cell.v) : ''));
    json.table.rows   = json.table.rows.slice(1);
  }

  return json.table.rows.map(r => {
    const obj = {};
    r.c.forEach((cell, i) => {
      obj[headers[i]] = cell ? cell.v : '';
    });
    return obj;
  });
}