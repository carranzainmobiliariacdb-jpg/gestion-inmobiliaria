// Plantillas HTML de los documentos que se imprimen o guardan como PDF:
// recibo de alquiler (duplicado + original en A4 apaisado, igual al modelo
// que usa la inmobiliaria) y liquidación al propietario (A4 vertical).

import { esc, money, numero, fmtDate, hoyIso, periodoTexto, mesDeContrato, montoEnLetras, sumarMeses } from "./util.js";

const n0 = (v) => numero(v, 2);

/** Banda negra con el logo y los datos de la inmobiliaria (liquidación, acta). */
function encabezado(cfg, titulo = "", numero = "") {
  const logo = cfg.recibo_logo || "logo-carranza.png";
  return `
    <div class="dm-cab">
      <img class="dm-logo" src="${esc(logo)}" alt="" />
      <div class="dm-marca">
        <span class="dm-nombre">${esc((cfg.inmobiliaria_nombre || "CARRANZA Inmobiliaria").replace(/\s*inmobiliaria\s*/i, ""))}</span>
        <span class="dm-sub">INMOBILIARIA${cfg.inmobiliaria_matricula ? ` · ${esc(cfg.inmobiliaria_matricula)}` : ""}</span>
        <span class="dm-contacto">${[cfg.inmobiliaria_direccion && `${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}`, cfg.inmobiliaria_telefono && `Tel. ${esc(cfg.inmobiliaria_telefono)}`, cfg.wa_inmobiliaria && `WhatsApp ${esc(cfg.wa_inmobiliaria)}`, esc(cfg.inmobiliaria_email || "")].filter(Boolean).join(" · ")}</span>
      </div>
      ${titulo ? `<div class="dm-titulo"><span>${esc(titulo)}</span>${numero !== "" ? `<b>N° ${esc(numero)}</b>` : ""}</div>` : ""}
    </div>`;
}

/** Totales del recibo con el mismo desglose que el modelo de la inmobiliaria. */
export function totalesRecibo(p) {
  const conceptos = Array.isArray(p.conceptos) ? p.conceptos : [];
  const servicios = conceptos.filter((c) => c.tipo === "servicios").reduce((a, c) => a + Number(c.monto || 0), 0);
  const otros = conceptos.filter((c) => c.tipo !== "servicios").reduce((a, c) => a + Number(c.monto || 0), 0);
  const alquiler = Number(p.monto_alquiler || 0);
  const interes = Number(p.monto_mora || 0);
  const multa = Number(p.monto_multa || 0);
  const subtotal = alquiler + interes + multa + servicios + otros;
  const bonificacion = Number(p.bonificacion || 0);
  const recargo = Number(p.recargo || 0);
  const aFavor = Number(p.a_favor || 0);
  return { conceptos, servicios, otros, alquiler, interes, multa, subtotal, bonificacion, recargo, aFavor, total: subtotal - bonificacion + recargo - aFavor };
}

/** Períodos cobrados con este recibo (get_recibo trae `filas`; si no, el propio pago). */
export function filasRecibo(r) {
  return Array.isArray(r.filas) && r.filas.length ? r.filas : [r];
}

/** Suma todos los períodos de un recibo en un solo "pago" (para totales). */
export function pagoCombinado(r) {
  const filas = filasRecibo(r);
  const sum = (k) => filas.reduce((a, f) => a + Number(f[k] || 0), 0);
  return {
    ...r,
    monto_alquiler: sum("monto_alquiler"), monto_mora: sum("monto_mora"), monto_multa: sum("monto_multa"),
    bonificacion: sum("bonificacion"), recargo: sum("recargo"), a_favor: sum("a_favor"), monto_total: sum("monto_total"),
    conceptos: filas.flatMap((f) => (Array.isArray(f.conceptos) ? f.conceptos : [])),
  };
}

/** "Septiembre 2026" o "Septiembre 2026 a Noviembre 2026 (3 meses)". */
export function periodosDeRecibo(r) {
  const pers = [...new Set(filasRecibo(r).map((f) => f.periodo))].sort();
  if (pers.length <= 1) return periodoTexto(pers[0] || r.periodo);
  const seguidos = pers.every((p, i) => i === 0 || sumarMeses(pers[i - 1], 1) === p);
  if (seguidos) return `${periodoTexto(pers[0])} a ${periodoTexto(pers[pers.length - 1])} (${pers.length} meses)`;
  return `${pers.slice(0, -1).map(periodoTexto).join(", ")} y ${periodoTexto(pers[pers.length - 1])}`;
}

