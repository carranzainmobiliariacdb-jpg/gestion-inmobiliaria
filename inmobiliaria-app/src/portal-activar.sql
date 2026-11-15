-- Gestión Inmobiliaria — Portal del inquilino y del propietario + seguridad de la base (v0.21.0)
--
-- Pegar TODO esto en Supabase → SQL Editor → Run.
-- Si pregunta por "Row Level Security", elegir "Run and enable RLS" (o "Run").
--
-- Qué hace:
--  1. Crea las tablas del portal (accesos, pagos informados, reclamos, avisos)
--     y, desde la v0.21.0, los accesos de los propietarios.
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

-- Portal del propietario (v0.21.0)
CREATE TABLE IF NOT EXISTS portal_accesos_propietarios (
    token          TEXT PRIMARY KEY,
    propietario_id BIGINT NOT NULL REFERENCES propietarios(id) ON DELETE CASCADE,
    creado         TIMESTAMPTZ NOT NULL DEFAULT now(),
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    ultimo_acceso  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS portal_accesos_prop_propietario ON portal_accesos_propietarios(propietario_id);
-- Comentario del propietario en un reclamo (lo lee la oficina).
ALTER TABLE portal_reclamos ADD COLUMN IF NOT EXISTS comentario_propietario TEXT;
ALTER TABLE portal_reclamos ADD COLUMN IF NOT EXISTS comentario_propietario_fecha TIMESTAMPTZ;
-- Avisos: para inquilinos (como hasta ahora) o para propietarios.
ALTER TABLE portal_avisos ADD COLUMN IF NOT EXISTS para TEXT NOT NULL DEFAULT 'inquilinos';
ALTER TABLE portal_avisos ADD COLUMN IF NOT EXISTS propietario_id BIGINT REFERENCES propietarios(id) ON DELETE CASCADE;

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
                        FROM portal_avisos x WHERE x.activo AND x.para = 'inquilinos' AND (x.inquilino_id IS NULL OR x.inquilino_id = v_inq)), '[]'::jsonb)
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


-- ---------- 2b. Funciones del portal del propietario ----------

