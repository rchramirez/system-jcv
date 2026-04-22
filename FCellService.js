// ============================================================
// JCV SYSTEM — CellService.gs
//
// Capa de dominio para Células y Ministerios (Programas tipo ministry).
//
// Responsabilidades Células:
//   • CRUD con auditoría
//   • Validación de campos requeridos (name, leader)
//   • Gestión de membresía via CellMembers (nueva tabla)
//   • Compatibilidad con campo legacy cellLeader en Personas
//
// Responsabilidades Ministerios:
//   • CRUD con auditoría
//   • Validación de tipo (enum MINISTRY_TYPES)
//   • Gestión idempotente de miembros
//   • Desnormalización ministryId en Personas (campo legacy)
//   • Limpieza en cascada al eliminar
//
// Dependencias:
//   ← Config.gs    (SHEETS, MINISTRY_TYPES)
//   ← Utils.gs     (_validate, _validateEnum, _validateId,
//                   _newId, _buildAuditCreate, _buildAuditUpdate,
//                   _nowIso, _parseMemberIds, gvizQuery)
//   ← SheetHelper  (DAO)
// ============================================================

const CellService = (() => {

  // ════════════════════════════════════════════════════════════
  // SECCIÓN A — CÉLULAS
  // ════════════════════════════════════════════════════════════

  /**
   * Retorna todas las células.
   * Usa GViz para lectura completa de la hoja.
   *
   * @returns {Object[]}
   */
  function getAllCells() {
    return gvizQuery(SHEETS.CELLS, 'SELECT *');
  }

  /**
   * Retorna una célula por ID.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getCellById(id) {
    return SheetHelper.getById(SHEETS.CELLS, id);
  }

  /**
   * Crea o actualiza una célula.
   *
   * Reglas de negocio:
   *   1. name + leader son requeridos
   *   2. Si se actualiza el líder, se actualiza cellLeader en
   *      Personas que referencian esta célula (campo legacy)
   *   3. Auditoría en AuditLog
   *
   * @param {Object} data   - datos de la célula
   * @param {string} userId - ID del usuario que opera
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function saveCell(data, userId) {
    _validate(data, ['name', 'leader']);

    const clean     = _stripInternal(data);
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (clean.id) {
      const existing = SheetHelper.getById(SHEETS.CELLS, clean.id) || {};
      const audit    = _buildAuditUpdate(existing, userId, actorUser);

      // Si cambió el líder, propagar al campo legacy en Personas
      if (existing.leader && existing.leader !== clean.leader) {
        _updateLegacyCellLeader(clean.id, clean.leader);
      }

      SheetHelper.update(SHEETS.CELLS, clean.id, { ...clean, ...audit });
      _audit('Celulas', clean.id, 'UPDATE', userId, actorUser, { name: clean.name });
      return { updated: true, id: clean.id };
    }

    const id    = _newId('c');
    const audit = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.CELLS, { ...clean, id, ...audit });
    _audit('Celulas', id, 'CREATE', userId, actorUser, { name: clean.name });
    return { created: true, id };
  }

  /**
   * Elimina una célula.
   * Limpieza: desvincula cellId/cellLeader en Personas que la referencian.
   *
   * @param {string} id     - ID de la célula
   * @param {string} userId - para auditoría
   * @returns {{ deleted: boolean }}
   */
  function removeCell(id, userId) {
    _validateId(id, 'cellId');
    const cell = SheetHelper.getById(SHEETS.CELLS, id);
    if (!cell) throw new Error(`Célula no encontrada: ${id}`);

    // Desvincular Personas que referenciaban esta célula
    _unlinkPersonsFromCell(id);

    SheetHelper.remove(SHEETS.CELLS, id);
    SheetHelper.evict(SHEETS.CELLS);

    _audit('Celulas', id, 'DELETE', userId, null, { name: cell.name });
    return { deleted: true };
  }

  // ── Membresía de Célula (nueva tabla CellMembers) ─────────

  /**
   * Agrega una persona como miembro de una célula.
   * Idempotente: si ya es miembro activo, retorna sin error.
   *
   * @param {string} cellId   - ID de la célula
   * @param {string} personId - ID de la persona
   * @param {string} role     - 'leader' | 'coleader' | 'member'
   * @param {string} userId   - para auditoría
   * @returns {{ ok: boolean, membershipId: string }}
   */
  function addCellMember(cellId, personId, role, userId) {
    _validateId(cellId,   'cellId');
    _validateId(personId, 'personId');
    _validateEnum(role || 'member', ['leader', 'coleader', 'member'], 'role');

    const cell   = SheetHelper.getById(SHEETS.CELLS, cellId);
    if (!cell)   throw new Error(`Célula no encontrada: ${cellId}`);
    const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
    if (!person) throw new Error(`Persona no encontrada: ${personId}`);

    // Idempotencia: verificar membresía activa existente
    const existing = SheetHelper.findOne(
      SHEETS.CELL_MEMBERS,
      m => m.cellId === cellId && m.personId === personId && m.status === 'active'
    );
    if (existing) return { ok: true, alreadyMember: true, membershipId: existing.id };

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditCreate(userId, actorUser);
    const id        = _newId('cm');

    SheetHelper.insert(SHEETS.CELL_MEMBERS, {
      id,
      cellId,
      personId,
      role:     role || 'member',
      status:   'active',
      joinedAt: _nowIso(),
      leftAt:   '',
      ...audit,
    });

    // Actualizar campos legacy en Personas para compatibilidad con frontend v4
    SheetHelper.update(SHEETS.PEOPLE, personId, {
      ...person,
      cellId,
      cellLeader: cell.leader || '',
      updatedAt:  _nowIso(),
    });
    SheetHelper.evict(SHEETS.PEOPLE);
    SheetHelper.evict(SHEETS.CELL_MEMBERS);

    _audit('Celulas', cellId, 'ADD_MEMBER', userId, actorUser, {
      cellName: cell.name, personId,
      personName: `${person.name} ${person.lastName}`,
    });

    return { ok: true, membershipId: id };
  }

  /**
   * Desactiva la membresía de una persona en una célula (soft delete).
   * No elimina la fila — mantiene historial.
   *
   * @param {string} cellId   - ID de la célula
   * @param {string} personId - ID de la persona
   * @param {string} userId   - para auditoría
   * @returns {{ ok: boolean }}
   */
  function removeCellMember(cellId, personId, userId) {
    _validateId(cellId,   'cellId');
    _validateId(personId, 'personId');

    const membership = SheetHelper.findOne(
      SHEETS.CELL_MEMBERS,
      m => m.cellId === cellId && m.personId === personId && m.status === 'active'
    );
    if (!membership) return { ok: true, notMember: true };

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(membership, userId, actorUser);

    SheetHelper.update(SHEETS.CELL_MEMBERS, membership.id, {
      ...membership,
      status: 'inactive',
      leftAt: _nowIso(),
      ...audit,
    });

    // Limpiar campo legacy en Persona si apuntaba a esta célula
    try {
      const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
      if (person && String(person.cellId) === String(cellId)) {
        SheetHelper.update(SHEETS.PEOPLE, personId, {
          ...person,
          cellId:     '',
          cellLeader: '',
          updatedAt:  _nowIso(),
        });
        SheetHelper.evict(SHEETS.PEOPLE);
      }
    } catch (_) {}

    SheetHelper.evict(SHEETS.CELL_MEMBERS);

    _audit('Celulas', cellId, 'REMOVE_MEMBER', userId, actorUser, { personId });
    return { ok: true };
  }

  /**
   * Retorna los miembros activos de una célula con sus datos completos.
   * Join en backend: CellMembers + Personas.
   *
   * @param {string} cellId
   * @returns {Object[]} miembros enriquecidos
   */
  function getCellMembers(cellId) {
    _validateId(cellId, 'cellId');
    const memberships = SheetHelper.findWhere(
      SHEETS.CELL_MEMBERS,
      m => m.cellId === cellId && m.status === 'active'
    );
    if (!memberships.length) return [];

    const personIds = memberships.map(m => m.personId);
    const people    = SheetHelper.getAll(SHEETS.PEOPLE);
    const peopleMap = Object.fromEntries(people.map(p => [p.id, p]));

    return memberships.map(m => {
      const p = peopleMap[m.personId] || {};
      return {
        membershipId: m.id,
        personId:     m.personId,
        role:         m.role,
        joinedAt:     m.joinedAt,
        name:         p.name      || '',
        lastName:     p.lastName  || '',
        phone:        p.phone     || '',
        email:        p.email     || '',
        photoUrl:     p.photoUrl  || '',
      };
    });
  }

  // ════════════════════════════════════════════════════════════
  // SECCIÓN B — MINISTERIOS (Programas tipo 'ministry')
  // ════════════════════════════════════════════════════════════

  /**
   * Retorna todos los ministerios con memberIds como array JS.
   * Incluye memberCount desnormalizado para la UI.
   *
   * @returns {Object[]}
   */
  function getAllMinistries() {
    return SheetHelper.getAll(SHEETS.PROGRAMS)
      .filter(p => p.type === PROGRAM_TYPES.MINISTRY)
      .map(_formatMinistry);
  }

  /**
   * Retorna un ministerio por ID.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getMinistryById(id) {
    const m = SheetHelper.getById(SHEETS.PROGRAMS, id);
    if (!m || m.type !== PROGRAM_TYPES.MINISTRY) return null;
    return _formatMinistry(m);
  }

  /**
   * Retorna un ministerio con datos completos de sus integrantes.
   * Join en backend: Programas + Personas.
   *
   * @param {string} id
   * @returns {Object} ministerio con array `members` enriquecido
   */
  function getMinistryDetail(id) {
    const ministry = getMinistryById(id);
    if (!ministry) throw new Error(`Ministerio no encontrado: ${id}`);

    const memberIds = _parseMemberIds(ministry.memberIds);
    const people    = SheetHelper.getAll(SHEETS.PEOPLE);

    const members = memberIds
      .map(pid => people.find(p => String(p.id) === String(pid)))
      .filter(Boolean)
      .map(p => ({
        id:         p.id,
        name:       p.name,
        lastName:   p.lastName,
        phone:      p.phone     || '',
        email:      p.email     || '',
        photoUrl:   p.photoUrl  || '',
        cellLeader: p.cellLeader|| '',
      }));

    return { ...ministry, members, memberCount: members.length };
  }

  /**
   * Crea o actualiza un ministerio.
   *
   * Reglas de negocio:
   *   1. name + type son requeridos
   *   2. type debe ser uno de MINISTRY_TYPES (enum controlado)
   *   3. memberIds se serializa a JSON string en la hoja
   *   4. Auditoría en AuditLog
   *
   * @param {Object} data   - datos del ministerio
   * @param {string} userId - para auditoría
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function saveMinistry(data, userId) {
    _validate(data, ['name', 'type']);
    _validateEnum(data.type, MINISTRY_TYPES, 'type');

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const clean = {
      name:        (data.name        || '').trim(),
      type:        data.type,
      description: (data.description || '').trim(),
      leaders:     (data.leaders     || '').trim(),
      schedule:    (data.schedule    || '').trim(),
      location:    (data.location    || '').trim(),
      memberIds:   JSON.stringify(_parseMemberIds(data.memberIds)),
      // Siempre tipo ministry para distinguir de schools en Programas
      programType: PROGRAM_TYPES.MINISTRY,
    };

    if (data.id) {
      const existing = SheetHelper.getById(SHEETS.PROGRAMS, data.id);
      if (!existing) throw new Error(`Ministerio no encontrado: ${data.id}`);
      const audit = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.PROGRAMS, data.id, { ...clean, ...audit });
      SheetHelper.evict(SHEETS.PROGRAMS);
      _audit('Ministerios', data.id, 'UPDATE', userId, actorUser, {
        name: clean.name, type: clean.type,
      });
      return { updated: true, id: data.id };
    }

    const id    = _newId('min');
    const audit = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.PROGRAMS, {
      id,
      ...clean,
      status: 'active',
      ...audit,
    });
    SheetHelper.evict(SHEETS.PROGRAMS);
    _audit('Ministerios', id, 'CREATE', userId, actorUser, {
      name: clean.name, type: clean.type,
    });
    return { created: true, id };
  }

  /**
   * Elimina un ministerio.
   * Limpieza en cascada:
   *   • Limpia ministryId (campo legacy) en Personas asociadas
   *
   * @param {string} id     - ID del ministerio
   * @param {string} userId - para auditoría
   * @returns {{ deleted: boolean }}
   */
  function removeMinistry(id, userId) {
    _validateId(id, 'ministryId');
    const ministry = SheetHelper.getById(SHEETS.PROGRAMS, id);
    if (!ministry) throw new Error(`Ministerio no encontrado: ${id}`);

    // Limpiar campo legacy ministryId en Personas
    const memberIds = _parseMemberIds(ministry.memberIds);
    if (memberIds.length) {
      memberIds.forEach(personId => {
        try {
          const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
          if (person && String(person.ministryId) === String(id)) {
            SheetHelper.update(SHEETS.PEOPLE, personId, {
              ...person,
              ministryId: '',
              updatedAt:  _nowIso(),
            });
          }
        } catch (_) {}
      });
      SheetHelper.evict(SHEETS.PEOPLE);
    }

    SheetHelper.remove(SHEETS.PROGRAMS, id);
    SheetHelper.evict(SHEETS.PROGRAMS);
    _audit('Ministerios', id, 'DELETE', userId, null, { name: ministry.name });
    return { deleted: true };
  }

  /**
   * Agrega un integrante al ministerio.
   * Idempotente: si ya es integrante, retorna sin error ni duplicado.
   *
   * Desnormaliza ministryId en Personas para compatibilidad
   * con el frontend v4 que hace lookups directos.
   *
   * @param {string} ministryId
   * @param {string} personId
   * @param {string} userId     - para auditoría
   * @returns {{ ok: boolean, memberCount: number }}
   */
  function addMinistryMember(ministryId, personId, userId) {
    _validateId(ministryId, 'ministryId');
    _validateId(personId,   'personId');

    const ministry = SheetHelper.getById(SHEETS.PROGRAMS, ministryId);
    if (!ministry) throw new Error(`Ministerio no encontrado: ${ministryId}`);
    const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
    if (!person)  throw new Error(`Persona no encontrada: ${personId}`);

    const memberIds = _parseMemberIds(ministry.memberIds);

    // Idempotencia
    if (memberIds.includes(personId)) {
      return { ok: true, alreadyMember: true, memberCount: memberIds.length };
    }

    memberIds.push(personId);
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(ministry, userId, actorUser);

    SheetHelper.update(SHEETS.PROGRAMS, ministryId, {
      ...ministry,
      memberIds: JSON.stringify(memberIds),
      ...audit,
    });

    // Desnormalizar ministryId en Persona (campo legacy para frontend v4)
    SheetHelper.update(SHEETS.PEOPLE, personId, {
      ...person,
      ministryId: ministryId,
      updatedAt:  _nowIso(),
    });

    SheetHelper.evict(SHEETS.PROGRAMS);
    SheetHelper.evict(SHEETS.PEOPLE);

    _audit('Ministerios', ministryId, 'ADD_MEMBER', userId, actorUser, {
      ministryName: ministry.name, personId,
      personName:   `${person.name} ${person.lastName}`,
    });
    return { ok: true, memberCount: memberIds.length };
  }

  /**
   * Quita un integrante del ministerio.
   * Idempotente: si no es miembro, retorna sin error.
   *
   * @param {string} ministryId
   * @param {string} personId
   * @param {string} userId     - para auditoría
   * @returns {{ ok: boolean, memberCount: number }}
   */
  function removeMinistryMember(ministryId, personId, userId) {
    _validateId(ministryId, 'ministryId');
    _validateId(personId,   'personId');

    const ministry = SheetHelper.getById(SHEETS.PROGRAMS, ministryId);
    if (!ministry) throw new Error(`Ministerio no encontrado: ${ministryId}`);

    const memberIds    = _parseMemberIds(ministry.memberIds);
    const newMemberIds = memberIds.filter(mid => String(mid) !== String(personId));

    // Si no era miembro, retornar silenciosamente (idempotente)
    if (newMemberIds.length === memberIds.length) {
      return { ok: true, notMember: true, memberCount: memberIds.length };
    }

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(ministry, userId, actorUser);

    SheetHelper.update(SHEETS.PROGRAMS, ministryId, {
      ...ministry,
      memberIds: JSON.stringify(newMemberIds),
      ...audit,
    });
    SheetHelper.evict(SHEETS.PROGRAMS);

    // Limpiar ministryId legacy en Persona (solo si apunta a este ministerio)
    try {
      const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
      if (person && String(person.ministryId) === String(ministryId)) {
        SheetHelper.update(SHEETS.PEOPLE, personId, {
          ...person,
          ministryId: '',
          updatedAt:  _nowIso(),
        });
        SheetHelper.evict(SHEETS.PEOPLE);
      }
    } catch (_) {}

    _audit('Ministerios', ministryId, 'REMOVE_MEMBER', userId, actorUser, {
      ministryName: ministry.name, personId,
    });
    return { ok: true, memberCount: newMemberIds.length };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Formatea un registro de Programas como objeto ministerio
   * con memberIds como array JS y memberCount calculado.
   */
  function _formatMinistry(m) {
    const ids = _parseMemberIds(m.memberIds);
    return {
      id:          m.id          || '',
      name:        m.name        || '',
      type:        m.type        || 'otro',
      description: m.description || '',
      leaders:     m.leaders     || '',
      schedule:    m.schedule    || '',
      location:    m.location    || '',
      status:      m.status      || 'active',
      memberIds:   ids,
      memberCount: ids.length,
      createdAt:   m.createdAt   || '',
      updatedAt:   m.updatedAt   || '',
    };
  }

  /**
   * Propaga el cambio de líder de una célula al campo legacy
   * cellLeader en Personas que referencian esa célula.
   */
  function _updateLegacyCellLeader(cellId, newLeader) {
    try {
      SheetHelper.findWhere(SHEETS.PEOPLE, p => String(p.cellId) === String(cellId))
        .forEach(p => {
          SheetHelper.update(SHEETS.PEOPLE, p.id, {
            ...p,
            cellLeader: newLeader,
            updatedAt:  _nowIso(),
          });
        });
      SheetHelper.evict(SHEETS.PEOPLE);
    } catch (_) {}
  }

  /**
   * Desvincula todas las Personas que referenciaban una célula eliminada.
   */
  function _unlinkPersonsFromCell(cellId) {
    try {
      SheetHelper.findWhere(SHEETS.PEOPLE, p => String(p.cellId) === String(cellId))
        .forEach(p => {
          SheetHelper.update(SHEETS.PEOPLE, p.id, {
            ...p,
            cellId:     '',
            cellLeader: '',
            updatedAt:  _nowIso(),
          });
        });
      SheetHelper.evict(SHEETS.PEOPLE);

      // Desactivar membresías en CellMembers
      SheetHelper.findWhere(SHEETS.CELL_MEMBERS, m => String(m.cellId) === String(cellId))
        .forEach(m => {
          SheetHelper.update(SHEETS.CELL_MEMBERS, m.id, {
            ...m,
            status: 'inactive',
            leftAt: _nowIso(),
          });
        });
      SheetHelper.evict(SHEETS.CELL_MEMBERS);
    } catch (_) {}
  }

  /** Elimina campos internos del payload */
  function _stripInternal(data) {
    const clean = { ...data };
    delete clean._userId;
    delete clean._token;
    return clean;
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
      Logger.log(`[CellService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    // Células
    getAllCells,
    getCellById,
    saveCell,
    removeCell,
    addCellMember,
    removeCellMember,
    getCellMembers,

    // Ministerios
    getAllMinistries,
    getMinistryById,
    getMinistryDetail,
    saveMinistry,
    removeMinistry,
    addMinistryMember,
    removeMinistryMember,
  };

})();