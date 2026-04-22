// ============================================================
// JCV SYSTEM — Auth.gs
// Sistema de autenticación con tokens, recuperación por email
// Basado en la arquitectura de MODA POS
// ============================================================

// ── SCHEMA ADICIONAL (agregar a SHEETS en Code.gs) ──────────
// TOKENS:     'Tokens'      → Token, UserID, Email, Expiracion, IP, UserAgent
// RECOVERY:   'Recuperacion'→ Token, Email, Expiracion, Usado, Intentos

// ============================================================
// CRYPTO & TOKEN UTILITIES
// ============================================================

/**
 * Hash SHA-256 de la contraseña.
 * Convierte bytes a hex string.
 */
function hashPassword(password) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password + 'jcv_salt_2024'  // Salt fijo — mejora seguridad vs rainbow tables
  );
  return raw.map(b => ((b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))).join('');
}

/**
 * Genera un UUID limpio como token de sesión.
 */
function generateToken() {
  return Utilities.getUuid().replace(/-/g, '') + Date.now().toString(36);
}

/**
 * Genera un código OTP numérico de 6 dígitos.
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Token cache en memoria (vida del script) ─────────────────
var _tokenCache = {};

function _invalidateTokenCache(token) {
  delete _tokenCache[token];
}

/**
 * Valida un token de sesión.
 * Primero busca en cache en memoria, luego en Sheets.
 * @returns {{ valid: boolean, userId?: string, email?: string, role?: string }}
 */
function validateToken(token) {
  if (!token) return { valid: false };

  // Cache hit
  if (_tokenCache[token]) {
    const cached = _tokenCache[token];
    if (new Date(cached.expiracion) > new Date()) return cached;
    delete _tokenCache[token];
    return { valid: false };
  }

  try {
    const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet  = ss.getSheetByName(SHEETS.TOKENS);
    const data   = sheet.getDataRange().getValues();
    const H      = data[0];

    const tIdx   = H.indexOf('Token');
    const uIdx   = H.indexOf('UserID');
    const eIdx   = H.indexOf('Email');
    const expIdx = H.indexOf('Expiracion');

    const row = data.slice(1).find(r => r[tIdx] === token);
    if (!row) return { valid: false };

    const expiration = new Date(row[expIdx]);
    if (expiration < new Date()) {
      // Token expirado — limpieza lazy
      _invalidateTokenCache(token);
      return { valid: false };
    }

    const result = {
      valid:      true,
      userId:     row[uIdx],
      email:      row[eIdx],
      expiracion: row[expIdx],
    };
    _tokenCache[token] = result;
    return result;

  } catch (e) {
    Logger.log('validateToken error: ' + e.message);
    return { valid: false };
  }
}

/**
 * Extiende la expiración del token (sliding window).
 * Llama cada vez que el usuario interactúa con la app.
 */
function _refreshToken(token) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEETS.TOKENS);
    const data  = sheet.getDataRange().getValues();
    const H     = data[0];
    const tIdx  = H.indexOf('Token');
    const expIdx= H.indexOf('Expiracion');
    const rowIdx= data.findIndex((r, i) => i > 0 && r[tIdx] === token);
    if (rowIdx < 1) return;

    const newExp = new Date(Date.now() + AUTH_CONFIG.TOKEN_TTL_HOURS * 3600000).toISOString();
    sheet.getRange(rowIdx + 1, expIdx + 1).setValue(newExp);

    // Actualizar cache
    if (_tokenCache[token]) _tokenCache[token].expiracion = newExp;
  } catch (e) {
    Logger.log('_refreshToken error: ' + e.message);
  }
}

// ============================================================
// EMAIL TEMPLATES
// ============================================================

/**
 * Envía el email de recuperación con el OTP.
 * Template con diseño JCV adaptado del POS.
 */
