-- Gestión Inmobiliaria v0.3.0 — actualización de la base de datos.
--
-- Se corre UNA SOLA VEZ: Supabase → SQL Editor → New query → pegar todo →
-- Run. Es seguro correrlo de nuevo (no borra ni duplica nada).
-- Agrega los datos nuevos (fotos de DNI, datos completos del inmueble,
-- número de contrato, conceptos del recibo, liquidaciones agrupadas, IPC,
-- configuración de la inmobiliaria y registro de avisos por WhatsApp).

-- ---------- Personas ----------
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS cuit_cuil TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS sexo TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS nacionalidad TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS estado_civil TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS profesion TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS localidad TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS dni_frente TEXT;
ALTER TABLE propietarios ADD COLUMN IF NOT EXISTS dni_dorso TEXT;

ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS cuit_cuil TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS sexo TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS nacionalidad TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS estado_civil TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS profesion TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS localidad TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS dni_frente TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS dni_dorso TEXT;

ALTER TABLE garantes ADD COLUMN IF NOT EXISTS cuit_cuil TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS sexo TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS nacionalidad TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS estado_civil TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS profesion TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS localidad TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS dni_frente TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS dni_dorso TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS tipo_garantia TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS detalle_garantia TEXT;

-- ---------- Inmuebles ----------
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS codigo BIGINT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS piso_depto TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS localidad TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS provincia TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS codigo_postal TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS destino TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS estado TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS dormitorios BIGINT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS banos BIGINT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS superficie_cubierta DOUBLE PRECISION;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS cochera BOOLEAN;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS patio BOOLEAN;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS amoblado BOOLEAN;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS nomenclatura_catastral TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS cuenta_rentas TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS cuenta_municipal TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS matricula TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS servicio_luz TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS servicio_agua TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS servicio_gas TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS llaves TEXT;

-- ---------- Contratos ----------
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS numero BIGINT;
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS destino TEXT;
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS deposito_garantia DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS multa_diaria DOUBLE PRECISION NOT NULL DEFAULT 0;
-- Conceptos que se cobran todos los meses además del alquiler
-- (ej. [{"concepto":"Expensas","tipo":"servicios","monto":25000}])
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS conceptos_fijos JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Los contratos que ya existían toman como número su id (se puede cambiar).
UPDATE contratos SET numero = id WHERE numero IS NULL;

-- ---------- Pagos (recibos) ----------
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS monto_multa DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS conceptos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS bonificacion DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS recargo DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS a_favor DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS usuario TEXT;

-- ---------- Liquidaciones ----------
-- Varias filas con el mismo numero_comprobante = una liquidación que agrupa
-- varios recibos del mismo propietario. "items" son gastos/descuentos o
-- importes a favor (monto negativo descuenta, positivo suma).
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS monto_cobrado DOUBLE PRECISION;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS usuario TEXT;

-- ---------- Tablas nuevas ----------
CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT
);

-- IPC cargado a mano (por si la API del INDEC todavía no publicó un mes).
-- variacion = % mensual, ej. 2.1
CREATE TABLE IF NOT EXISTS indices_ipc (
    periodo   TEXT PRIMARY KEY,
    variacion DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS recordatorios (
    id          BIGSERIAL PRIMARY KEY,
    contrato_id BIGINT REFERENCES contratos(id) ON DELETE CASCADE,
    tipo        TEXT NOT NULL,
    referencia  TEXT,
    telefono    TEXT,
    mensaje     TEXT,
    fecha       TEXT NOT NULL,
    usuario     TEXT
);

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Avisa a la API que hay columnas nuevas (si no, tarda unos minutos en verlas)
NOTIFY pgrst, 'reload schema';
