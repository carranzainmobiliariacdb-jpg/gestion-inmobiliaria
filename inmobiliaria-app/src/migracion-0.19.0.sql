-- Gestión Inmobiliaria v0.19.0 — Honorarios de alquileres (recibos propios de la inmobiliaria)
-- Plan de honorarios (pago único o en cuotas). cuotas = [{n, vence, monto, recibo_id, pagada}]
CREATE TABLE IF NOT EXISTS honorarios_planes (
    id              BIGSERIAL PRIMARY KEY,
    contrato_id     BIGINT REFERENCES contratos(id) ON DELETE SET NULL,
    pagador_tipo    TEXT,
    pagador_nombre  TEXT NOT NULL,
    pagador_dni     TEXT,
    pagador_telefono TEXT,
    concepto        TEXT NOT NULL,
    detalle         TEXT,
    total           DOUBLE PRECISION NOT NULL,
    cuotas          JSONB NOT NULL DEFAULT '[]'::jsonb,
    notas           TEXT,
    usuario         TEXT,
    creado          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS honorarios (
    id              BIGSERIAL PRIMARY KEY,
    numero          BIGINT NOT NULL,
    fecha           TEXT NOT NULL,
    contrato_id     BIGINT REFERENCES contratos(id) ON DELETE SET NULL,
    pagador_tipo    TEXT,          -- inquilino | propietario | otro
    pagador_nombre  TEXT NOT NULL,
    pagador_dni     TEXT,
    pagador_telefono TEXT,
    concepto        TEXT NOT NULL,
    detalle         TEXT,
    monto           DOUBLE PRECISION NOT NULL,
    metodo_pago     TEXT,
    notas           TEXT,
    usuario         TEXT,
    plan_id         BIGINT REFERENCES honorarios_planes(id) ON DELETE SET NULL,
    cuota           INTEGER,
    creado          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE honorarios ADD COLUMN IF NOT EXISTS plan_id BIGINT REFERENCES honorarios_planes(id) ON DELETE SET NULL;
ALTER TABLE honorarios ADD COLUMN IF NOT EXISTS cuota INTEGER;
CREATE INDEX IF NOT EXISTS honorarios_contrato ON honorarios(contrato_id);

-- Con el portal activado la tabla queda protegida (sólo el programa de la oficina).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'seguridad_activa') THEN
    ALTER TABLE honorarios ENABLE ROW LEVEL SECURITY;
    ALTER TABLE honorarios_planes ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON honorarios, honorarios_planes FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE honorarios_id_seq, honorarios_planes_id_seq FROM anon, authenticated;
  ELSE
    ALTER TABLE honorarios DISABLE ROW LEVEL SECURITY;
    ALTER TABLE honorarios_planes DISABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON honorarios, honorarios_planes TO anon, authenticated;
    GRANT USAGE, SELECT ON SEQUENCE honorarios_id_seq, honorarios_planes_id_seq TO anon, authenticated;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON honorarios, honorarios_planes TO service_role;
    GRANT ALL ON SEQUENCE honorarios_id_seq, honorarios_planes_id_seq TO service_role;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
