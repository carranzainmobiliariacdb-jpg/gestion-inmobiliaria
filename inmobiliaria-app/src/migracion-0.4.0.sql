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
