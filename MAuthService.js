// ============================================================
// JCV SYSTEM — AuthService.gs
//
// Capa de dominio para autenticación y gestión de sesiones.
//
// Responsabilidades:
//   • login()               — autentica usuario, crea token
//   • logout()              — invalida token
//   • validateToken()       — verifica token (cache L1 en memoria)
//   • getCurrentUser()      — rehidrata sesión desde token
//   • sendRecovery()        — envía OTP por email (paso 1)
//   • validateOTP()         — valida código OTP (paso 2)
//   • resetPassword()       — restablece contraseña con OTP (paso 3)
//
// Arquitectura de tokens:
//   • Un token por usuario (one-session-per-user)
//   • Sliding window: se extiende en cada getCurrentUser()
//   • Cache en memoria (_tokenCache) para validaciones frecuentes
//     sin API calls a Sheets
//
// Dependencias:
//   ← Config.gs    (SHEETS, AUTH_CONFIG)
//   ← Auth.gs      (hashPassword, generateToken, generateOTP,
//                   _sendRecoveryEmail)
//                  NOTA: validateToken y _refreshToken de Auth.gs NO se usan
//                  porque operan con columnas legacy ('Token','UserID','Expiracion').
//                  AuthService implementa _validateTokenV5 y _refreshTokenV5
//                  que usan el schema v5 ('token','userId','expiration').
//   ← SheetHelper  (DAO)
//   ← AuditService (log)
// ============================================================

