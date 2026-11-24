#!/usr/bin/env node
/**
 * Validador local del materializador de `local_change_inbox`.
 *
 * No usa dependencias, red ni la CLI de Supabase: solo lee archivos del repo.
 *
 * Qué comprueba:
 *  1. Cada tabla `public.<tabla>` que menciona la migración del materializador
 *     existe en el esquema evidenciado por las migraciones y el cliente.
 *  2. Cada columna escrita con INSERT ... (columnas) o UPDATE ... SET columna
 *     existe en esa tabla según la evidencia disponible.
 *  3. Cada tabla local del mapa TS tiene su rama `when '<local>' then '<cloud>'`
 *     y el destino coincide; cada rama del SQL tiene entrada en el mapa.
 *  4. Toda tabla de `LOCAL_DB_TABLES` está materializada o excluida con motivo.
 *  5. `sale_voids` (tabla solo local, sin DDL cloud) NO está en el mapa y sí en
 *     la lista de exclusión explícita `LOCAL_ONLY_TABLES`.
 *
 * Evidencia de columnas:
 *  - `create table` y `alter table ... add column` de TODAS las migraciones,
 *    incluida la del propio materializador (solo su DDL: su DML es el objeto
 *    validado y no puede usarse como prueba de sí mismo).
 *  - Listas de columnas de `insert into` y `update ... set` del resto de
 *    migraciones (las tablas de negocio ya existían antes de este repo y no
 *    tienen DDL).
 *  - `.select('...')`, claves de objetos de `.upsert/.insert/.update` y
 *    columnas de `.eq/.order/...` del cliente Supabase
 *    (`src/services/supabaseSync/**`), que corre contra ese mismo esquema.
 *    Sin esto, tablas como customers/suppliers/quotes no tendrían evidencia.
 *  - `CLIENT_READ_EVIDENCE`: lecturas indirectas (campos leídos de filas
 *    `select('*')` en mappers) que el parser no puede asociar a una tabla; se
 *    declaran con archivo y línea para que sean auditables.
 *
 * Política de fallo: si una tabla tiene evidencia, una columna desconocida es
 * un ERROR, salvo que el materializador la escriba tras comprobar su
 * existencia en `information_schema.columns` (entonces es una ADVERTENCIA y el
 * SQL tiene una rama alternativa). Las columnas evidenciadas que el mapa no
 * escribe se resumen en una ADVERTENCIA por tabla, nunca en un error.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

export const MIGRATIONS_DIR = "supabase/migrations";
export const MATERIALIZER_FILE = "20261123150000_local_change_materializer.sql";
export const MAPPING_FILE = "src/services/cloudSync/materializeMapping.ts";
export const SCHEMA_FILE = "src/services/localDb/schema.ts";
export const CLIENT_EVIDENCE_FILES = [
  "src/services/supabaseSync/mutations.ts",
  "src/services/supabaseSync/cashMutations.ts",
  "src/services/supabaseSync/rpc.ts",
  "src/services/supabaseSync/pull.ts",
  "src/services/supabaseSync/pull/mappers.ts",
  "src/services/supabaseSync/pull/loadOperationalExtras.ts"
];

/* -------------------------------------------------------------------------- */
/* Lectura y normalización                                                    */
/* -------------------------------------------------------------------------- */

function readText(root, relative) {
  return readFileSync(join(root, relative), "utf8");
}

function readMigrations(root, skipName) {
  const dir = join(root, MIGRATIONS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name), "utf8")
    }))
    .filter((migration) => migration.name !== skipName);
}

/**
 * Elimina comentarios y, opcionalmente, literales de cadena. Los literales se
 * reemplazan por `''` para que ninguna palabra dentro de un mensaje se confunda
 * con DDL/DML. El contenido de bloques `$$ ... $$` se conserva porque es código
 * PL/pgSQL real.
 */
