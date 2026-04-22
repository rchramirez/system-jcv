// ============================================================
// JCV SYSTEM — ClassService.gs
//
// Capa de dominio para Clases académicas.
//
// Responsabilidades:
//   • CRUD de clases con validación y auditoría
//   • Eliminación en cascada (asistencia + cuestionarios)
//   • Lectura filtrada por grado usando GViz WHERE
//   • Cambio de estado (programada → realizada → cancelada)
//
// Dependencias:
//   ← Config.gs    (SHEETS, GRADES)
//   ← Utils.gs     (_validate, _validateId, _validateEnum,
//                   _newId, _buildAuditCreate, _buildAuditUpdate,
//                   _nowIso, gvizQuery)
//   ← SheetHelper  (DAO)
// ============================================================

const ClassService = (() => {

  const CLASS_STATUSES = ['programada', 'realizada', 'cancelada'];

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Retorna todas las clases, opcionalmente filtradas por grado.
   * Usa GViz WHERE cuando se filtra (menos filas leídas).
   *
   * @param {string} [grade] - clave de GRADES o vacío para todas
   * @returns {Object[]}
   */
  function getAll(grade) {
    if (grade) {
      return gvizQuery(
        SHEETS.CLASSES,
        `SELECT * WHERE B = '${grade}' LABEL B 'grade'`
      );
    }
    return SheetHelper.getAll(SHEETS.CLASSES);
  }

  /**
   * Retorna una clase por ID.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getById(id) {
    return SheetHelper.getById(SHEETS.CLASSES, id);
  }

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Crea o actualiza una clase.
   *
   * Reglas de negocio:
   *   1. grade, title, scheduledDate son requeridos
   *   2. grade debe ser una clave válida de GRADES
   *   3. status debe ser uno de CLASS_STATUSES
   *   4. Auditoría en AuditLog
   *
   * @param {Object} data   - datos de la clase
   * @param {string} userId - para auditoría
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function save(data, userId) {
    _validate(data, ['grade', 'title', 'scheduledDate']);
    if (!GRADES[data.grade]) throw new Error(`Grado inválido: ${data.grade}`);

    const clean     = _stripInternal(data);
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (clean.id) {
      const existing = SheetHelper.getById(SHEETS.CLASSES, clean.id) || {};
      const audit    = _buildAuditUpdate(existing, userId, actorUser);

      // Validar status solo si viene en el update
      if (clean.status) {
        _validateEnum(clean.status, CLASS_STATUSES, 'status');
      }

      SheetHelper.update(SHEETS.CLASSES, clean.id, { ...clean, ...audit });
      SheetHelper.evict(SHEETS.CLASSES);
      _audit('Clases', clean.id, 'UPDATE', userId, actorUser, {
        title: clean.title, grade: clean.grade,
      });
      return { updated: true, id: clean.id };
    }

    const id    = _newId('cl');
    const audit = _buildAuditCreate(userId, actorUser);

    SheetHelper.insert(SHEETS.CLASSES, {
      ...clean,
      id,
      status: clean.status || 'programada',
      ...audit,
    });
    SheetHelper.evict(SHEETS.CLASSES);
    _audit('Clases', id, 'CREATE', userId, actorUser, {
      title: clean.title, grade: clean.grade,
    });
    return { created: true, id };
  }

  /**
   * Elimina una clase con cascade:
   *   • Elimina todos los registros de Asistencia de esta clase
   *   • Elimina todos los Cuestionarios de esta clase
   *
   * Orden correcto para evitar referencias huérfanas:
   *   1. Cuestionarios (referencian classId)
   *   2. Asistencia    (referencian classId)
   *   3. Clase         (la propia fila)
   *
   * @param {string} id     - ID de la clase
   * @param {string} userId - para auditoría
   * @returns {{ deleted: boolean, cascade: { attendance, questionnaires } }}
   */
  function remove(id, userId) {
    _validateId(id, 'classId');
    const cls = SheetHelper.getById(SHEETS.CLASSES, id);
    if (!cls) throw new Error(`Clase no encontrada: ${id}`);

    // Cascade: cuestionarios
    const questsDeleted = _cascadeDelete(SHEETS.QUESTIONNAIRES, 'classId', id);
    // Cascade: asistencia
    const attDeleted    = _cascadeDelete(SHEETS.ATTENDANCE, 'classId', id);

    SheetHelper.remove(SHEETS.CLASSES, id);
    SheetHelper.evict(SHEETS.CLASSES);
    SheetHelper.evict(SHEETS.ATTENDANCE);
    SheetHelper.evict(SHEETS.QUESTIONNAIRES);

    _audit('Clases', id, 'DELETE', userId, null, {
      title: cls.title, grade: cls.grade,
      cascade: { attendance: attDeleted, questionnaires: questsDeleted },
    });

    return {
      deleted: true,
      cascade: { attendance: attDeleted, questionnaires: questsDeleted },
    };
  }

  /**
   * Cambia el estado de una clase (programada ↔ realizada ↔ cancelada).
   * Atajo para no tener que mandar el objeto completo cuando solo
   * se quiere cambiar el status.
   *
   * @param {string} id     - ID de la clase
   * @param {string} status - nuevo estado
   * @param {string} userId - para auditoría
   * @returns {{ updated: boolean }}
   */
  function setStatus(id, status, userId) {
    _validateId(id, 'classId');
    _validateEnum(status, CLASS_STATUSES, 'status');

    const cls = SheetHelper.getById(SHEETS.CLASSES, id);
    if (!cls) throw new Error(`Clase no encontrada: ${id}`);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(cls, userId, actorUser);

    SheetHelper.update(SHEETS.CLASSES, id, { ...cls, status, ...audit });
    SheetHelper.evict(SHEETS.CLASSES);

    _audit('Clases', id, 'STATUS_CHANGE', userId, actorUser, {
      from: cls.status, to: status,
    });

    return { updated: true };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Elimina todos los registros de una hoja que tengan field=value.
   * Retorna el conteo de registros eliminados.
   */
  function _cascadeDelete(sheetName, field, value) {
    const toDelete = SheetHelper.findWhere(
      sheetName,
      r => String(r[field]) === String(value)
    );
    toDelete.forEach(r => {
      try { SheetHelper.remove(sheetName, r.id); } catch (_) {}
    });
    return toDelete.length;
  }

  function _stripInternal(data) {
    const clean = { ...data };
    delete clean._userId;
    delete clean._token;
    return clean;
  }

  function _audit(entity, entityId, action, userId, user, meta) {
    try {
      SheetHelper.insert(SHEETS.AUDIT_LOG, {
        id:        _newId('al'),
        entity,
        entityId:  entityId || '',
        action,
        userId:    userId   || '',
        userName:  user ? user.name : '',
        userRole:  user ? (user.role || '') : '',
        meta:      meta ? JSON.stringify(meta) : '{}',
        timestamp: _nowIso(),
      });
    } catch (e) {
      Logger.log(`[ClassService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return { getAll, getById, save, remove, setStatus };

})();