// Plantillas HTML de los documentos que se imprimen o guardan como PDF:
// recibo de alquiler (duplicado + original en A4 apaisado, igual al modelo
// que usa la inmobiliaria) y liquidación al propietario (A4 vertical).

import { esc, money, numero, fmtDate, hoyIso, periodoTexto, mesDeContrato, montoEnLetras } from "./util.js";

const n0 = (v) => numero(v, 2);

function encabezado(cfg) {
  const logo = cfg.recibo_logo || "logo-recibo.jpg";
  return `
    <div class="doc-cab">
      <div class="doc-cab-logo"><img src="${esc(logo)}" alt="" /></div>
      <div class="doc-cab-x">
        <div class="doc-x">X</div>
        <div class="doc-novalido">Comprobante No válido como Factura</div>
      </div>
      <div class="doc-cab-datos">
        <strong>${esc(cfg.inmobiliaria_nombre || "CARRANZA Inmobiliaria")}</strong>
        ${cfg.inmobiliaria_matricula ? `<span>${esc(cfg.inmobiliaria_matricula)}</span>` : ""}
        <span>${esc(cfg.inmobiliaria_direccion || "")}${cfg.inmobiliaria_localidad ? ` - ${esc(cfg.inmobiliaria_localidad)}` : ""}</span>
        <span>${esc(cfg.inmobiliaria_telefono || "")}</span>
        <span>${esc(cfg.inmobiliaria_email || "")}</span>
      </div>
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

function mitadRecibo(r, cfg, copia) {
  const c = r.contratos || {};
  const inq = c.inquilinos || {};
  const inm = c.inmuebles || {};
  const prop = inm.propietarios || {};
  const t = totalesRecibo(r);
  const mes = c.fecha_inicio && c.fecha_fin ? mesDeContrato(c.fecha_inicio, c.fecha_fin, r.periodo) : null;
  const periodo = `${periodoTexto(r.periodo)}${mes ? ` - Mes ${mes.mes}/${mes.total}` : ""}`;
  const direccion = [inm.direccion, inm.piso_depto].filter(Boolean).join(" ");
  const filasExtra = t.conceptos
    .map(
      (x) => `<tr><td>${esc((x.concepto || "").toUpperCase())}</td><td>${esc(periodoTexto(r.periodo))}</td>
        <td class="num">${n0(x.monto)}</td><td class="num">0,00</td><td class="num">0,00</td><td class="num">${n0(x.monto)}</td></tr>`
    )
    .join("");
  const esOriginal = copia === "ORIGINAL";
  return `
  <div class="recibo-mitad">
    ${encabezado(cfg)}
    <div class="rec-datos">
      <div class="rec-fila rec-fila-top">
        <span><label>Fecha</label> <b>${fmtDate(r.fecha_pago)}</b></span>
        <span class="rec-num">Recibo de Alquiler N°: ${esc(r.numero_recibo)}</span>
      </div>
      <div class="rec-fila"><label>Recibí de</label> <b>${esc(inq.nombre || "")}</b>${inq.dni_cuit ? ` <small>DNI ${esc(inq.dni_cuit)}</small>` : ""}</div>
      <div class="rec-fila"><label>Según Contrato N°</label> <b>${esc(c.numero ?? c.id ?? "")}</b>
        <span class="rec-sep">Venc.: ${fmtDate(c.fecha_fin)}</span><span class="rec-sep">TE: ${esc(inq.telefono || "")}</span></div>
      <div class="rec-fila"><label>Por orden y cuenta de</label> <b>${esc(prop.nombre || "")}</b></div>
      <div class="rec-fila"><label>${inm.codigo != null ? `<b>${esc(inm.codigo)}</b> ` : ""}Propiedad</label> <b>${esc(direccion.toUpperCase())}</b>${
        inm.localidad ? ` <small>${esc(inm.localidad)}</small>` : ""
      }</div>
    </div>
    <table class="rec-tabla">
      <thead><tr><th>Conceptos</th><th>Período</th><th class="num">Importe</th><th class="num">Intereses</th><th class="num">Multa</th><th class="num">Total</th></tr></thead>
      <tbody>
        <tr><td>ALQUILER</td><td>${esc(periodo)}</td><td class="num">${n0(t.alquiler)}</td><td class="num">${n0(t.interes)}</td><td class="num">${n0(t.multa)}</td>
          <td class="num">${n0(t.alquiler + t.interes + t.multa)}</td></tr>
        ${filasExtra}
      </tbody>
    </table>
    <div class="rec-resumen">
      <div><span>Alquiler: ${n0(t.alquiler)}</span><span>Interés: ${n0(t.interes)}</span><span>Multa: ${n0(t.multa)}</span></div>
      <div><span>Servicios: ${n0(t.servicios)}</span><span>Otros: ${n0(t.otros)}</span><span>A favor: ${n0(t.aFavor)}</span></div>
      <div class="rec-resumen-der"><span>Subtotal: ${n0(t.subtotal)}</span><span>Bonificación: ${n0(t.bonificacion)}</span><span>Recargo: ${n0(t.recargo)}</span>
        <strong>Total: ${money(t.total)}</strong></div>
    </div>
    <div class="rec-letras">Son Pesos: ${montoEnLetras(t.total)}</div>
    <div class="rec-extra">
      ${r.metodo_pago ? `<div><label>Forma de pago:</label> ${esc(r.metodo_pago)}</div>` : ""}
      ${r.dias_mora > 0 ? `<div><label>Pagado con</label> ${esc(r.dias_mora)} días de atraso</div>` : ""}
      ${r.notas ? `<div><label>Observaciones:</label> ${esc(r.notas)}</div>` : ""}
      ${cfg.recibo_leyenda ? `<div class="rec-leyenda">${esc(cfg.recibo_leyenda)}</div>` : ""}
    </div>
    <div class="rec-pie">
      <div class="rec-pie-fila">
        <span>${copia}</span>
        <span class="rec-firma">${esOriginal ? "Recibí conforme" : "Recibí copia"}</span>
      </div>
      <div class="rec-pie-fila rec-pie-chico">
        <span>Impreso: ${fmtDate(hoyIso())}</span><span>Recibo N° ${esc(r.numero_recibo)}</span><span>Usuario: ${esc((r.usuario || "").toUpperCase())}</span>
      </div>
    </div>
  </div>`;
}

export function htmlRecibo(r, cfg) {
  return `<div class="doc doc-recibo">${mitadRecibo(r, cfg, "DUPLICADO")}${mitadRecibo(r, cfg, "ORIGINAL")}</div>`;
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
    ${encabezado(cfg)}
    <div class="liq-titulo">
      <h2>Liquidación al Propietario</h2>
      <div class="liq-num">N° <b>${esc(f0.numero_comprobante)}</b><br/>Fecha: <b>${fmtDate(f0.fecha)}</b></div>
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
    ${encabezado(cfg)}
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