CREATE OR REPLACE FUNCTION portal_propietario(p_token TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v BIGINT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RAISE EXCEPTION 'Link no válido';
  END IF;
  SELECT propietario_id INTO v FROM portal_accesos_propietarios WHERE token = p_token AND activo;
  IF v IS NULL THEN
    RAISE EXCEPTION 'Link no válido o vencido. Pedile uno nuevo a la inmobiliaria.';
  END IF;
  RETURN v;
END $$;

-- Todo lo que ve el propietario: sus inmuebles, los contratos y cobros de
-- cada uno, las liquidaciones, los reclamos de los inquilinos (sin datos de
-- contacto del inquilino) y las fotos de la propiedad.
CREATE OR REPLACE FUNCTION portal_datos_propietario(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prop BIGINT; r JSONB;
BEGIN
  v_prop := portal_propietario(p_token);
  UPDATE portal_accesos_propietarios SET ultimo_acceso = now() WHERE token = p_token;
  SELECT jsonb_build_object(
    'propietario', (SELECT jsonb_build_object('id', p.id, 'nombre', p.nombre, 'dni_cuit', p.dni_cuit, 'cuit_cuil', p.cuit_cuil,
                      'telefono', p.telefono, 'email', p.email, 'datos_bancarios', p.datos_bancarios) FROM propietarios p WHERE p.id = v_prop),
    'inmuebles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'codigo', m.codigo, 'direccion', m.direccion, 'piso_depto', m.piso_depto, 'localidad', m.localidad, 'tipo', m.tipo,
        'fotos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'tipo', f.tipo, 'descripcion', f.descripcion, 'fecha', f.fecha, 'miniatura', f.miniatura) ORDER BY f.fecha DESC, f.id DESC)
                           FROM inmueble_fotos f WHERE f.inmueble_id = m.id), '[]'::jsonb),
        'contratos', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', c.id, 'numero', c.numero, 'estado', c.estado, 'fecha_inicio', c.fecha_inicio, 'fecha_fin', c.fecha_fin,
            'dia_pago', c.dia_pago, 'monto_inicial', c.monto_inicial, 'comision_porcentaje', c.comision_porcentaje,
            'frecuencia_actualizacion_meses', c.frecuencia_actualizacion_meses, 'tipo_actualizacion', c.tipo_actualizacion,
            'liquidado_hasta', c.liquidado_hasta,
            'inquilino', (SELECT jsonb_build_object('nombre', i.nombre) FROM inquilinos i WHERE i.id = c.inquilino_id),
            'actualizaciones', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha_vigencia', a.fecha_vigencia, 'monto_nuevo', a.monto_nuevo) ORDER BY a.fecha_vigencia)
                                         FROM actualizaciones a WHERE a.contrato_id = c.id), '[]'::jsonb),
            'pagos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pg.id, 'periodo', pg.periodo, 'fecha_pago', pg.fecha_pago, 'monto_alquiler', pg.monto_alquiler,
                                 'numero_recibo', pg.numero_recibo, 'liquidado', EXISTS (SELECT 1 FROM liquidaciones l WHERE l.pago_id = pg.id)) ORDER BY pg.periodo DESC, pg.id DESC)
                               FROM pagos pg WHERE pg.contrato_id = c.id), '[]'::jsonb)
          ) ORDER BY c.fecha_inicio DESC)
          FROM contratos c WHERE c.inmueble_id = m.id
            AND (c.estado = 'activo' OR c.fecha_fin >= to_char(now() - interval '400 days', 'YYYY-MM-DD'))
        ), '[]'::jsonb)
      ) ORDER BY m.codigo NULLS LAST, m.direccion)
      FROM inmuebles m WHERE m.propietario_id = v_prop
    ), '[]'::jsonb),
    'liquidaciones', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('pagos', jsonb_build_object(
          'numero_recibo', pg.numero_recibo, 'periodo', pg.periodo, 'fecha_pago', pg.fecha_pago, 'monto_mora', pg.monto_mora, 'monto_multa', pg.monto_multa,
          'contratos', jsonb_build_object('numero', c.numero,
             'inquilinos', (SELECT jsonb_build_object('nombre', i.nombre) FROM inquilinos i WHERE i.id = c.inquilino_id),
             'inmuebles', jsonb_build_object('codigo', m.codigo, 'direccion', m.direccion, 'piso_depto', m.piso_depto, 'localidad', m.localidad,
                'propietarios', (SELECT jsonb_build_object('nombre', p.nombre, 'dni_cuit', p.dni_cuit, 'cuit_cuil', p.cuit_cuil, 'telefono', p.telefono, 'datos_bancarios', p.datos_bancarios)
                                 FROM propietarios p WHERE p.id = m.propietario_id)))))
        ORDER BY l.numero_comprobante DESC, l.id)
      FROM liquidaciones l JOIN pagos pg ON pg.id = l.pago_id JOIN contratos c ON c.id = pg.contrato_id JOIN inmuebles m ON m.id = c.inmueble_id
      WHERE m.propietario_id = v_prop
    ), '[]'::jsonb),
    'reclamos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'contrato_id', x.contrato_id, 'inmueble_id', c.inmueble_id, 'titulo', x.titulo, 'descripcion', x.descripcion,
               'estado', x.estado, 'respuesta', x.respuesta, 'creado', x.creado, 'actualizado', x.actualizado, 'tiene_foto', x.foto IS NOT NULL,
               'comentario_propietario', x.comentario_propietario, 'comentario_propietario_fecha', x.comentario_propietario_fecha,
               'inquilino', (SELECT i.nombre FROM inquilinos i WHERE i.id = x.inquilino_id)) ORDER BY x.creado DESC)
      FROM portal_reclamos x JOIN contratos c ON c.id = x.contrato_id JOIN inmuebles m ON m.id = c.inmueble_id
      WHERE m.propietario_id = v_prop
    ), '[]'::jsonb),
    'config', COALESCE((SELECT jsonb_object_agg(clave, valor) FROM configuracion WHERE clave IN (
        'inmobiliaria_nombre', 'inmobiliaria_matricula', 'inmobiliaria_direccion', 'inmobiliaria_localidad', 'inmobiliaria_cuit',
        'inmobiliaria_telefono', 'inmobiliaria_email', 'wa_inmobiliaria', 'wa_codigo_area', 'recibo_logo', 'recibo_leyenda')), '{}'::jsonb),
    'avisos', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.creado DESC)
                        FROM portal_avisos x WHERE x.activo AND x.para = 'propietarios' AND (x.propietario_id IS NULL OR x.propietario_id = v_prop)), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $$;

-- Foto de un reclamo o de la propiedad, sólo si es de un inmueble suyo.
CREATE OR REPLACE FUNCTION portal_prop_foto(p_token TEXT, p_que TEXT, p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prop BIGINT;
BEGIN
  v_prop := portal_propietario(p_token);
  IF p_que = 'reclamo' THEN
    RETURN (SELECT x.foto FROM portal_reclamos x JOIN contratos c ON c.id = x.contrato_id JOIN inmuebles m ON m.id = c.inmueble_id
            WHERE x.id = p_id AND m.propietario_id = v_prop);
  END IF;
  RETURN (SELECT f.foto FROM inmueble_fotos f JOIN inmuebles m ON m.id = f.inmueble_id WHERE f.id = p_id AND m.propietario_id = v_prop);
END $$;

-- El propietario deja un comentario en un reclamo (p.ej. "autorizo el arreglo").
CREATE OR REPLACE FUNCTION portal_prop_comentar(p_token TEXT, p_id BIGINT, p_texto TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prop BIGINT;
BEGIN
  v_prop := portal_propietario(p_token);
  UPDATE portal_reclamos x SET comentario_propietario = NULLIF(left(trim(p_texto), 1000), ''), comentario_propietario_fecha = now()
  FROM contratos c JOIN inmuebles m ON m.id = c.inmueble_id
  WHERE x.id = p_id AND c.id = x.contrato_id AND m.propietario_id = v_prop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reclamo no válido';
  END IF;
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
GRANT EXECUTE ON FUNCTION portal_datos_propietario(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_prop_foto(TEXT, TEXT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION portal_prop_comentar(TEXT, BIGINT, TEXT) TO anon, authenticated;
-- Lo que se cree más adelante tampoco queda abierto para la clave pública.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
