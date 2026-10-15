-- Gestión Inmobiliaria v0.12.3 — balance en cero antes de noviembre 2026.
--
-- Se corre UNA SOLA VEZ: Supabase → SQL Editor → New query → pegar todo →
-- Run. Es seguro correrlo de nuevo (no borra ni duplica nada).
--
-- Agrega al contrato un campo "liquidado_hasta" (período YYYY-MM). Todo lo
-- anterior o igual a ese período se considera cerrado y no aparece como
-- deuda del inquilino. Para los 55 contratos que importamos en la carga
-- inicial queda en '2026-10', así desde noviembre 2026 arrancamos limpios.
-- Si más adelante se cierra una cuenta en otro período, se puede ajustar
-- a mano desde el contrato.

ALTER TABLE contratos ADD COLUMN IF NOT EXISTS liquidado_hasta TEXT;

UPDATE contratos
   SET liquidado_hasta = '2026-10'
 WHERE liquidado_hasta IS NULL
   AND id IN (SELECT contrato_id FROM pagos WHERE numero_recibo = 0 AND periodo = '2026-10');

NOTIFY pgrst, 'reload schema';
