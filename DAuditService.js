// ============================================================
// JCV SYSTEM — AuditService.gs
//
// Capa de dominio para Auditoría y Dashboard.
//
// Responsabilidades:
//   • log()         — escribe un evento en AuditLog (nunca lanza)
//   • query()       — consulta filtrada + paginada del log
//   • getDashboard  — estadísticas agregadas para el panel admin
//   • getSecretaryDashboard — panel contextual por grado
//
// Principio de diseño:
//   log() NUNCA interrumpe el flujo principal. Si falla,
//   loguea en Logger y continúa. Los Services llaman
//   AuditService.log() en vez de insertar en AuditLog directamente.
//   Esto centraliza el formato y el manejo de errores.
//
// Dependencias:
//   ← Config.gs    (SHEETS, GRADES, GRADE_KEYS, SCORE_FIELDS,
//                   PASSING_GRADE)
//   ← Utils.gs     (_newId, _nowIso, _calcAverage, _isComplete)
//   ← SheetHelper  (DAO)
// ============================================================

const AuditService = (() => {

  // ── ESCRITURA ──────────────────────────────────────────────

  /**
   * Registra un evento en AuditLog.
   * NUNCA lanza excepción — los errores de auditoría no deben
   * bloquear la operación de negocio que los originó.
   *
   * Uso en Services:
   *   AuditService.log('Personas', id, 'UPDATE', userId, { name });
   *
   * @param {string}  entity   - nombre de la tabla ('Personas', 'Celulas'…)
   * @param {string}  entityId - ID del registro afectado
   * @param {string}  action   - verbo en mayúsculas ('CREATE','UPDATE','DELETE'…)
   * @param {string}  userId   - ID del usuario que realizó la acción
   * @param {Object}  [meta]   - datos extra (diff, motivo, etc.)
   * @param {Object}  [user]   - objeto usuario ya resuelto (evita lookup extra)
   */
  function log(entity, entityId, action, userId, meta, user) {
    try {
      if (!user && userId) {
        try { user = SheetHelper.getById(SHEETS.USERS, userId); } catch (_) {}
      }
      SheetHelper.insert(SHEETS.AUDIT_LOG, {
        id:        _newId('al'),
        entity:    entity    || '',
        entityId:  entityId  || '',
        action:    action    || '',
        userId:    userId    || '',
        userName:  user ? (user.name || '') : '',
        userRole:  user ? (user.role || user.roleId || '') : '',
        meta:      meta ? JSON.stringify(meta) : '{}',
        timestamp: _nowIso(),
      });
    } catch (e) {
      Logger.log(`[AuditService.log] error — ${entity}/${action}: ${e.message}`);
    }
  }

  // ── LECTURA ────────────────────────────────────────────────

  /**
   * Consulta el log de auditoría con filtros opcionales.
   * Retorna registros ordenados por timestamp descendente.
   *
   * @param {Object} opts
   * @param {string}  [opts.entity]   - filtrar por entidad
   * @param {string}  [opts.entityId] - filtrar por ID de registro
   * @param {string}  [opts.userId]   - filtrar por usuario
   * @param {string}  [opts.action]   - filtrar por acción
   * @param {string}  [opts.search]   - texto libre en userName/meta
   * @param {number}  [opts.limit]    - máximo de registros (default 200)
   * @param {number}  [opts.page]     - página (1-based, para paginación)
   * @param {number}  [opts.pageSize] - registros por página (default = limit)
   * @returns {{ records: Object[], total: number, page?: number }}
   */
  function query(opts) {
    opts = opts || {};

    let records = SheetHelper.getAll(SHEETS.AUDIT_LOG);

    // Filtros exactos
    if (opts.entity)   records = records.filter(r => r.entity   === opts.entity);
    if (opts.entityId) records = records.filter(r => r.entityId === opts.entityId);
    if (opts.userId)   records = records.filter(r => r.userId   === opts.userId);
    if (opts.action)   records = records.filter(r => r.action   === opts.action);

    // Filtro de texto libre (userName + meta)
    if (opts.search) {
      const q = opts.search.toLowerCase().trim();
      records = records.filter(r => {
        const hay = [
          r.userName || '',
          r.action   || '',
          r.entity   || '',
          r.meta     || '',
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    // Orden descendente por timestamp
    records.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    const total = records.length;

    // Paginación
    if (opts.page && opts.pageSize) {
      const page  = Math.max(1, opts.page);
      const size  = Math.max(1, opts.pageSize);
      const start = (page - 1) * size;
      return {
        records:  records.slice(start, start + size),
        total,
        page,
        pages:    Math.max(1, Math.ceil(total / size)),
        pageSize: size,
      };
    }

    // Sin paginación — solo límite simple
    const limit = opts.limit || 200;
    return { records: records.slice(0, limit), total };
  }

  // ── DASHBOARD ──────────────────────────────────────────────

  /**
   * Estadísticas agregadas para el panel de administrador.
   * Lee cada tabla con caché (L1/L2) para minimizar API calls.
   *
   * @returns {DashboardStats}
   */
  function getDashboard() {
    const people      = SheetHelper.getAll(SHEETS.PEOPLE);
    const enrollments = SheetHelper.getAll(SHEETS.ENROLLMENTS);
    const scores      = SheetHelper.getAll(SHEETS.SCORES);
    const cells       = SheetHelper.getAll(SHEETS.CELLS);
    const churches    = SheetHelper.getAll(SHEETS.CHURCHES);
    const classes     = SheetHelper.getAll(SHEETS.CLASSES);

    // Índice scores para O(1) lookup
    const scoreIdx = {};
    scores.forEach(s => { scoreIdx[s.enrollmentId] = s; });

    const enrolledIds = new Set(enrollments.map(e => e.personId));

    const gradeStats = {};
    GRADE_KEYS.forEach(g => {
      const gEnr = enrollments.filter(e => e.grade === g);
      const gCls = classes.filter(c => c.grade === g);
      let approved = 0;

      gEnr.forEach(e => {
        const sc = scoreIdx[e.id];
        if (sc && _isComplete(sc) && _calcAverage(sc) >= PASSING_GRADE) approved++;
      });

      gradeStats[g] = {
        label:   GRADES[g].label,
        total:   gEnr.length,
        approved,
        classes: gCls.length,
      };
    });

    return {
      totalPeople:   people.length,
      totalEnrolled: enrolledIds.size,
      totalCells:    cells.length,
      totalChurches: churches.length,
      totalClasses:  classes.length,
      gradeStats,
    };
  }

  /**
   * Panel contextual para secretario/maestro.
   * Devuelve datos ricos y operativos para el grado asignado:
   * alumnos en riesgo, próximas clases, cumpleaños, TPs pendientes.
   *
   * @param {string} grade - grado asignado al secretario/maestro ('' = todos)
   * @returns {SecretaryDashboard}
   */
  function getSecretaryDashboard(grade) {
    const now        = new Date();
    const thisMonth  = now.getMonth();
    const thisYear   = now.getFullYear();

    const people      = SheetHelper.getAll(SHEETS.PEOPLE);
    const enrollments = SheetHelper.getAll(SHEETS.ENROLLMENTS);
    const scores      = SheetHelper.getAll(SHEETS.SCORES);
    const classes     = SheetHelper.getAll(SHEETS.CLASSES);
    const attendance  = SheetHelper.getAll(SHEETS.ATTENDANCE);
    const quests      = SheetHelper.getAll(SHEETS.QUESTIONNAIRES);

    const myEnrollments = grade
      ? enrollments.filter(e => e.grade === grade)
      : enrollments;
    const myClasses = grade
      ? classes.filter(c => c.grade === grade)
      : classes;

    // Índices para O(1) lookup
    const scoreIdx  = {};
    scores.forEach(s => { scoreIdx[s.enrollmentId] = s; });
    const peopleIdx = {};
    people.forEach(p => { peopleIdx[p.id] = p; });

    // ── A. Alumnos activos con riesgo de quedar libres
    const activeStudents = _buildActiveStudents(
      myEnrollments, peopleIdx, scoreIdx, attendance
    );

    // ── B. Próximas clases (30 días)
    const upcomingClasses = _buildUpcomingClasses(myClasses, myEnrollments, now);

    // ── C. Cumpleaños del mes (alumnos inscriptos)
    const birthdays = _buildBirthdays(myEnrollments, peopleIdx, thisMonth, thisYear, now);

    // ── D. Stats por grado
    const gradeStats = _buildGradeStats(grade, enrollments, scores, classes);

    // ── E. TPs y Cuestionarios pendientes
    const enrolledSet   = new Set(myEnrollments.map(e => e.personId));
    const pendingQuests = _buildPendingItems(quests, enrolledSet, classes, 'quest', 'Cuestionario');
    const pendingTPs    = _buildPendingItems(quests, enrolledSet, classes, 'tp',    'TP');

    return {
      activeStudents,
      upcomingClasses,
      birthdays,
      gradeStats,
      pendingQuests,
      pendingTPs,
    };
  }

  // ── PRIVADOS DEL DASHBOARD ─────────────────────────────────

  function _buildActiveStudents(myEnrollments, peopleIdx, scoreIdx, attendance) {
    const students = [];
    myEnrollments.forEach(enr => {
      const person = peopleIdx[enr.personId];
      if (!person) return;
      const sc     = scoreIdx[enr.id] || {};
      const done   = SCORE_FIELDS.every(f => sc[f] !== '' && sc[f] !== undefined);
      if (done) return; // ya tiene notas completas → skip

      const att          = attendance.filter(a => a.enrollmentId === enr.id);
      const ausentes     = att.filter(a => a.type === 'Ausente').length;
      const tardes       = att.filter(a => a.type === 'Tarde').length;
      const justificados = att.filter(a => a.type === 'Justificado').length;
      const presentes    = att.filter(a => a.type === 'Presente').length;
      const notaAtt      = Math.max(0, Math.min(10, 10 - ausentes - Math.floor(tardes / 3)));

      students.push({
        personId:       person.id,
        name:           person.name,
        lastName:       person.lastName,
        photoUrl:       person.photoUrl  || '',
        phone:          person.phone     || '',
        grade:          enr.grade,
        enrollmentId:   enr.id,
        ausentes,
        tardes,
        justificados,
        presentes,
        notaAsistencia: notaAtt,
        riskLevel: ausentes >= 3 ? 'critical' : ausentes === 2 ? 'warning' : 'ok',
      });
    });

    return students.sort((a, b) => {
      const rm = { critical: 0, warning: 1, ok: 2 };
      return (rm[a.riskLevel] || 2) - (rm[b.riskLevel] || 2) || b.ausentes - a.ausentes;
    });
  }

  function _buildUpcomingClasses(myClasses, myEnrollments, now) {
    const in30 = new Date(now);
    in30.setDate(in30.getDate() + 30);

    return myClasses
      .filter(c => c.status === 'programada' && c.scheduledDate)
      .map(c => {
        const enrolled = myEnrollments.filter(e => e.grade === c.grade).length;
        return {
          id:            c.id,
          grade:         c.grade,
          title:         c.title,
          scheduledDate: c.scheduledDate,
          enrolled,
        };
      })
      .filter(c => {
        const d = new Date(c.scheduledDate);
        return d >= now && d <= in30;
      })
      .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))
      .slice(0, 6);
  }

  function _buildBirthdays(myEnrollments, peopleIdx, thisMonth, thisYear, now) {
    const enrolledIds = new Set(myEnrollments.map(e => e.personId));
    const birthdays   = [];

    enrolledIds.forEach(pid => {
      const p = peopleIdx[pid];
      if (!p || !p.birthDate) return;
      const bd = new Date(p.birthDate + 'T12:00:00');
      if (isNaN(bd.getTime()) || bd.getMonth() !== thisMonth) return;
      birthdays.push({
        personId:     p.id,
        name:         p.name,
        lastName:     p.lastName,
        photoUrl:     p.photoUrl || '',
        phone:        p.phone    || '',
        day:          bd.getDate(),
        month:        thisMonth + 1,
        age:          thisYear - bd.getFullYear(),
        alreadyPassed: bd.getDate() < now.getDate(),
      });
    });

    return birthdays.sort((a, b) => a.day - b.day);
  }

  function _buildGradeStats(grade, enrollments, scores, classes) {
    const scoreIdx = {};
    scores.forEach(s => { scoreIdx[s.enrollmentId] = s; });

    const keys = grade ? [grade] : GRADE_KEYS;
    const stats = {};

    keys.forEach(g => {
      const gEnr   = enrollments.filter(e => e.grade === g);
      let approved = 0, inProgress = 0;

      gEnr.forEach(e => {
        const sc   = scoreIdx[e.id] || {};
        const done = SCORE_FIELDS.every(f => sc[f] !== '' && sc[f] !== undefined);
        const avg  = done
          ? SCORE_FIELDS.map(f => parseFloat(sc[f])).filter(v => !isNaN(v))
              .reduce((a, b) => a + b, 0) / SCORE_FIELDS.length
          : null;
        if (done && avg >= PASSING_GRADE) approved++;
        else if (!done) inProgress++;
      });

      const nextClass = classes
        .filter(c => c.grade === g && c.status === 'programada' && c.scheduledDate)
        .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))[0] || null;

      stats[g] = {
        label:        GRADES[g].label,
        total:        gEnr.length,
        approved,
        inProgress,
        failed:       gEnr.length - approved - inProgress,
        classesCount: classes.filter(c => c.grade === g).length,
        nextClass:    nextClass
          ? { title: nextClass.title, scheduledDate: nextClass.scheduledDate }
          : null,
      };
    });

    return stats;
  }

  function _buildPendingItems(quests, enrolledSet, classes, assessType, labelType) {
    const items = quests.filter(q =>
      (q.assessType === assessType || (!q.assessType && assessType === 'quest')) &&
      enrolledSet.has(q.personId)
    );

    const groups = {};
    const now    = new Date();

    items.forEach(q => {
      const key = (q.classId || '') + '___' + (q.title || '');
      if (!groups[key]) {
        const cls = classes.find(c => c.id === q.classId) || {};
        groups[key] = {
          title:      q.title,
          dueDate:    q.dueDate   || '',
          classTitle: cls.title   || '',
          grade:      q.grade     || cls.grade || '',
          assessType: labelType,
          total: 0, entregado: 0, pendiente: 0, vencido: 0,
        };
      }
      if (q.status === 'entregado') {
        groups[key].entregado++;
      } else if (q.dueDate && new Date(q.dueDate) < now) {
        groups[key].vencido++;
      } else {
        groups[key].pendiente++;
      }
      groups[key].total++;
    });

    return Object.values(groups)
      .filter(g => g.pendiente > 0 || g.vencido > 0)
      .sort((a, b) => {
        if (a.vencido > 0 && b.vencido === 0) return -1;
        if (b.vencido > 0 && a.vencido === 0) return  1;
        if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        return 0;
      })
      .slice(0, 8);
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    log,
    query,
    getDashboard,
    getSecretaryDashboard,
  };

})();