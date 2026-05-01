// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function toBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).trim().toLowerCase() === 'true';
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const dbConfig = {
  user: process.env.DB_USER || 'trackcore',
  password: process.env.DB_PASSWORD || '',
  server: process.env.DB_SERVER || 'localhost',
  port: toInt(process.env.DB_PORT, 1433),
  database: process.env.DB_NAME || 'SANic',
  options: {
    encrypt: toBool(process.env.DB_ENCRYPT, false),
    trustServerCertificate: toBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true)
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let pool = null;

async function getPool() {
  if (pool && pool.connected) {
    return pool;
  }

  if (pool && pool.connecting) {
    await pool.connect();
    return pool;
  }

  pool = new sql.ConnectionPool(dbConfig);
  pool.on('error', (err) => {
    console.error('SQL pool error:', err.message);
  });

  await pool.connect();
  return pool;
}

function escapeIdentifier(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

function clampTop(value) {
  const top = Number(value);
  if (!Number.isInteger(top) || top <= 0) return 200;
  return Math.min(top, 500);
}

function safeDbValue(rawValue, columnMeta) {
  if (rawValue === undefined) return undefined;
  if (rawValue === null) return null;

  const type = String(columnMeta?.data_type || '').toLowerCase();

  if (rawValue === '') {
    if (
      [
        'int',
        'bigint',
        'smallint',
        'tinyint',
        'decimal',
        'numeric',
        'float',
        'real',
        'money',
        'smallmoney',
        'bit',
        'date',
        'datetime',
        'datetime2',
        'smalldatetime',
        'datetimeoffset',
        'time'
      ].includes(type)
    ) {
      return null;
    }
    return '';
  }

  if (['int', 'smallint', 'tinyint'].includes(type)) {
    const n = Number(rawValue);
    return Number.isInteger(n) ? n : rawValue;
  }

  if (['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(type)) {
    const n = Number(rawValue);
    return Number.isFinite(n) ? n : rawValue;
  }

  if (type === 'bit') {
    if (typeof rawValue === 'boolean') return rawValue;

    const text = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'si', 'sí', 'yes'].includes(text)) return true;
    if (['0', 'false', 'no'].includes(text)) return false;
  }

  return rawValue;
}

async function listUserTables(db) {
  const result = await db.request().query(`
    SELECT
      t.TABLE_SCHEMA AS schema_name,
      t.TABLE_NAME AS table_name
    FROM INFORMATION_SCHEMA.TABLES t
    WHERE
      t.TABLE_TYPE = 'BASE TABLE'
      AND t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
  `);

  return result.recordset;
}

async function getAllowedTable(db, schema, table) {
  const result = await db
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT
        t.TABLE_SCHEMA AS schema_name,
        t.TABLE_NAME AS table_name
      FROM INFORMATION_SCHEMA.TABLES t
      WHERE
        t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_SCHEMA = @schema
        AND t.TABLE_NAME = @table
        AND t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA');
    `);

  const found = result.recordset[0];

  if (!found) {
    throw new ApiError(404, 'Tabla no permitida o inexistente.');
  }

  return found;
}

async function getColumnsMeta(db, schema, table) {
  const result = await db
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT
        c.name AS column_name,
        ty.name AS data_type,
        c.is_identity,
        c.is_computed,
        c.is_nullable,
        c.column_id
      FROM sys.columns c
      INNER JOIN sys.tables tb
        ON tb.object_id = c.object_id
      INNER JOIN sys.schemas s
        ON s.schema_id = tb.schema_id
      INNER JOIN sys.types ty
        ON ty.user_type_id = c.user_type_id
      WHERE
        s.name = @schema
        AND tb.name = @table
      ORDER BY c.column_id;
    `);

  return result.recordset;
}

