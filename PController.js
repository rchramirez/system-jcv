// ============================================================
// JCV SYSTEM — Controller.gs  v5.0
//
// Único archivo expuesto al frontend via google.script.run.
//
// Responsabilidades:
//   • doGet()      — sirve el HTML de la aplicación
//   • include()    — helper de plantillas HtmlService
//   • Exponer cada función pública con el MISMO NOMBRE
//     que tenía en Code.gs — retrocompatibilidad 100% con
//     el frontend v4 sin tocar App.html
//   • Envolver cada llamada en _respond() (try/catch → { ok, data/error })
//   • Extraer userId del payload (_userId) antes de delegar
//   • NO contiene lógica de dominio — todo delega a Services
//
// Principios de este archivo:
//   1. Cada función pública tiene máx. 3-5 líneas
//   2. Nunca manipula SheetHelper directamente
//   3. Nunca implementa reglas de negocio
//   4. _respond() envuelve TODO sin excepción
//
// Orden de secciones (mismo orden que Code.gs original):
//   A. Entry point (doGet, include)
//   B. Personas
//   C. Células
//   D. Nexos
//   E. Usuarios
//   F. Inscripciones y Períodos
//   G. Calificaciones
//   H. Clases
//   I. Asistencia
//   J. Cuestionarios
//   K. Ministerios
//   L. Dashboard y Estadísticas
//   M. Auditoría
//   N. Auth (login/logout/recovery)
//   O. Setup y mantenimiento (initializeSheets, migrate, cache)
// ============================================================

// ── A. ENTRY POINT ────────────────────────────────────────────

function doGet(e) {
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('JCV — Sistema de Gestión')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── B. PERSONAS ───────────────────────────────────────────────

/**
 * Retorna todas las personas.
 * Frontend: gasRead('getPeople', [])
 */
function getPeople() {
  return _respond(() => PeopleService.getAll());
}

/**
 * Retorna personas por array de IDs.
 * Frontend: gasReadWith('getPeopleByIds', ids, [])
 */
function getPeopleByIds(ids) {
  return _respond(() => PeopleService.getByIds(ids));
}

/**
 * Crea o actualiza una persona.
 * Frontend: gasMut('savePerson', data)
 * data._userId = ID del usuario que opera
 */
function savePerson(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return PeopleService.save(data, userId);
  });
}

/**
 * Elimina una persona.
 * Frontend: gasMut('deletePerson', id)
 */
function deletePerson(id) {
  return _respond(() => PeopleService.remove(id));
}

// ── C. CÉLULAS ────────────────────────────────────────────────

/**
 * Retorna todas las células.
 * Frontend: gasRead('getCells', [])
 */
function getCells() {
  return _respond(() => CellService.getAllCells());
}

/**
 * Crea o actualiza una célula.
 * Frontend: gasMut('saveCell', data)
 */
function saveCell(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return CellService.saveCell(data, userId);
  });
}

/**
 * Elimina una célula.
 * Frontend: gasMut('deleteCell', id)
 */
function deleteCell(id) {
  return _respond(() => CellService.removeCell(id));
}

// ── D. NEXOS ──────────────────────────────────────────────────

/**
 * Retorna todos los nexos.
 * Frontend: gasRead('getChurches', [])
 */
function getChurches() {
  return _respond(() => ChurchService.getAll());
}

/**
 * Crea o actualiza un nexo.
 * Frontend: gasMut('saveChurch', data)
 */
function saveChurch(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return ChurchService.save(data, userId);
  });
}

/**
 * Elimina un nexo.
 * Frontend: gasMut('deleteChurch', id)
 */
function deleteChurch(id) {
  return _respond(() => ChurchService.remove(id));
}

// ── E. USUARIOS ───────────────────────────────────────────────

/**
 * Retorna todos los usuarios (sin password).
 * Frontend: gasRead('getUsers', [])
 */
function getUsers() {
  return _respond(() => UserService.getAll());
}

/**
 * Crea o actualiza un usuario del sistema.
 * Frontend: gasMut('saveUser', data)
 */
function saveUser(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return UserService.save(data, userId);
  });
}

/**
 * Elimina (soft-delete) un usuario.
 * Frontend: gasMut('deleteUser', id)
 */
