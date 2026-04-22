// ============================================================
// JCV SYSTEM — Config.gs
//
// Fuente única de verdad para:
//   • Credenciales de infraestructura (IDs de Drive/Sheets)
//   • Nombres de hojas (SHEETS)
//   • Schema de columnas por hoja (SCHEMA)
//   • Enums de dominio (ROLES, GRADES, STATUS, etc.)
//   • Configuración de autenticación
//   • Colores de UI para initializeSheets()
//
// REGLAS:
//   1. Ningún otro archivo define constantes de dominio.
//   2. Los Services importan desde aquí, nunca hardcodean strings.
//   3. Al agregar una hoja nueva → agregar en SHEETS + SCHEMA + SHEET_COLORS.
// ============================================================

// ── INFRAESTRUCTURA ───────────────────────────────────────────
const SPREADSHEET_ID  = '1XVnSxKuX1X1-hqatdwaMsS6v2mnER-z7g8eVFwP71_k';
const DRIVE_FOLDER_ID = '1SyDqYwEMCYijwk_Ky8ZwOtdZnsbOd50z';

// ── NOMBRES DE HOJAS ──────────────────────────────────────────
// Alineado con el documento de schema del DBA.
// Valor = nombre exacto de la pestaña en Google Sheets.
const SHEETS = {
  // Seguridad y acceso
  ROLES:      'Roles',
  USERS:      'Usuarios',
  TOKENS:     'Tokens',
  RECOVERY:   'Recuperacion',

  // Personas
  PEOPLE:     'Personas',

  // Iglesias y células
  CHURCHES:   'Nexos',
  CELLS:      'Celulas',
  CELL_MEMBERS: 'MiembrosCelula',

  // Programas unificados (ministerios + escuelas)
  PROGRAMS:        'Programas',
  PROGRAM_MEMBERS: 'MiembrosPrograma',

  // Períodos académicos
  PERIODS: 'Periodos',

  // Inscripciones y académico
  ENROLLMENTS:    'Inscripciones',
  CLASSES:        'Clases',
  ATTENDANCE:     'Asistencia',
  SCORES:         'Calificaciones',
  QUESTIONNAIRES: 'Cuestionarios',

  // Fichas de control
  CONTROL_SHEETS:          'FichasControl',
  CONTROL_SHEET_TARGETS:   'FichasDestinatarios',
  CONTROL_SHEET_QUESTIONS: 'FichasPreguntas',
  CONTROL_SHEET_ANSWERS:   'FichasRespuestas',
  CONTROL_SHEET_REVIEWS:   'FichasRevisiones',

  // Auditoría
  AUDIT_LOG: 'AuditLog',
};

// ── CAMPOS DE AUDITORÍA (se agregan a todas las tablas) ───────
// Shorthand para no repetir en cada schema.
const AUD = [
  'createdAt',     // ISO timestamp de creación
  'createdBy',     // userId del creador
  'createdByName', // nombre legible (desnormalizado para lectura rápida)
  'updatedAt',     // ISO timestamp de última modificación
  'updatedBy',     // userId del último modificador
  'updatedByName', // nombre legible
];

