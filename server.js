// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
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

  if (!Number.isInteger(top) || top <= 0) {
    return 200;
  }

  return Math.min(top, 500);
}

function safeDbValue(rawValue, columnMeta) {
  if (rawValue === undefined) return undefined;
  if (rawValue === null) return null;

  const type = String(columnMeta?.data_type || '').toLowerCase();
  const isNullable = Boolean(columnMeta?.is_nullable);

  if (typeof rawValue === 'string') {
    rawValue = rawValue.trim();
  }

  if (rawValue === '') {
    if (isNullable) {
      return null;
    }

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

  if (type === 'bigint') {
    const n = Number(rawValue);
    return Number.isInteger(n) ? n : rawValue;
  }

  if (['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(type)) {
    const n = Number(rawValue);
    return Number.isFinite(n) ? n : rawValue;
  }

  if (type === 'bit') {
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }

    const text = String(rawValue).trim().toLowerCase();

    if (['1', 'true', 'si', 'sí', 'yes'].includes(text)) {
      return true;
    }

    if (['0', 'false', 'no'].includes(text)) {
      return false;
    }
  }

  return rawValue;
}

function getMovementMeta(tipoMovimiento) {
  const movementTypes = {
    entrada_compra: {
      direction: 'in'
    },
    entrada_devolucion_cliente: {
      direction: 'in'
    },
    entrada_ajuste: {
      direction: 'in'
    },
    salida_venta: {
      direction: 'out'
    },
    salida_devolucion_proveedor: {
      direction: 'out'
    },
    salida_danio: {
      direction: 'out'
    },
    salida_vencimiento: {
      direction: 'out'
    },
    salida_perdida: {
      direction: 'out'
    },
    salida_garantia: {
      direction: 'out'
    },
    salida_ajuste: {
      direction: 'out'
    },
    transferencia: {
      direction: 'neutral'
    },
    cuarentena: {
      direction: 'neutral'
    }
  };

  return movementTypes[tipoMovimiento] || null;
}

function calculateImpact(tipoMovimiento, cantidad) {
  const meta = getMovementMeta(tipoMovimiento);

  if (!meta) {
    throw new ApiError(400, 'Tipo de movimiento no válido.');
  }

  if (meta.direction === 'in') {
    return cantidad;
  }

  if (meta.direction === 'out') {
    return cantidad * -1;
  }

  return 0;
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

  const excludedSet = new Set(
    excludedColumns.map((name) => String(name).toLowerCase())
  );

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

/* ================== HEALTH ================== */

app.get('/api/health', async (req, res, next) => {
  try {
    const db = await getPool();

    await db.request().query('SELECT 1 AS ok;');

    res.json({
      ok: true
    });
  } catch (error) {
    next(error);
  }
});

/* ================== TABLES API DINÁMICA ================== */

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

    const query = `
      SELECT TOP (${top}) *
      FROM ${schemaSql}.${tableSql}
      ${orderSql};
    `;

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

    res.json({
      updated: result.rowsAffected?.[0] || 0
    });
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

    const columnsSql = inserts
      .map((item) => escapeIdentifier(item.column))
      .join(', ');

    const valuesSql = inserts
      .map((item, index) => {
        request.input(`v${index}`, item.value);
        return `@v${index}`;
      })
      .join(', ');

    const schemaSql = escapeIdentifier(allowed.schema_name);
    const tableSql = escapeIdentifier(allowed.table_name);

    const query = `
      INSERT INTO ${schemaSql}.${tableSql} (${columnsSql})
      VALUES (${valuesSql});
    `;

    await request.query(query);

    res.json({
      inserted: 1
    });
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

    res.json({
      deleted: result.rowsAffected?.[0] || 0
    });
  } catch (error) {
    next(error);
  }
});

/* ================== API ESPECÍFICA DE PRODUCTOS ================== */

app.get('/api/productos/codigo/:codigoBarra', async (req, res, next) => {
  try {
    const db = await getPool();

    const codigoBarra = String(req.params.codigoBarra || '').trim();

    if (!codigoBarra) {
      throw new ApiError(400, 'Código de barras requerido.');
    }

    const result = await db
      .request()
      .input('CodigoBarra', sql.VarChar(50), codigoBarra)
      .query(`
        SELECT TOP (1)
          *
        FROM dbo.Producto
        WHERE CodigoBarra = @CodigoBarra;
      `);

    const product = result.recordset[0];

    if (!product) {
      throw new ApiError(404, 'Producto no encontrado.');
    }

    res.json(product);
  } catch (error) {
    next(error);
  }
});

