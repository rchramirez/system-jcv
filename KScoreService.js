// ============================================================
// JCV SYSTEM — ScoreService.gs
//
// Capa de dominio para Calificaciones y Cuestionarios.
//
// Responsabilidades — Calificaciones:
//   • saveScores      — actualiza campos parciales de calificaciones
//   • getByEnrollment — retorna scores de un alumno
//   • _recalcFinal    — recalcula finalScore al guardar notas
//
// Responsabilidades — Cuestionarios:
//   • save            — crea/actualiza cuestionario
//   • submit          — marca como entregado con nota
//   • remove          — elimina y recalcula promedio
//   • getByClass      — cuestionarios de una clase
//   • getByEnrollment — cuestionarios de un alumno
//   • Recálculo automático de nota de cuestionarios en Calificaciones
//
// Dependencias:
//   ← Config.gs    (SHEETS, SCORE_FIELDS, PASSING_GRADE)
//   ← Utils.gs     (_validate, _validateId, _newId,
//                   _buildAuditCreate, _buildAuditUpdate,
//                   _calcAverage, _isComplete,
//                   _calcQuestScore, _nowIso)
//   ← SheetHelper  (DAO)
// ============================================================

const ScoreService = (() => {

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN A — CALIFICACIONES
  // ══════════════════════════════════════════════════════════════

  /**
   * Retorna los scores de una inscripción.
   * Si no existe la fila (nunca debería pasar, se crea al inscribir),
   * retorna un objeto vacío con todos los campos en ''.
   *
   * @param {string} enrollmentId
   * @returns {Object} fila de Calificaciones
   */
  function getScoreByEnrollment(enrollmentId) {
    _validateId(enrollmentId, 'enrollmentId');
    const row = SheetHelper.findOne(
      SHEETS.SCORES,
      s => String(s.enrollmentId) === String(enrollmentId)
    );
    if (!row) {
      return {
        enrollmentId,
        ...Object.fromEntries(SCORE_FIELDS.map(f => [f, ''])),
        finalScore: '',
      };
    }
    return row;
  }

  /**
   * Actualiza campos de calificaciones (partial update).
   * Solo sobreescribe los campos que vienen en scoresData.
   * Recalcula finalScore automáticamente si quedan notas completas.
   *
   * @param {string} enrollmentId - ID de la inscripción
   * @param {Object} scoresData   - { tp1?, examen1?, tp2?, examen2?, ... }
   * @param {string} userId       - para auditoría
   * @returns {{ updated: boolean, finalScore: number|'' }}
   */
  function saveScores(enrollmentId, scoresData, userId) {
    _validateId(enrollmentId, 'enrollmentId');

    const existing = SheetHelper.findOne(
      SHEETS.SCORES,
      s => String(s.enrollmentId) === String(enrollmentId)
    );
    if (!existing) throw new Error(`Calificaciones no encontradas para inscripción: ${enrollmentId}`);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(existing, userId, actorUser);

    // Aplicar solo los campos que vienen en scoresData
    const updated = { ...existing, ...audit };
    SCORE_FIELDS.forEach(f => {
      if (scoresData[f] !== undefined) updated[f] = scoresData[f];
    });

    // Recalcular finalScore si las notas están completas
    const finalScore = _isComplete(updated) ? _calcAverage(updated) : '';
    updated.finalScore = finalScore;

    SheetHelper.update(SHEETS.SCORES, existing.id, updated);
    SheetHelper.evict(SHEETS.SCORES);

    _audit('Calificaciones', existing.id, 'UPDATE', userId, actorUser, {
      enrollmentId, fields: Object.keys(scoresData),
    });

    return { updated: true, finalScore };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN B — CUESTIONARIOS
  // ══════════════════════════════════════════════════════════════

  /**
   * Retorna los cuestionarios de una clase específica.
   *
   * @param {string} classId
   * @returns {Object[]}
   */
  function getByClass(classId) {
    _validateId(classId, 'classId');
    return SheetHelper.findWhere(
      SHEETS.QUESTIONNAIRES,
      q => String(q.classId) === String(classId)
    );
  }

  /**
   * Retorna los cuestionarios de un alumno específico.
   *
   * @param {string} enrollmentId
   * @returns {Object[]}
   */
  function getByEnrollment(enrollmentId) {
    _validateId(enrollmentId, 'enrollmentId');
    return SheetHelper.findWhere(
      SHEETS.QUESTIONNAIRES,
      q => String(q.enrollmentId) === String(enrollmentId)
    );
  }

  /**
   * Crea o actualiza un cuestionario.
   * Recalcula la nota de cuestionarios en Calificaciones tras guardar.
   *
   * @param {Object} data   - { classId, title, personId, enrollmentId?,
   *                           grade?, totalItems?, dueDate?, status? }
   * @param {string} userId - para auditoría
   * @returns {{ saved: boolean, id: string }}
   */
  function saveQuestionnaire(data, userId) {
    _validate(data, ['classId', 'title', 'personId']);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;

    if (data.id) {
      const existing = SheetHelper.getById(SHEETS.QUESTIONNAIRES, data.id);
      if (!existing) throw new Error(`Cuestionario no encontrado: ${data.id}`);
      const audit = _buildAuditUpdate(existing, userId, actorUser);
      SheetHelper.update(SHEETS.QUESTIONNAIRES, data.id, { ...data, ...audit });
      SheetHelper.evict(SHEETS.QUESTIONNAIRES);
      _recalcQuestScore(data.personId, data.enrollmentId || existing.enrollmentId);
      return { saved: true, id: data.id };
    }

    const id    = _newId('q');
    const audit = _buildAuditCreate(userId, actorUser);
    SheetHelper.insert(SHEETS.QUESTIONNAIRES, {
      ...data,
      id,
      status:      data.status || 'pendiente',
      score:       '',
      submittedAt: '',
      ...audit,
    });
    SheetHelper.evict(SHEETS.QUESTIONNAIRES);

    // Recalcular tras crear (puede ser un cuestionario vencido → 0)
    if (data.enrollmentId) {
      _recalcQuestScore(data.personId, data.enrollmentId);
    }

    return { saved: true, id };
  }

  /**
   * Marca un cuestionario como entregado y registra la nota.
   * Valida que la nota esté en [0, 10].
   * Recalcula el promedio de cuestionarios en Calificaciones.
   *
   * @param {string}        questionnaireId
   * @param {number|string} score  - nota entre 0 y 10
   * @param {string}        userId - para auditoría
   * @returns {{ saved: boolean }}
   */
  function submitQuestionnaire(questionnaireId, score, userId) {
    _validateId(questionnaireId, 'questionnaireId');

    const numScore = parseFloat(score);
    if (isNaN(numScore) || numScore < 0 || numScore > 10) {
      throw new Error('La nota debe ser un número entre 0 y 10');
    }

    const q = SheetHelper.getById(SHEETS.QUESTIONNAIRES, questionnaireId);
    if (!q) throw new Error(`Cuestionario no encontrado: ${questionnaireId}`);

    const actorUser = userId ? SheetHelper.getById(SHEETS.USERS, userId) : null;
    const audit     = _buildAuditUpdate(q, userId, actorUser);

    SheetHelper.update(SHEETS.QUESTIONNAIRES, questionnaireId, {
      ...q,
      status:      'entregado',
      score:       String(numScore),
      // Campo legacy 'nota' para retrocompatibilidad con frontend v4
      nota:        String(numScore),
      submittedAt: _nowIso(),
      ...audit,
    });
    SheetHelper.evict(SHEETS.QUESTIONNAIRES);

    _recalcQuestScore(q.personId, q.enrollmentId);

    return { saved: true };
  }

  /**
   * Elimina un cuestionario y recalcula el promedio.
   *
   * @param {string} id     - ID del cuestionario
   * @param {string} userId - para auditoría
   * @returns {{ deleted: boolean }}
   */
  function removeQuestionnaire(id, userId) {
    _validateId(id, 'questionnaireId');
    const q = SheetHelper.getById(SHEETS.QUESTIONNAIRES, id);
    if (!q) throw new Error(`Cuestionario no encontrado: ${id}`);

    SheetHelper.remove(SHEETS.QUESTIONNAIRES, id);
    SheetHelper.evict(SHEETS.QUESTIONNAIRES);

    // Recalcular tras eliminar
    if (q.enrollmentId) {
      _recalcQuestScore(q.personId, q.enrollmentId);
    }

    return { deleted: true };
  }

  // ══════════════════════════════════════════════════════════════
  // SECCIÓN C — PRIVADOS: RECÁLCULO
  // ══════════════════════════════════════════════════════════════

  /**
   * Recalcula la nota de cuestionarios de UN alumno y la persiste
   * en su fila de Calificaciones (campo 'cuestionario').
   *
   * Algoritmo:
   *   • Cuestionarios entregados con nota → se promedia su score
   *   • Cuestionarios vencidos sin entregar → cuentan como 0
   *   • Cuestionarios pendientes no vencidos → no cuentan aún
   *   • Si no hay cuestionarios computables → deja el campo sin cambio
   *
   * @param {string} personId     - ID de la persona
   * @param {string} enrollmentId - ID de la inscripción
   */
  function _recalcQuestScore(personId, enrollmentId) {
    try {
      if (!enrollmentId && personId) {
        // Fallback: buscar enrollmentId desde Inscripciones
        const enr = SheetHelper.findOne(
          SHEETS.ENROLLMENTS,
          e => e.personId === personId
        );
        if (enr) enrollmentId = enr.id;
      }
      if (!enrollmentId) return;

      const questionnaires = SheetHelper.findWhere(
        SHEETS.QUESTIONNAIRES,
        q => String(q.enrollmentId) === String(enrollmentId) ||
             String(q.personId)     === String(personId)
      );
      if (!questionnaires.length) return;

      const nota = _calcQuestScore(questionnaires);
      if (nota === 0 && questionnaires.every(q => q.status === 'pendiente')) return;

      const scoreRow = SheetHelper.findOne(
        SHEETS.SCORES,
        s => String(s.enrollmentId) === String(enrollmentId)
      );
      if (!scoreRow) return;

      SheetHelper.update(SHEETS.SCORES, scoreRow.id, {
        ...scoreRow,
        cuestionario: nota,
        updatedAt:    _nowIso(),
      });
      SheetHelper.evict(SHEETS.SCORES);
    } catch (e) {
      Logger.log(`[ScoreService] _recalcQuestScore error: ${e.message}`);
    }
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
      Logger.log(`[ScoreService] AuditLog error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    // Calificaciones
    getScoreByEnrollment,
    saveScores,

    // Cuestionarios
    getByClass,
    getByEnrollment,
    saveQuestionnaire,
    submitQuestionnaire,
    removeQuestionnaire,
  };

})();