function cleanSql(sql, { keepStrings = false } = {}) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += keepStrings ? sql.slice(start, i) : "''";
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end !== -1) {
          out += ` ${sql.slice(i + tag[0].length, end)} `;
          i = end + tag[0].length;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Devuelve el contenido entre paréntesis y el índice siguiente al cierre. */
function readParenGroup(text, openIndex) {
  if (text[openIndex] !== "(") return null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Separa por comas de nivel superior (paréntesis). */
function splitTopLevel(content) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "(") depth += 1;
    else if (content[i] === ")") depth -= 1;
    else if (content[i] === "," && depth === 0) {
      parts.push(content.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(content.slice(start));
  return parts;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

function normalizeIdentifier(raw) {
  const name = raw.trim().replace(/^"|"$/g, "");
  return IDENTIFIER.test(name) ? name.toLowerCase() : null;
}

/* -------------------------------------------------------------------------- */
/* Evidencia SQL                                                              */
/* -------------------------------------------------------------------------- */

const DDL_DEFINITION_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "check",
  "foreign",
  "exclude",
  "like"
]);

function collectCreateTables(clean, addColumn, touchTable) {
  const re = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let match;
  while ((match = re.exec(clean))) {
    const table = match[1].toLowerCase();
    touchTable(table);
    const group = readParenGroup(clean, match.index + match[0].length - 1);
    if (!group) continue;
    for (const definition of splitTopLevel(group.content)) {
      const trimmed = definition.trim();
      if (!trimmed) continue;
      const first = trimmed.split(/\s+/)[0].toLowerCase();
      if (DDL_DEFINITION_KEYWORDS.has(first)) continue;
      const column = normalizeIdentifier(trimmed.split(/\s+/)[0]);
      if (column) addColumn(table, column);
    }
  }
}

function collectAlterTables(clean, addColumn, touchTable) {
  const re = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)([^;]*);/gi;
  let match;
  while ((match = re.exec(clean))) {
    const table = match[1].toLowerCase();
    touchTable(table);
    const body = match[2];
    const addRe = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
    let add;
    while ((add = addRe.exec(body))) addColumn(table, add[1].toLowerCase());
    const alterRe = /\balter\s+column\s+"?([a-z_][a-z0-9_]*)"?/gi;
    let alter;
    while ((alter = alterRe.exec(body))) addColumn(table, alter[1].toLowerCase());
  }
}

function columnListFromInsert(clean, startIndex) {
  const group = readParenGroup(clean, startIndex);
  if (!group) return null;
  const columns = [];
  for (const part of splitTopLevel(group.content)) {
    const column = normalizeIdentifier(part);
    if (!column) return null;
    columns.push(column);
  }
  return { columns, end: group.end };
}

function collectInserts(clean, addColumn, touchTable) {
  const re = /\binsert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let match;
  while ((match = re.exec(clean))) {
    const table = match[1].toLowerCase();
    touchTable(table);
    const parsed = columnListFromInsert(clean, match.index + match[0].length - 1);
    if (!parsed) continue;
    for (const column of parsed.columns) addColumn(table, column);
  }
}

/** Fin de una lista SET: WHERE/RETURNING/FROM a nivel 0 o `;`. */
function findSetEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && ch === ";") return i;
    else if (depth === 0 && /[a-z_]/i.test(ch) && (i === 0 || !/[a-z0-9_]/i.test(text[i - 1]))) {
      const word = text.slice(i, i + 9).toLowerCase();
      if (/^(where|returning|from)\b/.test(word)) return i;
    }
  }
  return text.length;
}

function collectUpdates(clean, addColumn, touchTable) {
  const re = /\bupdate\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+set\s+/gi;
  let match;
  while ((match = re.exec(clean))) {
    const table = match[1].toLowerCase();
    touchTable(table);
    const start = match.index + match[0].length;
    const end = findSetEnd(clean, start);
    for (const assignment of splitTopLevel(clean.slice(start, end))) {
      const column = assignment.split("=")[0].trim();
      const normalized = normalizeIdentifier(column);
      if (normalized) addColumn(table, normalized);
    }
    re.lastIndex = end;
  }
}

/**
 * Solo tablas mencionadas como public.<tabla> (para detectar tablas sin DML).
 * Se descartan dos falsos positivos habituales:
 *  - funciones: `public.materialize_local_change_inbox(` (el nombre va seguido
 *    de paréntesis),
 *  - tipos/casts: `null::public.payment_method` (precedido por `::`).
 */