/* ================== API ESPECÍFICA DE KARDEX ================== */

app.get('/api/kardex/movimientos', async (req, res, next) => {
  try {
    const db = await getPool();

    const top = clampTop(req.query.top);
    const idProducto = req.query.idProducto ? Number(req.query.idProducto) : null;
    const tipoMovimiento = req.query.tipoMovimiento ? String(req.query.tipoMovimiento) : null;
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;

    const request = db.request();

    request.input('top', sql.Int, top);

    let whereSql = 'WHERE 1 = 1';

    if (Number.isInteger(idProducto) && idProducto > 0) {
      request.input('IDProducto', sql.Int, idProducto);
      whereSql += ' AND k.IDProducto = @IDProducto';
    }

    if (tipoMovimiento) {
      request.input('TipoMovimiento', sql.VarChar(50), tipoMovimiento);
      whereSql += ' AND k.TipoMovimiento = @TipoMovimiento';
    }

    if (desde) {
      request.input('Desde', sql.DateTime2, desde);
      whereSql += ' AND k.FechaMovimiento >= @Desde';
    }

    if (hasta) {
      request.input('Hasta', sql.DateTime2, hasta);
      whereSql += ' AND k.FechaMovimiento <= @Hasta';
    }

    const result = await request.query(`
      SELECT TOP (@top)
        k.IDMovimiento,
        k.IDProducto,
        p.Nombre AS ProductoNombre,
        k.CodigoBarra,
        k.TipoMovimiento,
        k.Cantidad,
        k.StockAnterior,
        k.StockNuevo,
        k.Impacto,
        k.PrecioUnitario,
        k.CostoImpacto,
        k.DocumentoReferencia,
        k.Bodega,
        k.Responsable,
        k.Detalle,
        k.FechaMovimiento
      FROM dbo.KardexInventario k
      LEFT JOIN dbo.Producto p
        ON p.IDProducto = k.IDProducto
      ${whereSql}
      ORDER BY k.FechaMovimiento DESC, k.IDMovimiento DESC;
    `);

    res.json(result.recordset);
  } catch (error) {
    next(error);
  }
});