// ── SCHEMA DE COLUMNAS POR HOJA ───────────────────────────────
// Alineado exactamente con el documento entregado por el DBA.
// initializeSheets() y migrateSchema() usan este objeto como fuente.
//
// Orden importa: define el orden de columnas en Sheets.
// Agregar campos nuevos al FINAL para no romper hojas existentes.
const SCHEMA = {

  // ─── 🔐 SEGURIDAD Y ACCESO ───────────────────────────────────

  [SHEETS.ROLES]: [
    'id',
    'name',        // admin | supervisor | leader | member
    'description',
  ],

  [SHEETS.USERS]: [
    'id',
    'personId',    // FK → Personas.id (nuevo: vincula usuario con persona)
    'username',
    'password',    // hash SHA-256
    'roleId',      // FK → Roles.id  (nuevo: normalizado)
    // Legacy: 'role' directo se mantiene para compatibilidad durante migración
    'role',        // admin | secretary | maestro (legacy, se elimina en v5)
    'name',        // desnormalizado de Personas para login rápido sin join
    'email',       // desnormalizado de Personas
    'photoUrl',    // desnormalizado de Personas
    'churchId',    // FK → Nexos.id
    'assignedGrade', // escuelaVida | consolidacion | obreros1 | obreros2
    'status',      // active | inactive | blocked
    ...AUD,
  ],

  [SHEETS.TOKENS]: [
    'token',
    'userId',      // FK → Usuarios.id
    'email',
    'expiration',
    'ip',
    'userAgent',
  ],

  [SHEETS.RECOVERY]: [
    'token',
    'email',
    'expiration',
    'used',
    'attempts',
  ],

  // ─── 👤 PERSONAS ──────────────────────────────────────────────

  [SHEETS.PEOPLE]: [
    'id',
    'name',
    'lastName',
    'birthDate',
    'phone',
    'email',
    'gender',      // M | F | O
    'photoUrl',
    'country',
    'churchId',    // FK → Nexos.id
    'observation',
    'invitedBy',
    'attendedEncounter', // true | false
    // Legado: cellLeader, cellId, ministryId se migran a tablas de membresía
    // Se mantienen por compatibilidad hasta migración completa
    'cellLeader',
    'cellId',
    'ministryId',
    ...AUD,
  ],

  // ─── ⛪ IGLESIAS Y CÉLULAS ──────────────────────────────────

  [SHEETS.CHURCHES]: [
    'id',
    'name',
    'fullName',
    'country',
    'address',
    'email',
    'phone',
    'pastors',
    'logoUrl',
    ...AUD,
  ],

  [SHEETS.CELLS]: [
    'id',
    'name',
    'churchId',      // FK → Nexos.id
    'parentCellId',  // FK → Celulas.id (estructura jerárquica)
    // Legado mantenido durante transición
    'leader',
    'schedule',
    'location',
    'category',      // general | jovenes | matrimonios | adolescentes | ninos | preadolescentes
    ...AUD,
  ],

  [SHEETS.CELL_MEMBERS]: [
    'id',
    'cellId',    // FK → Celulas.id
    'personId',  // FK → Personas.id
    'role',      // leader | coleader | member
    'status',    // active | inactive
    'joinedAt',
    'leftAt',
    ...AUD,
  ],

  // ─── 🎯 PROGRAMAS (ministerios + escuelas unificados) ────────

  [SHEETS.PROGRAMS]: [
    'id',
    'name',
    'type',        // ministry | school
    'description',
    'schedule',
    'location',
    'churchId',    // FK → Nexos.id
    'status',      // active | inactive
    // Legado ministerios (mantener durante migración)
    'leaders',     // string CSV desnormalizado
    'memberIds',   // JSON array desnormalizado (legacy v4)
    ...AUD,
  ],

  [SHEETS.PROGRAM_MEMBERS]: [
    'id',
    'programId',  // FK → Programas.id
    'personId',   // FK → Personas.id
    'role',       // leader | assistant | member | student
    'status',     // active | inactive | completed | dropped
    'joinedAt',
    'leftAt',
    ...AUD,
  ],

  // ─── 📅 PERÍODOS ──────────────────────────────────────────────

  [SHEETS.PERIODS]: [
    'id',
    'name',
    'year',
    'semester',   // 1 | 2
    'startDate',
    'endDate',
    'status',     // active | closed
    'createdAt',
  ],

  // ─── 🎓 INSCRIPCIONES (escuelas) ─────────────────────────────

  [SHEETS.ENROLLMENTS]: [
    'id',
    'personId',   // FK → Personas.id
    'programId',  // FK → Programas.id (nuevo, reemplaza 'grade' hardcodeado)
    'periodId',   // FK → Periodos.id  (nuevo, reemplaza 'period')
    // Legado mantenido durante migración
    'grade',      // escuelaVida | consolidacion | obreros1 | obreros2
    'period',     // ID del período (legado)
    'status',     // active | approved | failed | dropped | suspended
    'enrolledAt',
    'completedAt',
    'droppedAt',
    'dropReason',
    'dropDetail',
    'dropBy',
    // Legado baja (renombrado a drop* en v5)
    'bajaAt',
    'bajaMotivo',
    'bajaDetail',
    'bajaBy',
    ...AUD,
  ],

  [SHEETS.CLASSES]: [
    'id',
    'programId',  // FK → Programas.id (nuevo)
    // Legado
    'grade',
    'title',
    'description',
    'scheduledDate',
    'status',     // scheduled | completed | cancelled
    ...AUD,
  ],

  [SHEETS.ATTENDANCE]: [
    'id',
    'classId',       // FK → Clases.id
    'personId',      // FK → Personas.id
    'enrollmentId',  // FK → Inscripciones.id
    'type',          // present | absent | justified | late
    'reason',
    ...AUD,
  ],

  [SHEETS.SCORES]: [
    'id',
    'enrollmentId',  // FK → Inscripciones.id
    'attendance',    // auto-calculado
    'quiz',          // cuestionario auto-calculado
    'tp1',
    'exam1',
    'tp2',
    'exam2',
    'finalScore',    // nuevo: promedio final calculado
    ...AUD,
  ],

  [SHEETS.QUESTIONNAIRES]: [
    'id',
    'classId',       // FK → Clases.id
    'personId',      // FK → Personas.id
    'enrollmentId',  // FK → Inscripciones.id
    'grade',
    'title',
    'totalItems',
    'dueDate',
    'status',        // pending | submitted | graded
    'score',         // nota (renombrado de 'nota')
    'submittedAt',
    ...AUD,
  ],

  // ─── 🧾 FICHAS DE CONTROL ────────────────────────────────────

  [SHEETS.CONTROL_SHEETS]: [
    'id',
    'title',
    'programId',  // FK → Programas.id
    'periodId',   // FK → Periodos.id
    'dueDate',
    'status',     // draft | sent | closed
    'sentAt',
    'createdBy',
    'updatedBy',
    'createdAt',
    'updatedAt',
  ],

  [SHEETS.CONTROL_SHEET_TARGETS]: [
    'id',
    'controlSheetId',  // FK → FichasControl.id
    'personId',        // FK → Personas.id
    'leaderId',        // FK → Personas.id
    'cellId',          // FK → Celulas.id
    'programId',       // FK → Programas.id
    'status',          // pending | answered | reviewed
    'sentAt',
    'answeredAt',
    'reviewedAt',
    ...AUD,
  ],

  [SHEETS.CONTROL_SHEET_QUESTIONS]: [
    'id',
    'controlSheetId',  // FK → FichasControl.id
    'question',
    'type',            // text | number | boolean | select
    'options',         // JSON array
    'order',
    'required',
    ...AUD,
  ],

  [SHEETS.CONTROL_SHEET_ANSWERS]: [
    'id',
    'targetId',    // FK → FichasDestinatarios.id
    'questionId',  // FK → FichasPreguntas.id
    'answer',
    'createdAt',
    'updatedAt',
  ],

  [SHEETS.CONTROL_SHEET_REVIEWS]: [
    'id',
    'targetId',    // FK → FichasDestinatarios.id
    'reviewerId',  // FK → Personas.id
    'evaluation',
    'comment',
    'reviewedAt',
    ...AUD,
  ],

  // ─── 📊 AUDITORÍA ────────────────────────────────────────────

  [SHEETS.AUDIT_LOG]: [
    'id',
    'entity',      // nombre de la tabla afectada
    'entityId',    // ID del registro afectado
    'action',      // create | update | delete | login | enroll | unenroll | baja | status_change
    'userId',      // FK → Usuarios.id
    'userName',    // desnormalizado
    'userRole',    // desnormalizado
    'meta',        // JSON con diff o datos extra
    'timestamp',   // ISO 8601
  ],
};