function mitadRecibo(r, cfg, copia) {
  const c = r.contratos || {};
  const inq = c.inquilinos || {};
  const inm = c.inmuebles || {};
  const prop = inm.propietarios || {};
  const t = totalesRecibo(pagoCombinado(r));
  const variosMeses = new Set(filasRecibo(r).map((f) => f.periodo)).size > 1;
  const periodo = periodosDeRecibo(r);
  const direccion = [inm.direccion, inm.piso_depto].filter(Boolean).join(" ");
  const logo = cfg.recibo_logo || "logo-carranza.png";
  const filas = filasRecibo(r)
    .flatMap((f) => {
      const per = periodoTexto(f.periodo);
      const mes = c.fecha_inicio && c.fecha_fin ? mesDeContrato(c.fecha_inicio, c.fecha_fin, f.periodo) : null;
      const alq = Number(f.monto_alquiler || 0), int = Number(f.monto_mora || 0), mul = Number(f.monto_multa || 0);
      return [
        `<tr><td><b>Alquiler</b></td><td>${esc(per)}${mes ? ` <span class="rm-mes">mes ${mes.mes}/${mes.total}</span>` : ""}</td>
      <td class="num">${n0(alq)}</td><td class="num">${n0(int)}</td><td class="num">${n0(mul)}</td><td class="num"><b>${n0(alq + int + mul)}</b></td></tr>`,
        ...(Array.isArray(f.conceptos) ? f.conceptos : []).map(
          (x) => `<tr><td>${esc(x.concepto || "")}</td><td>${esc(x.periodo ? periodoTexto(x.periodo) : per)}</td><td class="num">${n0(x.monto)}</td><td class="num">—</td><td class="num">—</td><td class="num"><b>${n0(x.monto)}</b></td></tr>`
        ),
      ];
    })
    .join("");
  const atrasos = filasRecibo(r).filter((f) => f.dias_mora > 0);
  const cantFilas = (filas.match(/<tr>/g) || []).length;
  const ajustes = [
    t.bonificacion ? `<div><span>Bonificación</span><span>- ${n0(t.bonificacion)}</span></div>` : "",
    t.recargo ? `<div><span>Recargo</span><span>${n0(t.recargo)}</span></div>` : "",
    t.aFavor ? `<div><span>Saldo a favor aplicado</span><span>- ${n0(t.aFavor)}</span></div>` : "",
  ].join("");
  const esOriginal = copia === "ORIGINAL";
  return `
  <div class="rm-mitad">
    <div class="rm-cab">
      <img class="rm-logo" src="${esc(logo)}" alt="" />
      <div class="rm-marca">
        <span class="rm-nombre">${esc((cfg.inmobiliaria_nombre || "CARRANZA").replace(/\s*inmobiliaria\s*/i, ""))}</span>
        <span class="rm-sub">INMOBILIARIA</span>
        <span class="rm-contacto">${esc(cfg.inmobiliaria_matricula || "")}</span>
      </div>
      <div class="rm-num">
        <span class="rm-tipo">Recibo de alquiler</span>
        <span class="rm-numero">N° ${esc(String(r.numero_recibo).padStart(6, "0"))}</span>
        <span class="rm-x"><b>X</b> Documento no válido como factura</span>
      </div>
    </div>
    <div class="rm-franja">
      <div><label>Fecha</label><b>${fmtDate(r.fecha_pago)}</b></div>
      <div><label>Período</label><b>${esc(periodo)}</b></div>
      <div><label>Contrato N°</label><b>${esc(c.numero ?? c.id ?? "")}</b></div>
      <div><label>Vence</label><b>${fmtDate(c.fecha_fin)}</b></div>
    </div>
    <div class="rm-datos">
      <div class="rm-dato rm-full"><label>Recibí de</label><b>${esc(inq.nombre || "")}</b>${[inq.dni_cuit && `DNI ${esc(inq.dni_cuit)}`, inq.telefono && `Tel. ${esc(inq.telefono)}`].filter(Boolean).map((x) => `<small>${x}</small>`).join("")}</div>
      <div class="rm-dato rm-full"><label>Propiedad</label><b>${inm.codigo != null ? `<span class="rm-cod">${esc(inm.codigo)}</span> ` : ""}${esc(direccion)}</b>${inm.localidad ? `<small>${esc(inm.localidad)}</small>` : ""}</div>
      <div class="rm-dato rm-full"><label>Por cuenta y orden de</label><b>${esc(prop.nombre || "")}</b></div>
    </div>
    <table class="rm-tabla${cantFilas > 6 ? " rm-compacta" : ""}">
      <thead><tr><th>Concepto</th><th>Período</th><th class="num">Importe</th><th class="num">Interés</th><th class="num">Multa</th><th class="num">Total</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="rm-totales">
      <div class="rm-ajustes">
        <div><span>Subtotal</span><span>${n0(t.subtotal)}</span></div>
        ${ajustes}
        ${r.metodo_pago ? `<div class="rm-pago"><span>Forma de pago</span><span>${esc(r.metodo_pago)}</span></div>` : ""}
      </div>
      <div class="rm-total"><span>TOTAL</span><b>${money(t.total)}</b></div>
    </div>
    <div class="rm-letras">Son pesos ${montoEnLetras(t.total).toLowerCase().replace(" cts.", "")}</div>
    <div class="rm-extra">
      ${!variosMeses && r.dias_mora > 0 ? `<div>Pagado con ${esc(r.dias_mora)} días de atraso.</div>` : ""}
      ${variosMeses && atrasos.length ? `<div>Atraso: ${atrasos.map((f) => `${esc(periodoTexto(f.periodo).toLowerCase())} ${esc(f.dias_mora)} días`).join(" · ")}.</div>` : ""}
      ${filasRecibo(r).map((f) => f.notas).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).map((n) => `<div><b>Observaciones:</b> ${esc(n)}</div>`).join("")}
      ${cfg.recibo_leyenda ? `<div class="rm-leyenda">${esc(cfg.recibo_leyenda)}</div>` : ""}
    </div>
    <div class="rm-pie">
      <span class="rm-copia ${esOriginal ? "rm-original" : ""}">${copia}</span>
      <div class="rm-firma">${esOriginal ? "Firma y sello" : "Recibí copia — firma del inquilino"}</div>
    </div>
    <div class="rm-legal">${[cfg.inmobiliaria_direccion && `${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}`, cfg.inmobiliaria_telefono && `Tel. ${esc(cfg.inmobiliaria_telefono)}`, cfg.wa_inmobiliaria && `WhatsApp ${esc(cfg.wa_inmobiliaria)}`, esc(cfg.inmobiliaria_email || "")].filter(Boolean).join(" · ")}
      <span>Impreso ${fmtDate(hoyIso())}${r.usuario ? ` · ${esc(r.usuario)}` : ""}</span></div>
  </div>`;
}

