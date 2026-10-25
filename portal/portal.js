// Portal del inquilino de Carranza Inmobiliaria.
//
// Cada inquilino entra con un link personal (…/#t=CODIGO). Con ese código la
// base devuelve sólo sus datos (función portal_datos); acá se calculan el
// estado de cuenta y los vencimientos con la misma lógica del programa de la
// oficina, y se pueden informar pagos y hacer reclamos.

import { esc, money, fmtDate, hoyIso, periodoTitulo, sumarMeses, vencimientoDe, diasEntre, telefonoWhatsapp, primerNombre } from "./util.js";
import { htmlReciboOriginal } from "./documentos.js";

const C = window.PORTAL_CONFIG || {};
const $ = (id) => document.getElementById(id);
const app = $("app");

// ---------- código de acceso ----------
function leerToken() {
  const m = location.hash.match(/t=([A-Za-z0-9]{20,})/);
  try {
    if (m) {
      localStorage.setItem("portal_token", m[1]);
      return m[1];
    }
    return localStorage.getItem("portal_token") || "";
  } catch {
    return m ? m[1] : "";
  }
}
const token = leerToken();

// ---------- base de datos ----------
async function rpc(fn, args) {
  const headers = { apikey: C.anon, "Content-Type": "application/json" };
  if (!String(C.anon).startsWith("sb_")) headers.Authorization = `Bearer ${C.anon}`;
  let r;
  try {
    r = await fetch(`${C.url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  } catch {
    throw new Error("Sin conexión. Revisá tu internet y probá de nuevo.");
  }
  const txt = await r.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {}
  if (!r.ok) throw new Error((data && data.message) || `Error ${r.status}`);
  return data;
}

// ---------- utilidades ----------
function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), error ? 6000 : 3500);
}
function abrirHoja(titulo, html) {
  $("hoja-titulo").textContent = titulo;
  $("hoja-cuerpo").innerHTML = html;
  $("hoja").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function cerrarHoja() {
  $("hoja").classList.add("hidden");
  $("hoja-cuerpo").innerHTML = "";
  document.body.style.overflow = "";
}
$("hoja-x").addEventListener("click", cerrarHoja);
$("hoja").addEventListener("click", (e) => e.target.id === "hoja" && cerrarHoja());

const redondear = (n) => Math.round(n * 100) / 100;
const fechaHora = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const TIPO_ACT = { porcentaje_fijo: "porcentaje fijo", ipc: "IPC", icl: "ICL", casa_propia: "Casa Propia" };

/** Achica una foto del celular a JPEG de ~1400 px (data URI). */
function comprimirFoto(file, max = 1400, calidad = 0.75) {
  return new Promise((ok, mal) => {
    if (!file) return ok(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * k);
      cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      ok(cv.toDataURL("image/jpeg", calidad));
    };
    img.onerror = () => mal(new Error("No se pudo leer la foto. Probá con otra imagen."));
    img.src = url;
  });
}

// ---------- cálculos (misma lógica que el programa de la oficina) ----------
function montoVigente(c, fecha) {
  const a = (c.actualizaciones || []).filter((x) => x.fecha_vigencia <= fecha).sort((x, y) => x.fecha_vigencia.localeCompare(y.fecha_vigencia)).pop();
  return a ? Number(a.monto_nuevo) : Number(c.monto_inicial);
}
const sumaFijos = (c) => (Array.isArray(c.conceptos_fijos) ? c.conceptos_fijos : []).reduce((a, x) => a + Number(x.monto || 0), 0);

function estadoCuenta(c) {
  const hoy = hoyIso();
  const pagados = new Set((c.pagos || []).map((p) => p.periodo));
  let p = c.fecha_inicio.slice(0, 7);
  if (c.liquidado_hasta) {
    const d = sumarMeses(c.liquidado_hasta, 1);
    if (d > p) p = d;
  }
  const lim = hoy.slice(0, 7);
  const fin = c.fecha_fin.slice(0, 7);
  const deuda = [];
  while (p <= lim && p <= fin) {
    const venc = vencimientoDe(p, c.dia_pago);
    if (venc <= hoy && !pagados.has(p)) {
      const monto = montoVigente(c, venc);
      const dias = Math.max(0, diasEntre(venc, hoy));
      deuda.push({ periodo: p, venc, monto, dias, interes: redondear(monto * (Number(c.tasa_mora_diaria) / 100) * dias) });
    }
    p = sumarMeses(p, 1);
  }
  // Próximo a pagar: el primer mes sin pagar que todavía no venció.
  let q = lim;
  let proximo = null;
  for (let i = 0; i < 24 && q <= fin; i++, q = sumarMeses(q, 1)) {
    const venc = vencimientoDe(q, c.dia_pago);
    if (!pagados.has(q) && venc > hoy) {
      proximo = { periodo: q, venc, monto: montoVigente(c, venc) };
      break;
    }
  }
  const total = deuda.reduce((a, d) => a + d.monto + d.interes, 0);
  return { deuda, total: redondear(total), proximo };
}

function proximaActualizacion(c) {
  const hoy = hoyIso();
  const frec = Number(c.frecuencia_actualizacion_meses || 0);
  if (!frec) return null;
  const ult = (c.actualizaciones || []).map((a) => a.fecha_vigencia).sort().pop();
  let base = ult || c.fecha_inicio;
  const dia = base.slice(8, 10);
  let f = `${sumarMeses(base.slice(0, 7), frec)}-${dia}`;
  for (let i = 0; i < 40 && f <= hoy; i++) f = `${sumarMeses(f.slice(0, 7), frec)}-${dia}`;
  return f > c.fecha_fin ? null : f;
}

/** Recibos: los cobros con el mismo número son un solo recibo (varios meses). */
function recibosDe(c, inq) {
  const grupos = new Map();
  for (const p of c.pagos || []) {
    if (!Number(p.numero_recibo)) continue;
    if (!grupos.has(p.numero_recibo)) grupos.set(p.numero_recibo, []);
    grupos.get(p.numero_recibo).push(p);
  }
  return [...grupos.values()]
    .map((filas) => {
      filas.sort((a, b) => a.periodo.localeCompare(b.periodo));
      const f0 = filas[0];
      return {
        ...f0,
        filas,
        total: filas.reduce((a, f) => a + Number(f.monto_total || 0), 0),
        contratos: { id: c.id, numero: c.numero, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin, dia_pago: c.dia_pago, inquilinos: inq, inmuebles: c.inmuebles || {} },
      };
    })
    .sort((a, b) => Number(b.numero_recibo) - Number(a.numero_recibo));
}

// ---------- pantalla ----------
let D = null; // datos del portal
let contratoSel = 0;
let pestana = "inicio";

const direccionDe = (c) => [c.inmuebles?.direccion, c.inmuebles?.piso_depto].filter(Boolean).join(" ");

function render() {
  const inq = D.inquilino || {};
  const cfg = D.config || {};
  if (cfg.recibo_logo) $("cab-logo").src = cfg.recibo_logo;
  if (cfg.inmobiliaria_nombre) $("cab-marca").textContent = cfg.inmobiliaria_nombre.replace(/\s*inmobiliaria\s*/i, "").toUpperCase();
  const contratos = D.contratos || [];
  if (!contratos.length) {
    app.innerHTML = `<div class="card error-caja"><h1>Hola ${esc(primerNombre(inq.nombre || ""))}</h1><p>No encontramos un contrato vigente a tu nombre. Consultá con la inmobiliaria.</p>${botonContacto(cfg)}</div>`;
    return;
  }
  const c = contratos[Math.min(contratoSel, contratos.length - 1)];
  const avisos = (D.avisos || []).map((a) => `<div class="aviso"><b>${esc(a.titulo)}</b>${a.texto ? `<p>${esc(a.texto)}</p>` : ""}</div>`).join("");
  const elegir =
    contratos.length > 1
      ? `<div class="tabs" id="sel-contrato">${contratos.map((x, i) => `<button class="${i === contratoSel ? "activo" : ""}" data-c="${i}">${esc(direccionDe(x))}</button>`).join("")}</div>`
      : "";
  const pend = (D.reclamos || []).filter((r) => r.contrato_id === c.id && r.estado !== "resuelto").length;
  const tabs = `<div class="tabs" id="tabs">
    ${[["inicio", "Mi alquiler"], ["recibos", "Recibos"], ["reclamos", `Reclamos${pend ? ` (${pend})` : ""}`]].map(([k, l]) => `<button class="${pestana === k ? "activo" : ""}" data-t="${k}">${l}</button>`).join("")}
  </div>`;
  const cuerpo = pestana === "recibos" ? vistaRecibos(c, inq) : pestana === "reclamos" ? vistaReclamos(c) : vistaInicio(c, cfg);
  app.innerHTML = `
    <div class="hola"><h1>Hola, ${esc(primerNombre(inq.nombre || ""))}</h1><p>${esc(direccionDe(c))}${c.inmuebles?.localidad ? ` · ${esc(c.inmuebles.localidad)}` : ""}</p></div>
    ${avisos}${elegir}${tabs}${cuerpo}
    <div class="pie">${esc(cfg.inmobiliaria_nombre || "Carranza Inmobiliaria")}${cfg.inmobiliaria_matricula ? ` · ${esc(cfg.inmobiliaria_matricula)}` : ""}${cfg.inmobiliaria_direccion ? `<br/>${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}` : ""}</div>`;
}

function botonContacto(cfg, texto = "Escribir a la inmobiliaria") {
  const tel = telefonoWhatsapp(cfg.wa_inmobiliaria || cfg.inmobiliaria_telefono || "", cfg.wa_codigo_area || "3468");
  return tel ? `<a class="btn btn-wa" href="https://wa.me/${tel}" target="_blank" rel="noopener">💬 ${esc(texto)}</a>` : "";
}

function vistaInicio(c, cfg) {
  const ec = estadoCuenta(c);
  const act = proximaActualizacion(c);
  const informados = (D.pagos_informados || []).filter((x) => x.contrato_id === c.id).slice(0, 5);
  const estado = ec.deuda.length
    ? `<div class="estado bad"><span>Tenés pagos pendientes</span><b>${money(ec.total)}</b><small>Incluye intereses por atraso calculados a hoy.</small>
        <ul class="deuda-lista">${ec.deuda.map((d) => `<li><span>${periodoTitulo(d.periodo)}<br/><small>venció ${fmtDate(d.venc)}${d.interes ? ` · intereses ${money(d.interes)}` : ""}</small></span><b>${money(d.monto + d.interes)}</b></li>`).join("")}</ul></div>`
    : `<div class="estado ok"><b>✓ Estás al día</b><small>¡Gracias por pagar a tiempo!</small></div>`;
  const prox = ec.proximo
    ? `<div class="fila"><span>Próximo vencimiento</span><b>${fmtDate(ec.proximo.venc)}<br/><small>${periodoTitulo(ec.proximo.periodo)} · ${money(ec.proximo.monto)}</small></b></div>`
    : "";
  return `
    <section class="card"><h2>Estado de cuenta</h2>${estado}
      <div class="botones"><button class="btn btn-oro" id="btn-informar">📤 Informar un pago</button>${botonContacto(cfg, "Consultar")}</div>
    </section>
    <section class="card"><h2>Mi alquiler</h2>
      <div class="fila"><span>Alquiler actual</span><b class="grande">${money(montoVigente(c, hoyIso()))}</b></div>
      ${sumaFijos(c) ? `<div class="fila"><span>Otros conceptos mensuales</span><b>${(c.conceptos_fijos || []).map((x) => `${esc(x.concepto)} ${money(x.monto)}`).join("<br/>")}</b></div>` : ""}
      <div class="fila"><span>Vence cada mes el día</span><b>${esc(c.dia_pago)}</b></div>
      ${prox}
      ${act ? `<div class="fila"><span>Próxima actualización</span><b>${fmtDate(act)}<br/><small>por ${esc(TIPO_ACT[c.tipo_actualizacion] || c.tipo_actualizacion || "")}, cada ${esc(c.frecuencia_actualizacion_meses)} meses</small></b></div>` : ""}
      <div class="fila"><span>Contrato</span><b>${c.numero ? `N° ${esc(c.numero)} · ` : ""}${fmtDate(c.fecha_inicio)} al ${fmtDate(c.fecha_fin)}</b></div>
    </section>
    ${
      cfg.wa_datos_pago
        ? `<section class="card"><h2>Datos para transferir</h2><div class="transferir" id="datos-pago">${esc(cfg.wa_datos_pago)}</div><button class="btn btn-claro copiar" id="btn-copiar">Copiar datos</button></section>`
        : ""
    }
    ${
      informados.length
        ? `<section class="card"><h2>Pagos que informaste</h2><div class="lista">${informados
            .map((x) => {
              const pill = x.estado === "confirmado" ? '<span class="pill pill-ok">Confirmado</span>' : x.estado === "rechazado" ? '<span class="pill pill-bad">Revisar</span>' : '<span class="pill pill-warn">En revisión</span>';
              return `<div class="item"><div class="item-txt"><b>${money(x.monto)} · ${esc(x.periodos || "")}</b><small>Informado ${fechaHora(x.creado)}</small>${x.respuesta ? `<div class="respuesta">${esc(x.respuesta)}</div>` : ""}</div>${pill}</div>`;
            })
            .join("")}</div></section>`
        : ""
    }`;
}

function vistaRecibos(c, inq) {
  const recs = recibosDe(c, inq);
  if (!recs.length) return `<section class="card"><h2>Recibos</h2><p class="vacio">Todavía no hay recibos emitidos en el sistema.</p></section>`;
  return `<section class="card"><h2>Recibos</h2><div class="lista">${recs
    .map(
      (r, i) => `<div class="item"><div class="item-txt"><b>${r.filas.map((f) => periodoTitulo(f.periodo)).join(", ")}</b><small>Recibo N° ${esc(r.numero_recibo)} · pagado ${fmtDate(r.fecha_pago)} · ${money(r.total)}</small></div>
      <button class="btn btn-negro" data-recibo="${i}">Ver</button></div>`
    )
    .join("")}</div></section>`;
}

const ESTADO_RECLAMO = { nuevo: ["Enviado", "pill-warn"], recibido: ["Recibido", "pill-gris"], en_arreglo: ["En arreglo", "pill-warn"], resuelto: ["Resuelto", "pill-ok"] };

function vistaReclamos(c) {
  const lista = (D.reclamos || []).filter((r) => r.contrato_id === c.id);
  return `<section class="card"><h2>Nuevo reclamo</h2>
      <p class="vacio" style="margin-top:0">Contanos qué pasa en la propiedad. Si podés, sumá una foto.</p>
      <button class="btn btn-oro" id="btn-reclamo">🛠 Hacer un reclamo</button></section>
    <section class="card"><h2>Mis reclamos</h2>${
      lista.length
        ? `<div class="lista">${lista
            .map((r) => {
              const [t, cl] = ESTADO_RECLAMO[r.estado] || [r.estado, "pill-gris"];
              return `<div class="item"><div class="item-txt"><b>${esc(r.titulo)}</b><small>${fechaHora(r.creado)}${r.descripcion ? ` · ${esc(r.descripcion.slice(0, 80))}` : ""}</small>${r.respuesta ? `<div class="respuesta"><b>Inmobiliaria:</b> ${esc(r.respuesta)}</div>` : ""}</div><span class="pill ${cl}">${t}</span></div>`;
            })
            .join("")}</div>`
        : '<p class="vacio">No hiciste reclamos.</p>'
    }</section>`;
}

// ---------- acciones ----------
app.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.t) {
    pestana = b.dataset.t;
    render();
    window.scrollTo({ top: 0 });
  }
  if (b.dataset.c) {
    contratoSel = Number(b.dataset.c);
    render();
  }
  const c = D.contratos[Math.min(contratoSel, D.contratos.length - 1)];
  if (b.id === "btn-informar") formularioPago(c);
  if (b.id === "btn-reclamo") formularioReclamo(c);
  if (b.id === "btn-copiar") {
    try {
      await navigator.clipboard.writeText(D.config.wa_datos_pago);
      toast("Datos copiados");
    } catch {
      toast("No se pudo copiar: mantené apretado el texto para copiarlo", true);
    }
  }
  if (b.dataset.recibo) verRecibo(recibosDe(c, D.inquilino)[Number(b.dataset.recibo)]);
});

function verRecibo(r) {
  const html = htmlReciboOriginal(r, D.config || {});
  abrirHoja(`Recibo N° ${r.numero_recibo}`, `<iframe class="recibo-marco" id="recibo-marco" title="Recibo"></iframe>
    <div class="botones"><button class="btn btn-negro" id="btn-imprimir">⬇ Guardar PDF / imprimir</button><button class="btn btn-claro" id="btn-cerrar-r">Cerrar</button></div>
    <p class="vacio">Para guardarlo, tocá «Guardar PDF» y elegí «Guardar como PDF».</p>`);
  const fr = $("recibo-marco");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="recibo.css">
    <style>@page{size:A5 landscape;margin:6mm} html,body{margin:0;background:#fff} .zoom{transform-origin:0 0} @media print{.zoom{transform:none!important}}</style></head>
    <body><div class="zoom" id="z">${html}</div></body></html>`;
  fr.srcdoc = doc;
  fr.onload = () => {
    const d = fr.contentDocument;
    const z = d.getElementById("z");
    const ancho = z.scrollWidth || 522;
    const k = Math.min(1, (fr.clientWidth - 2) / ancho);
    z.style.transform = `scale(${k})`;
    fr.style.height = Math.ceil(z.scrollHeight * k + 4) + "px";
  };
  $("btn-imprimir").onclick = () => fr.contentWindow.print();
  $("btn-cerrar-r").onclick = cerrarHoja;
}

function formularioPago(c) {
  const ec = estadoCuenta(c);
  const fijos = sumaFijos(c);
  const opciones = [
    ...ec.deuda.map((d) => ({ periodo: d.periodo, monto: d.monto + d.interes + fijos, txt: `${periodoTitulo(d.periodo)} (vencido)`, marcado: true })),
    ...(ec.proximo ? [{ periodo: ec.proximo.periodo, monto: ec.proximo.monto + fijos, txt: periodoTitulo(ec.proximo.periodo), marcado: !ec.deuda.length }] : []),
  ];
  abrirHoja(
    "Informar un pago",
    `<form id="f-pago">
      <div class="campo"><label>¿Qué meses pagaste?</label><div class="checks">${opciones
        .map((o) => `<label><input type="checkbox" name="per" value="${o.periodo}" data-monto="${o.monto}" ${o.marcado ? "checked" : ""}/><span>${esc(o.txt)}</span><b>${money(o.monto)}</b></label>`)
        .join("") || '<p class="vacio">No hay meses pendientes. Escribí abajo qué pagaste.</p>'}</div></div>
      <div class="campo"><label>Importe que pagaste</label><input type="number" inputmode="decimal" step="any" id="p-monto" required /></div>
      <div class="campo"><label>Fecha del pago</label><input type="date" id="p-fecha" value="${hoyIso()}" required /></div>
      <div class="campo"><label>¿Cómo pagaste?</label><select id="p-metodo"><option>Transferencia</option><option>Depósito</option><option>Mercado Pago</option><option>Efectivo</option><option>Otro</option></select></div>
      <div class="campo"><label>Foto o captura del comprobante</label><input type="file" accept="image/*" id="p-foto" /><img class="foto-prev hidden" id="p-prev" alt="" /><small>Ayuda a confirmarlo más rápido.</small></div>
      <div class="campo"><label>Comentario (opcional)</label><textarea id="p-nota" placeholder="Ej.: pagué desde la cuenta de mi pareja"></textarea></div>
      <button class="btn btn-oro" type="submit" id="p-enviar">Enviar a la inmobiliaria</button>
    </form>`
  );
  const f = $("f-pago");
  const recalcular = () => {
    const tot = [...f.querySelectorAll("[name=per]:checked")].reduce((a, i) => a + Number(i.dataset.monto), 0);
    if (tot) $("p-monto").value = redondear(tot);
  };
  f.addEventListener("change", (e) => {
    if (e.target.name === "per") recalcular();
  });
  recalcular();
  $("p-foto").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("p-prev").src = URL.createObjectURL(file);
    $("p-prev").classList.remove("hidden");
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("p-enviar");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const periodos = [...f.querySelectorAll("[name=per]:checked")].map((i) => periodoTitulo(i.value)).join(", ");
      const foto = await comprimirFoto($("p-foto").files[0]);
      await rpc("portal_informar_pago", {
        p_token: token, p_contrato_id: c.id, p_periodos: periodos || "(sin indicar)", p_monto: Number($("p-monto").value || 0),
        p_fecha: $("p-fecha").value, p_metodo: $("p-metodo").value, p_nota: $("p-nota").value.trim() || null, p_comprobante: foto,
      });
      cerrarHoja();
      toast("¡Listo! La inmobiliaria va a revisar tu pago y te confirma.");
      await cargar(false);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Enviar a la inmobiliaria";
    }
  });
}

