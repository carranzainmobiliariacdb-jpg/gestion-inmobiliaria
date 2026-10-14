-- Gestión Inmobiliaria v0.9.0 — deudas de servicios (luz EPEC; después gas y agua).
-- Se corre UNA SOLA VEZ en Supabase → SQL Editor → New query → Run
-- (si pregunta por "Row Level Security", elegir "Run without RLS").

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

ALTER TABLE servicios_estado DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON servicios_estado TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
