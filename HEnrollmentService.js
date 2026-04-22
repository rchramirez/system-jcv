// ============================================================
// JCV SYSTEM — EnrollmentService.gs
//
// Capa de dominio para Inscripciones y Períodos académicos.
//
// Responsabilidades:
//   • Inscripción con validación de prerequisitos
//   • Baja (soft-delete) con motivo controlado
//   • Cambio de estado (aprobado / desaprobado / suspendido)
//   • Egreso masivo por grado
//   • Queries: getAll (agrupado), getByGrade (GViz), getSchoolData
//   • CRUD de Períodos académicos
//
// Formato de salida:
//   Los métodos de lectura devuelven inscripciones en el formato
//   esperado por el frontend v4: { [grade]: [{ personId, enrollmentId,
//   status, scores, ... }] } — retrocompatibilidad total.
//
// Dependencias:
//   ← Config.gs    (SHEETS, GRADES, GRADE_KEYS, SCORE_FIELDS,
//                   ENROLLMENT_STATUS, DROP_REASONS, PASSING_GRADE)
//   ← Utils.gs     (_validate, _validateId, _validateEnum, _newId,
//                   _buildAuditCreate, _buildAuditUpdate, _nowIso,
//                   _calcAverage, _isComplete, gvizQuery)
//   ← SheetHelper  (DAO)
// ============================================================