export function htmlRecibo(r, cfg) {
  return `<div class="doc doc-recibo-m">${mitadRecibo(r, cfg, "DUPLICADO")}<div class="rm-corte"></div>${mitadRecibo(r, cfg, "ORIGINAL")}</div>`;
}

/** filas = respuesta de get_comprobante (una fila por recibo liquidado). */
export function totalesLiquidacion(filas) {
  const items = filas.flatMap((f) => (Array.isArray(f.items) ? f.items : []));
  const cobrado = filas.reduce((a, f) => a + Number(f.monto_cobrado ?? f.monto_alquiler ?? 0), 0);
  const comision = filas.reduce((a, f) => a + Number(f.monto_comision || 0), 0);
  const neto = filas.reduce((a, f) => a + Number(f.monto_neto || 0), 0);
  return { items, cobrado, comision, neto };
}

export function htmlLiquidacion(filas, cfg) {
  const f0 = filas[0];
  const prop = f0.pagos?.contratos?.inmuebles?.propietarios || {};
  const t = totalesLiquidacion(filas);
  const filasRecibos = filas
    .map((f) => {
      const p = f.pagos || {};
      const c = p.contratos || {};
      const inm = c.inmuebles || {};
      const dir = [inm.direccion, inm.piso_depto].filter(Boolean).join(" ");
      return `<tr>
        <td>${esc(p.numero_recibo ?? "")}</td>
        <td>${inm.codigo != null ? `<b>${esc(inm.codigo)}</b> ` : ""}${esc(dir)}</td>
        <td>${esc(c.inquilinos?.nombre || "")}</td>
        <td>${esc(periodoTexto(p.periodo))}</td>
        <td class="num">${n0(f.monto_cobrado ?? f.monto_alquiler)}</td>
        <td class="num">${n0(f.comision_porcentaje)}%</td>
        <td class="num">- ${n0(f.monto_comision)}</td>
        <td class="num">${n0(Number(f.monto_cobrado ?? f.monto_alquiler) - Number(f.monto_comision))}</td>
      </tr>`;
    })
    .join("");
  const filasItems = t.items
    .map((i) => `<tr><td colspan="7">${esc(i.concepto || i.descripcion || "")}</td><td class="num">${Number(i.monto) < 0 ? "- " : ""}${n0(Math.abs(i.monto))}</td></tr>`)
    .join("");
  const notas = filas.map((f) => f.notas).filter(Boolean).join(" · ");
  return `
  <div class="doc doc-liquidacion">
    ${encabezado(cfg, "Liquidación al propietario", f0.numero_comprobante)}
    <div class="liq-titulo">
      <h2>Liquidación de alquileres cobrados</h2>
      <div class="liq-num">Fecha: <b>${fmtDate(f0.fecha)}</b></div>
    </div>
    <div class="liq-datos">
      <div><label>Propietario</label><b>${esc(prop.nombre || "")}</b></div>
      <div><label>DNI / CUIT</label><b>${esc(prop.cuit_cuil || prop.dni_cuit || "-")}</b></div>
      <div class="liq-banco"><label>Datos para transferencia</label><b>${esc(prop.datos_bancarios || "No registrados")}</b></div>
    </div>
    <table class="liq-tabla">
      <thead><tr><th>Recibo</th><th>Propiedad</th><th>Inquilino</th><th>Período</th><th class="num">Cobrado</th><th class="num">Adm.</th><th class="num">Honorarios</th><th class="num">Subtotal</th></tr></thead>
      <tbody>${filasRecibos}</tbody>
      ${
        filasItems
          ? `<tbody class="liq-items"><tr><th colspan="8">Gastos, descuentos y otros importes</th></tr>${filasItems}</tbody>`
          : ""
      }
    </table>
    <div class="liq-totales">
      <div><span>Total cobrado</span><span>${money(t.cobrado)}</span></div>
      <div><span>Honorarios de administración</span><span>- ${money(t.comision)}</span></div>
      ${t.items.length ? (() => { const g = t.items.reduce((a, i) => a + Number(i.monto || 0), 0); return `<div><span>Gastos / otros</span><span>${g < 0 ? "- " : ""}${money(Math.abs(g))}</span></div>`; })() : ""}
      <div class="liq-neto"><span>Neto a liquidar</span><span>${money(t.neto)}</span></div>
      <div class="liq-letras">Son Pesos: ${montoEnLetras(t.neto)}</div>
    </div>
    ${notas ? `<p class="liq-notas"><label>Observaciones:</label> ${esc(notas)}</p>` : ""}
    <div class="liq-firmas">
      <div>Por ${esc(cfg.inmobiliaria_nombre || "la inmobiliaria")}</div>
      <div>Recibí conforme — ${esc(prop.nombre || "Propietario")}</div>
    </div>
    <div class="liq-pie">Impreso: ${fmtDate(hoyIso())}${f0.usuario ? ` · Usuario: ${esc(f0.usuario.toUpperCase())}` : ""}</div>
  </div>`;
}