function collectPublicRefs(clean, touchTable) {
  const re = /\bpublic\.([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = re.exec(clean))) {
    const after = clean.slice(re.lastIndex).search(/\S/);
    const nextChar = after === -1 ? "" : clean[re.lastIndex + after];
    if (nextChar === "(") continue;
    if (clean.slice(Math.max(0, match.index - 2), match.index) === "::") continue;
    touchTable(match[1].toLowerCase());
  }
}

/* -------------------------------------------------------------------------- */
/* Evidencia del cliente Supabase                                             */
/* -------------------------------------------------------------------------- */

function skipJsString(source, index) {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function readJsObject(source, openIndex) {
  if (source[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipJsString(source, i) - 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { content: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

function topLevelObjectKeys(content) {
  const keys = [];
  let depth = 0;
  let start = 0;
  const segments = [];
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipJsString(content, i) - 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push(content.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(content.slice(start));
  for (const segment of segments) {
    const match = /^\s*(?:\.\.\.)?\s*["']?([A-Za-z_$][\w$]*)["']?\s*:/.exec(segment);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function collectClientEvidence(source, addColumn, touchTable) {
  const fromRe = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
  let match;
  while ((match = fromRe.exec(source))) {
    const table = match[1].toLowerCase();
    touchTable(table);
    // La ventana termina en el siguiente `.from(`: en archivos minificados hay
    // varias cadenas por línea y sin este corte las claves de una tabla se
    // atribuirían a la anterior.
    const nextFrom = source.indexOf(".from(", match.index + match[0].length);
    const windowEnd = Math.min(
      nextFrom === -1 ? source.length : nextFrom,
      match.index + 6000
    );
    const window = source.slice(match.index, windowEnd);

    // `.upsert({...})`, `.insert({...})`, `.insert([{...}])` y también
    // `.insert(items.map(i => ({...})))`: se busca la primera llave de objeto
    // de la llamada, sin cruzar su paréntesis de cierre.
    const opRe = /\.(?:upsert|insert|update)\(/g;
    let op;
    while ((op = opRe.exec(window))) {
      let i = opRe.lastIndex;
      const limit = Math.min(window.length, i + 3000);
      let open = -1;
      while (i < limit) {
        const ch = window[i];
        if (ch === "'" || ch === '"' || ch === "`") {
          i = skipJsString(window, i);
          continue;
        }
        if (ch === "{") {
          open = i;
          break;
        }
        if (ch === ")") break;
        i += 1;
      }
      if (open === -1) continue;
      const object = readJsObject(window, open);
      if (!object) continue;
      for (const key of topLevelObjectKeys(object.content)) addColumn(table, key);
      opRe.lastIndex = object.end;
    }

    const selectRe = /\.select\(\s*['"]([^'"]+)['"]/g;
    let select;
    while ((select = selectRe.exec(window))) {
      const list = select[1];
      if (list.includes("*")) continue;
      for (const part of list.split(",")) {
        const column = normalizeIdentifier(part.trim().split(/\s+/)[0]);
        if (column) addColumn(table, column);
      }
    }

    // Filtros y ordenaciones: PostgREST los valida contra columnas reales, así
    // que `.eq('created_at')` u `.order('created_at')` prueban su existencia.
    const filterRe =
      /\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|order|filter)\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    let filter;
    while ((filter = filterRe.exec(window))) addColumn(table, filter[1].toLowerCase());
  }
}

/**
 * Lecturas indirectas que el parser no puede asociar a una tabla: campos leídos
 * de filas traídas con `select('*')`. Se declaran con archivo y línea para que
 * la evidencia sea auditable; no se inventan columnas.
 */
export const CLIENT_READ_EVIDENCE = {
  products: {
    track_serial: "src/services/supabaseSync/pull/mappers.ts:19",
    is_kit: "src/services/supabaseSync/pull/mappers.ts:21",
    image_path: "src/services/supabaseSync/pull/mappers.ts:27"
  },
  product_variants: {
    attributes: "src/services/supabaseSync/pull.ts:64-65 (v.attributes)"
  }
};

/**
 * Columnas que el materializador escribe solo tras comprobar su existencia en
 * `information_schema.columns` (bloques `if exists (...)`). No son errores si
 * no hay evidencia: el SQL degrada a una rama alternativa. Se devuelven como
 * `tabla.columna`.
 */
export function collectGuardedColumns(sql) {
  const clean = cleanSql(sql);
  const guarded = new Set();
  const patterns = [
    /information_schema\.columns[\s\S]{0,400}?table_name\s*=\s*'([a-z_][a-z0-9_]*)'[\s\S]{0,200}?column_name\s*=\s*'([a-z_][a-z0-9_]*)'/gi,
    /information_schema\.columns[\s\S]{0,400}?column_name\s*=\s*'([a-z_][a-z0-9_]*)'[\s\S]{0,200}?table_name\s*=\s*'([a-z_][a-z0-9_]*)'/gi
  ];
  for (const pattern of patterns) {
    const swapped = pattern === patterns[1];
    let match;
    while ((match = pattern.exec(clean))) {
      const table = (swapped ? match[2] : match[1]).toLowerCase();
      const column = (swapped ? match[1] : match[2]).toLowerCase();
      guarded.add(`${table}.${column}`);
    }
  }
  return guarded;
}

/* -------------------------------------------------------------------------- */
/* Evidencia combinada                                                        */
/* -------------------------------------------------------------------------- */

function createEvidence() {
  const tables = new Map();
  const ensure = (table) => {
    if (!tables.has(table)) tables.set(table, new Set());
    return tables.get(table);
  };
  return {
    tables,
    touchTable: (table) => ensure(table),
    addColumn: (table, column) => ensure(table).add(column)
  };
}

export function buildSchemaEvidence(migrations, materializerName) {
  const evidence = createEvidence();
  for (const migration of migrations) {
    const isMaterializer = migration.name === materializerName;
    const clean = cleanSql(migration.sql);
    if (!isMaterializer) collectPublicRefs(clean, evidence.touchTable);
    collectCreateTables(clean, evidence.addColumn, evidence.touchTable);
    collectAlterTables(clean, evidence.addColumn, evidence.touchTable);
    if (!isMaterializer) {
      collectInserts(clean, evidence.addColumn, evidence.touchTable);
      collectUpdates(clean, evidence.addColumn, evidence.touchTable);
    }
  }
  const result = new Map();
  for (const [table, columns] of evidence.tables) result.set(table, [...columns].sort());
  return result;
}

/* -------------------------------------------------------------------------- */
/* Referencias del materializador                                             */
/* -------------------------------------------------------------------------- */

export function extractMaterializerRefs(sql) {
  const clean = cleanSql(sql);
  const literal = cleanSql(sql, { keepStrings: true });
  const tables = new Set();
  const writes = new Map();

  const touch = (table) => {
    tables.add(table);
    if (!writes.has(table)) writes.set(table, new Set());
    return writes.get(table);
  };

  collectPublicRefs(clean, touch);
  collectCreateTables(clean, (table, column) => touch(table).add(column), touch);
  collectAlterTables(clean, (table, column) => touch(table).add(column), touch);
  collectInserts(clean, (table, column) => touch(table).add(column), touch);
  collectUpdates(clean, (table, column) => touch(table).add(column), touch);

  const branches = new Map();
  const start = literal.indexOf("v_cloud := case v_change.table_name");
  if (start !== -1) {
    const end = literal.indexOf("end;", start);
    const block = literal.slice(start, end === -1 ? undefined : end);
    const branchRe = /when\s+'([a-z_][a-z0-9_]*)'\s+then\s+'([a-z_][a-z0-9_]*)'/gi;
    let match;
    while ((match = branchRe.exec(block))) branches.set(match[1].toLowerCase(), match[2].toLowerCase());
  }

  return {
    tables: [...tables].sort(),
    writes: new Map([...writes].map(([table, columns]) => [table, [...columns].sort()])),
    branches
  };
}

/* -------------------------------------------------------------------------- */
/* Mapas TypeScript                                                           */
/* -------------------------------------------------------------------------- */

function blockBetween(source, startMarker, endMarker = "};") {
  const start = source.indexOf(startMarker);
  if (start === -1) return "";
  const open = source.indexOf("{", start + startMarker.length);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1, source.indexOf(endMarker, open));
}

function topLevelTsKeys(block) {
  const keys = [];
  const re = /^\s{2}([a-z_][a-z0-9_]*)\s*:/gm;
  let match;
  while ((match = re.exec(block))) keys.push(match[1]);
  return keys;
}

export function parseMappingSource(source) {
  const mapBlock = blockBetween(source, "export const MATERIALIZE_MAP");
  const localKeys = topLevelTsKeys(mapBlock);
  const targets = new Map();
  for (const local of localKeys) {
    const start = mapBlock.search(new RegExp(`^ {2}${local}\\s*:`, "m"));
    if (start === -1) continue;
    const rest = mapBlock.slice(start);
    const next = rest.slice(1).search(/^ {2}[a-z_][a-z0-9_]*\s*:/m);
    const entry = next === -1 ? rest : rest.slice(0, next + 1);
    const table = /^\s{4}table\s*:\s*"([a-z_][a-z0-9_]*)"/m.exec(entry);
    targets.set(local, table ? table[1] : null);
  }
  const unsupported = topLevelTsKeys(
    blockBetween(source, "export const UNSUPPORTED_LOCAL_TABLES")
  );
  const localOnlyBlock = blockBetween(source, "export const LOCAL_ONLY_TABLES");
  const localOnly = topLevelTsKeys(localOnlyBlock);
  return {
    localKeys,
    targets,
    unsupported,
    localOnly,
    hasSaleVoidsJustification: /sale_voids[\s\S]{0,400}?local_only_table/i.test(localOnlyBlock)
  };
}

export function parseLocalSchemaSource(source) {
  const block = blockBetween(source, "export const LOCAL_DB_TABLES");
  return topLevelTsKeys(block);
}

/* -------------------------------------------------------------------------- */
/* Validación                                                                 */
/* -------------------------------------------------------------------------- */

function lowerSet(values) {
  return new Set(values.map((value) => value.toLowerCase()));
}

export function validateMaterializer(options = {}) {
  const root = options.rootDir ?? DEFAULT_ROOT;
  const mappingSource = options.mappingSource ?? readText(root, MAPPING_FILE);
  const schemaSource = options.schemaSource ?? readText(root, SCHEMA_FILE);
  const materializerSql =
    options.materializerSql ?? readText(root, join(MIGRATIONS_DIR, MATERIALIZER_FILE));
  const migrations =
    options.migrations ?? readMigrations(root);
  const clientSources =
    options.clientSources ??
    CLIENT_EVIDENCE_FILES.map((file) => ({ name: file, source: readText(root, file) }));

  const errors = [];
  const warnings = [];
  const stats = { tables: 0, writes: 0, mapped: 0, excluded: 0, clientFiles: clientSources.length };

  const evidence = buildSchemaEvidence(migrations, MATERIALIZER_FILE);
  const evidenceHandles = createEvidence();
  for (const [table, columns] of evidence) {
    evidenceHandles.touchTable(table);
    for (const column of columns) evidenceHandles.addColumn(table, column);
  }
  for (const client of clientSources) {
    collectClientEvidence(client.source, evidenceHandles.addColumn, evidenceHandles.touchTable);
  }
  for (const [table, columns] of Object.entries(CLIENT_READ_EVIDENCE)) {
    evidenceHandles.touchTable(table);
    for (const column of Object.keys(columns)) evidenceHandles.addColumn(table, column);
  }

  const refs = extractMaterializerRefs(materializerSql);
  const guarded = collectGuardedColumns(materializerSql);
  stats.tables = refs.tables.length;
  stats.writes = [...refs.writes.values()].reduce((total, columns) => total + columns.length, 0);

  for (const table of refs.tables) {
    if (!evidenceHandles.tables.has(table)) {
      errors.push(`tabla desconocida: public.${table} no aparece en migraciones ni en el cliente`);
      continue;
    }
    const known = evidenceHandles.tables.get(table);
    const written = new Set(refs.writes.get(table) ?? []);
    if (known.size === 0 && written.size > 0) {
      warnings.push(
        `tabla sin columnas evidenciadas: public.${table} (${[...written].join(", ")})`
      );
      continue;
    }
    for (const column of written) {
      if (!known.has(column)) {
        if (guarded.has(`${table}.${column}`)) {
          warnings.push(
            `columna opcional: public.${table}.${column} existe solo si el esquema la tiene (guarda information_schema)`
          );
        } else {
          errors.push(`columna inexistente: public.${table}.${column}`);
        }
      }
    }
    const notMaterialized = [...known].filter((column) => !written.has(column)).sort();
    if (notMaterialized.length > 0) {
      const shown = notMaterialized.slice(0, 6).join(", ");
      const extra =
        notMaterialized.length > 6 ? ` (+${notMaterialized.length - 6} más)` : "";
      warnings.push(
        `public.${table}: ${notMaterialized.length} columnas evidenciadas fuera del mapa (${shown}${extra})`
      );
    }
  }

  const mapping = parseMappingSource(mappingSource);
  const localTables = parseLocalSchemaSource(schemaSource);
  const mapKeys = lowerSet(mapping.localKeys);
  const unsupported = lowerSet(mapping.unsupported);
  const localOnly = lowerSet(mapping.localOnly);
  stats.mapped = mapping.localKeys.length;
  stats.excluded = unsupported.size + localOnly.size;

  if (mapKeys.has("sale_voids")) {
    errors.push(
      "sale_voids no debe estar en MATERIALIZE_MAP: no existe public.sale_voids en la nube"
    );
  }
  if (!localOnly.has("sale_voids")) {
    errors.push("sale_voids debe estar en LOCAL_ONLY_TABLES con su justificación");
  }
  if (!mapping.hasSaleVoidsJustification) {
    errors.push("LOCAL_ONLY_TABLES.sale_voids no explica por qué no se materializa");
  }

  const branchLocals = new Set(refs.branches.keys());
  for (const local of mapping.localKeys) {
    const target = mapping.targets.get(local);
    if (!branchLocals.has(local)) {
      errors.push(`tabla local mapeada sin rama en el SQL: ${local}`);
      continue;
    }
    const sqlTarget = refs.branches.get(local);
    if (target && sqlTarget && target !== sqlTarget) {
      errors.push(`destino incoherente para ${local}: mapa=${target} sql=${sqlTarget}`);
    }
  }
  for (const local of branchLocals) {
    if (!mapKeys.has(local)) {
      errors.push(`rama SQL sin entrada en MATERIALIZE_MAP: ${local}`);
    }
  }
  for (const local of localTables) {
    if (!mapKeys.has(local) && !unsupported.has(local) && !localOnly.has(local)) {
      errors.push(`tabla local sin rama ni exclusión documentada: ${local}`);
    }
  }
  for (const local of mapping.unsupported) {
    if (localOnly.has(local)) errors.push(`exclusión duplicada: ${local}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats,
    evidence,
    branches: refs.branches,
    mapping,
    localTables
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function printResult(result) {
  const lines = [];
  lines.push("PALMYRA · validador del materializador local_change_inbox");
  lines.push(
    `Tablas referenciadas: ${result.stats.tables} · escrituras: ${result.stats.writes} · ` +
      `tablas mapeadas: ${result.stats.mapped} · exclusiones: ${result.stats.excluded} · ` +
      `archivos cliente: ${result.stats.clientFiles}`
  );
  lines.push(`Ramas local→cloud: ${result.branches.size}`);
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`Advertencias (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`  ~ ${warning}`);
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`Errores (${result.errors.length}):`);
    for (const error of result.errors) lines.push(`  x ${error}`);
    lines.push("");
    lines.push("RESULTADO: FALLO");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("RESULTADO: OK — tablas, columnas, ramas y exclusiones coherentes.");
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  const result = validateMaterializer();
  console.log(printResult(result));
  process.exit(result.ok ? 0 : 1);
}