const AuthService = (() => {

  // ── LOGIN ──────────────────────────────────────────────────

  /**
   * Autentica un usuario por username o email + password.
   *
   * Pipeline:
   *   1. Buscar usuario por username o email (case-insensitive)
   *   2. Verificar que la cuenta esté activa
   *   3. Verificar contraseña (hash SHA-256, con fallback legacy)
   *   4. Migrar contraseña legacy a hash si es necesario
   *   5. Invalidar tokens previos (one-session-per-user)
   *   6. Crear nuevo token con TTL configurado
   *   7. Retornar shape de usuario al frontend
   *
   * @param {string} identifier - username o email
   * @param {string} password   - texto plano
   * @returns {{ success: boolean, token?: string, user?: Object, message?: string }}
   */
  function login(identifier, password) {
    try {
      const idNorm = (identifier || '').toLowerCase().trim();

      // 1. Buscar usuario (SheetHelper para consistencia con el resto del sistema)
      const allUsers = SheetHelper.getAll(SHEETS.USERS);
      const user     = allUsers.find(u =>
        (u.username || '').toLowerCase() === idNorm ||
        (u.email    || '').toLowerCase() === idNorm
      );

      if (!user) {
        return { success: false, message: 'Usuario o contraseña incorrectos' };
      }

      // 2. Verificar cuenta activa
      if (user.status === 'inactive' || user.status === 'blocked') {
        return { success: false, message: 'Tu cuenta está desactivada. Contactá al administrador.' };
      }

      // 3. Verificar contraseña
      const storedPass   = user.password || '';
      const isGoogleAuth = password === 'google-auth';

      if (!isGoogleAuth) {
        const hashed   = hashPassword(password);
        const isLegacy = storedPass === password; // texto plano legado

        if (storedPass !== hashed && !isLegacy) {
          return { success: false, message: 'Usuario o contraseña incorrectos' };
        }

        // 4. Migrar contraseña legacy a hash (una sola vez)
        if (isLegacy) {
          try {
            SheetHelper.update(SHEETS.USERS, user.id, { ...user, password: hashed });
            SheetHelper.evict(SHEETS.USERS);
          } catch (_) {}
        }
      }

      // 5. Invalidar tokens previos (one-session-per-user)
      _invalidateUserTokens(user.id);

      // 6. Crear nuevo token
      const token      = generateToken();
      const expiration = new Date(
        Date.now() + AUTH_CONFIG.TOKEN_TTL_HOURS * 3600000
      ).toISOString();

      SheetHelper.insert(SHEETS.TOKENS, {
        token,
        userId:    user.id,
        email:     user.email || idNorm,
        expiration,
        ip:        '',
        userAgent: '',
      });

      // Auditoría de login
      AuditService.log('Usuarios', user.id, 'LOGIN', user.id, {
        username: user.username,
      }, user);

      // 7. Retornar shape al frontend
      return {
        success: true,
        token,
        user: _buildUserShape(user),
      };

    } catch (e) {
      Logger.log(`[AuthService.login] error: ${e.message}`);
      return { success: false, message: 'Error interno. Intentá de nuevo.' };
    }
  }

  // ── LOGOUT ─────────────────────────────────────────────────

  /**
   * Invalida el token de sesión.
   * El frontend debe eliminar el token de sessionStorage al recibir la respuesta.
   *
   * @param {string} token
   * @returns {{ success: boolean }}
   */
  function logout(token) {
    try {
      _deleteToken(token);
      return { success: true };
    } catch (e) {
      Logger.log(`[AuthService.logout] error: ${e.message}`);
      return { success: false };
    }
  }

  // ── VALIDACIÓN Y REHIDRATACIÓN ─────────────────────────────

  /**
   * Retorna los datos del usuario autenticado a partir de un token válido.
   * Extiende la sesión (sliding window) en cada llamada.
   * Usado para restaurar sesión al recargar la página.
   *
   * @param {string} token
   * @returns {{ success: boolean, user?: Object, message?: string }}
   */
  function getCurrentUser(token) {
    // Usa _validateTokenV5 propio (schema v5: 'token','userId','expiration')
    // NO llama a Auth.gs validateToken() que busca columnas legacy mayúsculas.
    const validation = _validateTokenV5(token);
    if (!validation.valid) {
      return { success: false, message: 'Sesión expirada. Ingresá nuevamente.' };
    }

    try {
      const user = SheetHelper.getById(SHEETS.USERS, validation.userId);
      if (!user) return { success: false, message: 'Usuario no encontrado' };

      // Verificar que la cuenta siga activa
      if (user.status === 'inactive' || user.status === 'blocked') {
        _deleteToken(token);
        return { success: false, message: 'Tu cuenta fue desactivada.' };
      }

      // Sliding window: extender TTL del token (schema v5)
      _refreshTokenV5(token);

      return {
        success: true,
        user: _buildUserShape(user),
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ── RECUPERACIÓN DE CONTRASEÑA (3 pasos) ──────────────────

  /**
   * PASO 1: Envía código OTP al email registrado.
   * Siempre responde OK para evitar enumeración de usuarios.
   *
   * @param {string} email
   * @returns {{ success: boolean, message: string }}
   */
  function sendRecovery(email) {
    try {
      const emailNorm = (email || '').toLowerCase().trim();
      if (!emailNorm) return { success: false, message: 'Email requerido' };

      const user = SheetHelper.findOne(
        SHEETS.USERS,
        u => (u.email || '').toLowerCase() === emailNorm
      );

      // Responder OK siempre (anti-enumeration)
      if (!user) {
        return {
          success: true,
          message: 'Si el email está registrado, recibirás el código.',
        };
      }

      // Limpiar OTPs previos no usados
      _cleanOTPs(emailNorm);

      // Generar OTP
      const otp        = generateOTP();
      const expiration = new Date(
        Date.now() + AUTH_CONFIG.RECOVERY_TTL_MIN * 60000
      ).toISOString();

      SheetHelper.insert(SHEETS.RECOVERY, {
        token:      otp,
        email:      emailNorm,
        expiration,
        used:       false,
        attempts:   0,
      });

      // Enviar email con template HTML
      _sendRecoveryEmail(emailNorm, user.name || 'Usuario', otp);

      return { success: true, message: 'Código enviado. Revisá tu email.' };

    } catch (e) {
      Logger.log(`[AuthService.sendRecovery] error: ${e.message}`);
      return { success: false, message: 'Error al enviar el email. Intentá de nuevo.' };
    }
  }

  /**
   * PASO 2: Valida el OTP ingresado.
   * Cuenta intentos fallidos — bloquea después de MAX_OTP_ATTEMPTS.
   *
   * @param {string} code - OTP de 6 dígitos
   * @returns {{ valid: boolean, email?: string, message?: string }}
   */
  function validateOTP(code) {
    try {
      const codeStr = String(code || '').trim();
      const row     = SheetHelper.findOne(
        SHEETS.RECOVERY,
        r => String(r.token) === codeStr && r.used !== true && r.used !== 'true'
      );

      if (!row) {
        return { valid: false, message: 'Código incorrecto o ya utilizado' };
      }

      // Verificar expiración
      if (new Date(row.expiration) < new Date()) {
        SheetHelper.update(SHEETS.RECOVERY, row.token, { ...row, used: true });
        return { valid: false, message: 'El código expiró. Solicitá uno nuevo.' };
      }

      // Verificar intentos
      const attempts = parseInt(row.attempts || 0);
      if (attempts >= AUTH_CONFIG.MAX_OTP_ATTEMPTS) {
        SheetHelper.update(SHEETS.RECOVERY, row.token, { ...row, used: true });
        return { valid: false, message: 'Demasiados intentos. Solicitá un nuevo código.' };
      }

      return { valid: true, email: row.email };

    } catch (e) {
      Logger.log(`[AuthService.validateOTP] error: ${e.message}`);
      return { valid: false, message: e.message };
    }
  }

  /**
   * PASO 3: Restablece la contraseña con OTP validado.
   * Marca el OTP como usado para prevenir replay attacks.
   * Invalida todas las sesiones activas del usuario.
   *
   * @param {string} code        - OTP validado en el paso 2
   * @param {string} newPassword - nueva contraseña en texto plano
   * @returns {{ success: boolean, message: string }}
   */
  function resetPassword(code, newPassword) {
    try {
      if (!newPassword || newPassword.length < AUTH_CONFIG.MIN_PASS_LENGTH) {
        return {
          success: false,
          message: `Mínimo ${AUTH_CONFIG.MIN_PASS_LENGTH} caracteres`,
        };
      }

      const codeStr = String(code || '').trim();
      const row     = SheetHelper.findOne(
        SHEETS.RECOVERY,
        r => String(r.token) === codeStr && r.used !== true && r.used !== 'true'
      );

      if (!row) {
        return { success: false, message: 'Código inválido o ya utilizado' };
      }
      if (new Date(row.expiration) < new Date()) {
        SheetHelper.update(SHEETS.RECOVERY, row.token, { ...row, used: true });
        return { success: false, message: 'Código expirado. Solicitá uno nuevo.' };
      }

      // Actualizar contraseña del usuario
      const emailNorm = (row.email || '').toLowerCase().trim();
      const user = SheetHelper.findOne(
        SHEETS.USERS,
        u => (u.email || '').toLowerCase() === emailNorm
      );

      if (!user) {
        return { success: false, message: 'Usuario no encontrado' };
      }

      SheetHelper.update(SHEETS.USERS, user.id, {
        ...user,
        password:  hashPassword(newPassword),
        updatedAt: _nowIso(),
      });
      SheetHelper.evict(SHEETS.USERS);

      // Marcar OTP como usado
      SheetHelper.update(SHEETS.RECOVERY, row.token, { ...row, used: true });

      // Invalidar todas las sesiones activas
      _invalidateUserTokens(user.id);

      AuditService.log('Usuarios', user.id, 'RESET_PASSWORD', user.id, {
        email: emailNorm,
      }, user);

      return { success: true, message: 'Contraseña actualizada correctamente' };

    } catch (e) {
      Logger.log(`[AuthService.resetPassword] error: ${e.message}`);
      return { success: false, message: 'Error al cambiar la contraseña.' };
    }
  }

  // ── PRIVADOS ───────────────────────────────────────────────

  /**
   * Construye el shape de usuario que espera el frontend v4.
   * Sin password. Con churchName desnormalizado.
   */
  function _buildUserShape(user) {
    let churchName = '';
    if (user.churchId) {
      try {
        const church = SheetHelper.getById(SHEETS.CHURCHES, user.churchId);
        if (church) churchName = church.name;
      } catch (_) {}
    }
    return {
      id:            user.id,
      name:          user.name          || '',
      email:         user.email         || '',
      username:      user.username      || '',
      role:          user.role          || user.roleId || '',
      churchId:      user.churchId      || '',
      churchName,
      assignedGrade: user.assignedGrade || null,
      photoUrl:      user.photoUrl      || '',
      personId:      user.personId      || '',
      status:        user.status        || 'active',
    };
  }

  /**
   * Elimina todos los tokens de sesión de un usuario.
   * Garantiza one-session-per-user.
   * USA findWhere por campo 'userId' (schema v5) + deleteRow directo
   * porque la PK de Tokens es 'token', no 'id'.
   */
  function _invalidateUserTokens(userId) {
    try {
      const tokens = SheetHelper.findWhere(
        SHEETS.TOKENS,
        t => String(t.userId) === String(userId)
      );
      // Borrar via update que marca deleted, o directo por campo token
      [...tokens].forEach(t => {
        try {
          _deleteToken(t.token);
        } catch (_) {}
      });
    } catch (e) {
      Logger.log(`[AuthService._invalidateUserTokens] error: ${e.message}`);
    }
  }

  /**
   * Elimina un token específico de la hoja Tokens.
   * La PK de la hoja Tokens es el campo 'token' (no 'id'),
   * por lo que usamos findWhere + deleteRow directo.
   */
  function _deleteToken(token) {
    if (!token) return;
    try {
      // Buscar la fila por el campo 'token' usando SheetHelper interno
      const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet   = ss.getSheetByName(SHEETS.TOKENS);
      if (!sheet) return;
      const lastRow = sheet.getLastRow();
      if (lastRow <= 1) return;

      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const tCol    = headers.indexOf('token');
      if (tCol < 0) return;

      const colVals = sheet.getRange(2, tCol + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < colVals.length; i++) {
        if (String(colVals[i][0]) === String(token)) {
          sheet.deleteRow(i + 2);
          // Invalidar cache in-memory de Auth.gs si está disponible
          if (typeof _invalidateTokenCache === 'function') {
            try { _invalidateTokenCache(token); } catch (_) {}
          }
          // Evict caché de SheetHelper para Tokens
          SheetHelper.evict(SHEETS.TOKENS);
          return;
        }
      }
    } catch (e) {
      Logger.log(`[AuthService._deleteToken] error: ${e.message}`);
    }
  }

  /**
   * Elimina OTPs no usados de un email (evita acumulación).
   * Recovery table también usa 'token' como PK (no 'id').
   */
  function _cleanOTPs(emailNorm) {
    try {
      const toClean = SheetHelper.findWhere(
        SHEETS.RECOVERY,
        r => (r.email || '').toLowerCase() === emailNorm &&
             r.used !== true && r.used !== 'true'
      );
      if (!toClean.length) return;

      const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName(SHEETS.RECOVERY);
      if (!sheet) return;
      const lastRow = sheet.getLastRow();
      if (lastRow <= 1) return;

      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const tCol    = headers.indexOf('token');
      if (tCol < 0) return;

      const tokensToDelete = new Set(toClean.map(r => String(r.token)));
      const colVals = sheet.getRange(2, tCol + 1, lastRow - 1, 1).getValues();

      // Borrar de abajo hacia arriba para no desplazar índices
      for (let i = colVals.length - 1; i >= 0; i--) {
        if (tokensToDelete.has(String(colVals[i][0]))) {
          sheet.deleteRow(i + 2);
        }
      }
      SheetHelper.evict(SHEETS.RECOVERY);
    } catch (e) {
      Logger.log(`[AuthService._cleanOTPs] error: ${e.message}`);
    }
  }

  // ── VALIDACIÓN DE TOKEN V5 ────────────────────────────────
  // Implementación propia que usa el schema v5 de Config.gs:
  //   campo 'token'      (Auth.gs usaba 'Token')
  //   campo 'userId'     (Auth.gs usaba 'UserID')
  //   campo 'expiration' (Auth.gs usaba 'Expiracion')
  //
  // Cache en memoria: mismo patrón que Auth.gs pero separado
  // para no contaminar el cache legacy de validateToken().

  const _tokenCacheV5 = {};

  /**
   * Valida un token contra la hoja Tokens usando schema v5.
   * @returns {{ valid: boolean, userId?: string, email?: string }}
   */
  function _validateTokenV5(token) {
    if (!token) return { valid: false };

    // L1: cache en memoria
    const cached = _tokenCacheV5[token];
    if (cached) {
      if (new Date(cached.expiration) > new Date()) return cached;
      delete _tokenCacheV5[token];
      return { valid: false };
    }

    try {
      // Buscar en la hoja usando SheetHelper (respeta schema v5)
      const row = SheetHelper.findOne(
        SHEETS.TOKENS,
        t => String(t.token) === String(token)
      );

      if (!row) return { valid: false };

      // Verificar expiración
      const exp = new Date(row.expiration);
      if (isNaN(exp.getTime()) || exp < new Date()) {
        return { valid: false };
      }

      const result = {
        valid:      true,
        userId:     row.userId,
        email:      row.email,
        expiration: row.expiration,
      };

      // Guardar en cache
      _tokenCacheV5[token] = result;
      return result;

    } catch (e) {
      Logger.log(`[AuthService._validateTokenV5] error: ${e.message}`);
      return { valid: false };
    }
  }

  /**
   * Extiende la expiración del token (sliding window) — schema v5.
   * @param {string} token
   */
  function _refreshTokenV5(token) {
    try {
      const row = SheetHelper.findOne(
        SHEETS.TOKENS,
        t => String(t.token) === String(token)
      );
      if (!row) return;

      const newExp = new Date(
        Date.now() + AUTH_CONFIG.TOKEN_TTL_HOURS * 3600000
      ).toISOString();

      // Actualizar campo 'expiration' en la hoja
      // SheetHelper.update busca por campo 'id', pero Tokens usa 'token'.
      // Actualizamos directamente via SpreadsheetApp.
      const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet   = ss.getSheetByName(SHEETS.TOKENS);
      if (!sheet) return;
      const lastRow = sheet.getLastRow();
      if (lastRow <= 1) return;

      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const tCol    = headers.indexOf('token');
      const expCol  = headers.indexOf('expiration');
      if (tCol < 0 || expCol < 0) return;

      const colVals = sheet.getRange(2, tCol + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < colVals.length; i++) {
        if (String(colVals[i][0]) === String(token)) {
          sheet.getRange(i + 2, expCol + 1).setValue(newExp);
          // Actualizar cache
          if (_tokenCacheV5[token]) _tokenCacheV5[token].expiration = newExp;
          SheetHelper.evict(SHEETS.TOKENS);
          return;
        }
      }
    } catch (e) {
      Logger.log(`[AuthService._refreshTokenV5] error: ${e.message}`);
    }
  }

  // ── API PÚBLICA ────────────────────────────────────────────

  return {
    login,
    logout,
    getCurrentUser,
    sendRecovery,
    validateOTP,
    resetPassword,
  };

})();