function formularioReclamo(c) {
  abrirHoja(
    "Hacer un reclamo",
    `<form id="f-rec">
      <div class="campo"><label>¿Sobre qué es?</label><select id="r-tipo">
        ${["Plomería / agua", "Electricidad", "Gas", "Humedad / filtraciones", "Cerraduras / aberturas", "Artefactos (calefón, cocina…)", "Otro"].map((x) => `<option>${x}</option>`).join("")}
      </select></div>
      <div class="campo"><label>Contanos qué pasa</label><textarea id="r-desc" required placeholder="Ej.: pierde agua la canilla de la cocina desde ayer"></textarea></div>
      <div class="campo"><label>Foto (opcional)</label><input type="file" accept="image/*" id="r-foto" /><img class="foto-prev hidden" id="r-prev" alt="" /></div>
      <button class="btn btn-oro" type="submit" id="r-enviar">Enviar reclamo</button>
    </form>`
  );
  $("r-foto").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("r-prev").src = URL.createObjectURL(file);
    $("r-prev").classList.remove("hidden");
  });
  $("f-rec").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("r-enviar");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const foto = await comprimirFoto($("r-foto").files[0]);
      await rpc("portal_reclamo", { p_token: token, p_contrato_id: c.id, p_titulo: $("r-tipo").value, p_descripcion: $("r-desc").value.trim(), p_foto: foto });
      cerrarHoja();
      toast("Reclamo enviado. Te avisamos cuando lo veamos.");
      await cargar(false);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Enviar reclamo";
    }
  });
}

// ---------- inicio ----------
async function cargar(mostrarSpinner = true) {
  if (mostrarSpinner) app.innerHTML = `<div class="cargando"><div class="spinner"></div>Cargando tus datos…</div>`;
  D = await rpc("portal_datos", { p_token: token });
  render();
}

(async () => {
  if (!C.url || !C.anon) {
    app.innerHTML = `<div class="card error-caja"><h1>Portal en preparación</h1><p>Volvé a intentar en unos minutos.</p></div>`;
    return;
  }
  if (!token) {
    app.innerHTML = `<div class="card error-caja"><h1>Necesitás tu link personal</h1><p>Pedile a la inmobiliaria el link de acceso a tu alquiler. Te llega por WhatsApp.</p></div>`;
    return;
  }
  // Que el código no quede a la vista en la barra de direcciones.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  try {
    await cargar();
  } catch (e) {
    app.innerHTML = `<div class="card error-caja"><h1>No pudimos abrir tu cuenta</h1><p>${esc(e.message)}</p></div>`;
  }
})();
