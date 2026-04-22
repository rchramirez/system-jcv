/**
 * PASO 1: Limpiar todos los caches de GAS (Script, Document, User)
 * Ejecutá esta función en la consola de Apps Script (Tools > Script Editor)
 */
function clearAllCaches() {
  try {
    console.log('🔄 Limpiando caches de GAS...');
    
    // Limpiar ScriptCache — solo las claves que JCV usa
    const scriptCache = CacheService.getScriptCache();
    const jcvKeys = [
      'jcv:' + SHEETS.CELLS,
      'jcv:' + SHEETS.CHURCHES,
      'jcv:' + SHEETS.ROLES,
      'jcv:' + SHEETS.PERIODS,
      'jcv:' + SHEETS.PROGRAMS,
      'jcv:' + SHEETS.USERS,
      'jcv:' + SHEETS.ENROLLMENTS,
      'jcv:' + SHEETS.SCORES,
      'jcv:' + SHEETS.CLASSES,
    ];
    
    let removedCount = 0;
    for (const key of jcvKeys) {
      try {
        scriptCache.remove(key);
        console.log(`  ✓ Removido: ${key}`);
        removedCount++;
      } catch (e) {
        console.log(`  ⚠ No existe o error: ${key}`);
      }
    }
    
    // Limpiar DocumentCache
    const docCache = CacheService.getDocumentCache();
    for (const key of jcvKeys) {
      try {
        docCache.remove(key);
        removedCount++;
      } catch (e) {}
    }
    
    // Limpiar UserCache
    const userCache = CacheService.getUserCache();
    for (const key of jcvKeys) {
      try {
        userCache.remove(key);
        removedCount++;
      } catch (e) {}
    }
    
    console.log(`✅ Limpieza completada. ${removedCount} entradas de caché removidas.`);
    return { ok: true, message: `Limpios ${removedCount} items de caché` };
    
  } catch (error) {
    console.error('❌ Error al limpiar caches:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * PASO 2: Verificar qué hojas existen en el Spreadsheet
 * Ejecutá después de clearAllCaches()
 */
function checkSheetsExist() {
  try {
    console.log('\n📊 Verificando hojas del Spreadsheet...\n');
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const allSheets = ss.getSheets();
    const sheetNames = new Set(allSheets.map(s => s.getName()));
    
    const requiredSheets = Object.values(SHEETS);
    console.log(`Total de hojas en el spreadsheet: ${allSheets.length}`);
    console.log(`Hojas requeridas: ${requiredSheets.length}\n`);
    
    const results = {};
    for (const sheetName of requiredSheets) {
      const exists = sheetNames.has(sheetName);
      if (exists) {
        const sheet = ss.getSheetByName(sheetName);
        const rowCount = sheet.getLastRow() - 1; // excluyendo header
        const colCount = sheet.getLastColumn();
        results[sheetName] = {
          exists: true,
          rows: rowCount,
          columns: colCount,
          status: '✓'
        };
        console.log(`✓ ${sheetName}: ${rowCount} filas, ${colCount} columnas`);
      } else {
        results[sheetName] = {
          exists: false,
          status: '✗ FALTA'
        };
        console.log(`✗ FALTA: ${sheetName}`);
      }
    }
    
    console.log('\n📋 Resumen:');
    const missingSheets = requiredSheets.filter(s => !sheetNames.has(s));
    if (missingSheets.length === 0) {
      console.log('✅ TODAS las hojas existen.');
      return { ok: true, allSheetsExist: true, results };
    } else {
      console.log(`⚠ FALTAN ${missingSheets.length} hojas:`);
      missingSheets.forEach(s => console.log(`  - ${s}`));
      return { ok: false, missingSheets, results };
    }
    
  } catch (error) {
    console.error('❌ Error en checkSheetsExist:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * PASO 3: Test directo de getDashboardStats() 
 * Ejecutá después de checkSheetsExist()
 */
function testGetDashboardStats() {
  try {
    console.log('\n🧪 Testeando getDashboardStats()...\n');
    
    const result = getDashboardStats();
    
    if (result && result.ok) {
      console.log('✅ SUCCESS! getDashboardStats() retornó datos:');
      console.log(JSON.stringify(result.data, null, 2));
      return { ok: true, success: true, data: result.data };
    } else {
      console.log('❌ FAILED! getDashboardStats() retornó error:');
      console.log('Error:', result.error);
      return { ok: false, error: result.error };
    }
    
  } catch (error) {
    console.error('❌ Exception en testGetDashboardStats:', error.message);
    console.error('Stack:', error.stack);
    return { ok: false, exception: error.message, stack: error.stack };
  }
}

/**
 * RESUMEN: Ejecutá estas funciones en orden
 */
function runFullDiagnostic() {
  console.log('🚀 INICIANDO DIAGNÓSTICO COMPLETO...\n');
  
  // Paso 1
  console.log('='.repeat(60));
  console.log('PASO 1: Limpiar Caches');
  console.log('='.repeat(60));
  const clearResult = clearAllCaches();
  
  // Paso 2
  console.log('\n' + '='.repeat(60));
  console.log('PASO 2: Verificar Hojas');
  console.log('='.repeat(60));
  const sheetsResult = checkSheetsExist();
  
  // Paso 3
  console.log('\n' + '='.repeat(60));
  console.log('PASO 3: Test getDashboardStats');
  console.log('='.repeat(60));
  const statsResult = testGetDashboardStats();
  
  // Resumen final
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMEN FINAL');
  console.log('='.repeat(60));
  console.log('Caches limpiados:', clearResult.ok ? '✓' : '✗');
  console.log('Hojas validadas:', sheetsResult.ok ? '✓' : '✗');
  if (sheetsResult.results) {
    const existing = Object.values(sheetsResult.results).filter(r => r.exists).length;
    const total = Object.values(sheetsResult.results).length;
    console.log(`  → ${existing}/${total} hojas existen`);
  }
  console.log('getDashboardStats() test:', statsResult.ok && statsResult.success ? '✅ FUNCIONA' : '❌ FALLA');
  
  return {
    clearCache: clearResult,
    sheets: sheetsResult,
    stats: statsResult
  };
}
