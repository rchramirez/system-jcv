// ============================================================
// JCV SYSTEM — ChurchService.gs
//
// Capa de dominio para Nexos (iglesias / sedes / franquicias).
//
// Responsabilidades:
//   • CRUD con auditoría y validación de campos requeridos
//   • Búsquedas: getAll, getById, findByCountry
//   • Validación de integridad referencial en otras tablas
//     antes de permitir eliminar un nexo
//   • Resumen enriquecido: personas, células y usuarios por nexo
//
// Dependencias:
//   ← Config.gs    (SHEETS)
//   ← Utils.gs     (_validate, _validateId, _newId,
//                   _buildAuditCreate, _buildAuditUpdate,
//                   _nowIso, gvizQuery)
//   ← SheetHelper  (DAO)
// ============================================================

const ChurchService = (() => {

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Retorna todos los nexos.
   * Usa GViz para lectura inicial sin filtro.
   *
   * @returns {Object[]}
   */
  function getAll() {
    return gvizQuery(SHEETS.CHURCHES, 'SELECT *');
  }

  /**
   * Retorna un nexo por ID.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getById(id) {
    return SheetHelper.getById(SHEETS.CHURCHES, id);
  }

  /**
   * Retorna nexos filtrados por país.
   *
   * @param {string} country - nombre del país (case-insensitive)
   * @returns {Object[]}
   */
  function getByCountry(country) {
    if (!country) return getAll();
    const q = country.toLowerCase().trim();
    return SheetHelper.findWhere(
      SHEETS.CHURCHES,
      c => (c.country || '').toLowerCase() === q
    );
  }

  /**
   * Retorna un resumen enriquecido de un nexo específico:
   * personas, células y usuarios asociados.
   * Útil para la vista de detalle en el frontend.
   *
   * @param {string} id
   * @returns {Object} nexo con conteos y listas resumidas
   */
  function getDetail(id) {
    const church = SheetHelper.getById(SHEETS.CHURCHES, id);
    if (!church) throw new Error(`Nexo no encontrado: ${id}`);

    const strId = String(id);

    // Conteos con CacheService si disponible
    const people = SheetHelper.findWhere(
      SHEETS.PEOPLE,
      p => String(p.churchId) === strId
    );
    const cells = SheetHelper.findWhere(
      SHEETS.CELLS,
      c => String(c.churchId) === strId
    );
    const users = SheetHelper.findWhere(
      SHEETS.USERS,
      u => String(u.churchId) === strId
    ).map(_sanitizeUser);

    return {
      ...church,
      peopleCount: people.length,
      cellCount:   cells.length,
      userCount:   users.length,
      // Resumen liviano de células (sin miembros)
      cells: cells.map(c => ({
        id:       c.id,
        name:     c.name,
        leader:   c.leader   || '',
        category: c.category || '',
      })),
      // Usuarios del nexo (sin password)
      users,
    };
  }

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Crea o actualiza un nexo.
   *
   * Reglas de negocio:
   *   1. name + country son requeridos
   *   2. Auditoría en AuditLog
   *
   * @param {Object} data   - datos del nexo
   * @param {string} userId - para auditoría
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function save(data, userId) {
    _validate(data, ['name', 'country']);

    const clean     = _stripInternal(data);
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (clean.id) {
      const existing = SheetHelper.getById(SHEETS.CHURCHES, clean.id) || {};
      const audit    = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.CHURCHES, clean.id, { ...clean, ...audit });
      SheetHelper.evict(SHEETS.CHURCHES);
      _audit('Nexos', clean.id, 'UPDATE', userId, actorUser, { name: clean.name });
      return { updated: true, id: clean.id };
    }

    const id    = _newId('ch');
    const audit = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.CHURCHES, { ...clean, id, ...audit });
    SheetHelper.evict(SHEETS.CHURCHES);
    _audit('Nexos', id, 'CREATE', userId, actorUser, { name: clean.name });
    return { created: true, id };
  }

  /**
   * Elimina un nexo.
   *
   * Validación de integridad referencial:
   *   • Verifica que no haya Personas, Células o Usuarios asociados
   *   • Si los hay, lanza error con conteo para que el admin decida
   *
   * Para forzar el borrado (cascade), el Controller puede pasar
   * { force: true } y los registros dependientes se desvincularán.
   *
   * @param {string}  id      - ID del nexo
   * @param {string}  userId  - para auditoría
   * @param {boolean} [force] - si true, desvincula dependencias
   * @returns {{ deleted: boolean }}
   */
  function remove(id, userId, force) {
    _validateId(id, 'churchId');
    const church = SheetHelper.getById(SHEETS.CHURCHES, id);
    if (!church) throw new Error(`Nexo no encontrado: ${id}`);

    const strId = String(id);

    // Verificar dependencias
    const dependentPeople = SheetHelper.findWhere(
      SHEETS.PEOPLE, p => String(p.churchId) === strId
    );
    const dependentCells = SheetHelper.findWhere(
      SHEETS.CELLS, c => String(c.churchId) === strId
    );
    const dependentUsers = SheetHelper.findWhere(
      SHEETS.USERS, u => String(u.churchId) === strId
    );

    const hasDependencies =
      dependentPeople.length > 0 ||
      dependentCells.length  > 0 ||
      dependentUsers.length  > 0;

    if (hasDependencies && !force) {
      throw new Error(
        `El nexo "${church.name}" tiene dependencias: ` +
        `${dependentPeople.length} persona(s), ` +
        `${dependentCells.length} célula(s), ` +
        `${dependentUsers.length} usuario(s). ` +
        `Desvincularlos primero o usar force=true.`
      );
    }

    // Desvinculación en cascada (solo si force=true)
    if (force) {
      _unlinkDependencies(strId, dependentPeople, dependentCells, dependentUsers);
    }

    SheetHelper.remove(SHEETS.CHURCHES, id);
    SheetHelper.evict(SHEETS.CHURCHES);
    _audit('Nexos', id, 'DELETE', userId, null, { name: church.name });
    return { deleted: true };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Desvincula todas las entidades que referencian el nexo eliminado.
   * Solo se llama cuando force=true.
   */
  function _unlinkDependencies(churchId, people, cells, users) {
    const now = _nowIso();

    people.forEach(p => {
      try {
        SheetHelper.update(SHEETS.PEOPLE, p.id, { ...p, churchId: '', updatedAt: now });
      } catch (_) {}
    });
    if (people.length) SheetHelper.evict(SHEETS.PEOPLE);

    cells.forEach(c => {
      try {
        SheetHelper.update(SHEETS.CELLS, c.id, { ...c, churchId: '', updatedAt: now });
      } catch (_) {}
    });
    if (cells.length) SheetHelper.evict(SHEETS.CELLS);

    users.forEach(u => {
      try {
        SheetHelper.update(SHEETS.USERS, u.id, { ...u, churchId: '', updatedAt: now });
      } catch (_) {}
    });
    if (users.length) SheetHelper.evict(SHEETS.USERS);
  }

  /** Elimina campos internos del payload */
  function _stripInternal(data) {
    const clean = { ...data };
    delete clean._userId;
    delete clean._token;
    return clean;
  }

  /** Elimina password del objeto usuario antes de exponerlo */
  function _sanitizeUser(u) {
    const { password, ...safe } = u;
    return safe;
  }

  /** Escribe en AuditLog sin interrumpir el flujo principal */
  function _audit(entity, entityId, action, userId, user, meta) {
    try {
      SheetHelper.insert(SHEETS.AUDIT_LOG, {
        id:        _newId('al'),
        entity,
        entityId:  entityId || '',
        action,
        userId:    userId   || '',
        userName:  user ? user.name : '',
        userRole:  user ? (user.role || user.roleId || '') : '',
        meta:      meta ? JSON.stringify(meta) : '{}',
        timestamp: _nowIso(),
      });
    } catch (e) {
      Logger.log(`[ChurchService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    getAll,
    getById,
    getByCountry,
    getDetail,
    save,
    remove,
  };

})();