/** Acta de constatación del estado del inmueble con sus fotos. */
export function htmlActaFotos({ inmueble, contrato, fotos, tipo, fecha }, cfg) {
  const dir = [inmueble.direccion, inmueble.piso_depto].filter(Boolean).join(" ");
  const items = fotos
    .map(
      (f, i) => `<div class="acta-foto"><img src="${f.foto}" alt="" /><div><b>${i + 1}.</b> ${esc(f.descripcion || "")} <span style="color:#666">(${fmtDate(f.fecha)})</span></div></div>`
    )
    .join("");
  return `<div class="doc doc-acta">
    ${encabezado(cfg, "Acta de estado")}
    <div class="acta-cuerpo">
      <h2>Acta de constatación del estado del inmueble${tipo ? ` — ${esc(tipo)}` : ""}</h2>
      <div class="acta-datos">
        <div><label>Inmueble:</label> <b>${inmueble.codigo != null ? esc(inmueble.codigo) + " - " : ""}${esc(dir)}</b>${inmueble.localidad ? `, ${esc(inmueble.localidad)}` : ""}</div>
        <div><label>Fecha:</label> <b>${fmtDate(fecha)}</b></div>
        <div><label>Propietario:</label> <b>${esc(inmueble.propietario_nombre || "")}</b></div>
        <div><label>Inquilino:</label> <b>${esc(contrato?.inquilino_nombre || "-")}</b>${contrato?.numero ? ` (contrato N° ${esc(contrato.numero)})` : ""}</div>
      </div>
      <p style="margin:0 0 10px">Las partes dejan constancia de que el inmueble se encuentra en el estado que muestran las ${fotos.length} fotografías siguientes, que forman parte del contrato de locación.</p>
      <div class="acta-fotos">${items}</div>
      <div class="acta-firmas"><div>Locador / ${esc(cfg.inmobiliaria_nombre || "Inmobiliaria")}</div><div>Locatario</div></div>
    </div>
  </div>`;
}