function _sendRecoveryEmail(email, userName, otp) {
  const subject = `🔐 ${AUTH_CONFIG.APP_NAME} — Código de recuperación`;

  const htmlBody = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a1a;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;background:linear-gradient(135deg,#071E5C 0%,#0D3A8C 55%,#1A5FD4 100%)">
    <tr><td align="center" style="padding:48px 24px">
      <table width="100%" style="max-width:480px;background:rgba(255,255,255,.97);border-radius:24px;overflow:hidden;box-shadow:0 32px 80px rgba(7,30,92,.4)">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#071E5C,#1A5FD4);padding:36px 40px;text-align:center">
          <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,.15);border:3px solid rgba(255,255,255,.4);display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px">
            <span style="color:#fff;font-size:22px;font-weight:900;font-family:Georgia,serif">JCV</span>
          </div>
          <h1 style="color:#fff;font-family:Georgia,serif;font-size:22px;font-weight:800;margin:0 0 4px;letter-spacing:1px">Jesus Camino de Vida</h1>
          <p style="color:rgba(255,255,255,.6);font-size:12px;margin:0;letter-spacing:3px;text-transform:uppercase">Sistema de Gestión Ministerial</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:40px">
          <h2 style="color:#0F172A;font-size:20px;font-weight:700;margin:0 0 8px;font-family:Georgia,serif">Recuperación de contraseña</h2>
          <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 28px">
            Hola <strong style="color:#1A5FD4">${userName}</strong>, recibimos una solicitud para restablecer la contraseña de tu cuenta.
            Usá el siguiente código de 6 dígitos:
          </p>

          <!-- OTP Code -->
          <div style="text-align:center;margin:28px 0">
            <div style="display:inline-block;background:linear-gradient(135deg,#E8F0FE,#C5D8FC);border:2px solid #1A5FD4;border-radius:16px;padding:20px 36px">
              <div style="font-size:13px;color:#1A5FD4;font-weight:600;letter-spacing:4px;text-transform:uppercase;margin-bottom:8px">Código de verificación</div>
              <div style="font-size:40px;font-weight:900;letter-spacing:14px;color:#071E5C;font-family:monospace">${otp}</div>
            </div>
          </div>

          <!-- Expiry info -->
          <div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:12px;padding:14px 18px;margin-bottom:24px">
            <p style="color:#92400E;font-size:13px;margin:0">
              ⏱ <strong>Este código expira en ${AUTH_CONFIG.RECOVERY_TTL_MIN} minutos.</strong>
              Si no solicitaste este cambio, ignorá este email.
            </p>
          </div>

          <p style="color:#94A3B8;font-size:12px;line-height:1.6;margin:0">
            Por seguridad, nunca compartas este código con nadie. El equipo de JCV jamás te lo pedirá.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F8FAFC;padding:20px 40px;border-top:1px solid #E2E8F0;text-align:center">
          <p style="color:#94A3B8;font-size:11px;margin:0">
            ${AUTH_CONFIG.APP_NAME} · ${AUTH_CONFIG.APP_SUBTITLE}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    MailApp.sendEmail({
      to:       email,
      subject,
      htmlBody,
      name:     AUTH_CONFIG.APP_NAME,
    });
  } catch (e) {
    Logger.log('_sendRecoveryEmail error: ' + e.message);
    throw new Error('No se pudo enviar el email. Verificá la dirección.');
  }
}

// ============================================================
// HELPERS PRIVADOS
// ============================================================

/**
 * Elimina todos los tokens activos de un usuario.
 * Llama antes de crear un nuevo token (one-session-per-user).
 */
function _cleanUserTokens(ss, userId) {
  try {
    const sheet = ss.getSheetByName(SHEETS.TOKENS);
    const data  = sheet.getDataRange().getValues();
    const H     = data[0];
    const uIdx  = H.indexOf('UserID');
    const tIdx  = H.indexOf('Token');

    // Recorre de abajo hacia arriba para no desplazar índices al borrar
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][uIdx] === userId) {
        _invalidateTokenCache(data[i][tIdx]);
        sheet.deleteRow(i + 1);
      }
    }
  } catch (e) {
    Logger.log('_cleanUserTokens error: ' + e.message);
  }
}

/**
 * Elimina OTPs no usados de un email (evita acumulación).
 */
function _cleanUserOTPs(ss, email) {
  try {
    const sheet = ss.getSheetByName(SHEETS.RECOVERY);
    const data  = sheet.getDataRange().getValues();
    const H     = data[0];
    const eIdx  = H.indexOf('Email');
    const uIdx  = H.indexOf('Usado');

    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][eIdx].toString().toLowerCase() === email && !data[i][uIdx]) {
        sheet.deleteRow(i + 1);
      }
    }
  } catch (e) {
    Logger.log('_cleanUserOTPs error: ' + e.message);
  }
}

/**
 * Obtiene el nombre de una iglesia por ID.
 */
function _getChurchName(ss, churchId) {
  if (!churchId) return '';
  try {
    const data = ss.getSheetByName(SHEETS.CHURCHES).getDataRange().getValues();
    const H    = data[0];
    const row  = data.slice(1).find(r => r[H.indexOf('id')] === churchId);
    return row ? row[H.indexOf('name')] : '';
  } catch (e) {
    return '';
  }
}

// ============================================================
// SCHEMA TOKENS — Agregar a initializeSheets()
// ============================================================
// SHEETS.TOKENS:    ['Token','UserID','Email','Expiracion','IP','UserAgent']
// SHEETS.RECOVERY:  ['Token','Email','Expiracion','Usado','Intentos']
