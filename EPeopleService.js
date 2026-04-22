// ============================================================
// JCV SYSTEM — PeopleService.gs
//
// Capa de dominio para Personas.
// Responsabilidades:
//   • Validación de reglas de negocio (campos requeridos,
//     resolución de cellId, integridad referencial)
//   • Orquestación de escrituras (Personas + AuditLog)
//   • Queries compuestas (getAll, getByIds, getPaginated)
//   • Limpiezas en cascada (ministryId al borrar)
//
// NO contiene lógica HTTP. NO usa _respond().
// El Controller envuelve cada llamada en _respond().
//
// Dependencias:
//   ← Config.gs    (SHEETS, GRADES)
//   ← Utils.gs     (_validate, _newId, _buildAuditCreate,
//                   _buildAuditUpdate, _nowIso, gvizQuery)
//   ← SheetHelper  (DAO)
//   → AuditService (cuando esté disponible — Parte 5)
// ============================================================

const PeopleService = (() => {

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Retorna todas las personas.
   * Usa GViz para la lectura inicial (sin filtro WHERE,
   * pero sin el overhead de CacheService para tablas grandes).
   *
   * @returns {Object[]}
   */
  function getAll() {
    return gvizQuery(SHEETS.PEOPLE, 'SELECT *');
  }

  /**
   * Retorna solo las personas cuyos IDs están en la lista.
   * Usa SheetHelper.getAll() que tiene CacheService de 6 min:
   * si la hoja ya fue leída en esta ejecución, 0 API calls adicionales.
   *
   * Usado por getSchoolData() para resolver personIds de inscripciones
   * sin leer toda la tabla Personas dos veces.
   *
   * @param {string[]} ids - array de personIds
   * @returns {Object[]}
   */
  function getByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const idSet = new Set(ids.map(String));
    return SheetHelper.getAll(SHEETS.PEOPLE).filter(p => idSet.has(String(p.id)));
  }

  /**
   * Paginación server-side con filtro de texto opcional.
   *
   * @param {number}  page     - página (1-based)
   * @param {number}  pageSize - registros por página
   * @param {string}  [search] - texto libre para filtrar
   * @returns {{ rows, total, page, pages, pageSize }}
   */
  function getPaginated(page, pageSize, search) {
    const q = (search || '').toLowerCase().trim();
    const filterFn = q
      ? p => {
          const hay = [p.name, p.lastName, p.email, p.phone, p.country]
            .filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        }
      : null;
    return SheetHelper.getPaginated(SHEETS.PEOPLE, page, pageSize, filterFn);
  }

  /**
   * Retorna una persona por ID.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getById(id) {
    return SheetHelper.getById(SHEETS.PEOPLE, id);
  }

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Crea o actualiza una persona.
   *
   * Reglas de negocio aplicadas:
   *   1. name + lastName son requeridos
   *   2. Si viene cellLeader sin cellId → resolver cellId desde Células
   *      (compatibilidad retroactiva con formularios viejos)
   *   3. Campos _userId y otros campos internos se limpian antes de persistir
   *   4. Auditoría registrada en AuditLog
   *
   * @param {Object} data   - datos de la persona (puede incluir _userId)
   * @param {string} userId - ID del usuario que opera (para auditoría)
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function save(data, userId) {
    _validate(data, ['name', 'lastName']);

    // Limpiar campos internos que no van a la hoja
    const clean = _stripInternalFields(data);

    // Resolver cellId desde cellLeader si no viene el ID
    // (retrocompatibilidad: formularios legacy envían solo cellLeader=string)
    if (!clean.cellId && clean.cellLeader) {
      const cell = SheetHelper.findOne(
        SHEETS.CELLS,
        c => c.leader === clean.cellLeader || c.name === clean.cellLeader
      );
      if (cell) clean.cellId = cell.id;
    }

    // Resolver usuario una sola vez (evita N lookups en _buildAudit*)
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (clean.id) {
      // UPDATE
      const existing  = SheetHelper.getById(SHEETS.PEOPLE, clean.id) || {};
      const auditMeta = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.PEOPLE, clean.id, { ...clean, ...auditMeta });
      _writeAuditLog('Personas', clean.id, 'UPDATE', userId, actorUser, {
        name: `${data.name} ${data.lastName}`,
      });
      return { updated: true, id: clean.id };
    }

    // CREATE
    const id        = _newId('p');
    const auditMeta = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.PEOPLE, { ...clean, id, ...auditMeta });
    _writeAuditLog('Personas', id, 'CREATE', userId, actorUser, {
      name: `${data.name} ${data.lastName}`,
    });
    return { created: true, id };
  }

  /**
   * Elimina una persona FÍSICAMENTE de la hoja.
   *
   * Limpieza en cascada:
   *   • Ministerios: limpia ministryId en el programa si existía
   *
   * NOTA: las inscripciones (Enrollments) quedan huérfanas intencionalmente
   * para preservar historial académico. El Controller puede decidir
   * soft-delete en su lugar si la política cambia.
   *
   * @param {string} id     - ID de la persona
   * @param {string} userId - ID del usuario que borra (para auditoría)
   * @returns {{ deleted: boolean, id: string }}
   */
  function remove(id, userId) {
    _validateId(id, 'personId');
    const person = SheetHelper.getById(SHEETS.PEOPLE, id);
    if (!person) throw new Error(`Persona no encontrada: ${id}`);

    // Limpiar ministryId legacy en programas/ministerios
    _cleanMinistryRef(id);

    SheetHelper.remove(SHEETS.PEOPLE, id);
    SheetHelper.evict(SHEETS.PEOPLE);

    _writeAuditLog('Personas', id, 'DELETE', userId, null, {
      name: `${person.name} ${person.lastName}`,
    });
    return { deleted: true, id };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Elimina campos internos del objeto antes de persistir.
   * Estos campos viajan en el payload desde el frontend pero
   * no tienen columna en la hoja.
   */
  function _stripInternalFields(data) {
    const clean = { ...data };
    delete clean._userId;
    delete clean._token;
    return clean;
  }

  /**
   * Limpia la referencia legacy ministryId en Programas/Ministerios
   * cuando se borra una persona.
   * Solo actúa si la persona tenía ministryId en el campo desnormalizado.
   */
  function _cleanMinistryRef(personId) {
    try {
      // Campo desnormalizado legacy en Programas (tipo ministry)
      if (SHEETS.PROGRAMS) {
        SheetHelper.findWhere(
          SHEETS.PROGRAMS,
          m => {
            const ids = _parseMemberIds(m.memberIds);
            return ids.includes(personId);
          }
        ).forEach(m => {
          const newIds = _parseMemberIds(m.memberIds).filter(id => id !== personId);
          SheetHelper.update(SHEETS.PROGRAMS, m.id, {
            ...m,
            memberIds: JSON.stringify(newIds),
            updatedAt: _nowIso(),
          });
        });
        SheetHelper.evict(SHEETS.PROGRAMS);
      }
    } catch (_) {
      // Nunca romper el flujo principal por una limpieza de referencia
    }
  }

  /**
   * Escribe un evento en AuditLog.
   * Wrapper local hasta que AuditService esté disponible (Parte 5).
   * Nunca lanza excepción — un fallo de auditoría no debe bloquear
   * la operación principal.
   */
  function _writeAuditLog(entity, entityId, action, userId, user, meta) {
    try {
      SheetHelper.insert(SHEETS.AUDIT_LOG, {
        id:        _newId('al'),
        entity,
        entityId:  entityId  || '',
        action,
        userId:    userId    || '',
        userName:  user ? user.name : '',
        userRole:  user ? (user.role || user.roleId || '') : '',
        meta:      meta ? JSON.stringify(meta) : '{}',
        timestamp: _nowIso(),
      });
    } catch (e) {
      Logger.log(`[PeopleService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    getAll,
    getByIds,
    getPaginated,
    getById,
    save,
    remove,
  };

})();