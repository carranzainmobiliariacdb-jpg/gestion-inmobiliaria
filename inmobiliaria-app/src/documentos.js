// Plantillas HTML de los documentos que se imprimen o guardan como PDF:
// recibo de alquiler (duplicado + original en A4 apaisado, igual al modelo
// que usa la inmobiliaria) y liquidación al propietario (A4 vertical).

import { esc, money, numero, fmtDate, hoyIso, periodoTexto, mesDeContrato, montoEnLetras } from "./util.js";

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
        <span class="dm-contacto">${[cfg.inmobiliaria_direccion && `${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}`, cfg.inmobiliaria_telefono && `Tel. ${esc(cfg.inmobiliaria_telefono)}`, esc(cfg.inmobiliaria_email || "")].filter(Boolean).join(" · ")}</span>
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

function mitadRecibo(r, cfg, copia) {
  const c = r.contratos || {};
  const inq = c.inquilinos || {};
  const inm = c.inmuebles || {};
  const prop = inm.propietarios || {};
  const t = totalesRecibo(r);
  const mes = c.fecha_inicio && c.fecha_fin ? mesDeContrato(c.fecha_inicio, c.fecha_fin, r.periodo) : null;
  const periodo = periodoTexto(r.periodo);
  const direccion = [inm.direccion, inm.piso_depto].filter(Boolean).join(" ");
  const logo = cfg.recibo_logo || "logo-carranza.png";
  const filas = [
    `<tr><td><b>Alquiler</b></td><td>${esc(periodo)}${mes ? ` <span class="rm-mes">mes ${mes.mes}/${mes.total}</span>` : ""}</td>
      <td class="num">${n0(t.alquiler)}</td><td class="num">${n0(t.interes)}</td><td class="num">${n0(t.multa)}</td><td class="num"><b>${n0(t.alquiler + t.interes + t.multa)}</b></td></tr>`,
    ...t.conceptos.map(
      (x) => `<tr><td>${esc(x.concepto || "")}</td><td>${esc(periodo)}</td><td class="num">${n0(x.monto)}</td><td class="num">—</td><td class="num">—</td><td class="num"><b>${n0(x.monto)}</b></td></tr>`
    ),
  ].join("");
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
    <table class="rm-tabla">
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
      ${r.dias_mora > 0 ? `<div>Pagado con ${esc(r.dias_mora)} días de atraso.</div>` : ""}
      ${r.notas ? `<div><b>Observaciones:</b> ${esc(r.notas)}</div>` : ""}
      ${cfg.recibo_leyenda ? `<div class="rm-leyenda">${esc(cfg.recibo_leyenda)}</div>` : ""}
    </div>
    <div class="rm-pie">
      <span class="rm-copia ${esOriginal ? "rm-original" : ""}">${copia}</span>
      <div class="rm-firma">${esOriginal ? "Firma y sello" : "Recibí copia — firma del inquilino"}</div>
    </div>
    <div class="rm-legal">${[cfg.inmobiliaria_direccion && `${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}`, cfg.inmobiliaria_telefono && `Tel. ${esc(cfg.inmobiliaria_telefono)}`, esc(cfg.inmobiliaria_email || "")].filter(Boolean).join(" · ")}
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
