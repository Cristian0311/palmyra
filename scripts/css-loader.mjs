/**
 * Loader de Node para smoke tests (solo scripts/): .css como módulo vacío
 * y shim de `import.meta.env` (tsx no emula el entorno de Vite).
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }
  const result = await nextLoad(url, context);
  if ((result.format === 'module' || result.format === 'commonjs') && result.source !== undefined) {
    const source = typeof result.source === 'string'
      ? result.source
      : Buffer.from(result.source).toString('utf8');
    const shim = 'import.meta.env=import.meta.env??{};';
    return { ...result, source: shim + source };
  }
  return result;
}
