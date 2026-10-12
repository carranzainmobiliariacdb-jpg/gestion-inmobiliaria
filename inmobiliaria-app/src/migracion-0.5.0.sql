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