async function getSinglePk(db, schema, table) {
  const result = await db
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT
        c.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE c
        ON c.TABLE_NAME = tc.TABLE_NAME
       AND c.TABLE_SCHEMA = tc.TABLE_SCHEMA
       AND c.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE
        tc.TABLE_SCHEMA = @schema
        AND tc.TABLE_NAME = @table
        AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ORDER BY c.ORDINAL_POSITION;
    `);

  if (result.recordset.length !== 1) {
    return null;
  }

  return result.recordset[0].COLUMN_NAME;
}

function filterPayloadByColumns(payload, columnsMeta, excludedColumns = []) {
  const allowedMap = new Map(
    columnsMeta.map((col) => [col.column_name.toLowerCase(), col])
  );

  const excludedSet = new Set(excludedColumns.map((name) => String(name).toLowerCase()));
  const result = [];

  for (const [key, value] of Object.entries(payload || {})) {
    const meta = allowedMap.get(String(key).toLowerCase());
    if (!meta) continue;
    if (excludedSet.has(String(meta.column_name).toLowerCase())) continue;
    result.push({
      column: meta.column_name,
      meta,
      value: safeDbValue(value, meta)
    });
  }

  return result;
}

app.get('/api/health', async (req, res, next) => {
  try {
    const db = await getPool();
    await db.request().query('SELECT 1 AS ok;');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/tables', async (req, res, next) => {
  try {
    const db = await getPool();
    const tables = await listUserTables(db);
    res.json(tables);
  } catch (error) {
    next(error);
  }
});

app.get('/api/table/:schema/:table', async (req, res, next) => {
  try {
    const db = await getPool();
    const top = clampTop(req.query.top);

    const allowed = await getAllowedTable(db, req.params.schema, req.params.table);
    const pk = await getSinglePk(db, allowed.schema_name, allowed.table_name);

    const schemaSql = escapeIdentifier(allowed.schema_name);
    const tableSql = escapeIdentifier(allowed.table_name);
    const orderSql = pk ? ` ORDER BY ${escapeIdentifier(pk)}` : '';

    const query = `SELECT TOP (${top}) * FROM ${schemaSql}.${tableSql}${orderSql};`;
    const result = await db.request().query(query);

    res.json(result.recordset);
  } catch (error) {
    next(error);
  }
});

app.put('/api/table/:schema/:table', async (req, res, next) => {
  try {
    const { pkValue, changes } = req.body || {};

    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new ApiError(400, 'Faltan cambios válidos.');
    }

    const db = await getPool();
    const allowed = await getAllowedTable(db, req.params.schema, req.params.table);
    const columnsMeta = await getColumnsMeta(db, allowed.schema_name, allowed.table_name);
    const pk = await getSinglePk(db, allowed.schema_name, allowed.table_name);

    if (!pk) {
      throw new ApiError(400, 'La tabla no tiene una PK simple; edición deshabilitada.');
    }

    const pkMeta = columnsMeta.find((col) => col.column_name === pk);
    const updates = filterPayloadByColumns(changes, columnsMeta, [pk]);

    if (!updates.length) {
      throw new ApiError(400, 'No hay columnas válidas para actualizar.');
    }

    const request = db.request();
    request.input('pk', safeDbValue(pkValue, pkMeta));

    const setSql = updates.map((item, index) => {
      request.input(`v${index}`, item.value);
      return `${escapeIdentifier(item.column)} = @v${index}`;
    });

    const schemaSql = escapeIdentifier(allowed.schema_name);
    const tableSql = escapeIdentifier(allowed.table_name);
    const pkSql = escapeIdentifier(pk);

    const query = `
      UPDATE ${schemaSql}.${tableSql}
      SET ${setSql.join(', ')}
      WHERE ${pkSql} = @pk;
    `;

    const result = await request.query(query);
    res.json({ updated: result.rowsAffected?.[0] || 0 });
  } catch (error) {
    next(error);
  }
});

app.post('/api/table/:schema/:table', async (req, res, next) => {
  try {
    const { values } = req.body || {};

    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ApiError(400, 'Faltan valores válidos para insertar.');
    }

    const db = await getPool();
    const allowed = await getAllowedTable(db, req.params.schema, req.params.table);
    const columnsMeta = await getColumnsMeta(db, allowed.schema_name, allowed.table_name);

    const insertableMeta = columnsMeta.filter(
      (col) => !col.is_identity && !col.is_computed
    );

    const inserts = filterPayloadByColumns(values, insertableMeta);

    if (!inserts.length) {
      throw new ApiError(400, 'No hay columnas válidas para insertar.');
    }

    const request = db.request();

    const columnsSql = inserts.map((item) => escapeIdentifier(item.column)).join(', ');
    const valuesSql = inserts.map((item, index) => {
      request.input(`v${index}`, item.value);
      return `@v${index}`;
    }).join(', ');

    const schemaSql = escapeIdentifier(allowed.schema_name);
    const tableSql = escapeIdentifier(allowed.table_name);

    const query = `
      INSERT INTO ${schemaSql}.${tableSql} (${columnsSql})
      VALUES (${valuesSql});
    `;

    await request.query(query);
    res.json({ inserted: 1 });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/table/:schema/:table', async (req, res, next) => {
  try {
    const { pkValue } = req.body || {};

    const db = await getPool();
    const allowed = await getAllowedTable(db, req.params.schema, req.params.table);
    const columnsMeta = await getColumnsMeta(db, allowed.schema_name, allowed.table_name);
    const pk = await getSinglePk(db, allowed.schema_name, allowed.table_name);

    if (!pk) {
      throw new ApiError(400, 'La tabla no tiene una PK simple; borrado deshabilitado.');
    }

    const pkMeta = columnsMeta.find((col) => col.column_name === pk);

    const request = db.request();
    request.input('pk', safeDbValue(pkValue, pkMeta));

    const schemaSql = escapeIdentifier(allowed.schema_name);
    const tableSql = escapeIdentifier(allowed.table_name);
    const pkSql = escapeIdentifier(pk);

    const query = `
      DELETE FROM ${schemaSql}.${tableSql}
      WHERE ${pkSql} = @pk;
    `;

    const result = await request.query(query);
    res.json({ deleted: result.rowsAffected?.[0] || 0 });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  console.error('API error:', error.message);
  res.status(status).json({
    error: error.message || 'Error interno del servidor.'
  });
});

const PORT = toInt(process.env.PORT, 3000);

app.listen(PORT, () => {
  console.log(`✅ App corriendo en http://localhost:${PORT}`);
});