/** Constancia del estado de una cuenta de servicio (agua, luz o gas) según la
 *  última consulta guardada. `f` = fila de servicios_estado. */
export function htmlConstanciaServicio({ f, servicio, empresa, fuente, inmuebles, contrato, vencidos, hoy }, cfg) {
  const m = String(f.actualizado || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
  const consultado = m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]} hs` : f.actualizado || "";
  const docs = Array.isArray(f.documentos) ? f.documentos : [];
  const esVencido = (d) => vencidos.includes(d);
  const totalVenc = vencidos.reduce((a, d) => a + Number(d.importe || 0), 0);
  const porVencer = docs.filter((d) => !esVencido(d));
  const totalPorVencer = porVencer.reduce((a, d) => a + Number(d.importe || 0), 0);
  const estado = f.error
    ? { clase: "cs-aviso", titulo: "NO SE PUDO LEER LA DEUDA", detalle: f.error }
    : vencidos.length
      ? { clase: "cs-deuda", titulo: `REGISTRA DEUDA VENCIDA: ${money(totalVenc)}`, detalle: `${vencidos.length} ${vencidos.length === 1 ? "boleta vencida" : "boletas vencidas"}${porVencer.length ? ` · además ${money(totalPorVencer)} por vencer` : ""}` }
      : porVencer.length
        ? { clase: "cs-ok", titulo: "AL DÍA — SIN DEUDA VENCIDA", detalle: `Tiene ${porVencer.length} ${porVencer.length === 1 ? "boleta" : "boletas"} por vencer: ${money(totalPorVencer)}` }
        : { clase: "cs-ok", titulo: "AL DÍA — SIN DEUDA", detalle: "No registra boletas a pagar" };
  const filas = docs
    .map(
      (d) => `<tr class="${esVencido(d) ? "cs-fila-venc" : ""}"><td>${esc(d.periodo || "")}</td><td>${esc(d.tipo || "")}</td><td>${esc(d.numero || "")}</td><td>${esc(d.vencimiento || "")}</td>
      <td>${esVencido(d) ? "<b>Vencida</b>" : "Por vencer"}</td><td class="num">${n0(d.importe)}</td></tr>`
    )
    .join("");
  const inms = (inmuebles || []).map((i) => `${i.codigo != null && i.codigo !== "" ? esc(i.codigo) + " - " : ""}${esc([i.direccion, i.piso_depto].filter(Boolean).join(" "))}`).join("<br/>");
  return `<div class="doc doc-acta doc-constancia">
    ${encabezado(cfg, `Constancia de ${servicio}`)}
    <div class="acta-cuerpo">
      <h2>Estado de deuda — ${esc(servicio)} (${esc(empresa)})</h2>
      <div class="acta-datos">
        <div><label>Cuenta N°:</label> <b>${esc(f.cuenta)}</b></div>
        <div><label>Consultado:</label> <b>${esc(consultado)}</b></div>
        <div><label>Titular en ${esc(empresa)}:</label> <b>${esc(f.titular || "-")}</b></div>
        <div><label>Inquilino:</label> <b>${esc(contrato?.inquilino_nombre || "-")}</b></div>
        <div style="grid-column:1/-1"><label>Inmueble:</label> <b>${inms || esc(f.direccion || "-")}</b></div>
      </div>
      <div class="cs-estado ${estado.clase}"><b>${estado.titulo}</b><span>${esc(estado.detalle)}</span></div>
      ${
        docs.length
          ? `<table class="liq-tabla"><thead><tr><th>Período</th><th>Descripción</th><th>Boleta</th><th>Vencimiento</th><th>Estado</th><th class="num">Importe</th></tr></thead><tbody>${filas}</tbody>
             <tfoot><tr><td colspan="5"><b>Total a pagar</b></td><td class="num"><b>${n0(totalVenc + totalPorVencer)}</b></td></tr></tfoot></table>`
          : ""
      }
      <p class="cs-nota">Datos leídos de ${esc(fuente)} el ${esc(consultado)}. Constancia interna de ${esc(cfg.inmobiliaria_nombre || "la inmobiliaria")}: el estado puede cambiar después de la consulta.</p>
    </div>
    <div class="liq-pie">Impreso: ${fmtDate(hoy || hoyIso())}</div>
  </div>`;
}