const EnrollmentService = (() => {

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN A — PERÍODOS ACADÉMICOS
  // ══════════════════════════════════════════════════════════════

  /**
   * Retorna todos los períodos ordenados: activo primero,
   * luego por año/semestre descendente.
   *
   * @returns {Object[]}
   */
  function getAllPeriods() {
    return SheetHelper.getAll(SHEETS.PERIODS).sort((a, b) => {
      if (a.status === 'active'  && b.status !== 'active')  return -1;
      if (b.status === 'active'  && a.status !== 'active')  return 1;
      // Legacy status
      if (a.status === 'activo'  && b.status !== 'activo')  return -1;
      if (b.status === 'activo'  && a.status !== 'activo')  return 1;
      const ay = parseInt(a.year || 0) * 10 + parseInt(a.semester || 0);
      const by = parseInt(b.year || 0) * 10 + parseInt(b.semester || 0);
      return by - ay;
    });
  }

  /**
   * Retorna el período activo según fecha actual.
   * Un período activo tiene status='active'|'activo' y fechas que
   * engloban hoy. Si hay varios activos (error de datos), retorna el primero.
   *
   * @returns {Object|null}
   */
  function getCurrentPeriod() {
    const now = new Date();
    return SheetHelper.getAll(SHEETS.PERIODS).find(p => {
      if (p.status !== 'active' && p.status !== 'activo') return false;
      const start = p.startDate ? new Date(p.startDate) : null;
      const end   = p.endDate   ? new Date(p.endDate)   : null;
      if (start && now < start) return false;
      if (end   && now > end)   return false;
      return true;
    }) || null;
  }

  /**
   * Crea o actualiza un período académico.
   * Si se activa un período, desactiva todos los demás (solo uno activo).
   *
   * @param {Object} data   - { name, year, semester, startDate, endDate, status }
   * @param {string} userId - para auditoría
   * @returns {{ id: string, created?: boolean, updated?: boolean }}
   */
  function savePeriod(data, userId) {
    _validate(data, ['name', 'year', 'semester', 'startDate', 'endDate']);

    const id = data.id || _newId('per');

    // Un solo período activo: desactivar los demás
    if (data.status === 'active' || data.status === 'activo') {
      SheetHelper.getAll(SHEETS.PERIODS)
        .filter(p => p.id !== id && (p.status === 'active' || p.status === 'activo'))
        .forEach(p => {
          SheetHelper.update(SHEETS.PERIODS, p.id, { ...p, status: 'closed' });
        });
      SheetHelper.evict(SHEETS.PERIODS);
    }

    const record = {
      id,
      name:      data.name,
      year:      data.year,
      semester:  data.semester,
      startDate: data.startDate,
      endDate:   data.endDate,
      status:    data.status || 'closed',
    };

    if (data.id) {
      SheetHelper.update(SHEETS.PERIODS, id, record);
      _audit('Periodos', id, 'UPDATE', userId, null, { name: data.name });
      return { updated: true, id };
    }

    record.createdAt = _nowIso();
    SheetHelper.insert(SHEETS.PERIODS, record);
    _audit('Periodos', id, 'CREATE', userId, null, { name: data.name });
    return { created: true, id };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN B — LECTURA DE INSCRIPCIONES
  // ══════════════════════════════════════════════════════════════

  /**
   * Retorna TODAS las inscripciones agrupadas por grado, con scores
   * embebidos. Formato exacto que espera el frontend v4.
   *
   * @returns {{ [grade]: EnrollmentRow[] }}
   */
  function getAll() {
    const enrollments = SheetHelper.getAll(SHEETS.ENROLLMENTS);
    const scoreMap    = _buildScoreMap(enrollments.map(e => e.id));
    const result      = Object.fromEntries(GRADE_KEYS.map(g => [g, []]));

    enrollments.forEach(e => {
      if (!result[e.grade]) return;
      result[e.grade].push(_formatEnrollment(e, scoreMap));
    });

    return result;
  }

  /**
   * Retorna las inscripciones de UN SOLO grado usando GViz WHERE.
   * ~60-80% menos filas leídas vs getAll() para roles no-admin.
   *
   * @param {string} grade - clave de GRADES
   * @returns {{ [grade]: EnrollmentRow[] }}
   */
  function getByGrade(grade) {
    if (!grade || !GRADES[grade]) throw new Error(`Grado inválido: ${grade}`);

    // GViz WHERE — columna C = 'grade' en Inscripciones
    const enrollments = gvizQuery(
      SHEETS.ENROLLMENTS,
      `SELECT * WHERE C = '${grade}' LABEL C 'grade'`
    );
    if (!enrollments.length) return { [grade]: [] };

    const scoreMap = _buildScoreMap(enrollments.map(e => e.id));
    return { [grade]: enrollments.map(e => _formatEnrollment(e, scoreMap)) };
  }

  /**
   * UN SOLO RPC que devuelve TODO lo necesario para renderizar
   * la página Escuelas: enrollments, people, classes, attendance,
   * questionnaires, users, currentSemester.
   *
   * Antes: 6 RPCs en serie → ~8-12s
   * Ahora: 1 RPC          → ~2-3s
   *
   * @param {string} grade - grado específico ('' = todos para admin)
   * @returns {SchoolDataPayload}
   */
  function getSchoolData(grade) {
    const isAll = !grade;

    // ── 1. Inscripciones (filtradas por grado si aplica)
    let enrollments;
    if (grade && GRADES[grade]) {
      enrollments = gvizQuery(
        SHEETS.ENROLLMENTS,
        `SELECT * WHERE C = '${grade}' LABEL C 'grade'`
      );
    } else {
      enrollments = SheetHelper.getAll(SHEETS.ENROLLMENTS);
    }

    const enrollIds  = new Set(enrollments.map(e => e.id).filter(Boolean));
    const scoreMap   = _buildScoreMap([...enrollIds]);

    // Agrupar por grado
    const grouped = Object.fromEntries(GRADE_KEYS.map(g => [g, []]));
    enrollments.forEach(e => {
      if (!grouped[e.grade]) return;
      grouped[e.grade].push(_formatEnrollment(e, scoreMap));
    });

    // ── 2. Personas — solo las que aparecen en inscripciones
    const personIds = new Set(enrollments.map(e => e.personId).filter(Boolean));
    const people    = SheetHelper.getAll(SHEETS.PEOPLE)
      .filter(p => personIds.has(p.id));

    // ── 3. Clases (filtradas por grado)
    let classes;
    if (grade) {
      // columna B = grade en Clases
      classes = gvizQuery(
        SHEETS.CLASSES,
        `SELECT * WHERE B = '${grade}' LABEL B 'grade'`
      );
    } else {
      classes = SheetHelper.getAll(SHEETS.CLASSES);
    }

    const classIds = new Set(classes.map(c => c.id).filter(Boolean));

    // ── 4. Asistencia (solo de las clases del grado)
    const attendance = SheetHelper.getAll(SHEETS.ATTENDANCE)
      .filter(a => classIds.has(a.classId));

    // ── 5. Cuestionarios (solo de las clases del grado)
    const questionnaires = SheetHelper.getAll(SHEETS.QUESTIONNAIRES)
      .filter(q => classIds.has(q.classId));

    // ── 6. Usuarios staff del grado (sin password)
    const users = SheetHelper.getAll(SHEETS.USERS)
      .filter(u => !grade || u.assignedGrade === grade || u.role === 'admin')
      .map(u => { const { password, ...safe } = u; return safe; });

    // ── 7. Período activo
    const currentSemester = getCurrentPeriod() || {};

    return {
      enrollments:     grouped,
      people,
      classes,
      attendance,
      questionnaires,
      users,
      currentSemester,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN C — ESCRITURA DE INSCRIPCIONES
  // ══════════════════════════════════════════════════════════════

  /**
   * Inscribe a una persona en un grado.
   *
   * Reglas de negocio:
   *   1. No duplicar: si ya tiene inscripción activa en el grado → error
   *   2. Validar prerequisito del grado
   *   3. Crear fila de Calificaciones vacía automáticamente
   *   4. Asociar al período activo si existe
   *
   * @param {string} personId - ID de la persona
   * @param {string} grade    - clave de GRADES
   * @param {string} userId   - para auditoría
   * @returns {{ enrollmentId: string, created: boolean }}
   */
  function enroll(personId, grade, userId) {
    _validateId(personId, 'personId');
    if (!GRADES[grade]) throw new Error(`Grado inválido: ${grade}`);

    // No duplicar inscripciones activas
    const existingActive = SheetHelper.findOne(
      SHEETS.ENROLLMENTS,
      e => e.personId === personId &&
           e.grade    === grade    &&
           e.status   !== ENROLLMENT_STATUS.BAJA &&
           e.status   !== ENROLLMENT_STATUS.DROPPED &&
           e.status   !== 'baja' &&
           e.status   !== 'dropped'
    );
    if (existingActive) {
      throw new Error('La persona ya está inscripta activamente en este grado');
    }

    // Validar prerequisitos de dominio
    _checkPrerequisite(personId, grade);

    const period    = getCurrentPeriod();
    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditCreate(userId, actorUser);
    const id        = _newId('e');

    SheetHelper.insert(SHEETS.ENROLLMENTS, {
      id,
      personId,
      grade,
      status:     ENROLLMENT_STATUS.ACTIVO,
      period:     period ? period.id : '',
      periodId:   period ? period.id : '',
      enrolledAt: _nowIso(),
      completedAt:'',
      droppedAt:  '',
      dropReason: '',
      dropDetail: '',
      dropBy:     '',
      // Legacy baja fields
      bajaAt:     '',
      bajaMotivo: '',
      bajaDetail: '',
      bajaBy:     '',
      ...audit,
    });

    // Crear fila de Calificaciones vacía — siempre acompañan a la inscripción
    const scoreId    = _newId('s');
    const emptyScore = { id: scoreId, enrollmentId: id, finalScore: '', ...audit };
    SCORE_FIELDS.forEach(f => { emptyScore[f] = ''; });
    SheetHelper.insert(SHEETS.SCORES, emptyScore);

    SheetHelper.evict(SHEETS.ENROLLMENTS);
    SheetHelper.evict(SHEETS.SCORES);

    _audit('Inscripciones', id, 'ENROLL', userId, actorUser, {
      personId, grade, period: period ? period.id : '',
    });

    return { created: true, enrollmentId: id };
  }

  /**
   * Da de baja a un alumno (soft-delete de la inscripción).
   * Registra motivo controlado y detalle libre.
   *
   * @param {string} enrollmentId - ID de la inscripción
   * @param {string} motivo       - clave de DROP_REASONS
   * @param {string} detail       - texto libre opcional
   * @param {string} userId       - para auditoría
   * @returns {{ updated: boolean }}
   */
  function drop(enrollmentId, motivo, detail, userId) {
    _validateId(enrollmentId, 'enrollmentId');

    const enr = SheetHelper.getById(SHEETS.ENROLLMENTS, enrollmentId);
    if (!enr) throw new Error(`Inscripción no encontrada: ${enrollmentId}`);
    if (enr.status === 'baja' || enr.status === 'dropped') {
      throw new Error('El alumno ya fue dado de baja');
    }

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(enr, userId, actorUser);
    const now       = _nowIso();

    SheetHelper.update(SHEETS.ENROLLMENTS, enrollmentId, {
      ...enr,
      status:     ENROLLMENT_STATUS.BAJA,
      bajaAt:     now,
      bajaMotivo: motivo || 'otro',
      bajaDetail: detail || '',
      bajaBy:     userId || '',
      // Nuevo schema
      droppedAt:  now,
      dropReason: motivo || 'otro',
      dropDetail: detail || '',
      dropBy:     userId || '',
      ...audit,
    });

    SheetHelper.evict(SHEETS.ENROLLMENTS);

    _audit('Inscripciones', enrollmentId, 'BAJA', userId, actorUser, {
      personId: enr.personId, grade: enr.grade, motivo, detail,
    });

    return { updated: true };
  }

  /**
   * Cambia el estado de una inscripción (approved / failed / suspended).
   * Usado por egreso individual y masivo.
   *
   * @param {string} enrollmentId - ID de la inscripción
   * @param {string} status       - nuevo estado
   * @param {string} periodId     - ID del período (opcional)
   * @param {string} userId       - para auditoría
   * @returns {{ updated: boolean, status: string }}
   */
  function setStatus(enrollmentId, status, periodId, userId) {
    _validateId(enrollmentId, 'enrollmentId');

    const VALID_TRANSITIONS = [
      ENROLLMENT_STATUS.APROBADO,
      ENROLLMENT_STATUS.DESAPROBADO,
      ENROLLMENT_STATUS.SUSPENDIDO,
      // Nuevo schema
      'approved', 'failed', 'suspended',
    ];
    _validateEnum(status, VALID_TRANSITIONS, 'status');

    const enr = SheetHelper.getById(SHEETS.ENROLLMENTS, enrollmentId);
    if (!enr) throw new Error(`Inscripción no encontrada: ${enrollmentId}`);
    if (enr.status === 'baja' || enr.status === 'dropped') {
      throw new Error('No se puede cambiar el estado de un alumno dado de baja');
    }

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(enr, userId, actorUser);

    SheetHelper.update(SHEETS.ENROLLMENTS, enrollmentId, {
      ...enr,
      status,
      period:      periodId || enr.period    || '',
      periodId:    periodId || enr.periodId  || '',
      completedAt: _nowIso(),
      ...audit,
    });

    SheetHelper.evict(SHEETS.ENROLLMENTS);

    _audit('Inscripciones', enrollmentId, 'STATUS_CHANGE', userId, actorUser, {
      from: enr.status, to: status, periodId,
    });

    return { updated: true, status };
  }

  /**
   * Egreso masivo: cambia el estado de todos los alumnos con notas
   * completas en un grado. Aprobados → 'aprobado', otros → 'baja/reprobo'.
   * Usa batchUpdate para mínimos API calls.
   *
   * @param {string} grade    - grado a egresar
   * @param {string} periodId - período al que se asocia el egreso
   * @param {string} userId   - para auditoría
   * @returns {{ processed: number, approved: number, failed: number }}
   */
  function bulkGraduate(grade, periodId, userId) {
    if (!GRADES[grade]) throw new Error(`Grado inválido: ${grade}`);

    const enrollments = SheetHelper.findWhere(
      SHEETS.ENROLLMENTS,
      e => e.grade === grade &&
           (e.status === ENROLLMENT_STATUS.ACTIVO || e.status === 'activo')
    );
    if (!enrollments.length) return { processed: 0, approved: 0, failed: 0 };

    const enrollIds = enrollments.map(e => e.id);
    const scoreMap  = _buildScoreMap(enrollIds);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const now       = _nowIso();

    let approved = 0, failed = 0;
    const updates = [];

    enrollments.forEach(enr => {
      const sc = scoreMap[enr.id];
      if (!sc || !_isComplete(sc)) return; // sin notas completas → skip

      const avg     = _calcAverage(sc);
      const newStat = avg >= PASSING_GRADE
        ? ENROLLMENT_STATUS.APROBADO
        : ENROLLMENT_STATUS.DESAPROBADO;
      const audit   = _buildAuditUpdate(enr, userId, actorUser);

      updates.push({
        ...enr,
        id:          enr.id,
        status:      newStat,
        period:      periodId || enr.period   || '',
        periodId:    periodId || enr.periodId || '',
        completedAt: now,
        ...audit,
      });

      if (newStat === ENROLLMENT_STATUS.APROBADO) approved++;
      else failed++;
    });

    if (updates.length) {
      SheetHelper.batchUpdate(SHEETS.ENROLLMENTS, updates);
      SheetHelper.evict(SHEETS.ENROLLMENTS);
    }

    _audit('Inscripciones', grade, 'BULK_GRADUATE', userId, actorUser, {
      grade, periodId, processed: updates.length, approved, failed,
    });

    return { processed: updates.length, approved, failed };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN D — PRIVADOS
  // ══════════════════════════════════════════════════════════════

  /**
   * Valida prerequisitos para inscribirse en un grado.
   * - Escuela de Vida: requiere attendedEncounter = true
   * - Grados superiores: requiere haber aprobado el grado previo
   */
  function _checkPrerequisite(personId, grade) {
    const prereq = GRADES[grade] && GRADES[grade].prereq;

    if (!prereq) {
      // Escuela de Vida — requiere Encuentro
      const person = SheetHelper.getById(SHEETS.PEOPLE, personId);
      if (!person) throw new Error(`Persona no encontrada: ${personId}`);
      const attended = String(person.attendedEncounter).toLowerCase();
      if (attended !== 'true') {
        throw new Error(
          'La persona debe haber asistido al Encuentro ' +
          'para inscribirse en Escuela de Vida'
        );
      }
      return;
    }

    // Grados superiores — requiere aprobar el prerequisito
    const prereqEnr = SheetHelper.findOne(
      SHEETS.ENROLLMENTS,
      e => e.personId === personId && e.grade === prereq
    );
    if (!prereqEnr) {
      throw new Error(`Debe completar ${GRADES[prereq].label} primero`);
    }

    const sc = SheetHelper.findOne(
      SHEETS.SCORES,
      s => s.enrollmentId === prereqEnr.id
    );
    if (!sc || !_isComplete(sc) || _calcAverage(sc) < PASSING_GRADE) {
      throw new Error(`Debe aprobar ${GRADES[prereq].label} antes de continuar`);
    }
  }

  /**
   * Construye un mapa enrollmentId → { campo: valor } para scores.
   * Lee SCORES una sola vez y filtra en memoria.
   * Con CacheService activo, la segunda llamada es 0 API calls.
   *
   * @param {string[]} enrollIds
   * @returns {Object} mapa de scores
   */
  function _buildScoreMap(enrollIds) {
    if (!enrollIds || !enrollIds.length) return {};
    const idSet    = new Set(enrollIds);
    const scoreMap = {};

    SheetHelper.getAll(SHEETS.SCORES)
      .filter(s => idSet.has(s.enrollmentId))
      .forEach(s => {
        scoreMap[s.enrollmentId] = scoreMap[s.enrollmentId] || {};
        SCORE_FIELDS.forEach(f => {
          scoreMap[s.enrollmentId][f] = s[f] !== undefined ? s[f] : '';
        });
      });

    return scoreMap;
  }

  /**
   * Formatea una fila de Inscripciones al shape exacto
   * que espera el frontend v4 (retrocompatibilidad total).
   */
  function _formatEnrollment(e, scoreMap) {
    return {
      personId:      e.personId,
      enrollmentId:  e.id,
      status:        e.status        || ENROLLMENT_STATUS.ACTIVO,
      period:        e.period        || e.periodId  || '',
      enrolledAt:    e.enrolledAt    || '',
      bajaAt:        e.bajaAt        || e.droppedAt || '',
      bajaMotivo:    e.bajaMotivo    || e.dropReason|| '',
      bajaDetail:    e.bajaDetail    || e.dropDetail|| '',
      bajaBy:        e.bajaBy        || e.dropBy    || '',
      createdAt:     e.createdAt     || '',
      createdBy:     e.createdBy     || '',
      createdByName: e.createdByName || '',
      updatedAt:     e.updatedAt     || '',
      updatedBy:     e.updatedBy     || '',
      updatedByName: e.updatedByName || '',
      scores: scoreMap[e.id] ||
              Object.fromEntries(SCORE_FIELDS.map(f => [f, ''])),
    };
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
        userRole:  user ? (user.role || '') : '',
        meta:      meta ? JSON.stringify(meta) : '{}',
        timestamp: _nowIso(),
      });
    } catch (e) {
      Logger.log(`[EnrollmentService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    // Períodos
    getAllPeriods,
    getCurrentPeriod,
    savePeriod,

    // Lectura inscripciones
    getAll,
    getByGrade,
    getSchoolData,

    // Escritura inscripciones
    enroll,
    drop,
    setStatus,
    bulkGraduate,
  };

})();