app.post('/api/kardex/movimiento', async (req, res, next) => {
  const db = await getPool();
  const transaction = new sql.Transaction(db);

  try {
    const body = req.body || {};

    const idProducto = Number(body.IDProducto ?? body.idProducto);
    const tipoMovimiento = String(body.TipoMovimiento ?? body.tipoMovimiento ?? '').trim();
    const cantidad = Number(body.Cantidad ?? body.cantidad);
    const codigoBarraInput = body.CodigoBarra ?? body.codigoBarra ?? null;
    const documentoReferencia = body.DocumentoReferencia ?? body.documentoReferencia ?? null;
    const bodega = body.Bodega ?? body.bodega ?? null;
    const responsable = String(body.Responsable ?? body.responsable ?? '').trim();
    const detalle = String(body.Detalle ?? body.detalle ?? '').trim();
    const fechaMovimiento = body.FechaMovimiento ?? body.fechaMovimiento ?? null;

    if (!Number.isInteger(idProducto) || idProducto <= 0) {
      throw new ApiError(400, 'IDProducto no válido.');
    }

    if (!getMovementMeta(tipoMovimiento)) {
      throw new ApiError(400, 'Tipo de movimiento no válido.');
    }

    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new ApiError(400, 'La cantidad debe ser un número entero mayor que 0.');
    }

    if (!responsable) {
      throw new ApiError(400, 'Responsable requerido.');
    }

    if (!detalle) {
      throw new ApiError(400, 'Detalle requerido.');
    }

    await transaction.begin();

    const productRequest = new sql.Request(transaction);

    const productResult = await productRequest
      .input('IDProducto', sql.Int, idProducto)
      .query(`
        SELECT TOP (1)
          IDProducto,
          Nombre,
          CodigoBarra,
          UnidadesEnStock,
          PrecioUnitario
        FROM dbo.Producto WITH (UPDLOCK, ROWLOCK)
        WHERE IDProducto = @IDProducto;
      `);

    const product = productResult.recordset[0];

    if (!product) {
      throw new ApiError(404, 'Producto no encontrado.');
    }

    const stockAnterior = Number(product.UnidadesEnStock || 0);
    const precioUnitario = Number(product.PrecioUnitario || 0);
    const impacto = calculateImpact(tipoMovimiento, cantidad);
    const stockNuevo = stockAnterior + impacto;

    if (stockNuevo < 0) {
      throw new ApiError(409, 'No hay stock suficiente para registrar esa salida.');
    }

    if (impacto !== 0) {
      const updateRequest = new sql.Request(transaction);

      await updateRequest
        .input('IDProducto', sql.Int, idProducto)
        .input('StockNuevo', sql.Int, stockNuevo)
        .query(`
          UPDATE dbo.Producto
          SET UnidadesEnStock = @StockNuevo
          WHERE IDProducto = @IDProducto;
        `);
    }

    const codigoBarra = codigoBarraInput || product.CodigoBarra || null;
    const costoImpacto = Math.abs(impacto) * precioUnitario;

    const insertRequest = new sql.Request(transaction);

    const insertResult = await insertRequest
      .input('IDProducto', sql.Int, idProducto)
      .input('CodigoBarra', sql.VarChar(50), codigoBarra)
      .input('TipoMovimiento', sql.VarChar(50), tipoMovimiento)
      .input('Cantidad', sql.Int, cantidad)
      .input('StockAnterior', sql.Int, stockAnterior)
      .input('StockNuevo', sql.Int, stockNuevo)
      .input('Impacto', sql.Int, impacto)
      .input('PrecioUnitario', sql.Decimal(18, 2), precioUnitario)
      .input('CostoImpacto', sql.Decimal(18, 2), costoImpacto)
      .input('DocumentoReferencia', sql.VarChar(100), documentoReferencia)
      .input('Bodega', sql.VarChar(100), bodega)
      .input('Responsable', sql.VarChar(100), responsable)
      .input('Detalle', sql.VarChar(500), detalle)
      .input('FechaMovimiento', sql.DateTime2, fechaMovimiento || new Date())
      .query(`
        INSERT INTO dbo.KardexInventario (
          IDProducto,
          CodigoBarra,
          TipoMovimiento,
          Cantidad,
          StockAnterior,
          StockNuevo,
          Impacto,
          PrecioUnitario,
          CostoImpacto,
          DocumentoReferencia,
          Bodega,
          Responsable,
          Detalle,
          FechaMovimiento
        )
        OUTPUT INSERTED.*
        VALUES (
          @IDProducto,
          @CodigoBarra,
          @TipoMovimiento,
          @Cantidad,
          @StockAnterior,
          @StockNuevo,
          @Impacto,
          @PrecioUnitario,
          @CostoImpacto,
          @DocumentoReferencia,
          @Bodega,
          @Responsable,
          @Detalle,
          @FechaMovimiento
        );
      `);

    await transaction.commit();

    res.status(201).json({
      inserted: 1,
      stockAnterior,
      stockNuevo,
      impacto,
      movimiento: insertResult.recordset[0]
    });
  } catch (error) {
    try {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }
    } catch (rollbackError) {
      console.error('Rollback error:', rollbackError.message);
    }

    next(error);
  }
});

/* ================== 404 Y ERRORES ================== */

app.use((req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada.'
  });
});

app.use((error, req, res, next) => {
  let status = error.status || 500;
  let message = error.message || 'Error interno del servidor.';

  if (error.number === 2601 || error.number === 2627) {
    status = 409;
    message = 'Ya existe un registro con ese valor único. Verifica que el código de barras no esté repetido.';
  }

  if (error.number === 547) {
    status = 409;
    message = 'No se puede completar la operación porque el registro está relacionado con otros datos.';
  }

  console.error('API error:', error.message);

  res.status(status).json({
    error: message
  });
});

const PORT = toInt(process.env.PORT, 3000);

app.listen(PORT, () => {
  console.log(`App corriendo en http://localhost:${PORT}`);
});