// ── ENUMS DE DOMINIO ──────────────────────────────────────────
// Fuente única: el frontend y los Services usan estas mismas claves.

const ROLES = {
  ADMIN:      'admin',
  SECRETARY:  'secretary',
  MAESTRO:    'maestro',
};

// Grados académicos con prerequisito y etiqueta de UI
const GRADES = {
  escuelaVida:   { label: 'Escuela de Vida', prereq: null },
  consolidacion: { label: 'Consolidación',   prereq: 'escuelaVida' },
  obreros1:      { label: 'Obreros I',       prereq: 'consolidacion' },
  obreros2:      { label: 'Obreros II',      prereq: 'obreros1' },
};

const GRADE_KEYS = Object.keys(GRADES);

// Campos de puntaje (en el mismo orden que la hoja Calificaciones)
const SCORE_FIELDS = ['asistencia', 'cuestionario', 'tp1', 'examen1', 'tp2', 'examen2'];

const PASSING_GRADE = 6;

// Estados de inscripción
const ENROLLMENT_STATUS = {
  ACTIVE:      'active',       // cursando
  APPROVED:    'approved',     // aprobó
  FAILED:      'failed',       // desaprobó
  DROPPED:     'dropped',      // dado de baja
  SUSPENDED:   'suspended',    // suspendido
  // Legado (v4) — se mantiene para compatibilidad durante migración
  ACTIVO:      'activo',
  APROBADO:    'aprobado',
  DESAPROBADO: 'desaprobado',
  BAJA:        'baja',
};