function deleteUser(id) {
  return _respond(() => UserService.remove(id));
}

/**
 * Cambia la contraseña del usuario autenticado.
 * Frontend: gasMut('changePassword', userId, currentPass, newPass)
 */
function changePassword(userId, currentPassword, newPassword) {
  return _respond(() =>
    UserService.changePassword(userId, currentPassword, newPassword)
  );
}

// ── F. INSCRIPCIONES Y PERÍODOS ───────────────────────────────

/**
 * Retorna TODAS las inscripciones agrupadas por grado, con scores.
 * Frontend: gasRead('getEnrollments', {})
 */
function getEnrollments() {
  return _respond(() => EnrollmentService.getAll());
}

/**
 * Retorna inscripciones de un solo grado (más eficiente via GViz WHERE).
 * Frontend: gasReadWith('getEnrollmentsByGrade', grade, [])
 */
function getEnrollmentsByGrade(grade) {
  return _respond(() => EnrollmentService.getByGrade(grade));
}

/**
 * RPC único que trae todo para renderizar la página Escuelas.
 * Frontend: gasReadWith('getSchoolData', grade, {})
 */
function getSchoolData(grade) {
  return _respond(() => EnrollmentService.getSchoolData(grade));
}

/**
 * Inscribe una persona en un grado.
 * Frontend: gasMut('enrollPerson', personId, grade, userId)
 */
function enrollPerson(personId, grade, userId) {
  return _respond(() => EnrollmentService.enroll(personId, grade, userId));
}

/**
 * Da de baja a un alumno.
 * Frontend: gasMut('unenrollPerson', enrollmentId, motivo, detail, userId)
 */
function unenrollPerson(enrollmentId, motivo, detail, userId) {
  return _respond(() =>
    EnrollmentService.drop(enrollmentId, motivo, detail, userId)
  );
}

/**
 * Cambia el estado de una inscripción (aprobado/desaprobado/suspendido).
 * Frontend: gasMut('setEnrollmentStatus', enrollmentId, status, periodId, userId)
 */
function setEnrollmentStatus(enrollmentId, status, periodId, userId) {
  return _respond(() =>
    EnrollmentService.setStatus(enrollmentId, status, periodId, userId)
  );
}

/**
 * Alias de setEnrollmentStatus — mantiene retrocompatibilidad
 * con el frontend que usa gasMut('updateEnrollmentStatus', ...).
 */
function updateEnrollmentStatus(enrollmentId, status, periodId, userId) {
  return _respond(() =>
    EnrollmentService.setStatus(enrollmentId, status, periodId, userId)
  );
}

/**
 * Retorna todos los períodos académicos.
 * Frontend: gasReadWith('getPeriods', null, [])
 */
function getPeriods() {
  return _respond(() => EnrollmentService.getAllPeriods());
}

/**
 * Retorna el período activo actual.
 * Frontend: gasReadWith('getCurrentSemester', null, null)
 */
function getCurrentSemester() {
  return _respond(() => EnrollmentService.getCurrentPeriod());
}

/**
 * Crea o actualiza un período académico.
 * Frontend: gasMut('savePeriod', data, userId)
 */
function savePeriod(data, userId) {
  return _respond(() => EnrollmentService.savePeriod(data, userId));
}

// ── G. CALIFICACIONES ─────────────────────────────────────────

/**
 * Guarda calificaciones parciales de un alumno.
 * Frontend: gasMut('saveScores', enrollmentId, scoresData, userId)
 */
function saveScores(enrollmentId, scoresData, userId) {
  return _respond(() =>
    ScoreService.saveScores(enrollmentId, scoresData, userId)
  );
}

// ── H. CLASES ─────────────────────────────────────────────────

/**
 * Retorna clases, opcionalmente filtradas por grado.
 * Frontend: gasReadWith('getClasses', grade, []) — legacy usa gasRead
 */
function getClasses(grade) {
  return _respond(() => ClassService.getAll(grade));
}

/**
 * Crea o actualiza una clase.
 * Frontend: gasMut('saveClass', data)
 */
function saveClass(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return ClassService.save(data, userId);
  });
}

/**
 * Elimina una clase (con cascade en asistencia y cuestionarios).
 * Frontend: gasMut('deleteClass', id)
 */
