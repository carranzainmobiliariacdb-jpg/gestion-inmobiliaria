-- Inmobiliaria App — esquema de base de datos para Supabase.
--
-- Se corre UNA SOLA VEZ, pegando todo este archivo en Supabase → SQL Editor
-- → New query → Run. Es seguro volver a correrlo si hace falta (no borra
-- datos ni duplica nada: las tablas se crean solo si no existen, y los
-- permisos se re-otorgan sin problema).
--
-- Por qué hace falta este paso manual: la app habla con Supabase por su API
-- REST (PostgREST), que no permite crear tablas por HTTP por motivos de
-- seguridad — solo lee y escribe filas de tablas que ya existen. Antes la
-- app se conectaba directo a Postgres y podía crear las tablas sola, pero
-- esa conexión directa chocaba con el certificado propio de Supabase y
-- fallaba en varias PCs Windows; por eso se pasó a la API REST, que es la
-- misma forma en que se conectan la mayoría de las apps hechas con Supabase.

CREATE TABLE IF NOT EXISTS usuarios (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    nombre_completo TEXT NOT NULL,
    activo          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS propietarios (
    id                BIGSERIAL PRIMARY KEY,
    nombre            TEXT NOT NULL,
    dni_cuit          TEXT,
    fecha_nacimiento  TEXT,
    telefono          TEXT,
    email             TEXT,
    direccion         TEXT,
    datos_bancarios   TEXT,
    notas             TEXT
);

CREATE TABLE IF NOT EXISTS inquilinos (
    id                BIGSERIAL PRIMARY KEY,
    nombre            TEXT NOT NULL,
    dni_cuit          TEXT,
    fecha_nacimiento  TEXT,
    telefono          TEXT,
    email             TEXT,
    direccion         TEXT,
    notas             TEXT
);

CREATE TABLE IF NOT EXISTS garantes (
    id                BIGSERIAL PRIMARY KEY,
    nombre            TEXT NOT NULL,
    dni_cuit          TEXT,
    fecha_nacimiento  TEXT,
    telefono          TEXT,
    email             TEXT,
    direccion         TEXT,
    notas             TEXT
);

CREATE TABLE IF NOT EXISTS inmuebles (
    id             BIGSERIAL PRIMARY KEY,
    propietario_id BIGINT NOT NULL REFERENCES propietarios(id) ON DELETE RESTRICT,
    direccion      TEXT NOT NULL,
    tipo           TEXT,
    superficie     DOUBLE PRECISION,
    ambientes      BIGINT,
    notas          TEXT
);

CREATE TABLE IF NOT EXISTS contratos (
    id                              BIGSERIAL PRIMARY KEY,
    inmueble_id                     BIGINT NOT NULL REFERENCES inmuebles(id) ON DELETE RESTRICT,
    inquilino_id                    BIGINT NOT NULL REFERENCES inquilinos(id) ON DELETE RESTRICT,
    fecha_inicio                    TEXT NOT NULL,
    fecha_fin                       TEXT NOT NULL,
    dia_pago                        BIGINT NOT NULL DEFAULT 10,
    monto_inicial                   DOUBLE PRECISION NOT NULL,
    comision_porcentaje             DOUBLE PRECISION NOT NULL DEFAULT 0,
    tasa_mora_diaria                DOUBLE PRECISION NOT NULL DEFAULT 0,
    frecuencia_actualizacion_meses  BIGINT NOT NULL DEFAULT 12,
    tipo_actualizacion              TEXT NOT NULL DEFAULT 'porcentaje_fijo',
    porcentaje_actualizacion        DOUBLE PRECISION NOT NULL DEFAULT 0,
    estado                          TEXT NOT NULL DEFAULT 'activo',
    notas                           TEXT
);

CREATE TABLE IF NOT EXISTS contrato_garantes (
    contrato_id BIGINT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
    garante_id  BIGINT NOT NULL REFERENCES garantes(id) ON DELETE RESTRICT,
    PRIMARY KEY (contrato_id, garante_id)
);

CREATE TABLE IF NOT EXISTS actualizaciones (
    id             BIGSERIAL PRIMARY KEY,
    contrato_id    BIGINT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
    fecha_vigencia TEXT NOT NULL,
    monto_nuevo    DOUBLE PRECISION NOT NULL,
    motivo         TEXT
);

CREATE TABLE IF NOT EXISTS pagos (
    id              BIGSERIAL PRIMARY KEY,
    contrato_id     BIGINT NOT NULL REFERENCES contratos(id) ON DELETE RESTRICT,
    periodo         TEXT NOT NULL,
    fecha_pago      TEXT NOT NULL,
    monto_alquiler  DOUBLE PRECISION NOT NULL,
    dias_mora       BIGINT NOT NULL DEFAULT 0,
    monto_mora      DOUBLE PRECISION NOT NULL DEFAULT 0,
    monto_total     DOUBLE PRECISION NOT NULL,
    metodo_pago     TEXT,
    numero_recibo   BIGINT NOT NULL,
    notas           TEXT
);

CREATE TABLE IF NOT EXISTS liquidaciones (
    id                  BIGSERIAL PRIMARY KEY,
    pago_id             BIGINT NOT NULL REFERENCES pagos(id) ON DELETE RESTRICT,
    fecha               TEXT NOT NULL,
    monto_alquiler      DOUBLE PRECISION NOT NULL,
    comision_porcentaje DOUBLE PRECISION NOT NULL,
    monto_comision      DOUBLE PRECISION NOT NULL,
    monto_neto          DOUBLE PRECISION NOT NULL,
    numero_comprobante  BIGINT NOT NULL,
    notas               TEXT
);

-- La app usa la clave "anon" de Supabase para leer y escribir, sin Row Level
-- Security (como el resto de los proyectos propios) — por eso hay que darle
-- permiso explícito a los roles "anon" y "authenticated" sobre estas tablas;
-- Supabase no lo hace solo para tablas nuevas.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;


-- =====================================================================
-- Agregado en v0.3.0 (igual a src/migracion-0.3.0.sql)
-- =====================================================================
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
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS servicio_luz_contrato TEXT;
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


-- =====================================================================
-- Agregado en v0.4.0 (igual a src/migracion-0.4.0.sql)
-- =====================================================================
-- Gestión Inmobiliaria v0.4.0 — actualización de la base de datos.
-- Se corre UNA SOLA VEZ en Supabase → SQL Editor → New query → Run
-- (si pregunta por "Row Level Security", elegir "Run without RLS").
-- Es seguro correrlo de nuevo.

-- Fotos del estado de cada inmueble (entrega, devolución, etc.)
CREATE TABLE IF NOT EXISTS inmueble_fotos (
    id          BIGSERIAL PRIMARY KEY,
    inmueble_id BIGINT NOT NULL REFERENCES inmuebles(id) ON DELETE CASCADE,
    contrato_id BIGINT REFERENCES contratos(id) ON DELETE SET NULL,
    tipo        TEXT NOT NULL DEFAULT 'Entrega',
    descripcion TEXT,
    fecha       TEXT,
    foto        TEXT NOT NULL,
    miniatura   TEXT,
    usuario     TEXT
);
CREATE INDEX IF NOT EXISTS inmueble_fotos_inmueble ON inmueble_fotos(inmueble_id);

-- Última consulta a la Central de Deudores del BCRA
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS bcra_situacion BIGINT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS bcra_fecha TEXT;
ALTER TABLE inquilinos ADD COLUMN IF NOT EXISTS bcra_detalle JSONB;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS bcra_situacion BIGINT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS bcra_fecha TEXT;
ALTER TABLE garantes ADD COLUMN IF NOT EXISTS bcra_detalle JSONB;

-- La app usa la clave "anon" sin Row Level Security (si Supabase la activó
-- sola en alguna tabla, la app no puede leer ni guardar).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- Agregado en v0.5.0 (igual a src/migracion-0.5.0.sql)
-- =====================================================================
-- Gestión Inmobiliaria v0.5.0 — contratos desde modelo.
-- Se corre UNA SOLA VEZ en Supabase → SQL Editor → New query → Run
-- (si pregunta por "Row Level Security", elegir "Run without RLS").

CREATE TABLE IF NOT EXISTS modelos_contrato (
    id          BIGSERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL,
    tipo        TEXT,
    contenido   TEXT NOT NULL,
    actualizado TEXT
);

CREATE TABLE IF NOT EXISTS documentos_generados (
    id          BIGSERIAL PRIMARY KEY,
    contrato_id BIGINT REFERENCES contratos(id) ON DELETE CASCADE,
    modelo_id   BIGINT REFERENCES modelos_contrato(id) ON DELETE SET NULL,
    titulo      TEXT NOT NULL,
    contenido   TEXT NOT NULL,
    fecha       TEXT NOT NULL,
    usuario     TEXT
);
CREATE INDEX IF NOT EXISTS documentos_generados_contrato ON documentos_generados(contrato_id);

-- ---------- Balance en cero (v0.12.3) ----------
-- Período (YYYY-MM) hasta el que un contrato se considera cerrado: cualquier
-- mes anterior o igual no aparece como deuda. Lo deja en '2026-10' para los
-- contratos de la carga inicial, así desde noviembre 2026 arrancamos limpios.
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS liquidado_hasta TEXT;

-- ---------- Servicios (v0.9.0) ----------
CREATE TABLE IF NOT EXISTS servicios_estado (
    id          BIGSERIAL PRIMARY KEY,
    servicio    TEXT NOT NULL,          -- luz | gas | agua
    cuenta      TEXT NOT NULL,          -- N° de contrato / cuenta en la empresa
    cliente     TEXT,
    titular     TEXT,
    direccion   TEXT,
    referencia  TEXT,
    documentos  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- facturas a pagar
    financiados BIGINT NOT NULL DEFAULT 0,
    error       TEXT,
    actualizado TEXT,
    UNIQUE (servicio, cuenta)
);

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