// Tipos de asistencia válidos
const ATTENDANCE_TYPES = ['Presente', 'Ausente', 'Justificado', 'Tarde'];

// Motivos de baja controlados
const DROP_REASONS = {
  abandono:   'Abandono',
  reprobo:    'Reprobó',
  traslado:   'Traslado a otra sede',
  enfermedad: 'Enfermedad / salud',
  trabajo:    'Razones laborales',
  mudanza:    'Cambio de domicilio',
  disciplina: 'Razones disciplinarias',
  graduado:   'Graduado / completó cursada',
  otro:       'Otro motivo',
};

// Tipos de programa (ministerios y escuelas)
const PROGRAM_TYPES = {
  MINISTRY: 'ministry',
  SCHOOL:   'school',
};

// Tipos de ministerio (subtipo de PROGRAM_TYPES.MINISTRY)
const MINISTRY_TYPES = [
  'alabanza', 'ensenanza', 'ujieres', 'intercesion',
  'evangelismo', 'jovenes', 'ninos', 'medios', 'accion', 'otro',
];

// ── CONFIGURACIÓN DE AUTH ──────────────────────────────────────
const AUTH_CONFIG = {
  TOKEN_TTL_HOURS:   8,
  RECOVERY_TTL_MIN: 30,
  MAX_OTP_ATTEMPTS:  5,
  MIN_PASS_LENGTH:   6,
  SALT:             'jcv_salt_2024',
  APP_NAME:         'JCV Sistema',
  APP_SUBTITLE:     'Jesus Camino de Vida',
  BRAND_COLOR:      '#1A5FD4',
};

// ── COLORES DE CABECERA POR HOJA (para initializeSheets) ──────
const SHEET_COLORS = {
  [SHEETS.ROLES]:                    '#374151',
  [SHEETS.USERS]:                    '#1A5FD4',
  [SHEETS.TOKENS]:                   '#4B5563',
  [SHEETS.RECOVERY]:                 '#4B5563',
  [SHEETS.PEOPLE]:                   '#065F46',
  [SHEETS.CHURCHES]:                 '#6D28D9',
  [SHEETS.CELLS]:                    '#854F0B',
  [SHEETS.CELL_MEMBERS]:             '#92400E',
  [SHEETS.PROGRAMS]:                 '#5B21B6',
  [SHEETS.PROGRAM_MEMBERS]:          '#4C1D95',
  [SHEETS.PERIODS]:                  '#0F766E',
  [SHEETS.ENROLLMENTS]:              '#1E40AF',
  [SHEETS.CLASSES]:                  '#0D6E56',
  [SHEETS.ATTENDANCE]:               '#854F0B',
  [SHEETS.SCORES]:                   '#9A3412',
  [SHEETS.QUESTIONNAIRES]:           '#533AB7',
  [SHEETS.CONTROL_SHEETS]:           '#1E3A5F',
  [SHEETS.CONTROL_SHEET_TARGETS]:    '#1E3A5F',
  [SHEETS.CONTROL_SHEET_QUESTIONS]:  '#1E3A5F',
  [SHEETS.CONTROL_SHEET_ANSWERS]:    '#1E3A5F',
  [SHEETS.CONTROL_SHEET_REVIEWS]:    '#1E3A5F',
  [SHEETS.AUDIT_LOG]:                '#374151',
};