function deleteClass(id) {
  return _respond(() => ClassService.remove(id));
}

// ── I. ASISTENCIA ─────────────────────────────────────────────

/**
 * Retorna asistencia de una clase.
 * Frontend: gasReadWith('getAttendance', classId, [])
 */
function getAttendance(classId) {
  return _respond(() => AttendanceService.getByClass(classId));
}

/**
 * Guarda un registro individual de asistencia.
 * Frontend: gasMut('saveAttendance', data)
 */
function saveAttendance(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return AttendanceService.saveIndividual(data, userId);
  });
}

/**
 * Guarda N registros de asistencia en batch.
 * Frontend: gasMut('saveAttendanceBatch', classId, records, userId)
 * (usa gasMut3 en el frontend para 3 argumentos)
 */
function saveAttendanceBatch(classId, records, userId) {
  return _respond(() =>
    AttendanceService.saveBatch(classId, records, userId)
  );
}

/**
 * Retorna resumen de asistencia de un alumno por enrollmentId.
 * Frontend: gasMut('getAttendanceSummary', enrollmentId)
 */
function getAttendanceSummary(enrollmentId) {
  return _respond(() => {
    const { summary } = AttendanceService.getByEnrollment(enrollmentId);
    return summary;
  });
}

// ── J. CUESTIONARIOS ──────────────────────────────────────────

/**
 * Retorna cuestionarios, filtrados por classId si se provee.
 * Frontend: gasReadWith('getQuestionnaires', classId, [])
 */
function getQuestionnaires(classId) {
  return _respond(() => ScoreService.getByClass(classId));
}

/**
 * Crea o actualiza un cuestionario.
 * Frontend: gasMut('saveQuestionnaire', data)
 */
function saveQuestionnaire(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return ScoreService.saveQuestionnaire(data, userId);
  });
}

/**
 * Marca un cuestionario como entregado con su nota.
 * Frontend: gasMut('submitQuestionnaire', id, nota)
 */
function submitQuestionnaire(questionnaireId, nota) {
  return _respond(() =>
    ScoreService.submitQuestionnaire(questionnaireId, nota)
  );
}

/**
 * Elimina un cuestionario.
 * Frontend: gasMut('deleteQuestionnaire', id)
 */
function deleteQuestionnaire(id) {
  return _respond(() => ScoreService.removeQuestionnaire(id));
}

// ── K. MINISTERIOS ────────────────────────────────────────────

/**
 * Retorna todos los ministerios.
 * Frontend: google.script.run directo (no via gasMut)
 */
function getMinistries() {
  return _respond(() => CellService.getAllMinistries());
}

/**
 * Crea o actualiza un ministerio.
 * Frontend: gasMut('saveMinistry', data)
 */
function saveMinistry(data) {
  return _respond(() => {
    const userId = _extractUserId(data);
    return CellService.saveMinistry(data, userId);
  });
}

/**
 * Elimina un ministerio.
 * Frontend: gasMut('deleteMinistry', id)
 */
function deleteMinistry(id) {
  return _respond(() => CellService.removeMinistry(id));
}

/**
 * Agrega un integrante al ministerio.
 * Frontend: gasMut('addMinistryMember', ministryId, personId)
 */
function addMinistryMember(ministryId, personId) {
  return _respond(() =>
    CellService.addMinistryMember(ministryId, personId)
  );
}

/**
 * Quita un integrante del ministerio.
 * Frontend: gasMut('removeMinistryMember', ministryId, personId)
 */
function removeMinistryMember(ministryId, personId) {
  return _respond(() =>
    CellService.removeMinistryMember(ministryId, personId)
  );
}

// ── L. DASHBOARD Y ESTADÍSTICAS ───────────────────────────────

/**
 * Estadísticas del panel de administrador.
 * Frontend: gasRead('getDashboardStats', {})
 */
function getDashboardStats() {
  return _respond(() => AuditService.getDashboard());
}

/**
 * Panel contextual para secretario/maestro.
 * Frontend: google.script.run directo con grade como argumento
 */
function getSecretaryDashboard(grade) {
  return _respond(() => AuditService.getSecretaryDashboard(grade));
}

// ── M. AUDITORÍA ──────────────────────────────────────────────

