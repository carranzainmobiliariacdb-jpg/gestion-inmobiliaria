-- Gestión Inmobiliaria — Portal del inquilino + seguridad de la base (v0.18.0)
--
-- Pegar TODO esto en Supabase → SQL Editor → Run.
-- Si pregunta por "Row Level Security", elegir "Run and enable RLS" (o "Run").
--
-- Qué hace:
--  1. Crea las tablas del portal (accesos, pagos informados, reclamos, avisos).
--  2. Crea las funciones que usa el portal: cada inquilino sólo ve lo suyo,
--     identificado por el código secreto de su link.
--  3. Bloquea todas las tablas para la clave pública ("anon"): desde ahora
--     sólo entra el programa de la oficina, con la clave de la oficina.

-- ---------- 1. Tablas del portal ----------

CREATE TABLE IF NOT EXISTS portal_accesos (
    token          TEXT PRIMARY KEY,
    inquilino_id   BIGINT NOT NULL REFERENCES inquilinos(id) ON DELETE CASCADE,
    creado         TIMESTAMPTZ NOT NULL DEFAULT now(),
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    ultimo_acceso  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS portal_accesos_inquilino ON portal_accesos(inquilino_id);

CREATE TABLE IF NOT EXISTS portal_pagos_informados (
    id           BIGSERIAL PRIMARY KEY,
    inquilino_id BIGINT NOT NULL REFERENCES inquilinos(id) ON DELETE CASCADE,
    contrato_id  BIGINT REFERENCES contratos(id) ON DELETE CASCADE,
    periodos     TEXT,
    monto        DOUBLE PRECISION,
    fecha        TEXT,
    metodo       TEXT,
    nota         TEXT,
    comprobante  TEXT,
    estado       TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | confirmado | rechazado
    respuesta    TEXT,
    pago_id      BIGINT,
    creado       TIMESTAMPTZ NOT NULL DEFAULT now(),
    revisado     TEXT
);

CREATE TABLE IF NOT EXISTS portal_reclamos (
    id           BIGSERIAL PRIMARY KEY,
    inquilino_id BIGINT NOT NULL REFERENCES inquilinos(id) ON DELETE CASCADE,
    contrato_id  BIGINT REFERENCES contratos(id) ON DELETE CASCADE,
    titulo       TEXT NOT NULL,
    descripcion  TEXT,
    foto         TEXT,
    estado       TEXT NOT NULL DEFAULT 'nuevo',       -- nuevo | recibido | en_arreglo | resuelto
    respuesta    TEXT,
    creado       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_avisos (
    id           BIGSERIAL PRIMARY KEY,
    inquilino_id BIGINT REFERENCES inquilinos(id) ON DELETE CASCADE,  -- NULL = para todos
    titulo       TEXT NOT NULL,
    texto        TEXT,
    activo       BOOLEAN NOT NULL DEFAULT TRUE,
    creado       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 2. Funciones del portal ----------

CREATE OR REPLACE FUNCTION seguridad_activa() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT relrowsecurity FROM pg_class WHERE oid = 'public.usuarios'::regclass;
$$;

-- Inquilino del link (o error si el link no existe o se desactivó).
CREATE OR REPLACE FUNCTION portal_inquilino(p_token TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v BIGINT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RAISE EXCEPTION 'Link no válido';
  END IF;
  SELECT inquilino_id INTO v FROM portal_accesos WHERE token = p_token AND activo;
  IF v IS NULL THEN
    RAISE EXCEPTION 'Link no válido o vencido. Pedile uno nuevo a la inmobiliaria.';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION portal_datos(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inq BIGINT; r JSONB;
BEGIN
  v_inq := portal_inquilino(p_token);
  UPDATE portal_accesos SET ultimo_acceso = now() WHERE token = p_token;
  SELECT jsonb_build_object(
    'inquilino', (SELECT jsonb_build_object('id', i.id, 'nombre', i.nombre, 'dni_cuit', i.dni_cuit, 'telefono', i.telefono) FROM inquilinos i WHERE i.id = v_inq),
    'contratos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'estado', c.estado, 'fecha_inicio', c.fecha_inicio, 'fecha_fin', c.fecha_fin,
        'dia_pago', c.dia_pago, 'monto_inicial', c.monto_inicial, 'tasa_mora_diaria', c.tasa_mora_diaria,
        'multa_diaria', c.multa_diaria, 'frecuencia_actualizacion_meses', c.frecuencia_actualizacion_meses,
        'tipo_actualizacion', c.tipo_actualizacion, 'liquidado_hasta', c.liquidado_hasta, 'conceptos_fijos', c.conceptos_fijos,
        'inmuebles', (SELECT jsonb_build_object('codigo', m.codigo, 'direccion', m.direccion, 'piso_depto', m.piso_depto, 'localidad', m.localidad,
                        'propietarios', (SELECT jsonb_build_object('nombre', p.nombre) FROM propietarios p WHERE p.id = m.propietario_id))
                      FROM inmuebles m WHERE m.id = c.inmueble_id),
        'actualizaciones', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha_vigencia', a.fecha_vigencia, 'monto_nuevo', a.monto_nuevo) ORDER BY a.fecha_vigencia)
                                     FROM actualizaciones a WHERE a.contrato_id = c.id), '[]'::jsonb),
        'pagos', COALESCE((SELECT jsonb_agg(to_jsonb(pg) - 'usuario' ORDER BY pg.periodo DESC, pg.id DESC)
                           FROM pagos pg WHERE pg.contrato_id = c.id), '[]'::jsonb)
      ) ORDER BY c.fecha_inicio DESC)
      FROM contratos c
      WHERE c.inquilino_id = v_inq AND (c.estado = 'activo' OR c.fecha_fin >= to_char(now() - interval '120 days', 'YYYY-MM-DD'))
    ), '[]'::jsonb),
    'config', COALESCE((SELECT jsonb_object_agg(clave, valor) FROM configuracion WHERE clave IN (
        'inmobiliaria_nombre', 'inmobiliaria_matricula', 'inmobiliaria_direccion', 'inmobiliaria_localidad',
        'inmobiliaria_telefono', 'inmobiliaria_email', 'wa_inmobiliaria', 'wa_datos_pago', 'wa_codigo_area',
        'recibo_logo', 'recibo_leyenda')), '{}'::jsonb),
    'pagos_informados', COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'comprobante' ORDER BY x.creado DESC)
                                  FROM portal_pagos_informados x WHERE x.inquilino_id = v_inq), '[]'::jsonb),
    'reclamos', COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'foto') || jsonb_build_object('tiene_foto', x.foto IS NOT NULL) ORDER BY x.creado DESC)
                          FROM portal_reclamos x WHERE x.inquilino_id = v_inq), '[]'::jsonb),
    'avisos', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.creado DESC)
                        FROM portal_avisos x WHERE x.activo AND (x.inquilino_id IS NULL OR x.inquilino_id = v_inq)), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION portal_informar_pago(
  p_token TEXT, p_contrato_id BIGINT, p_periodos TEXT, p_monto DOUBLE PRECISION,
  p_fecha TEXT, p_metodo TEXT, p_nota TEXT, p_comprobante TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inq BIGINT; v_id BIGINT;
BEGIN
  v_inq := portal_inquilino(p_token);
  IF NOT EXISTS (SELECT 1 FROM contratos WHERE id = p_contrato_id AND inquilino_id = v_inq) THEN
    RAISE EXCEPTION 'Contrato no válido';
  END IF;
  IF p_comprobante IS NOT NULL AND (length(p_comprobante) > 4000000 OR p_comprobante NOT LIKE 'data:%') THEN
    RAISE EXCEPTION 'La foto del comprobante es demasiado grande';
  END IF;
  IF (SELECT count(*) FROM portal_pagos_informados WHERE inquilino_id = v_inq AND estado = 'pendiente') >= 10 THEN
    RAISE EXCEPTION 'Ya hay varios pagos informados esperando revisión. La inmobiliaria los va a revisar a la brevedad.';
  END IF;
  INSERT INTO portal_pagos_informados (inquilino_id, contrato_id, periodos, monto, fecha, metodo, nota, comprobante)
  VALUES (v_inq, p_contrato_id, left(p_periodos, 200), p_monto, left(p_fecha, 10), left(p_metodo, 40), left(p_nota, 500), p_comprobante)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION portal_reclamo(
  p_token TEXT, p_contrato_id BIGINT, p_titulo TEXT, p_descripcion TEXT, p_foto TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inq BIGINT; v_id BIGINT;
BEGIN
  v_inq := portal_inquilino(p_token);
  IF NOT EXISTS (SELECT 1 FROM contratos WHERE id = p_contrato_id AND inquilino_id = v_inq) THEN
    RAISE EXCEPTION 'Contrato no válido';
  END IF;
  IF p_foto IS NOT NULL AND (length(p_foto) > 4000000 OR p_foto NOT LIKE 'data:%') THEN
    RAISE EXCEPTION 'La foto es demasiado grande';
  END IF;
  IF (SELECT count(*) FROM portal_reclamos WHERE inquilino_id = v_inq AND estado IN ('nuevo', 'recibido')) >= 10 THEN
    RAISE EXCEPTION 'Ya hay varios reclamos abiertos. La inmobiliaria los va a revisar a la brevedad.';
  END IF;
  INSERT INTO portal_reclamos (inquilino_id, contrato_id, titulo, descripcion, foto)
  VALUES (v_inq, p_contrato_id, left(p_titulo, 120), left(p_descripcion, 2000), p_foto)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Foto de un reclamo propio (para verla en el portal).
CREATE OR REPLACE FUNCTION portal_foto_reclamo(p_token TEXT, p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inq BIGINT;
BEGIN
  v_inq := portal_inquilino(p_token);
  RETURN (SELECT foto FROM portal_reclamos WHERE id = p_id AND inquilino_id = v_inq);
END $$;

-- ---------- 3. Seguridad ----------
-- Todas las tablas con Row Level Security y SIN políticas para "anon" ni
-- "authenticated": la clave pública no puede leer ni escribir nada. El
-- programa de la oficina usa la clave "service_role", que sí puede.
-- El portal sólo puede ejecutar las funciones de arriba.

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.tablename);
  END LOOP;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION seguridad_activa() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_datos(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_informar_pago(TEXT, BIGINT, TEXT, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_reclamo(TEXT, BIGINT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_foto_reclamo(TEXT, BIGINT) TO anon, authenticated;
-- Lo que se cree más adelante tampoco queda abierto para la clave pública.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
