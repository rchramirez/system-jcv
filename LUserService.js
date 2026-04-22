// ============================================================
// JCV SYSTEM — UserService.gs
//
// Capa de dominio para Usuarios del sistema.
//
// Responsabilidades:
//   • CRUD con validación, hash de password y auditoría
//   • Asociación usuario ↔ persona (nuevo campo personId)
//   • Activar / desactivar usuario (status field)
//   • Cambio de contraseña autenticado
//   • Sanitización (nunca exponer hash de password al frontend)
//
// Dependencias:
//   ← Config.gs    (SHEETS, ROLES)
//   ← Utils.gs     (_validate, _validateId, _validateEnum,
//                   _newId, _buildAuditCreate, _buildAuditUpdate,
//                   _sanitizeUser, _nowIso, gvizQuery)
//   ← Auth.gs      (hashPassword — función de hashing)
//   ← SheetHelper  (DAO)
//   ← AuditService (log)
// ============================================================

const UserService = (() => {

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Retorna todos los usuarios sin campo password.
   * Usa GViz para lectura masiva inicial.
   *
   * @returns {Object[]} usuarios sanitizados
   */
  function getAll() {
    return gvizQuery(SHEETS.USERS, 'SELECT *').map(_sanitizeUser);
  }

  /**
   * Retorna un usuario por ID, sin password.
   *
   * @param {string} id
   * @returns {Object|null}
   */
  function getById(id) {
    const user = SheetHelper.getById(SHEETS.USERS, id);
    return user ? _sanitizeUser(user) : null;
  }

  /**
   * Retorna los datos completos del usuario (incluyendo persona asociada)
   * si tiene personId vinculado.
   * Útil para el perfil enriquecido en el frontend.
   *
   * @param {string} id
   * @returns {Object|null} usuario con datos de persona embebidos
   */
  function getProfile(id) {
    const user = SheetHelper.getById(SHEETS.USERS, id);
    if (!user) return null;

    const safe = _sanitizeUser(user);

    // Enriquecer con datos de persona si está vinculado
    if (user.personId) {
      const person = SheetHelper.getById(SHEETS.PEOPLE, user.personId);
      if (person) {
        safe.person = {
          id:        person.id,
          name:      person.name,
          lastName:  person.lastName,
          phone:     person.phone    || '',
          email:     person.email    || '',
          photoUrl:  person.photoUrl || '',
          birthDate: person.birthDate|| '',
          gender:    person.gender   || '',
          country:   person.country  || '',
          churchId:  person.churchId || '',
        };
        // Sincronizar foto del perfil desde la persona si el usuario no tiene
        if (!safe.photoUrl && person.photoUrl) {
          safe.photoUrl = person.photoUrl;
        }
      }
    }

    // Enriquecer con nombre del nexo
    if (user.churchId) {
      const church = SheetHelper.getById(SHEETS.CHURCHES, user.churchId);
      if (church) safe.churchName = church.name;
    }

    return safe;
  }

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Crea o actualiza un usuario del sistema.
   *
   * Reglas de negocio:
   *   1. name, username, role son requeridos
   *   2. password es requerido al crear; opcional al actualizar
   *      (vacío = mantener contraseña actual)
   *   3. password se hashea siempre antes de persistir
   *   4. Si viene personId, sincronizar name/email/photoUrl
   *      desde la persona vinculada
   *   5. role debe ser uno de ROLES válidos
   *
   * @param {Object} data   - datos del usuario (puede incluir _userId)
   * @param {string} userId - ID del usuario que opera (para auditoría)
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function save(data, userId) {
    _validate(data, ['name', 'username', 'role']);
    _validateEnum(
      data.role,
      Object.values(ROLES).concat(['admin', 'secretary', 'maestro']),
      'role'
    );

    const clean     = _stripInternal(data);
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    // Sincronizar datos desde persona vinculada si hay personId
    if (clean.personId) {
      _syncFromPerson(clean);
    }

    if (clean.id) {
      // UPDATE
      const existing = SheetHelper.getById(SHEETS.USERS, clean.id);
      if (!existing) throw new Error(`Usuario no encontrado: ${clean.id}`);

      // Mantener password actual si no se envió nueva
      if (!clean.password || String(clean.password).trim() === '') {
        clean.password = existing.password || '';
      } else {
        clean.password = hashPassword(clean.password);
      }

      const audit = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.USERS, clean.id, { ...clean, ...audit });
      SheetHelper.evict(SHEETS.USERS);

      AuditService.log('Usuarios', clean.id, 'UPDATE', userId, {
        username: clean.username, role: clean.role,
      }, actorUser);

      return { updated: true, id: clean.id };
    }

    // CREATE
    _validate(clean, ['password']);
    clean.password = hashPassword(clean.password);
    clean.status   = clean.status || 'active';

    const id    = _newId('u');
    const audit = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.USERS, { ...clean, id, ...audit });
    SheetHelper.evict(SHEETS.USERS);

    AuditService.log('Usuarios', id, 'CREATE', userId, {
      username: clean.username, role: clean.role,
    }, actorUser);

    return { created: true, id };
  }

  /**
   * Activa o desactiva un usuario.
   * No elimina el registro — soft enable/disable.
   *
   * @param {string}  id      - ID del usuario
   * @param {boolean} active  - true = activar, false = desactivar
   * @param {string}  userId  - para auditoría
   * @returns {{ updated: boolean, status: string }}
   */
  function setActive(id, active, userId) {
    _validateId(id, 'userId');
    const user = SheetHelper.getById(SHEETS.USERS, id);
    if (!user) throw new Error(`Usuario no encontrado: ${id}`);

    const status    = active ? 'active' : 'inactive';
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(user, userId, actorUser);

    SheetHelper.update(SHEETS.USERS, id, { ...user, status, ...audit });
    SheetHelper.evict(SHEETS.USERS);

    AuditService.log('Usuarios', id, active ? 'ACTIVATE' : 'DEACTIVATE', userId, {
      username: user.username,
    }, actorUser);

    return { updated: true, status };
  }

  /**
   * Elimina un usuario con soft-delete.
   * No borra la fila — marca deleted=true para mantener historial
   * en AuditLog y referencias en inscripciones.
   *
   * @param {string} id     - ID del usuario
   * @param {string} userId - para auditoría
   * @returns {{ deleted: boolean }}
   */
  function remove(id, userId) {
    _validateId(id, 'userId');
    const user = SheetHelper.getById(SHEETS.USERS, id);
    if (!user) throw new Error(`Usuario no encontrado: ${id}`);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    SheetHelper.softDelete(SHEETS.USERS, id, userId);
    SheetHelper.evict(SHEETS.USERS);

    AuditService.log('Usuarios', id, 'DELETE', userId, {
      username: user.username,
    }, actorUser);

    return { deleted: true };
  }

  // ── CAMBIO DE CONTRASEÑA ───────────────────────────────────

  /**
   * Cambia la contraseña del usuario autenticado.
   * Requiere verificar la contraseña actual antes de permitir el cambio.
   *
   * @param {string} userId          - ID del usuario que cambia su propia contraseña
   * @param {string} currentPassword - contraseña actual en texto plano
   * @param {string} newPassword     - nueva contraseña en texto plano
   * @returns {{ updated: boolean }}
   */
  function changePassword(userId, currentPassword, newPassword) {
    _validateId(userId, 'userId');
    if (!currentPassword) throw new Error('La contraseña actual es requerida');
    if (!newPassword)      throw new Error('La nueva contraseña es requerida');
    if (newPassword.length < AUTH_CONFIG.MIN_PASS_LENGTH) {
      throw new Error(
        `La nueva contraseña debe tener al menos ${AUTH_CONFIG.MIN_PASS_LENGTH} caracteres`
      );
    }

    const user = SheetHelper.getById(SHEETS.USERS, userId);
    if (!user) throw new Error(`Usuario no encontrado: ${userId}`);

    // Verificar contraseña actual
    const currentHash = hashPassword(currentPassword);
    if (user.password !== currentHash) {
      throw new Error('La contraseña actual no es correcta');
    }

    const audit = _buildAuditUpdate(user, userId, user);
    SheetHelper.update(SHEETS.USERS, userId, {
      ...user,
      password: hashPassword(newPassword),
      ...audit,
    });
    SheetHelper.evict(SHEETS.USERS);

    // Auditoría sin exponer el hash
    AuditService.log('Usuarios', userId, 'CHANGE_PASSWORD', userId, {}, user);

    return { updated: true };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Sincroniza name/email/photoUrl desde la persona vinculada.
   * Solo sobreescribe si el campo del usuario está vacío,
   * para no pisar datos que el admin haya editado manualmente.
   *
   * @param {Object} clean - objeto usuario mutable (modifica in-place)
   */
  function _syncFromPerson(clean) {
    try {
      const person = SheetHelper.getById(SHEETS.PEOPLE, clean.personId);
      if (!person) return;

      if (!clean.name)     clean.name     = `${person.name || ''} ${person.lastName || ''}`.trim();
      if (!clean.email)    clean.email    = person.email    || '';
      if (!clean.photoUrl) clean.photoUrl = person.photoUrl || '';
    } catch (_) {}
  }

  /** Elimina campos internos del payload */
  function _stripInternal(data) {
    const clean = { ...data };
    delete clean._userId;
    delete clean._token;
    return clean;
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    getAll,
    getById,
    getProfile,
    save,
    setActive,
    remove,
    changePassword,
  };

})();