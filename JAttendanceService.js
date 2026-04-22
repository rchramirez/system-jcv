// ============================================================
// JCV SYSTEM — AttendanceService.gs
//
// Capa de dominio para Asistencia.
//
// Responsabilidades:
//   • saveIndividual  — guarda o actualiza un registro
//   • saveBatch       — guarda N registros en 1 API call (LockService)
//   • getByClass      — asistencia de una clase
//   • getByEnrollment — historial completo del alumno
//   • Recálculo automático de nota de asistencia en Calificaciones
//   • Marcar clase como 'realizada' al tomar asistencia
//
// Performance crítica para UX:
//   saveBatch(20 alumnos):
//     v4: 20 inserts + 20 updates + 20 score updates = ~60 API calls ≈ 12s
//     v5: 1 batchInsert + 1 batchUpdate (scores)      =  ~2 API calls ≈ 0.8s
//
// Dependencias:
//   ← Config.gs    (SHEETS, ATTENDANCE_TYPES, SCORE_FIELDS)
//   ← Utils.gs     (_validate, _validateId, _validateEnum, _newId,
//                   _buildAuditCreate, _calcAttendanceScore, _nowIso)
//   ← SheetHelper  (DAO)
// ============================================================

const AttendanceService = (() => {

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Retorna todos los registros de asistencia de una clase.
   *
   * @param {string} classId
   * @returns {Object[]}
   */
  function getByClass(classId) {
    _validateId(classId, 'classId');
    return SheetHelper.findWhere(
      SHEETS.ATTENDANCE,
      a => String(a.classId) === String(classId)
    );
  }

  /**
   * Retorna el historial de asistencia de un alumno (por enrollmentId).
   * Incluye resumen { total, presente, ausente, justificado, tarde, pct }.
   *
   * @param {string} enrollmentId
   * @returns {{ records: Object[], summary: Object }}
   */
  function getByEnrollment(enrollmentId) {
    _validateId(enrollmentId, 'enrollmentId');
    const records = SheetHelper.findWhere(
      SHEETS.ATTENDANCE,
      a => String(a.enrollmentId) === String(enrollmentId)
    );
    return { records, summary: _summarize(records) };
  }

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Guarda o actualiza UN registro de asistencia individual.
   * Si ya existe un registro para (classId + personId), lo actualiza.
   *
   * @param {Object} data   - { classId, personId, enrollmentId, type, reason? }
   * @param {string} userId - para auditoría
   * @returns {{ saved: boolean, id: string }}
   */
  function saveIndividual(data, userId) {
    _validate(data, ['classId', 'personId', 'enrollmentId', 'type']);
    _validateEnum(data.type, ATTENDANCE_TYPES, 'type');

    const cls = SheetHelper.getById(SHEETS.CLASSES, data.classId);
    if (!cls) throw new Error(`Clase no encontrada: ${data.classId}`);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (data.id) {
      // UPDATE del registro existente
      const existing = SheetHelper.getById(SHEETS.ATTENDANCE, data.id);
      if (!existing) throw new Error(`Registro de asistencia no encontrado: ${data.id}`);
      const audit = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.ATTENDANCE, data.id, { ...data, ...audit });
    } else {
      // Buscar si ya existe para este alumno en esta clase
      const existing = SheetHelper.findOne(
        SHEETS.ATTENDANCE,
        a => a.classId       === data.classId  &&
             a.personId      === data.personId  &&
             a.enrollmentId  === data.enrollmentId
      );
      if (existing) {
        const audit = _buildAuditUpdate(existing, userId, actorUser);
        SheetHelper.update(SHEETS.ATTENDANCE, existing.id, {
          ...existing,
          type:   data.type,
          reason: data.reason || '',
          ...audit,
        });
        data.id = existing.id;
      } else {
        const audit = _buildAuditCreate(userId, actorUser);
        const id    = _newId('at');
        SheetHelper.insert(SHEETS.ATTENDANCE, {
          id,
          classId:      data.classId,
          personId:     data.personId,
          enrollmentId: data.enrollmentId,
          type:         data.type,
          reason:       data.reason || '',
          ...audit,
        });
        data.id = id;
      }
    }

    SheetHelper.evict(SHEETS.ATTENDANCE);

    // Recalcular nota de asistencia para el alumno
    _recalcForEnrollment(data.enrollmentId);

    return { saved: true, id: data.id };
  }

  /**
   * Guarda N registros de asistencia en una sola operación batch.
   * Re-toma de asistencia: elimina registros previos de la clase
   * y los reemplaza completos.
   *
   * Pipeline:
   *   1. Validar todos los registros antes de escribir
   *   2. Eliminar registros existentes de la clase (1 batch remove)
   *   3. Insertar nuevos registros (1 batchInsert)
   *   4. Marcar clase como 'realizada' si estaba 'programada'
   *   5. Recalcular notas de asistencia por grado (1 batchUpdate)
   *
   * @param {string}   classId - ID de la clase
   * @param {Object[]} records - [{ personId, enrollmentId, type, reason? }]
   * @param {string}   userId  - para auditoría
   * @returns {{ saved: number }}
   */
  function saveBatch(classId, records, userId) {
    _validateId(classId, 'classId');
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('Se requiere al menos un registro de asistencia');
    }

    const cls = SheetHelper.getById(SHEETS.CLASSES, classId);
    if (!cls) throw new Error(`Clase no encontrada: ${classId}`);

    // Validar todos los tipos antes de tocar la hoja
    records.forEach((r, i) => {
      if (!ATTENDANCE_TYPES.includes(r.type)) {
        throw new Error(
          `Registro ${i + 1}: tipo inválido "${r.type}". ` +
          `Valores: ${ATTENDANCE_TYPES.join(', ')}`
        );
      }
    });

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditCreate(userId, actorUser);

    // 1. Eliminar registros previos de esta clase
    const prevRecords = SheetHelper.findWhere(
      SHEETS.ATTENDANCE,
      a => String(a.classId) === String(classId)
    );
    prevRecords.forEach(a => {
      try { SheetHelper.remove(SHEETS.ATTENDANCE, a.id); } catch (_) {}
    });

    // 2. Insertar nuevos en batch (1 API call)
    const rows = records.map(r => ({
      id:           _newId('at'),
      classId,
      personId:     r.personId,
      enrollmentId: r.enrollmentId,
      type:         r.type,
      reason:       r.reason || '',
      ...audit,
    }));
    SheetHelper.batchInsert(SHEETS.ATTENDANCE, rows);
    SheetHelper.evict(SHEETS.ATTENDANCE);

    // 3. Marcar clase como 'realizada' (si estaba 'programada')
    if (cls.status === 'programada') {
      SheetHelper.update(SHEETS.CLASSES, classId, {
        ...cls,
        status:    'realizada',
        updatedAt: _nowIso(),
        updatedBy: userId || '',
      });
      SheetHelper.evict(SHEETS.CLASSES);
    }

    // 4. Recalcular notas de asistencia para todos los alumnos del grado
    _recalcByGrade(cls.grade);

    return { saved: rows.length };
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Calcula estadísticas de asistencia a partir de un array de registros.
   */
  function _summarize(records) {
    const total       = records.length;
    const presente    = records.filter(a => a.type === 'Presente').length;
    const ausente     = records.filter(a => a.type === 'Ausente').length;
    const justificado = records.filter(a => a.type === 'Justificado').length;
    const tarde       = records.filter(a => a.type === 'Tarde').length;
    const valid       = presente + tarde + justificado;
    const pct         = total > 0 ? Math.round((valid / total) * 100) : 0;
    const nota        = _calcAttendanceScore(records);
    return { total, presente, ausente, justificado, tarde, pct, nota };
  }

  /**
   * Recalcula la nota de asistencia de UN alumno y la persiste
   * en su fila de Calificaciones.
   *
   * @param {string} enrollmentId
   */
  function _recalcForEnrollment(enrollmentId) {
    try {
      const records = SheetHelper.findWhere(
        SHEETS.ATTENDANCE,
        a => String(a.enrollmentId) === String(enrollmentId)
      );
      const nota      = _calcAttendanceScore(records);
      const scoreRow  = SheetHelper.findOne(
        SHEETS.SCORES,
        s => String(s.enrollmentId) === String(enrollmentId)
      );
      if (!scoreRow) return;
      SheetHelper.update(SHEETS.SCORES, scoreRow.id, {
        ...scoreRow,
        asistencia: nota,
        updatedAt:  _nowIso(),
      });
      SheetHelper.evict(SHEETS.SCORES);
    } catch (e) {
      Logger.log(`[AttendanceService] _recalcForEnrollment error: ${e.message}`);
    }
  }

  /**
   * Recalcula la nota de asistencia para TODOS los alumnos activos
   * de un grado. Usa batchUpdate para minimizar API calls.
   *
   * @param {string} grade - clave de GRADES
   */
  function _recalcByGrade(grade) {
    try {
      const enrollments = SheetHelper.findWhere(
        SHEETS.ENROLLMENTS,
        e => e.grade === grade &&
             (e.status === 'activo' || e.status === 'active')
      );
      if (!enrollments.length) return;

      const allAtt    = SheetHelper.getAll(SHEETS.ATTENDANCE);
      const allScores = SheetHelper.getAll(SHEETS.SCORES);
      const now       = _nowIso();

      const scoreUpdates = [];

      enrollments.forEach(enr => {
        const records  = allAtt.filter(
          a => String(a.enrollmentId) === String(enr.id)
        );
        if (!records.length) return;

        const nota     = _calcAttendanceScore(records);
        const scoreRow = allScores.find(
          s => String(s.enrollmentId) === String(enr.id)
        );
        if (!scoreRow) return;

        scoreUpdates.push({
          ...scoreRow,
          asistencia: nota,
          updatedAt:  now,
        });
      });

      if (scoreUpdates.length) {
        SheetHelper.batchUpdate(SHEETS.SCORES, scoreUpdates);
        SheetHelper.evict(SHEETS.SCORES);
      }
    } catch (e) {
      Logger.log(`[AttendanceService] _recalcByGrade error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    getByClass,
    getByEnrollment,
    saveIndividual,
    saveBatch,
  };

})();