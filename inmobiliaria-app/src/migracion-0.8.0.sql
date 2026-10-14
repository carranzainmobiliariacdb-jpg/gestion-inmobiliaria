-- Gestión Inmobiliaria v0.8.0 — N° de contrato de luz (EPEC) en el inmueble.
-- Se corre UNA SOLA VEZ en Supabase → SQL Editor → New query → Run
-- (si pregunta por "Row Level Security", elegir "Run without RLS").

ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS servicio_luz_contrato TEXT;
