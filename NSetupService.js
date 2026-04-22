// ============================================================
// JCV SYSTEM — SetupService.gs
//
// Gestión del schema de Google Sheets.
// Solo se ejecuta manualmente desde el editor de GAS,
// nunca desde el frontend de usuario.
//
// Responsabilidades:
//   • initialize() — crea hojas y cabeceras según SCHEMA
//   • migrate()    — agrega columnas nuevas sin borrar datos
//   • _seed()      — crea admin por defecto y período inicial
// ============================================================

const SetupService = (() => {

  /**
   * Crea todas las hojas con sus schemas.
   * Idempotente: si la hoja ya existe, solo agrega columnas nuevas.
   * No borra datos existentes.
   *
   * @returns {{ ok: boolean, message: string, sheets: string[] }}
   */
  function initialize() {
    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
    const created = [];

    Object.entries(SCHEMA).forEach(([sheetName, headers]) => {
      const color = SHEET_COLORS[sheetName] || '#374151';
      _ensureSheet(ss, sheetName, headers, color);
      created.push(sheetName);
    });

    // Crear datos iniciales solo si las hojas estaban vacías
    _seed(ss);

    SheetHelper.clearCache();

    return {
      ok:      true,
      message: `Hojas inicializadas v5.0 — ${created.length} tablas`,
      sheets:  created,
    };
  }

  /**
   * Migración incremental: agrega columnas del schema nuevo
   * a hojas existentes sin tocar los datos.
   * Seguro de correr múltiples veces (idempotente).
   *
   * @returns {{ success: boolean, log: string[] }}
   */
  function migrate() {
    const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
    const log = [];

    Object.entries(SCHEMA).forEach(([sheetName, headers]) => {
      const color  = SHEET_COLORS[sheetName] || '#374151';
      const result = _ensureSheet(ss, sheetName, headers, color);
      if (result.created) {
        log.push(`Hoja creada: ${sheetName} (${headers.length} columnas)`);
      } else if (result.added > 0) {
        log.push(`${sheetName}: ${result.added} columna(s) agregada(s)`);
      }
    });

    // Normalizar inscripciones legacy (status vacío → 'activo')
    const migrated = _normalizeEnrollmentStatus();
    if (migrated > 0) {
      log.push(`Inscripciones normalizadas: ${migrated}`);
    }

    SheetHelper.clearCache();
    log.push('Migración v5 completada');

    return { success: true, log };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Crea la hoja si no existe, o agrega columnas faltantes si ya existe.
   *
   * @returns {{ created: boolean, added: number }}
   */
  function _ensureSheet(ss, sheetName, headers, color) {
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    if (sheet.getLastRow() === 0) {
      // Hoja nueva — escribir cabecera completa
      sheet.appendRow(headers);
      _styleHeader(sheet, headers.length, color);
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, headers.length);
      return { created: true, added: 0 };
    }

    // Hoja existente — agregar solo columnas que faltan
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    let added = 0;
    headers.forEach(h => {
      if (!existing.includes(h)) {
        const col = sheet.getLastColumn() + 1;
        sheet.getRange(1, col).setValue(h)
          .setBackground(color)
          .setFontColor('#FFFFFF')
          .setFontWeight('bold');
        added++;
      }
    });

    return { created: false, added };
  }

  /** Aplica formato de cabecera (color + bold + freeze) */
  function _styleHeader(sheet, colCount, color) {
    sheet.getRange(1, 1, 1, colCount)
      .setBackground(color)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }

  /**
   * Crea datos iniciales si las tablas críticas están vacías:
   *   • Usuario admin por defecto
   *   • Período activo del cuatrimestre actual
   */
  function _seed(ss) {
    // Usuario admin por defecto
    try {
      const users = SheetHelper.getAll(SHEETS.USERS);
      if (!users.find(u => u.username === 'admin')) {
        const now   = _nowIso();
        const audit = {
          createdAt: now, createdBy: 'system', createdByName: 'Sistema',
          updatedAt: now, updatedBy: 'system', updatedByName: 'Sistema',
        };
        SheetHelper.insert(SHEETS.USERS, {
          id:             'u1',
          personId:       '',
          username:       'admin',
          password:       hashPassword('admin123'),
          roleId:         '',
          role:           ROLES.ADMIN,
          name:           'Administrador',
          email:          'admin@jcv.org',
          photoUrl:       '',
          churchId:       '',
          assignedGrade:  '',
          status:         'active',
          ...audit,
        });
        Logger.log('[SetupService] Usuario admin creado (cambiar contraseña)');
      }
    } catch (e) {
      Logger.log(`[SetupService._seed] usuarios error: ${e.message}`);
    }

    // Período activo por defecto
    try {
      const periods = SheetHelper.getAll(SHEETS.PERIODS);
      if (!periods.length) {
        const now = new Date();
        const sem = now.getMonth() < 6 ? 1 : 2;
        SheetHelper.insert(SHEETS.PERIODS, {
          id:        'per_default',
          name:      `${now.getFullYear()} — Cuatrimestre ${sem}`,
          year:      now.getFullYear(),
          semester:  sem,
          startDate: sem === 1
            ? `${now.getFullYear()}-03-01`
            : `${now.getFullYear()}-08-01`,
          endDate:   sem === 1
            ? `${now.getFullYear()}-07-31`
            : `${now.getFullYear()}-12-15`,
          status:    'active',
          createdAt: _nowIso(),
        });
        Logger.log('[SetupService] Período activo por defecto creado');
      }
    } catch (e) {
      Logger.log(`[SetupService._seed] períodos error: ${e.message}`);
    }
  }

  /**
   * Normaliza inscripciones legacy: status vacío → 'activo'.
   * @returns {number} cantidad de inscripciones actualizadas
   */
  function _normalizeEnrollmentStatus() {
    let count = 0;
    try {
      SheetHelper.getAll(SHEETS.ENROLLMENTS)
        .filter(e => !e.status || String(e.status).trim() === '')
        .forEach(e => {
          try {
            SheetHelper.update(SHEETS.ENROLLMENTS, e.id, {
              ...e,
              status:     'activo',
              bajaAt:     e.bajaAt     || '',
              bajaMotivo: e.bajaMotivo || '',
              bajaDetail: e.bajaDetail || '',
              bajaBy:     e.bajaBy     || '',
            });
            count++;
          } catch (_) {}
        });
      if (count) SheetHelper.evict(SHEETS.ENROLLMENTS);
    } catch (e) {
      Logger.log(`[SetupService._normalizeEnrollmentStatus] error: ${e.message}`);
    }
    return count;
  }

  return { initialize, migrate };

})();