/**
 * Retorna el log de auditoría con filtros opcionales.
 * Frontend: google.script.run.getAuditLog(opts) directo
 */
function getAuditLog(options) {
  return _respond(() => AuditService.query(options));
}

// ── N. AUTH ───────────────────────────────────────────────────
// Estas funciones son llamadas desde Index.html/Code.js de la capa de auth.
// Se mantienen con el mismo nombre para compatibilidad.

/**
 * Login con username/email + password.
 * Llamado desde el formulario de login (Index.html).
 */
function login(identifier, password) {
  // login NO usa _respond() — ya retorna { success, token, user, message }
  // para que el frontend maneje la respuesta directamente
  try {
    return AuthService.login(identifier, password);
  } catch (e) {
    Logger.log(`[Controller.login] error: ${e.message}`);
    return { success: false, message: 'Error interno. Intentá de nuevo.' };
  }
}

/**
 * Cierra sesión invalidando el token.
 */
function logout(token) {
  try {
    return AuthService.logout(token);
  } catch (e) {
    return { success: false };
  }
}

/**
 * Rehidrata la sesión desde un token almacenado.
 */
function getCurrentUser(token) {
  try {
    return AuthService.getCurrentUser(token);
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * PASO 1 recovery: envía OTP al email.
 */
function sendPasswordRecovery(email) {
  try {
    return AuthService.sendRecovery(email);
  } catch (e) {
    return { success: false, message: 'Error al enviar el email.' };
  }
}

/**
 * PASO 2 recovery: valida el código OTP.
 */
function validateRecoveryToken(code) {
  try {
    return AuthService.validateOTP(code);
  } catch (e) {
    return { valid: false, message: e.message };
  }
}

/**
 * PASO 3 recovery: restablece contraseña con OTP válido.
 */
function resetPassword(code, newPassword) {
  try {
    return AuthService.resetPassword(code, newPassword);
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * Obtiene el email de Google del usuario logueado (para Google Auth).
 * Delegado a la función de Auth.gs (mantiene el mismo comportamiento).
 */
function getGoogleUserEmail() {
  try {
    return getGoogleUserEmail_fromAuth
      ? getGoogleUserEmail_fromAuth()
      : Session.getActiveUser().getEmail() || null;
  } catch (_) { return null; }
}

// ── O. SETUP Y MANTENIMIENTO ──────────────────────────────────

/**
 * Crea/migra todas las hojas con sus schemas.
 * Idempotente — seguro de correr múltiples veces.
 * Solo se ejecuta manualmente desde el editor de GAS.
 */
function initializeSheets() {
  return _respond(() => SetupService.initialize());
}

/**
 * Migración a v5: agrega columnas nuevas del schema DBA
 * sin borrar datos existentes.
 */
function migrateToV4Fast() {
  return _respond(() => SetupService.migrate());
}

/**
 * Limpia todo el caché de SheetHelper (L1 + L2).
 * Frontend: gasMut('clearAllCache')
 */
function clearAllCache() {
  return _respond(() => {
    SheetHelper.clearCache();
    return { ok: true };
  });
}

/**
 * Sube una foto a Google Drive y retorna la URL pública.
 * Frontend: gasMut('uploadPhoto', base64, mimeType, fileName)
 */
function uploadPhoto(base64Data, mimeType, fileName) {
  return _respond(() => {
    if (!DRIVE_FOLDER_ID) throw new Error('Carpeta de Drive no configurada');
    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const blob   = Utilities.newBlob(
      Utilities.base64Decode(base64Data), mimeType, fileName
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {
      fileId:  file.getId(),
      viewUrl: `https://drive.google.com/thumbnail?id=${file.getId()}`,
    };
  });
}

// ── HELPER PRIVADO DEL CONTROLLER ────────────────────────────

/**
 * Extrae y elimina el campo _userId del payload antes de delegarlo
 * al Service. Así los Services no necesitan saber nada sobre
 * el transporte HTTP y el campo interno.
 *
 * @param {Object} data - payload mutable del frontend
 * @returns {string} userId extraído (puede ser '')
 */
function _extractUserId(data) {
  if (!data || typeof data !== 'object') return '';
  const userId = data._userId || '';
  delete data._userId;
  return userId;
}