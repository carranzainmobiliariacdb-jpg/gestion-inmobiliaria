import {
  esc, money, numero, fmtDate, hoyIso, periodoTexto, periodoTitulo, sumarMeses, mesDeContrato, vencimientoDe, diasEntre,
  montoEnLetras, telefonoWhatsapp, enlaceWhatsapp, completarPlantilla, primerNombre, serieIpcCompleta, calcularIpc,
} from "./util.js";
import { leerCodigoDni, interpretarCodigoDni, comprimirFoto } from "./dni.js";
import { htmlRecibo, htmlLiquidacion, totalesRecibo, totalesLiquidacion } from "./documentos.js";

const invoke = window.__TAURI__.core.invoke;

document.getElementById("titlebar-minimize").addEventListener("click", () => invoke("minimizar_ventana").catch(console.error));
document.getElementById("titlebar-close").addEventListener("click", () => invoke("cerrar_ventana").catch(console.error));

const state = {
  usuarioActual: null,
  usuarios: [],
  propietarios: [],
  inquilinos: [],
  garantes: [],
  inmuebles: [],
  contratos: [],
  pagos: [],
  liquidaciones: [],
  config: {},
  recordatorios: [],
  dashboard: null,
  ipc: null,
  aumentos: [],
};

// ---------- configuración por defecto ----------

const CONFIG_DEFECTO = {
  inmobiliaria_nombre: "CARRANZA Inmobiliaria",
  inmobiliaria_matricula: "C.P.I. N° 6545",
  inmobiliaria_direccion: "Montevideo 115",
  inmobiliaria_localidad: "Corral de Bustos",
  inmobiliaria_telefono: "3468563371",
  inmobiliaria_email: "carranzainmobiliariacdb@gmail.com",
  inmobiliaria_cuit: "",
  recibo_numero_desde: "",
  recibo_leyenda: "",
  recibo_logo: "",
  aumento_redondeo: "1",
  wa_codigo_area: "3468",
  wa_datos_pago: "",
  aviso_dias_antes: "5",
  plantilla_recordatorio:
    "Hola {nombre}! Te recordamos que el alquiler de {inmueble} correspondiente a {periodo} vence el {vencimiento}. Importe: {monto}.\n{datos_pago}\nMuchas gracias. {inmobiliaria}",
  plantilla_deuda:
    "Hola {nombre}. Te escribimos de {inmobiliaria}: figura pendiente el alquiler de {inmueble} ({periodos}). Total a hoy con intereses: {monto}. Por favor comunicate con nosotros para regularizarlo. Gracias.",
  plantilla_aumento:
    "Hola {nombre}! Te informamos que, según el contrato, desde el {fecha} el alquiler de {inmueble} se actualiza por {indice} ({porcentaje}). El nuevo importe es {monto}. Cualquier consulta estamos a disposición. {inmobiliaria}",
  plantilla_vencimiento:
    "Hola {nombre}! Te recordamos que el contrato de alquiler de {inmueble} vence el {fecha}. Queremos saber si tenés intención de renovarlo para coordinar. Saludos, {inmobiliaria}",
  plantilla_recibo:
    "Hola {nombre}! Recibimos tu pago de {monto} correspondiente a {periodo} ({inmueble}). Recibo N° {recibo}. ¡Muchas gracias! {inmobiliaria}",
  plantilla_liquidacion:
    "Hola {nombre}! Te enviamos la liquidación N° {numero} de los alquileres cobrados. Neto a liquidar: {monto}. Saludos, {inmobiliaria}",
  plantilla_cumple: "¡Feliz cumpleaños {nombre}! Te desea todo el equipo de {inmobiliaria} 🎂",
};

const cfg = (k) => {
  const v = state.config[k];
  return v === undefined || v === null || v === "" ? CONFIG_DEFECTO[k] ?? "" : v;
};
const configCompleta = () => {
  const out = {};
  for (const k of Object.keys(CONFIG_DEFECTO)) out[k] = cfg(k);
  return { ...state.config, ...out };
};

// ---------- utilidades de interfaz ----------

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), isError ? 6000 : 3500);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(typeof e === "string" ? e : "Ocurrió un error", true);
    throw e;
  }
}

const byId = (list, id) => list.find((x) => x.id === id);
const usuarioNombre = () => state.usuarioActual?.nombre_completo || "";
const $ = (id) => document.getElementById(id);
const vacio = (cols, txt) => `<tr class="empty-row"><td colspan="${cols}">${txt}</td></tr>`;
/** "Octubre 2026" o, si son muchos, "12 meses (nov 2025 a oct 2026)". */
function periodosTexto(lista) {
  if (lista.length <= 3) return lista.map(periodoTitulo).join(", ");
  const corto = (p) => periodoTitulo(p).slice(0, 3).toLowerCase() + " " + p.slice(0, 4);
  return `${lista.length} meses (${corto(lista[0])} a ${corto(lista[lista.length - 1])})`;
}
const codHtml = (cod) => (cod != null && cod !== "" ? `<span class="cod">${esc(cod)}</span> ` : "");

function diasTexto(d) {
  if (d === 0) return "hoy";
  if (d === 1) return "mañana";
  if (d === -1) return "ayer";
  return d > 0 ? `en ${d} días` : `hace ${-d} días`;
}

const ICONO_WA = `<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg>`;

// ---------- navegación ----------

document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g && !g.classList.contains("nav-btn")) {
    switchView(g.dataset.goto);
    if (g.dataset.tab) abrirTabConfig(g.dataset.tab);
  }
});

function switchView(view) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $("content").scrollTop = 0;
  if (view === "aumentos") renderAumentos();
  if (view === "avisos") {
    // Abrir en la primera pestaña que tenga algo pendiente
    const g = calcularAvisos();
    if (!g[avisosTab].some((a) => !a.enviado)) {
      const conPend = TABS_AVISOS.find(([k]) => g[k].some((a) => !a.enviado));
      if (conPend) avisosTab = conPend[0];
    }
    renderAvisos();
  }
  if (view === "configuracion") renderConfig();
}

// Buscadores de las tablas
document.querySelectorAll("input.search").forEach((inp) => inp.addEventListener("input", () => aplicarBusqueda(inp.dataset.search)));
function aplicarBusqueda(tablaId) {
  const inp = document.querySelector(`input.search[data-search="${tablaId}"]`);
  if (!inp) return;
  const q = inp.value.trim().toLowerCase();
  document.querySelectorAll(`#${tablaId} tr`).forEach((tr) => {
    if (tr.classList.contains("empty-row")) return;
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}

// ---------- modal genérico ----------

const modalOverlay = $("modal-overlay");
const modalEl = $("modal");
const modalTitle = $("modal-title");
const modalBody = $("modal-body");
const modalSave = $("modal-save");
const modalInfo = $("modal-footer-info");
let modalCleanup = null;

function closeModal() {
  modalOverlay.classList.add("hidden");
  modalBody.innerHTML = "";
  modalInfo.innerHTML = "";
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
}
$("modal-close").addEventListener("click", closeModal);
$("modal-cancel").addEventListener("click", closeModal);

function fieldHtml(f, value) {
  const v = value ?? f.default ?? "";
  const id = `f-${f.name}`;
  const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "";
  if (f.type === "select") {
    const opts = (f.blank ? `<option value="">${esc(f.blank)}</option>` : "") +
      f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? "selected" : ""}>${esc(o.label)}</option>`).join("");
    return `<select id="${id}">${opts}</select>`;
  }
  if (f.type === "textarea") return `<textarea id="${id}" ${ph}>${esc(v)}</textarea>`;
  if (f.type === "checkbox") return `<input type="checkbox" id="${id}" ${v === true || v === "true" ? "checked" : ""} />`;
  if (f.type === "checkbox-group") {
    const sel = new Set(value ?? []);
    const items = f.options.map((o) => `<label><input type="checkbox" value="${o.value}" ${sel.has(o.value) ? "checked" : ""}/> ${esc(o.label)}</label>`).join("");
    return `<div class="checkbox-list" id="${id}">${items || '<span class="muted">No hay registros cargados</span>'}</div>`;
  }
  if (f.type === "lineas") return lineasHtml(id, value ?? [], f.tipos);
  const step = f.type === "number" ? `step="${f.step ?? "any"}"` : "";
  return `<input type="${f.type ?? "text"}" id="${id}" value="${esc(v)}" ${step} ${ph} ${f.readonly ? "readonly" : ""} />`;
}

function formHtml(fields, values, cols = "") {
  return `<div class="form-grid ${cols}">${fields
    .map((f) => {
      if (f.type === "section") return `<div class="form-section">${esc(f.label)}</div>`;
      if (f.type === "html") return f.html;
      const cls = [f.full || f.type === "lineas" ? "full" : "", f.doble ? "doble" : "", f.type === "checkbox" ? "form-check" : ""].join(" ");
      const label = `<label for="f-${f.name}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>`;
      const ctrl = fieldHtml(f, values?.[f.name]);
      return `<div class="form-field ${cls}">${f.type === "checkbox" ? ctrl + label : label + ctrl}${f.hint ? `<small class="field-hint">${esc(f.hint)}</small>` : ""}</div>`;
    })
    .join("")}</div>`;
}

function leerCampos(fields) {
  const result = {};
  for (const f of fields) {
    if (["section", "html"].includes(f.type)) continue;
    if (f.type === "checkbox-group") {
      result[f.name] = Array.from(document.querySelectorAll(`#f-${f.name} input:checked`)).map((c) => Number(c.value));
      continue;
    }
    if (f.type === "lineas") {
      result[f.name] = leerLineas(`f-${f.name}`);
      continue;
    }
    const el = $(`f-${f.name}`);
    if (!el) continue;
    if (f.type === "checkbox") {
      result[f.name] = el.checked;
      continue;
    }
    let val = el.value;
    if (typeof val === "string") val = val.trim();
    if (f.required && val === "") {
      el.focus();
      throw new Error(`Completá "${f.label}"`);
    }
    if (f.type === "number" || f.numeric) val = val === "" ? (f.nullable ? null : 0) : Number(val);
    result[f.name] = val === "" ? null : val;
  }
  return result;
}

/**
 * Abre el modal. opts: { title, size: ""|"wide"|"xl", fields, values, html,
 * cols, saveLabel, onMount(), onSave(values) }.
 */
function openModal(opts) {
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
  modalTitle.textContent = opts.title;
  modalEl.className = `modal ${opts.size ? "modal-" + opts.size : ""}`;
  modalBody.innerHTML = (opts.before || "") + (opts.fields ? formHtml(opts.fields, opts.values, opts.cols) : "") + (opts.html || "");
  modalInfo.innerHTML = "";
  modalSave.textContent = opts.saveLabel || "Guardar";
  modalSave.classList.toggle("hidden", opts.sinGuardar === true);
  modalSave.disabled = false;
  modalOverlay.classList.remove("hidden");
  modalBody.scrollTop = 0;
  if (opts.onMount) opts.onMount();
  modalSave.onclick = async () => {
    let values = {};
    try {
      if (opts.fields) values = leerCampos(opts.fields);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    modalSave.disabled = true;
    try {
      const r = await opts.onSave(values);
      if (r !== false) closeModal();
    } catch (e) {
      if (e && e.message && typeof e !== "string") toast(e.message, true);
    } finally {
      modalSave.disabled = false;
    }
  };
}

// ---------- editor de líneas (conceptos / gastos) ----------

const TIPOS_CONCEPTO = [
  { value: "servicios", label: "Servicios" },
  { value: "otros", label: "Otros" },
];

function lineaHtml(l, tipos) {
  return `<div class="linea">
    <input type="text" class="l-concepto" value="${esc(l.concepto || "")}" placeholder="Concepto (ej. Expensas, Agua, Luz)" />
    <select class="l-tipo">${tipos.map((t) => `<option value="${t.value}" ${t.value === l.tipo ? "selected" : ""}>${t.label}</option>`).join("")}</select>
    <input type="number" step="any" class="l-monto" value="${l.monto ?? ""}" placeholder="Importe" />
    <button type="button" class="btn-icon l-quitar" title="Quitar">✕</button>
  </div>`;
}

function lineasHtml(id, lineas, tipos = TIPOS_CONCEPTO) {
  return `<div class="lineas" id="${id}" data-tipos='${esc(JSON.stringify(tipos))}'>
    <div class="lineas-filas">${lineas.map((l) => lineaHtml(l, tipos)).join("")}</div>
    <button type="button" class="btn-secondary btn-sm lineas-add">+ Agregar concepto</button>
  </div>`;
}

modalBody.addEventListener("click", (e) => {
  const add = e.target.closest(".lineas-add");
  if (add) {
    const cont = add.closest(".lineas");
    const tipos = JSON.parse(cont.dataset.tipos);
    cont.querySelector(".lineas-filas").insertAdjacentHTML("beforeend", lineaHtml({ tipo: tipos[0].value }, tipos));
    cont.querySelector(".lineas-filas .linea:last-child .l-concepto").focus();
    cont.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const q = e.target.closest(".l-quitar");
  if (q) {
    const cont = q.closest(".lineas");
    q.closest(".linea").remove();
    cont.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

function leerLineas(id) {
  return Array.from(document.querySelectorAll(`#${id} .linea`))
    .map((row) => ({
      concepto: row.querySelector(".l-concepto").value.trim(),
      tipo: row.querySelector(".l-tipo").value,
      monto: Number(row.querySelector(".l-monto").value || 0),
    }))
    .filter((l) => l.concepto || l.monto);
}

// ---------- vista previa / impresión ----------

const printOverlay = $("print-overlay");
let printWhatsapp = null;
function cerrarPrint() {
  printOverlay.classList.add("hidden");
}
$("print-close").addEventListener("click", cerrarPrint);
$("print-close-2").addEventListener("click", cerrarPrint);
$("print-now").addEventListener("click", () => window.print());
$("print-whatsapp").addEventListener("click", () => printWhatsapp && printWhatsapp());

function openPrint(html, { titulo = "Vista previa", apaisado = false, whatsapp = null } = {}) {
  $("page-style").textContent = `@page { size: A4 ${apaisado ? "landscape" : "portrait"}; margin: ${apaisado ? "8mm" : "10mm"}; }`;
  $("print-title").textContent = titulo;
  $("print-body").innerHTML = html;
  printWhatsapp = whatsapp;
  $("print-whatsapp").classList.toggle("hidden", !whatsapp);
  $("print-now").classList.toggle("hidden", titulo.startsWith("DNI"));
  printOverlay.classList.remove("hidden");
}

// ---------- WhatsApp ----------

function datosBaseMensaje() {
  const pago = cfg("wa_datos_pago");
  return { inmobiliaria: cfg("inmobiliaria_nombre"), datos_pago: pago ? `Datos para transferir: ${pago}` : "" };
}

/** Abre WhatsApp con el mensaje y lo registra. Devuelve true si se pudo abrir. */
async function enviarWhatsapp({ telefono, mensaje, contrato_id = null, tipo, referencia = null, nombre = "" }) {
  const tel = telefonoWhatsapp(telefono, cfg("wa_codigo_area"));
  if (!tel) {
    toast(`${nombre || "La persona"} no tiene un teléfono válido cargado`, true);
    return false;
  }
  const limpio = mensaje.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  await call("abrir_enlace", { url: enlaceWhatsapp(tel, limpio) });
  try {
    const reg = { contrato_id, tipo, referencia, telefono: tel, mensaje: limpio, fecha: hoyIso(), usuario: usuarioNombre() };
    await invoke("registrar_recordatorio", { recordatorio: reg });
    state.recordatorios.unshift({ ...reg, id: Date.now() });
  } catch (e) {
    console.error(e);
  }
  return true;
}

function ultimoAviso(contratoId, tipo, referencia) {
  return state.recordatorios.find((r) => r.tipo === tipo && (contratoId == null || r.contrato_id === contratoId) && (referencia == null || r.referencia === referencia));
}

// ---------- carga de datos ----------

async function loadAll() {
  const desde = sumarMeses(hoyIso().slice(0, 7), -4) + "-01";
  const [usuarios, propietarios, inquilinos, garantes, inmuebles, contratos, pagos, liquidaciones, config, recordatorios] = await Promise.all([
    call("get_usuarios"),
    call("get_propietarios"),
    call("get_inquilinos"),
    call("get_garantes"),
    call("get_inmuebles"),
    call("get_contratos"),
    call("get_pagos"),
    call("get_liquidaciones"),
    call("get_configuracion"),
    call("get_recordatorios", { desde }),
  ]);
  Object.assign(state, { usuarios, propietarios, inquilinos, garantes, inmuebles, contratos, pagos, liquidaciones, config, recordatorios });
  renderTodo();
  await renderDashboard();
  actualizarBadges();
}

function renderTodo() {
  renderUsuarios();
  renderPersonas("propietarios");
  renderPersonas("inquilinos");
  renderPersonas("garantes");
  renderInmuebles();
  renderContratos();
  renderPagos();
  renderLiquidaciones();
  const activa = document.querySelector(".view.active")?.id;
  if (activa === "view-avisos") renderAvisos();
}

// ---------- helpers de negocio ----------

const contratosActivos = () => state.contratos.filter((c) => c.estado === "activo");
const pagosDe = (contratoId) => state.pagos.filter((p) => p.contrato_id === contratoId);
const pagoDelPeriodo = (contratoId, periodo) => state.pagos.find((p) => p.contrato_id === contratoId && p.periodo === periodo);
const inquilinoDe = (c) => byId(state.inquilinos, c.inquilino_id) || {};
const propietarioDe = (c) => byId(state.propietarios, c.propietario_id) || {};
const etiquetaInmueble = (c) => `${c.inmueble_codigo != null ? c.inmueble_codigo + " - " : ""}${c.inmueble_direccion}`;

/** Primer período sin pagar del contrato (o el mes siguiente al último pagado). */
function periodoSugerido(c) {
  const hoyP = hoyIso().slice(0, 7);
  let p = c.fecha_inicio.slice(0, 7);
  const fin = c.fecha_fin.slice(0, 7);
  while (p <= hoyP && p <= fin) {
    if (!pagoDelPeriodo(c.id, p)) return p;
    p = sumarMeses(p, 1);
  }
  return p <= fin ? p : hoyP;
}

// ---------- TABLERO ----------

$("dash-btn-cobrar").addEventListener("click", () => abrirCobro());
$("dash-dias-venc").addEventListener("change", renderDashboard);
$("dash-dias-cumple").addEventListener("change", renderDashboard);

async function renderDashboard() {
  const d = await call("get_dashboard", {
    diasVencimiento: Number($("dash-dias-venc").value || 60),
    diasActualizacion: 45,
    diasCumpleanos: Number($("dash-dias-cumple").value || 30),
  });
  state.dashboard = d;
  const hoy = hoyIso();
  const mes = hoy.slice(0, 7);
  $("dash-fecha").textContent = new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("dash-mes-label").textContent = periodoTitulo(mes);

  const activos = contratosActivos();
  const delMes = activos.filter((c) => c.fecha_inicio.slice(0, 7) <= mes && c.fecha_fin.slice(0, 7) >= mes);
  const cobrados = delMes.filter((c) => pagoDelPeriodo(c.id, mes));
  const pendientes = delMes.filter((c) => !pagoDelPeriodo(c.id, mes));
  const cobradoMes = state.pagos.filter((p) => p.periodo === mes).reduce((a, p) => a + p.monto_total, 0);
  const pendienteMes = pendientes.reduce((a, c) => a + c.monto_vigente, 0);
  const liquidados = new Set(state.liquidaciones.map((l) => l.pago_id));
  const sinLiquidar = state.pagos.filter((p) => !liquidados.has(p.id));
  const aLiquidar = sinLiquidar.reduce((a, p) => {
    const c = byId(state.contratos, p.contrato_id);
    return a + (p.monto_alquiler + p.monto_mora + (p.monto_multa || 0)) - p.monto_alquiler * ((c?.comision_porcentaje || 0) / 100);
  }, 0);

  $("dash-cards").innerHTML = `
    <div class="card card-metric" data-goto="contratos"><span class="metric-label"><i style="background:var(--gold)"></i>Contratos activos</span><span class="metric-value">${d.total_contratos_activos}</span><span class="metric-foot">${state.inmuebles.length} inmuebles en cartera</span></div>
    <div class="card card-metric" data-goto="cobros"><span class="metric-label"><i style="background:var(--success)"></i>Cobrado ${periodoTitulo(mes).split(" ")[0].toLowerCase()}</span><span class="metric-value">${money(cobradoMes)}</span><span class="metric-foot">${cobrados.length} de ${delMes.length} alquileres</span></div>
    <div class="card card-metric"><span class="metric-label"><i style="background:var(--warning)"></i>Falta cobrar del mes</span><span class="metric-value">${money(pendienteMes)}</span><span class="metric-foot">${pendientes.length} alquileres</span></div>
    <div class="card card-metric" data-goto="avisos"><span class="metric-label"><i style="background:var(--danger)"></i>Deuda vencida</span><span class="metric-value">${money(d.total_adeudado)}</span><span class="metric-foot">${d.deudas.length} contratos con atraso</span></div>
    <div class="card card-metric" data-goto="liquidaciones"><span class="metric-label"><i style="background:var(--info)"></i>A liquidar</span><span class="metric-value">${money(aLiquidar)}</span><span class="metric-foot">${sinLiquidar.length} recibos sin liquidar</span></div>`;

  // cobros del mes
  const filasMes = delMes
    .map((c) => {
      const pago = pagoDelPeriodo(c.id, mes);
      const venc = vencimientoDe(mes, c.dia_pago);
      const dd = diasEntre(hoy, venc);
      let estado;
      if (pago) estado = `<span class="pill pill-ok">Cobrado · N° ${pago.numero_recibo}</span>`;
      else if (dd < 0) estado = `<span class="pill pill-danger">Vencido ${diasTexto(dd)}</span>`;
      else if (dd <= 5) estado = `<span class="pill pill-warning">Vence ${diasTexto(dd)}</span>`;
      else estado = `<span class="pill pill-gris">Vence ${diasTexto(dd)}</span>`;
      const acc = pago
        ? `<button class="btn-link" data-recibo="${pago.id}">Recibo</button>`
        : `<button class="btn-icon wa" title="Recordar por WhatsApp" data-wa-recordar="${c.id}">${ICONO_WA}</button><button class="btn-link" data-cobrar="${c.id}" data-periodo="${mes}">Cobrar</button>`;
      return { orden: pago ? 1 : 0, venc, html: `<tr><td>${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">${esc(c.inquilino_nombre)}</span></td><td class="num">${money(c.monto_vigente)}<span class="sub-line">vence ${fmtDate(venc).slice(0, 5)}</span></td><td>${estado}</td><td class="actions">${acc}</td></tr>` };
    })
    .sort((a, b) => a.orden - b.orden || a.venc.localeCompare(b.venc))
    .map((x) => x.html)
    .join("");
  $("tbl-mes").innerHTML = filasMes || vacio(4, "No hay contratos activos este mes");

  $("tbl-deudas").innerHTML = d.deudas.length
    ? d.deudas
        .map((x) => {
          const c = byId(state.contratos, x.contrato_id);
          return `<tr><td>${codHtml(c?.inmueble_codigo)}${esc(x.inmueble_direccion)}<span class="sub-line">${esc(x.inquilino_nombre)}</span></td>
          <td>${periodosTexto(x.periodos_impagos)}</td><td class="num"><b>${money(x.monto_adeudado)}</b></td>
          <td class="actions"><button class="btn-icon wa" title="Reclamar por WhatsApp" data-wa-deuda="${x.contrato_id}">${ICONO_WA}</button><button class="btn-link" data-cobrar="${x.contrato_id}" data-periodo="${x.periodos_impagos[0]}">Cobrar</button></td></tr>`;
        })
        .join("")
    : vacio(4, "No hay deudas vencidas");

  $("tbl-vencimientos").innerHTML = d.vencimientos.length
    ? d.vencimientos
        .map((x) => {
          const pill = x.dias_restantes < 0 ? "pill-danger" : x.dias_restantes <= 30 ? "pill-warning" : "pill-gris";
          return `<tr><td>${esc(x.inmueble_direccion)}</td><td>${esc(x.inquilino_nombre)}</td>
          <td>${fmtDate(x.fecha_fin)} <span class="pill ${pill}">${diasTexto(x.dias_restantes)}</span></td>
          <td class="actions"><button class="btn-icon wa" title="Avisar al inquilino" data-wa-fin="${x.contrato_id}">${ICONO_WA}</button></td></tr>`;
        })
        .join("")
    : vacio(4, "Sin vencimientos próximos");

  $("tbl-cumpleanos").innerHTML = d.cumpleanos_proximos.length
    ? d.cumpleanos_proximos
        .map((x) => {
          const pill = x.dias_restantes === 0 ? "pill-gold" : "pill-gris";
          return `<tr><td>${esc(x.nombre)}</td><td>${esc(x.tipo)}</td><td>${fmtDate(x.proximo_cumple)} <span class="pill ${pill}">${x.dias_restantes === 0 ? "¡hoy!" : diasTexto(x.dias_restantes)}</span></td>
          <td class="actions"><button class="btn-icon wa" title="Saludar" data-wa-cumple="${esc(x.tipo)}|${esc(x.nombre)}">${ICONO_WA}</button></td></tr>`;
        })
        .join("")
    : vacio(4, "Sin cumpleaños próximos");
}

// Acciones compartidas (tablero, avisos, etc.)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.cobrar) abrirCobro(Number(b.dataset.cobrar), b.dataset.periodo);
  if (b.dataset.recibo) verRecibo(Number(b.dataset.recibo));
  if (b.dataset.waRecordar) await avisoRecordatorio(Number(b.dataset.waRecordar));
  if (b.dataset.waDeuda) await avisoDeuda(Number(b.dataset.waDeuda));
  if (b.dataset.waFin) await avisoFinContrato(Number(b.dataset.waFin));
  if (b.dataset.waCumple) await avisoCumple(b.dataset.waCumple);
  if (b.dataset.waEnviar) {
    const a = avisosCache[Number(b.dataset.waEnviar)];
    if (a && (await enviarWhatsapp(a))) renderAvisos();
  }
});

// ---------- mensajes de aviso ----------

function datosRecordatorio(c) {
  const mes = periodoSugerido(c);
  const venc = vencimientoDe(mes, c.dia_pago);
  return {
    ...datosBaseMensaje(),
    nombre: primerNombre(c.inquilino_nombre),
    inmueble: c.inmueble_direccion,
    periodo: periodoTitulo(mes).toLowerCase(),
    vencimiento: fmtDate(venc),
    monto: money(c.monto_vigente),
    _periodo: mes,
  };
}

async function avisoRecordatorio(contratoId) {
  const c = byId(state.contratos, contratoId);
  const datos = datosRecordatorio(c);
  await enviarWhatsapp({ telefono: c.inquilino_telefono, nombre: c.inquilino_nombre, contrato_id: c.id, tipo: "recordatorio", referencia: datos._periodo, mensaje: completarPlantilla(cfg("plantilla_recordatorio"), datos) });
}

function datosDeuda(contratoId) {
  const c = byId(state.contratos, contratoId);
  const d = state.dashboard?.deudas.find((x) => x.contrato_id === contratoId);
  if (!c || !d) return null;
  return {
    c,
    d,
    datos: { ...datosBaseMensaje(), nombre: primerNombre(c.inquilino_nombre), inmueble: c.inmueble_direccion, periodos: periodosTexto(d.periodos_impagos).toLowerCase(), monto: money(d.monto_adeudado) },
  };
}

async function avisoDeuda(contratoId) {
  const x = datosDeuda(contratoId);
  if (!x) return;
  await enviarWhatsapp({ telefono: x.c.inquilino_telefono, nombre: x.c.inquilino_nombre, contrato_id: x.c.id, tipo: "deuda", referencia: x.d.periodos_impagos.join(","), mensaje: completarPlantilla(cfg("plantilla_deuda"), x.datos) });
}

async function avisoFinContrato(contratoId) {
  const c = byId(state.contratos, contratoId);
  const datos = { ...datosBaseMensaje(), nombre: primerNombre(c.inquilino_nombre), inmueble: c.inmueble_direccion, fecha: fmtDate(c.fecha_fin) };
  await enviarWhatsapp({ telefono: c.inquilino_telefono, nombre: c.inquilino_nombre, contrato_id: c.id, tipo: "vencimiento", referencia: c.fecha_fin, mensaje: completarPlantilla(cfg("plantilla_vencimiento"), datos) });
}

function personaPorTipoNombre(tipo, nombre) {
  const lista = { Propietario: state.propietarios, Inquilino: state.inquilinos, Garante: state.garantes }[tipo] || [];
  return lista.find((p) => p.nombre === nombre);
}

async function avisoCumple(clave) {
  const [tipo, nombre] = clave.split("|");
  const p = personaPorTipoNombre(tipo, nombre);
  await enviarWhatsapp({ telefono: p?.telefono, nombre, tipo: "cumple", referencia: `${tipo}:${nombre}:${hoyIso().slice(0, 4)}`, mensaje: completarPlantilla(cfg("plantilla_cumple"), { ...datosBaseMensaje(), nombre: primerNombre(nombre) }) });
}

// ---------- AVISOS (vista) ----------

let avisosTab = "recordatorio";
let avisosCache = [];

function calcularAvisos() {
  const hoy = hoyIso();
  const diasAntes = Number(cfg("aviso_dias_antes")) || 5;
  const grupos = { recordatorio: [], deuda: [], aumento: [], vencimiento: [], cumple: [] };

  // Recordatorio de pago: el período del mes todavía sin pagar y por vencer
  for (const c of contratosActivos()) {
    const mes = hoy.slice(0, 7);
    if (c.fecha_inicio.slice(0, 7) > mes || c.fecha_fin.slice(0, 7) < mes) continue;
    if (pagoDelPeriodo(c.id, mes)) continue;
    const venc = vencimientoDe(mes, c.dia_pago);
    const dd = diasEntre(hoy, venc);
    if (dd < 0 || dd > diasAntes) continue;
    const datos = datosRecordatorio(c);
    grupos.recordatorio.push({
      contrato_id: c.id, tipo: "recordatorio", referencia: mes, telefono: c.inquilino_telefono, nombre: c.inquilino_nombre,
      detalle: `${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">Vence ${fmtDate(venc)} (${diasTexto(dd)}) · ${money(c.monto_vigente)}</span>`,
      mensaje: completarPlantilla(cfg("plantilla_recordatorio"), datos),
    });
  }
  // Deudas
  for (const d of state.dashboard?.deudas || []) {
    const x = datosDeuda(d.contrato_id);
    if (!x) continue;
    grupos.deuda.push({
      contrato_id: x.c.id, tipo: "deuda", referencia: d.periodos_impagos.join(","), telefono: x.c.inquilino_telefono, nombre: x.c.inquilino_nombre,
      detalle: `${codHtml(x.c.inmueble_codigo)}${esc(x.c.inmueble_direccion)}<span class="sub-line">${periodosTexto(d.periodos_impagos)} · <b>${money(d.monto_adeudado)}</b></span>`,
      mensaje: completarPlantilla(cfg("plantilla_deuda"), x.datos),
    });
  }
  // Aumentos ya cargados que rigen desde hace poco o en breve
  for (const c of contratosActivos()) {
    if (!c.ultima_actualizacion_fecha || c.monto_anterior == null) continue;
    const dd = diasEntre(hoy, c.ultima_actualizacion_fecha);
    if (dd < -25 || dd > 40) continue;
    const nuevo = c.ultima_actualizacion_monto;
    const pct = c.monto_anterior ? (nuevo / c.monto_anterior - 1) * 100 : 0;
    const datos = {
      ...datosBaseMensaje(), nombre: primerNombre(c.inquilino_nombre), inmueble: c.inmueble_direccion, fecha: fmtDate(c.ultima_actualizacion_fecha),
      indice: nombreIndice(c.tipo_actualizacion), porcentaje: `${pct >= 0 ? "+" : ""}${numero(pct)}%`, monto: money(nuevo),
    };
    grupos.aumento.push({
      contrato_id: c.id, tipo: "aumento", referencia: c.ultima_actualizacion_fecha, telefono: c.inquilino_telefono, nombre: c.inquilino_nombre,
      detalle: `${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">Desde ${fmtDate(c.ultima_actualizacion_fecha)}: ${money(c.monto_anterior)} → <b>${datos.monto}</b> (${datos.porcentaje})</span>`,
      mensaje: completarPlantilla(cfg("plantilla_aumento"), datos),
    });
  }
  // Fin de contrato (60 días)
  for (const v of state.dashboard?.vencimientos || []) {
    if (v.dias_restantes > 60) continue;
    const c = byId(state.contratos, v.contrato_id);
    grupos.vencimiento.push({
      contrato_id: c.id, tipo: "vencimiento", referencia: c.fecha_fin, telefono: c.inquilino_telefono, nombre: c.inquilino_nombre,
      detalle: `${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">Vence ${fmtDate(c.fecha_fin)} (${diasTexto(v.dias_restantes)})</span>`,
      mensaje: completarPlantilla(cfg("plantilla_vencimiento"), { ...datosBaseMensaje(), nombre: primerNombre(c.inquilino_nombre), inmueble: c.inmueble_direccion, fecha: fmtDate(c.fecha_fin) }),
    });
  }
  // Cumpleaños (hoy y mañana)
  for (const x of state.dashboard?.cumpleanos_proximos || []) {
    if (x.dias_restantes > 1) continue;
    const p = personaPorTipoNombre(x.tipo, x.nombre);
    grupos.cumple.push({
      contrato_id: null, tipo: "cumple", referencia: `${x.tipo}:${x.nombre}:${x.proximo_cumple.slice(0, 4)}`, telefono: p?.telefono, nombre: x.nombre,
      detalle: `${esc(x.tipo)}<span class="sub-line">Cumple ${x.edad_cumple} años ${diasTexto(x.dias_restantes)}</span>`,
      mensaje: completarPlantilla(cfg("plantilla_cumple"), { ...datosBaseMensaje(), nombre: primerNombre(x.nombre) }),
    });
  }
  for (const lista of Object.values(grupos)) {
    for (const a of lista) {
      a.enviado = ultimoAviso(a.contrato_id, a.tipo, a.referencia);
      a.telValido = !!telefonoWhatsapp(a.telefono, cfg("wa_codigo_area"));
    }
  }
  return grupos;
}

function nombreIndice(t) {
  return { ICL: "ICL (BCRA)", IPC: "IPC (INDEC)", porcentaje_fijo: "porcentaje fijo", casa_propia: "índice Casa Propia", otro: "lo pactado" }[t] || t;
}

const TABS_AVISOS = [
  ["recordatorio", "Recordatorio de pago"],
  ["deuda", "Pagos atrasados"],
  ["aumento", "Aumentos"],
  ["vencimiento", "Fin de contrato"],
  ["cumple", "Cumpleaños"],
];

function renderAvisos() {
  const grupos = calcularAvisos();
  $("avisos-tabs").innerHTML = TABS_AVISOS.map(([k, label]) => {
    const pend = grupos[k].filter((a) => !a.enviado).length;
    return `<button class="tab ${k === avisosTab ? "active" : ""}" data-avisos-tab="${k}">${label} <span class="cnt">${pend}/${grupos[k].length}</span></button>`;
  }).join("");
  const lista = grupos[avisosTab];
  avisosCache = lista;
  const ayuda = {
    recordatorio: `Inquilinos con el alquiler de este mes sin pagar que vence en los próximos ${cfg("aviso_dias_antes")} días.`,
    deuda: "Inquilinos con meses vencidos sin pagar (con los intereses calculados a hoy).",
    aumento: "Contratos con un aumento cargado recientemente o que rige en los próximos días. Cargá los aumentos desde «Aumentos IPC / ICL».",
    vencimiento: "Contratos que vencen en los próximos 60 días.",
    cumple: "Cumpleaños de hoy y mañana de propietarios, inquilinos y garantes.",
  }[avisosTab];
  $("avisos-lista").innerHTML = `<p class="hint">${ayuda}</p>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Destinatario</th><th>Detalle</th><th>Mensaje</th><th></th></tr></thead><tbody>${
      lista.length
        ? lista
            .map(
              (a, i) => `<tr><td><b>${esc(a.nombre)}</b><span class="sub-line">${esc(a.telefono || "sin teléfono")}</span></td>
          <td>${a.detalle}</td>
          <td><div class="aviso-row-msg">${esc(a.mensaje)}</div></td>
          <td class="actions">${a.enviado ? `<div class="aviso-enviado">✓ Enviado ${fmtDate(a.enviado.fecha)}${a.enviado.usuario ? " · " + esc(a.enviado.usuario.split(" ")[0]) : ""}</div>` : ""}
            ${a.telValido ? `<button class="btn-whatsapp btn-sm" data-wa-enviar="${i}">${ICONO_WA} ${a.enviado ? "Reenviar" : "Enviar"}</button>` : `<span class="pill pill-danger">Falta teléfono</span>`}</td></tr>`
            )
            .join("")
        : vacio(4, "No hay avisos para enviar 🎉")
    }</tbody></table></div>`;
}

$("avisos-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-avisos-tab]");
  if (!t) return;
  avisosTab = t.dataset.avisosTab;
  renderAvisos();
});

function actualizarBadges() {
  try {
    const g = calcularAvisos();
    const pend = g.recordatorio.filter((a) => !a.enviado).length + g.deuda.filter((a) => !a.enviado).length;
    $("badge-avisos").textContent = pend;
    $("badge-avisos").classList.toggle("hidden", !pend);
    const hoy = hoyIso();
    const aum = contratosActivos().filter((c) => c.proxima_actualizacion && diasEntre(hoy, c.proxima_actualizacion) <= 15 && c.proxima_actualizacion <= c.fecha_fin).length;
    $("badge-aumentos").textContent = aum;
    $("badge-aumentos").classList.toggle("hidden", !aum);
  } catch (e) {
    console.error(e);
  }
}

// ---------- PERSONAS (propietarios, inquilinos, garantes) ----------

const PERSONA = {
  propietarios: { singular: "propietario", cmd: "guardar_propietario", arg: "propietario", del: "eliminar_propietario" },
  inquilinos: { singular: "inquilino", cmd: "guardar_inquilino", arg: "inquilino", del: "eliminar_inquilino" },
  garantes: { singular: "garante", cmd: "guardar_garante", arg: "garante", del: "eliminar_garante" },
};

function personaFields(tabla) {
  const f = [
    { type: "section", label: "Datos personales" },
    { name: "nombre", label: "Apellido y nombres", required: true, full: true, placeholder: "Ej: VILLALBA ENZO SANTIAGO" },
    { name: "dni_cuit", label: "DNI" },
    { name: "cuit_cuil", label: "CUIT / CUIL" },
    { name: "sexo", label: "Sexo", type: "select", blank: "—", options: [{ value: "M", label: "Masculino" }, { value: "F", label: "Femenino" }, { value: "X", label: "X" }] },
    { name: "fecha_nacimiento", label: "Fecha de nacimiento", type: "date" },
    { name: "nacionalidad", label: "Nacionalidad", default: "ARGENTINA" },
    { name: "estado_civil", label: "Estado civil", type: "select", blank: "—", options: ["Soltero/a", "Casado/a", "Divorciado/a", "Viudo/a", "Unión convivencial"].map((x) => ({ value: x, label: x })) },
    { name: "profesion", label: tabla === "propietarios" ? "Profesión" : "Profesión / lugar de trabajo", full: true },
    { type: "section", label: "Contacto" },
    { name: "telefono", label: "Teléfono / WhatsApp", hint: "Con característica, ej: 3468 563371" },
    { name: "email", label: "Email", type: "email" },
    { name: "direccion", label: "Domicilio" },
    { name: "localidad", label: "Localidad", default: cfg("inmobiliaria_localidad") },
  ];
  if (tabla === "propietarios") {
    f.push({ type: "section", label: "Para transferirle" }, { name: "datos_bancarios", label: "Datos bancarios", type: "textarea", full: true, placeholder: "Banco, titular, CBU, alias" });
  }
  if (tabla === "garantes") {
    f.push(
      { type: "section", label: "Garantía" },
      { name: "tipo_garantia", label: "Tipo de garantía", type: "select", blank: "—", options: ["Propietaria (inmueble)", "Recibo de sueldo", "Seguro de caución", "Otra"].map((x) => ({ value: x, label: x })) },
      { name: "detalle_garantia", label: "Detalle", type: "textarea", placeholder: "Inmueble y matrícula, empleador, póliza…" }
    );
  }
  f.push({ name: "notas", label: "Notas", type: "textarea", full: true });
  return f;
}

function renderPersonas(tabla) {
  const tbody = $(`tbl-${tabla}`);
  const lista = state[tabla];
  if (!lista.length) {
    tbody.innerHTML = vacio(6, `No hay ${tabla} cargados`);
    return;
  }
  tbody.innerHTML = lista
    .map((p) => {
      let vinc = "";
      if (tabla === "propietarios") {
        const inm = state.inmuebles.filter((i) => i.propietario_id === p.id);
        vinc = inm.length ? inm.map((i) => `${codHtml(i.codigo)}${esc(i.direccion)}`).join("<br/>") : '<span class="muted">—</span>';
      } else if (tabla === "inquilinos") {
        const cs = state.contratos.filter((c) => c.inquilino_id === p.id && c.estado === "activo");
        vinc = cs.length ? cs.map((c) => `${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}`).join("<br/>") : '<span class="muted">sin contrato activo</span>';
      } else {
        const cs = state.contratos.filter((c) => c.garante_ids.includes(p.id) && c.estado === "activo");
        vinc = cs.length ? cs.map((c) => esc(c.inquilino_nombre)).join("<br/>") : '<span class="muted">—</span>';
      }
      const doc = [p.dni_cuit, p.cuit_cuil].filter(Boolean).map(esc).join("<span class='sub-line'>") + (p.dni_cuit && p.cuit_cuil ? "</span>" : "");
      const cols =
        tabla === "garantes"
          ? `<td>${esc(p.nombre)}${p.tiene_fotos_dni ? ' <span class="pill pill-gold" title="DNI escaneado">DNI</span>' : ""}</td><td>${doc}</td><td>${esc(p.telefono)}</td><td>${esc(p.tipo_garantia || "-")}</td><td>${vinc}</td>`
          : `<td>${esc(p.nombre)}${p.tiene_fotos_dni ? ' <span class="pill pill-gold" title="DNI escaneado">DNI</span>' : ""}</td><td>${doc}</td><td>${esc(p.telefono)}</td><td>${esc(p.email)}</td><td>${vinc}</td>`;
      return `<tr>${cols}<td class="actions">
        ${p.telefono ? `<button class="btn-icon wa" title="Abrir chat" data-chat="${tabla}:${p.id}">${ICONO_WA}</button>` : ""}
        <button class="btn-link" data-edit-persona="${tabla}:${p.id}">Editar</button>
        <button class="btn-link peligro" data-del-persona="${tabla}:${p.id}">Eliminar</button></td></tr>`;
    })
    .join("");
  aplicarBusqueda(`tbl-${tabla}`);
}

document.querySelectorAll("[data-nueva-persona]").forEach((b) => b.addEventListener("click", () => abrirPersona(b.dataset.nuevaPersona)));
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.editPersona) {
    const [tabla, id] = b.dataset.editPersona.split(":");
    abrirPersona(tabla, Number(id));
  }
  if (b.dataset.delPersona) {
    const [tabla, id] = b.dataset.delPersona.split(":");
    if (!confirm(`¿Eliminar este ${PERSONA[tabla].singular}? No se puede si tiene contratos o inmuebles asociados.`)) return;
    await call(PERSONA[tabla].del, { id: Number(id) });
    toast("Eliminado");
    await loadAll();
  }
  if (b.dataset.chat) {
    const [tabla, id] = b.dataset.chat.split(":");
    const p = byId(state[tabla], Number(id));
    const tel = telefonoWhatsapp(p?.telefono, cfg("wa_codigo_area"));
    if (tel) await call("abrir_enlace", { url: `https://wa.me/${tel}` });
    else toast("El teléfono cargado no parece válido", true);
  }
});

/** Abre la ficha de una persona. Devuelve una promesa con el id guardado (o null). */
function abrirPersona(tabla, id = null, valoresIniciales = {}) {
  return new Promise((resolve) => {
    const meta = PERSONA[tabla];
    const actual = id ? byId(state[tabla], id) : null;
    const fotos = { frente: undefined, dorso: undefined }; // undefined = sin cambios
    const dniBox = `
      <div class="dni-box">
        <div class="dni-box-top"><b>📷 Cargar desde el DNI</b><small class="muted">Arrastrá, hacé clic o pegá (Ctrl+V) la foto. Se leen los datos del código de barras.</small></div>
        <div class="dni-fotos">
          <div class="dni-slot" data-lado="frente"><span>Frente del DNI</span></div>
          <div class="dni-slot" data-lado="dorso"><span>Dorso del DNI</span></div>
        </div>
        <div class="dni-codigo"><input type="text" id="dni-texto" placeholder="…o pegá acá el texto leído con un lector de códigos (ej. 00123456789@PEREZ@JUAN@M@…)" /><button type="button" class="btn-secondary btn-sm" id="dni-interpretar">Usar texto</button></div>
        <div class="dni-estado" id="dni-estado"></div>
        <input type="file" id="dni-file" accept="image/*" class="hidden" />
      </div>`;
    const fields = personaFields(tabla);
    let ladoPendiente = "frente";
    openModal({
      title: id ? `Editar ${meta.singular}` : `Nuevo ${meta.singular}`,
      size: "wide",
      cols: "cuatro",
      before: dniBox,
      fields: fields.map((f) => ({ ...f, full: f.full || f.type === "textarea" })),
      values: { ...(actual || {}), ...valoresIniciales },
      onMount: () => {
        const estado = $("dni-estado");
        const pintarSlot = (lado, src) => {
          const slot = modalBody.querySelector(`.dni-slot[data-lado="${lado}"]`);
          slot.innerHTML = src
            ? `<img src="${src}" alt=""/><button type="button" class="dni-slot-quitar" data-quitar="${lado}">Quitar</button><button type="button" class="dni-slot-ver" data-ver="${lado}">Ver</button>`
            : `<span>${lado === "frente" ? "Frente" : "Dorso"} del DNI</span>`;
        };
        const aplicar = (d) => {
          const set = (name, val) => {
            const el = $(`f-${name}`);
            if (el && val) el.value = val;
          };
          set("nombre", d.nombre_completo);
          set("dni_cuit", d.dni);
          set("cuit_cuil", d.cuil);
          set("sexo", d.sexo);
          set("fecha_nacimiento", d.fecha_nacimiento);
          set("nacionalidad", d.nacionalidad);
          estado.className = "dni-estado ok";
          estado.textContent = `✓ Datos leídos: ${d.nombre_completo} — DNI ${d.dni}${d.cuil ? " — CUIL " + d.cuil : ""}. Revisalos y completá el resto.`;
        };
        const procesar = async (lado, blob) => {
          estado.className = "dni-estado";
          estado.textContent = "Leyendo la foto…";
          try {
            fotos[lado] = await comprimirFoto(blob);
            pintarSlot(lado, fotos[lado]);
            const texto = await leerCodigoDni(blob);
            const d = interpretarCodigoDni(texto);
            if (d) aplicar(d);
            else {
              estado.className = "dni-estado err";
              estado.textContent = texto
                ? "Se leyó un código pero no tiene el formato del DNI. Cargá los datos a mano."
                : "La foto quedó guardada, pero no se pudo leer el código de barras. Probá con una foto más nítida, de frente y sin reflejos (el código es el rectángulo de rayitas), o cargá los datos a mano.";
            }
          } catch (err) {
            console.error(err);
            estado.className = "dni-estado err";
            estado.textContent = "No se pudo procesar la imagen.";
          }
        };
        const fileInput = $("dni-file");
        modalBody.querySelectorAll(".dni-slot").forEach((slot) => {
          slot.addEventListener("click", (ev) => {
            if (ev.target.dataset.quitar) {
              fotos[ev.target.dataset.quitar] = null;
              pintarSlot(ev.target.dataset.quitar, null);
              return;
            }
            if (ev.target.dataset.ver) {
              const src = fotos[ev.target.dataset.ver];
              if (src) openPrint(`<div style="padding:10px;max-width:900px"><img src="${src}" style="max-width:100%;display:block"></div>`, { titulo: "DNI" });
              return;
            }
            ladoPendiente = slot.dataset.lado;
            fileInput.click();
          });
          slot.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            slot.classList.add("drag");
          });
          slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
          slot.addEventListener("drop", (ev) => {
            ev.preventDefault();
            slot.classList.remove("drag");
            const f = ev.dataTransfer.files[0];
            if (f) procesar(slot.dataset.lado, f);
          });
        });
        fileInput.addEventListener("change", () => {
          if (fileInput.files[0]) procesar(ladoPendiente, fileInput.files[0]);
          fileInput.value = "";
        });
        const onPaste = (ev) => {
          const item = Array.from(ev.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
          if (!item) return;
          ev.preventDefault();
          const lado = !fotos.frente && !modalBody.querySelector('.dni-slot[data-lado="frente"] img') ? "frente" : "dorso";
          procesar(lado, item.getAsFile());
        };
        document.addEventListener("paste", onPaste);
        modalCleanup = () => document.removeEventListener("paste", onPaste);
        $("dni-interpretar").addEventListener("click", () => {
          const d = interpretarCodigoDni($("dni-texto").value);
          if (d) aplicar(d);
          else {
            estado.className = "dni-estado err";
            estado.textContent = "El texto no tiene el formato del código del DNI.";
          }
        });
        $("dni-texto").addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            $("dni-interpretar").click();
          }
        });
        if (actual?.tiene_fotos_dni) {
          invoke("get_fotos_dni", { tabla, id }).then((f) => {
            if (f?.dni_frente && fotos.frente === undefined) pintarSlot("frente", f.dni_frente);
            if (f?.dni_dorso && fotos.dorso === undefined) pintarSlot("dorso", f.dni_dorso);
            if (f) {
              fotos._frenteOriginal = f.dni_frente;
              fotos._dorsoOriginal = f.dni_dorso;
            }
          });
        }
      },
      onSave: async (values) => {
        const datos = { id, ...values };
        if (fotos.frente !== undefined) datos.dni_frente = fotos.frente;
        if (fotos.dorso !== undefined) datos.dni_dorso = fotos.dorso;
        const nuevoId = await call(meta.cmd, { [meta.arg]: datos });
        toast(`${meta.singular.charAt(0).toUpperCase() + meta.singular.slice(1)} guardado`);
        await loadAll();
        resolve(nuevoId);
      },
    });
    const prevCleanup = modalCleanup;
    modalCleanup = () => {
      if (prevCleanup) prevCleanup();
      resolve(null);
    };
  });
}

// ---------- INMUEBLES ----------

function inmuebleFields() {
  const siguienteCodigo = Math.max(0, ...state.inmuebles.map((i) => Number(i.codigo) || 0)) + 1;
  return [
    { type: "section", label: "Ubicación" },
    { name: "codigo", label: "Código de propiedad", type: "number", nullable: true, default: siguienteCodigo, hint: "Número que aparece en el recibo" },
    { name: "propietario_id", label: "Propietario", type: "select", required: true, numeric: true, doble: true, blank: "Elegí…", options: state.propietarios.map((p) => ({ value: p.id, label: p.nombre })) },
    { name: "estado", label: "Estado (si no está alquilado)", type: "select", options: ["Disponible", "En refacción", "Reservado", "No disponible"].map((x) => ({ value: x, label: x })) },
    { name: "direccion", label: "Calle y número", required: true, doble: true, placeholder: "Ej: DORREGO N°806" },
    { name: "piso_depto", label: "Piso / Depto / Lote", placeholder: "Ej: PB A" },
    { name: "codigo_postal", label: "Código postal", default: "2645" },
    { name: "localidad", label: "Localidad", default: cfg("inmobiliaria_localidad"), doble: true },
    { name: "provincia", label: "Provincia", default: "Córdoba", doble: true },
    { type: "section", label: "Características" },
    { name: "tipo", label: "Tipo", type: "select", options: ["Casa", "Departamento", "Dúplex", "Local comercial", "Oficina", "Galpón / depósito", "Cochera", "Terreno", "Campo", "Otro"].map((x) => ({ value: x, label: x })) },
    { name: "destino", label: "Destino", type: "select", options: ["Vivienda", "Comercial", "Mixto", "Rural"].map((x) => ({ value: x, label: x })) },
    { name: "superficie", label: "Sup. terreno (m²)", type: "number", nullable: true },
    { name: "superficie_cubierta", label: "Sup. cubierta (m²)", type: "number", nullable: true },
    { name: "ambientes", label: "Ambientes", type: "number", nullable: true },
    { name: "dormitorios", label: "Dormitorios", type: "number", nullable: true },
    { name: "banos", label: "Baños", type: "number", nullable: true },
    { type: "html", html: "<div></div>" },
    { name: "cochera", label: "Cochera", type: "checkbox" },
    { name: "patio", label: "Patio", type: "checkbox" },
    { name: "amoblado", label: "Amoblado", type: "checkbox" },
    { type: "html", html: "<div></div>" },
    { type: "section", label: "Datos catastrales e impuestos" },
    { name: "nomenclatura_catastral", label: "Nomenclatura catastral", doble: true },
    { name: "cuenta_rentas", label: "N° cuenta Rentas", hint: "Impuesto inmobiliario" },
    { name: "cuenta_municipal", label: "N° cuenta municipal", hint: "Tasa municipal" },
    { name: "matricula", label: "Matrícula / Folio", doble: true },
    { type: "html", html: "<div></div><div></div>" },
    { type: "section", label: "Servicios" },
    { name: "servicio_luz", label: "Luz (N° de cliente)" },
    { name: "servicio_agua", label: "Agua (N° de cuenta)" },
    { name: "servicio_gas", label: "Gas (N° de cuenta)" },
    { name: "llaves", label: "Llaves", placeholder: "¿Dónde están? ¿cuántas copias?" },
    { name: "notas", label: "Notas", type: "textarea", full: true },
  ];
}

function contratoActivoDe(inmuebleId) {
  return state.contratos.find((c) => c.inmueble_id === inmuebleId && c.estado === "activo");
}

function renderInmuebles() {
  const tbody = $("tbl-inmuebles");
  if (!state.inmuebles.length) {
    tbody.innerHTML = vacio(7, "No hay inmuebles cargados");
    return;
  }
  tbody.innerHTML = [...state.inmuebles]
    .sort((a, b) => (Number(a.codigo) || 1e9) - (Number(b.codigo) || 1e9) || a.direccion.localeCompare(b.direccion))
    .map((i) => {
      const c = contratoActivoDe(i.id);
      const estado = c ? `<span class="pill pill-ok">Alquilado</span><span class="sub-line">${esc(c.inquilino_nombre)}</span>` : `<span class="pill ${i.estado === "Disponible" || !i.estado ? "pill-info" : "pill-gris"}">${esc(i.estado || "Disponible")}</span>`;
      const det = [i.dormitorios ? `${i.dormitorios} dorm.` : "", i.banos ? `${i.banos} baño${i.banos > 1 ? "s" : ""}` : "", i.superficie_cubierta ? `${i.superficie_cubierta} m² cub.` : i.superficie ? `${i.superficie} m²` : "", i.cochera ? "cochera" : ""].filter(Boolean).join(" · ");
      return `<tr><td>${codHtml(i.codigo)}</td><td>${esc(i.direccion)}${i.piso_depto ? " " + esc(i.piso_depto) : ""}<span class="sub-line">${esc(i.localidad || "")}</span></td>
      <td>${esc(i.tipo || "-")}<span class="sub-line">${esc(i.destino || "")}</span></td><td>${det || '<span class="muted">-</span>'}</td>
      <td>${esc(i.propietario_nombre)}</td><td>${estado}</td>
      <td class="actions"><button class="btn-link" data-action="edit-inmueble" data-id="${i.id}">Editar</button><button class="btn-link peligro" data-action="del-inmueble" data-id="${i.id}">Eliminar</button></td></tr>`;
    })
    .join("");
  aplicarBusqueda("tbl-inmuebles");
}

function abrirInmueble(id = null) {
  const actual = id ? byId(state.inmuebles, id) : null;
  return new Promise((resolve) => {
    openModal({
      title: id ? "Editar inmueble" : "Nuevo inmueble",
      size: "wide",
      cols: "cuatro",
      fields: inmuebleFields(),
      values: actual || {},
      onMount: () => {
        if (!state.propietarios.length) modalInfo.innerHTML = "Primero cargá al menos un propietario.";
      },
      onSave: async (values) => {
        const nuevoId = await call("guardar_inmueble", { inmueble: { id, ...values } });
        toast("Inmueble guardado");
        await loadAll();
        resolve(nuevoId);
      },
    });
  });
}

$("btn-nuevo-inmueble").addEventListener("click", () => {
  if (!state.propietarios.length) return toast("Primero cargá al menos un propietario", true);
  abrirInmueble();
});
$("tbl-inmuebles").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "edit-inmueble") abrirInmueble(id);
  if (btn.dataset.action === "del-inmueble" && confirm("¿Eliminar este inmueble? No se puede si tiene contratos.")) {
    await call("eliminar_inmueble", { id });
    toast("Inmueble eliminado");
    await loadAll();
  }
});

// ---------- CONTRATOS ----------

const TIPOS_ACTUALIZACION = [
  { value: "IPC", label: "IPC (INDEC)" },
  { value: "ICL", label: "ICL (BCRA)" },
  { value: "porcentaje_fijo", label: "Porcentaje fijo" },
  { value: "casa_propia", label: "Índice Casa Propia (a mano)" },
  { value: "otro", label: "Otro / a convenir (a mano)" },
];

function contratoFields() {
  return [
    { type: "section", label: "Partes" },
    { name: "numero", label: "N° de contrato", type: "number", nullable: true, hint: "Vacío = el siguiente automático" },
    { name: "inmueble_id", label: "Propiedad", type: "select", required: true, numeric: true, doble: true, blank: "Elegí…", options: [...state.inmuebles].sort((a, b) => (a.codigo || 1e9) - (b.codigo || 1e9)).map((i) => ({ value: i.id, label: `${i.codigo != null ? i.codigo + " - " : ""}${i.direccion} (${i.propietario_nombre})` })) },
    { name: "estado", label: "Estado", type: "select", options: [{ value: "activo", label: "Activo" }, { value: "finalizado", label: "Finalizado" }, { value: "rescindido", label: "Rescindido" }] },
    { name: "inquilino_id", label: "Inquilino", type: "select", required: true, numeric: true, doble: true, blank: "Elegí…", options: state.inquilinos.map((i) => ({ value: i.id, label: i.nombre })) },
    { type: "html", html: `<div class="form-field doble" style="justify-content:flex-end"><div style="display:flex;gap:8px"><button type="button" class="btn-secondary btn-sm" id="c-nuevo-inq">+ Nuevo inquilino</button><button type="button" class="btn-secondary btn-sm" id="c-nuevo-gar">+ Nuevo garante</button></div></div>` },
    { name: "garante_ids", label: "Garantes", type: "checkbox-group", full: true, options: state.garantes.map((g) => ({ value: g.id, label: `${g.nombre}${g.tipo_garantia ? " — " + g.tipo_garantia : ""}` })) },
    { type: "section", label: "Plazo y precio" },
    { name: "fecha_inicio", label: "Inicio", type: "date", required: true },
    { name: "fecha_fin", label: "Vencimiento", type: "date", required: true, hint: "Tip: elegí duración ↓" },
    { type: "html", html: `<div class="form-field"><label>Duración</label><select id="c-duracion"><option value="">—</option><option value="12">12 meses</option><option value="24">24 meses</option><option value="36">36 meses</option></select></div>` },
    { name: "destino", label: "Destino", type: "select", options: ["Vivienda", "Comercial", "Mixto"].map((x) => ({ value: x, label: x })) },
    { name: "monto_inicial", label: "Alquiler inicial ($)", type: "number", required: true },
    { name: "dia_pago", label: "Paga hasta el día", type: "number", default: 10, required: true, hint: "Desde el día siguiente corren intereses" },
    { name: "deposito_garantia", label: "Depósito en garantía ($)", type: "number" },
    { name: "comision_porcentaje", label: "Honorarios administración (%)", type: "number", hint: "Se descuenta al liquidar al propietario" },
    { type: "section", label: "Actualización del alquiler" },
    { name: "tipo_actualizacion", label: "Índice", type: "select", options: TIPOS_ACTUALIZACION },
    { name: "frecuencia_actualizacion_meses", label: "Cada (meses)", type: "select", numeric: true, options: [1, 2, 3, 4, 6, 12].map((x) => ({ value: x, label: `${x} ${x === 1 ? "mes" : "meses"}` })) },
    { name: "porcentaje_actualizacion", label: "% fijo (si corresponde)", type: "number" },
    { type: "html", html: "<div></div>" },
    { type: "section", label: "Atrasos" },
    { name: "tasa_mora_diaria", label: "Interés por día de atraso (%)", type: "number", hint: "Ej: 0,5 = medio por ciento diario" },
    { name: "multa_diaria", label: "Multa por día de atraso ($)", type: "number", hint: "Monto fijo por día (opcional)" },
    { type: "html", html: "<div></div><div></div>" },
    { type: "section", label: "Conceptos que se cobran todos los meses además del alquiler" },
    { name: "conceptos_fijos", label: "", type: "lineas" },
    { name: "notas", label: "Notas", type: "textarea", full: true },
  ];
}

function renderContratos() {
  const tbody = $("tbl-contratos");
  const filtro = $("filtro-contratos").value;
  const lista = state.contratos.filter((c) => !filtro || c.estado === filtro).sort((a, b) => (b.numero || 0) - (a.numero || 0));
  if (!lista.length) {
    tbody.innerHTML = vacio(8, "No hay contratos");
    return;
  }
  const hoy = hoyIso();
  tbody.innerHTML = lista
    .map((c) => {
      const dFin = diasEntre(hoy, c.fecha_fin);
      const pill = c.estado !== "activo" ? `<span class="pill pill-finalizado">${esc(c.estado)}</span>` : dFin < 0 ? `<span class="pill pill-danger">Vencido</span>` : dFin <= 60 ? `<span class="pill pill-warning">Vence ${diasTexto(dFin)}</span>` : `<span class="pill pill-ok">Activo</span>`;
      const dAct = c.proxima_actualizacion ? diasEntre(hoy, c.proxima_actualizacion) : null;
      return `<tr>
      <td><b>${esc(c.numero ?? "-")}</b></td>
      <td>${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}</td>
      <td>${esc(c.inquilino_nombre)}<span class="sub-line">Prop.: ${esc(c.propietario_nombre)}${c.garantes.length ? " · Gar.: " + c.garantes.map(esc).join(", ") : ""}</span></td>
      <td>${fmtDate(c.fecha_inicio)} → ${fmtDate(c.fecha_fin)}</td>
      <td class="num"><b>${money(c.monto_vigente)}</b></td>
      <td>${esc(nombreIndice(c.tipo_actualizacion))} c/${c.frecuencia_actualizacion_meses}m${c.estado === "activo" && c.proxima_actualizacion && c.proxima_actualizacion <= c.fecha_fin ? `<span class="sub-line">próx. ${fmtDate(c.proxima_actualizacion)}${dAct != null && dAct <= 15 ? " ⚠" : ""}</span>` : ""}</td>
      <td>${pill}</td>
      <td class="actions">
        <button class="btn-link" data-action="ver-actualizaciones" data-id="${c.id}">Aumentos</button>
        <button class="btn-link" data-action="edit-contrato" data-id="${c.id}">Editar</button>
        <button class="btn-link peligro" data-action="del-contrato" data-id="${c.id}">Eliminar</button>
      </td></tr>`;
    })
    .join("");
  aplicarBusqueda("tbl-contratos");
}
$("filtro-contratos").addEventListener("change", renderContratos);

function abrirContrato(id = null) {
  const c = id ? byId(state.contratos, id) : null;
  const valores = c
    ? { ...c, garante_ids: c.garante_ids ?? [] }
    : { dia_pago: 10, tipo_actualizacion: "IPC", frecuencia_actualizacion_meses: 3, estado: "activo", destino: "Vivienda", comision_porcentaje: 10, conceptos_fijos: [] };
  openModal({
    title: id ? `Editar contrato N° ${c.numero ?? c.id}` : "Nuevo contrato",
    size: "wide",
    cols: "cuatro",
    fields: contratoFields(),
    values: valores,
    onMount: () => {
      $("c-duracion").addEventListener("change", (e) => {
        const ini = $("f-fecha_inicio").value;
        const m = Number(e.target.value);
        if (!ini || !m) return;
        const [y, mo, d] = ini.split("-").map(Number);
        const fin = new Date(y, mo - 1 + m, d - 1);
        $("f-fecha_fin").value = `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, "0")}-${String(fin.getDate()).padStart(2, "0")}`;
      });
      // Alta rápida de inquilino / garante sin cerrar el contrato: se guarda
      // lo cargado hasta ahora y se vuelve a abrir el contrato al terminar.
      const altaRapida = async (tabla) => {
        let borrador;
        try {
          borrador = leerCamposSinValidar(contratoFields());
        } catch {
          borrador = {};
        }
        const nuevoId = await abrirPersona(tabla);
        abrirContrato(id);
        setTimeout(() => {
          for (const [k, v] of Object.entries(borrador)) {
            const el = $(`f-${k}`);
            if (el && v != null && !Array.isArray(v) && el.type !== "checkbox") el.value = v;
          }
          if (nuevoId && tabla === "inquilinos") $("f-inquilino_id").value = nuevoId;
          const gar = new Set([...(borrador.garante_ids || []), ...(nuevoId && tabla === "garantes" ? [nuevoId] : [])]);
          document.querySelectorAll("#f-garante_ids input").forEach((i) => (i.checked = gar.has(Number(i.value))));
        }, 0);
      };
      $("c-nuevo-inq").addEventListener("click", () => altaRapida("inquilinos"));
      $("c-nuevo-gar").addEventListener("click", () => altaRapida("garantes"));
    },
    onSave: async (values) => {
      if (values.fecha_fin <= values.fecha_inicio) throw new Error("El vencimiento tiene que ser posterior al inicio");
      await call("guardar_contrato", { contrato: { id, ...values } });
      toast("Contrato guardado");
      await loadAll();
    },
  });
}

function leerCamposSinValidar(fields) {
  return leerCampos(fields.map((f) => ({ ...f, required: false })));
}

$("btn-nuevo-contrato").addEventListener("click", () => {
  if (!state.inmuebles.length) return toast("Primero cargá al menos un inmueble", true);
  abrirContrato();
});

$("tbl-contratos").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "edit-contrato") abrirContrato(id);
  if (btn.dataset.action === "del-contrato" && confirm("¿Eliminar este contrato? No se puede si tiene pagos registrados.")) {
    await call("eliminar_contrato", { id });
    toast("Contrato eliminado");
    await loadAll();
  }
  if (btn.dataset.action === "ver-actualizaciones") abrirActualizaciones(id);
});

async function abrirActualizaciones(contratoId, sugerido = null) {
  const c = byId(state.contratos, contratoId);
  const actualizaciones = await call("get_actualizaciones", { contratoId });
  const render = () => {
    const filas = actualizaciones
      .map((a) => `<tr><td>${fmtDate(a.fecha_vigencia)}</td><td class="num">${money(a.monto_nuevo)}</td><td>${esc(a.motivo)}</td><td class="actions"><button class="btn-link peligro" data-del-act="${a.id}">Eliminar</button></td></tr>`)
      .join("");
    modalBody.innerHTML = `
      <p class="hint">Alquiler inicial: <b>${money(c.monto_inicial)}</b> · Vigente hoy: <b>${money(c.monto_vigente)}</b> · Índice: <b>${esc(nombreIndice(c.tipo_actualizacion))}</b> cada ${c.frecuencia_actualizacion_meses} meses</p>
      <div class="table-wrap" style="margin-bottom:16px"><table class="data-table compact"><thead><tr><th>Rige desde</th><th class="num">Nuevo alquiler</th><th>Motivo</th><th></th></tr></thead>
      <tbody>${filas || vacio(4, "Sin aumentos cargados")}</tbody></table></div>
      <div class="form-section" style="margin-bottom:12px">Cargar aumento</div>
      <div class="form-grid cuatro">
        <div class="form-field"><label>Rige desde</label><input type="date" id="act-fecha" value="${esc(sugerido?.fecha ?? c.proxima_actualizacion ?? "")}" /></div>
        <div class="form-field"><label>Aumento (%)</label><input type="number" id="act-porcentaje" step="any" value="${sugerido ? sugerido.porcentaje.toFixed(2) : ""}" /></div>
        <div class="form-field doble"><label>Nuevo alquiler ($)</label><input type="number" id="act-monto" step="any" value="${sugerido ? sugerido.monto : ""}" /></div>
        <div class="form-field full"><label>Motivo</label><input type="text" id="act-motivo" value="${esc(sugerido?.motivo ?? "")}" /></div>
      </div>`;
    $("act-porcentaje").addEventListener("input", (e) => {
      const pct = Number(e.target.value);
      if (e.target.value !== "" && !Number.isNaN(pct)) $("act-monto").value = redondearMonto(c.monto_vigente * (1 + pct / 100));
    });
    $("act-monto").addEventListener("input", (e) => {
      const m = Number(e.target.value);
      if (m && c.monto_vigente) $("act-porcentaje").value = ((m / c.monto_vigente - 1) * 100).toFixed(2);
    });
    modalBody.querySelectorAll("[data-del-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("¿Eliminar este aumento?")) return;
        await call("eliminar_actualizacion", { id: Number(b.dataset.delAct) });
        const idx = actualizaciones.findIndex((a) => a.id === Number(b.dataset.delAct));
        if (idx >= 0) actualizaciones.splice(idx, 1);
        render();
        loadAll();
      })
    );
  };
  openModal({
    title: `Aumentos — ${etiquetaInmueble(c)}`,
    size: "wide",
    saveLabel: "Guardar aumento",
    onMount: render,
    onSave: async () => {
      const fecha_vigencia = $("act-fecha").value;
      const monto_nuevo = Number($("act-monto").value);
      const motivo = $("act-motivo").value || null;
      if (!fecha_vigencia || !monto_nuevo) throw new Error("Completá la fecha y el nuevo alquiler");
      await call("agregar_actualizacion", { actualizacion: { id: null, contrato_id: contratoId, fecha_vigencia, monto_nuevo, motivo } });
      toast("Aumento cargado");
      await loadAll();
      if (document.querySelector("#view-aumentos.active")) renderAumentos();
    },
  });
}

function redondearMonto(m) {
  const r = Number(cfg("aumento_redondeo")) || 1;
  return Math.round(m / r) * r;
}

// ---------- AUMENTOS (IPC / ICL / fijo) ----------

$("aum-recalcular").addEventListener("click", () => {
  state.ipc = null;
  renderAumentos(true);
});
$("aum-dias").addEventListener("change", () => renderAumentos());

async function cargarIpc() {
  if (state.ipc) return state.ipc;
  const r = await call("get_ipc");
  state.ipc = { ...r, serieCompleta: serieIpcCompleta(r.serie, r.manual) };
  return state.ipc;
}

const iclCache = new Map();

async function renderAumentos(forzar = false) {
  const hoy = hoyIso();
  const dias = Number($("aum-dias").value || 45);
  const lista = contratosActivos()
    .filter((c) => c.proxima_actualizacion && c.proxima_actualizacion <= c.fecha_fin && diasEntre(hoy, c.proxima_actualizacion) <= dias)
    .sort((a, b) => a.proxima_actualizacion.localeCompare(b.proxima_actualizacion));
  const tbody = $("tbl-aumentos");
  if (!lista.length) {
    tbody.innerHTML = vacio(7, `No hay aumentos en los próximos ${dias} días`);
    $("aum-info").textContent = "";
    state.aumentos = [];
    return;
  }
  tbody.innerHTML = vacio(7, "Calculando…");
  let ipc = null;
  if (lista.some((c) => c.tipo_actualizacion === "IPC")) {
    try {
      ipc = await cargarIpc();
    } catch (e) {
      console.error(e);
    }
  }
  const info = [];
  if (ipc) {
    const u = ipc.serieCompleta.ultimo;
    if (u) info.push(`IPC: último mes disponible <b>${periodoTitulo(u)}</b>${ipc.error ? " (sin conexión con el INDEC: se usan los meses cargados a mano)" : ""}. Si el INDEC ya publicó un mes y acá no aparece, cargalo en Configuración → Índice IPC.`);
    else info.push(`IPC: no se pudo conectar con el INDEC y no hay meses cargados a mano. Revisá la conexión a internet o cargá los meses en Configuración → Índice IPC.`);
  }
  if (lista.some((c) => c.tipo_actualizacion === "ICL")) info.push("ICL: se consulta al BCRA el valor del día del aumento (si es futuro, es una estimación con el último valor publicado).");
  $("aum-info").innerHTML = info.join("<br/>");

  const resultados = [];
  for (const c of lista) {
    const r = { c, estado: "manual", porcentaje: null, detalle: "", confirmado: false };
    try {
      if (c.tipo_actualizacion === "porcentaje_fijo") {
        r.porcentaje = c.porcentaje_actualizacion;
        r.detalle = `${numero(c.porcentaje_actualizacion)}% fijo pactado`;
        r.confirmado = true;
      } else if (c.tipo_actualizacion === "IPC" && ipc) {
        const x = calcularIpc(ipc.serieCompleta, c.proxima_actualizacion, c.frecuencia_actualizacion_meses);
        if (x) {
          r.porcentaje = x.porcentaje;
          r.detalle = `IPC ${periodoTitulo(x.desde)} a ${periodoTitulo(x.hasta)}: ${x.meses.map((m) => numero(m.variacion, 1) + "%").join(" + ")}`;
          r.confirmado = x.completo;
          if (!x.completo) r.detalle += ` <span class="pill pill-warning">falta publicar ${periodoTitulo(sumarMeses(c.proxima_actualizacion.slice(0, 7), -1))}</span>`;
        } else r.detalle = "Faltan datos del IPC para este período (ver Configuración → Índice IPC)";
      } else if (c.tipo_actualizacion === "ICL") {
        const clave = `${c.id}:${c.proxima_actualizacion}`;
        let x = !forzar && iclCache.get(clave);
        const real = c.proxima_actualizacion <= hoy;
        if (!x) {
          x = await invoke(real ? "confirmar_actualizacion_icl" : "estimar_actualizacion_icl", { contratoId: c.id });
          iclCache.set(clave, x);
        }
        r.porcentaje = x.porcentaje_variacion;
        r.detalle = `ICL ${fmtDate(x.fecha_referencia)} (${numero(x.valor_icl_referencia, 2)}) → ${fmtDate(x.fecha_consulta)} (${numero(x.valor_icl_consulta, 2)})`;
        r.confirmado = real;
        if (!real) r.detalle += ' <span class="pill pill-warning">estimado</span>';
      } else {
        r.detalle = "Se carga a mano";
      }
    } catch (e) {
      r.detalle = `<span class="pill pill-danger">No se pudo calcular</span> <small class="muted">${esc(typeof e === "string" ? e.slice(0, 120) : "")}</small>`;
    }
    if (r.porcentaje != null) r.monto = redondearMonto(c.monto_vigente * (1 + r.porcentaje / 100));
    resultados.push(r);
  }
  state.aumentos = resultados;
  tbody.innerHTML = resultados
    .map((r, i) => {
      const c = r.c;
      const dd = diasEntre(hoy, c.proxima_actualizacion);
      return `<tr>
        <td>${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">${esc(c.inquilino_nombre)}</span></td>
        <td>${esc(nombreIndice(c.tipo_actualizacion))}<span class="sub-line">cada ${c.frecuencia_actualizacion_meses} meses</span></td>
        <td>${fmtDate(c.proxima_actualizacion)}<span class="sub-line">${dd < 0 ? `<b style="color:var(--danger)">atrasado ${-dd} días</b>` : diasTexto(dd)}</span></td>
        <td class="num">${money(c.monto_vigente)}</td>
        <td style="max-width:340px;font-size:12.5px">${r.detalle}</td>
        <td class="num">${r.monto != null ? `<b>${money(r.monto)}</b><span class="sub-line">${r.porcentaje >= 0 ? "+" : ""}${numero(r.porcentaje)}%</span>` : "-"}</td>
        <td class="actions">
          ${r.monto != null ? `<button class="btn-primary btn-sm" data-aum-aplicar="${i}" ${r.confirmado ? "" : 'title="Todavía es un estimado"'}>Aplicar</button>` : ""}
          <button class="btn-link" data-aum-manual="${i}">${r.monto != null ? "Ajustar" : "Cargar"}</button>
        </td></tr>`;
    })
    .join("");
}

function motivoAumento(r) {
  const c = r.c;
  const pct = `${r.porcentaje >= 0 ? "+" : ""}${numero(r.porcentaje)}%`;
  if (c.tipo_actualizacion === "IPC") return `Actualización IPC (INDEC) ${pct} — ${r.detalle.replace(/<[^>]+>/g, "").split(":")[0].replace("IPC ", "")}`;
  if (c.tipo_actualizacion === "ICL") return `Actualización ICL (BCRA) ${pct}`;
  return `Actualización ${nombreIndice(c.tipo_actualizacion)} ${pct}`;
}

async function aplicarAumento(r, avisar = true) {
  await call("agregar_actualizacion", {
    actualizacion: { id: null, contrato_id: r.c.id, fecha_vigencia: r.c.proxima_actualizacion, monto_nuevo: r.monto, motivo: motivoAumento(r) },
  });
  if (avisar && confirm(`Aumento aplicado: ${money(r.monto)} desde el ${fmtDate(r.c.proxima_actualizacion)}.\n\n¿Avisarle ahora al inquilino por WhatsApp?`)) {
    const c = r.c;
    const datos = {
      ...datosBaseMensaje(), nombre: primerNombre(c.inquilino_nombre), inmueble: c.inmueble_direccion, fecha: fmtDate(c.proxima_actualizacion),
      indice: nombreIndice(c.tipo_actualizacion), porcentaje: `${r.porcentaje >= 0 ? "+" : ""}${numero(r.porcentaje)}%`, monto: money(r.monto),
    };
    await enviarWhatsapp({ telefono: c.inquilino_telefono, nombre: c.inquilino_nombre, contrato_id: c.id, tipo: "aumento", referencia: c.proxima_actualizacion, mensaje: completarPlantilla(cfg("plantilla_aumento"), datos) });
  }
}

$("tbl-aumentos").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.aumAplicar) {
    const r = state.aumentos[Number(b.dataset.aumAplicar)];
    if (!r.confirmado && !confirm("Este cálculo todavía es un ESTIMADO (falta publicar el índice del último mes). ¿Aplicarlo igual?")) return;
    await aplicarAumento(r);
    toast("Aumento aplicado");
    await loadAll();
    renderAumentos();
  }
  if (b.dataset.aumManual) {
    const r = state.aumentos[Number(b.dataset.aumManual)];
    abrirActualizaciones(r.c.id, r.monto != null ? { fecha: r.c.proxima_actualizacion, porcentaje: r.porcentaje, monto: r.monto, motivo: motivoAumento(r) } : null);
  }
});

$("aum-aplicar-todos").addEventListener("click", async () => {
  const listos = state.aumentos.filter((r) => r.confirmado && r.monto != null);
  if (!listos.length) return toast("No hay aumentos confirmados para aplicar", true);
  if (!confirm(`Se van a aplicar ${listos.length} aumento(s) confirmados:\n\n${listos.map((r) => `• ${etiquetaInmueble(r.c)}: ${money(r.c.monto_vigente)} → ${money(r.monto)}`).join("\n")}\n\n¿Continuar?`)) return;
  for (const r of listos) await aplicarAumento(r, false);
  toast(`${listos.length} aumento(s) aplicados. Avisá a los inquilinos desde «Avisos WhatsApp → Aumentos».`);
  await loadAll();
  renderAumentos();
});

// ---------- COBROS (pagos / recibos) ----------

function renderPagos() {
  const tbody = $("tbl-pagos");
  const sel = $("filtro-pagos-mes");
  const meses = [...new Set(state.pagos.map((p) => p.fecha_pago.slice(0, 7)))].sort().reverse();
  const elegido = sel.value || "";
  sel.innerHTML = `<option value="">Todos los meses</option>` + meses.map((m) => `<option value="${m}" ${m === elegido ? "selected" : ""}>Cobrados en ${periodoTitulo(m)}</option>`).join("");
  const liquidados = new Map(state.liquidaciones.map((l) => [l.pago_id, l.numero_comprobante]));
  const lista = state.pagos.filter((p) => !elegido || p.fecha_pago.startsWith(elegido)).sort((a, b) => b.numero_recibo - a.numero_recibo);
  if (!lista.length) {
    tbody.innerHTML = vacio(8, "No hay cobros registrados");
    return;
  }
  tbody.innerHTML = lista
    .map((p) => {
      const c = byId(state.contratos, p.contrato_id);
      const liq = liquidados.get(p.id);
      return `<tr>
      <td><b>${p.numero_recibo}</b></td><td>${fmtDate(p.fecha_pago)}</td>
      <td>${c ? `${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<span class="sub-line">${esc(c.inquilino_nombre)}</span>` : "(contrato eliminado)"}</td>
      <td>${periodoTitulo(p.periodo)}</td><td>${esc(p.metodo_pago || "-")}</td>
      <td class="num"><b>${money(p.monto_total)}</b>${p.dias_mora > 0 ? `<span class="sub-line">${p.dias_mora} días de atraso</span>` : ""}</td>
      <td>${liq ? `<span class="pill pill-ok">N° ${liq}</span>` : '<span class="pill pill-warning">Pendiente</span>'}</td>
      <td class="actions"><button class="btn-link" data-recibo="${p.id}">Ver recibo</button><button class="btn-link peligro" data-del-pago="${p.id}">Anular</button></td></tr>`;
    })
    .join("");
  aplicarBusqueda("tbl-pagos");
}
$("filtro-pagos-mes").addEventListener("change", renderPagos);
$("btn-nuevo-pago").addEventListener("click", () => abrirCobro());
$("tbl-pagos").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b?.dataset.delPago) return;
  if (!confirm("¿Anular (eliminar) este cobro? También se borra de la liquidación si ya estaba liquidado.")) return;
  await call("eliminar_pago", { id: Number(b.dataset.delPago) });
  toast("Cobro anulado");
  await loadAll();
});

const METODOS_PAGO = ["Efectivo", "Transferencia", "Depósito bancario", "Mercado Pago", "Cheque", "Débito / Crédito", "Otro"];

/** Abre el formulario de cobro. contratoId/periodo opcionales (desde el tablero). */
async function abrirCobro(contratoId = null, periodo = null) {
  const activos = contratosActivos().sort((a, b) => (a.inmueble_codigo || 1e9) - (b.inmueble_codigo || 1e9));
  if (!activos.length) return toast("No hay contratos activos", true);
  const hoy = hoyIso();
  const opciones = activos.map((c) => `<option value="${c.id}">${esc(etiquetaInmueble(c))} — ${esc(c.inquilino_nombre)}</option>`).join("");
  const html = `
    <div class="cobro-layout" id="cb-layout">
      <div>
        <div class="form-grid">
          <div class="form-field full"><label>Contrato <span class="req">*</span></label>
            <input type="text" id="cb-buscar" placeholder="Buscar por dirección, código o inquilino…" style="margin-bottom:6px" />
            <select id="cb-contrato" size="1">${opciones}</select></div>
          <div class="form-field"><label>Período que paga</label><input type="month" id="cb-periodo" /></div>
          <div class="form-field"><label>Fecha de pago</label><input type="date" id="cb-fecha" value="${hoy}" /></div>
          <div class="form-field"><label>Forma de pago</label><select id="cb-metodo">${METODOS_PAGO.map((m) => `<option>${m}</option>`).join("")}</select></div>
          <div class="form-field"><label>Alquiler ($)</label><input type="number" step="any" id="cb-alquiler" /></div>
          <div class="form-field"><label>Intereses por atraso ($)</label><input type="number" step="any" id="cb-interes" /><small class="field-hint" id="cb-interes-hint"></small></div>
          <div class="form-field"><label>Multa ($)</label><input type="number" step="any" id="cb-multa" /></div>
          <div class="form-section">Otros conceptos (expensas, servicios, etc.)</div>
          <div class="form-field full" id="cb-conceptos-wrap"></div>
          <div class="form-field"><label>Bonificación / descuento ($)</label><input type="number" step="any" id="cb-bonif" value="0" /></div>
          <div class="form-field"><label>Recargo ($)</label><input type="number" step="any" id="cb-recargo" value="0" /></div>
          <div class="form-field"><label>Saldo a favor que se descuenta ($)</label><input type="number" step="any" id="cb-afavor" value="0" /></div>
          <div class="form-field full"><label>Observaciones (salen en el recibo)</label><input type="text" id="cb-notas" /></div>
        </div>
      </div>
      <div class="cobro-resumen" id="cb-resumen"></div>
    </div>`;
  let actualizaciones = [];
  let c = null;

  const montoPara = (venc) => {
    const vig = actualizaciones.filter((a) => a.fecha_vigencia <= venc).sort((a, b) => b.fecha_vigencia.localeCompare(a.fecha_vigencia))[0];
    return vig ? vig.monto_nuevo : c.monto_inicial;
  };

  const recalcular = (desdeCero) => {
    if (!c) return;
    const per = $("cb-periodo").value;
    const fecha = $("cb-fecha").value || hoy;
    if (!per) return;
    const venc = vencimientoDe(per, c.dia_pago);
    const dias = Math.max(0, diasEntre(venc, fecha));
    if (desdeCero) {
      const alq = montoPara(venc);
      $("cb-alquiler").value = alq;
      $("cb-interes").value = (Math.round(alq * (c.tasa_mora_diaria / 100) * dias * 100) / 100).toFixed(2);
      $("cb-multa").value = (Math.round((c.multa_diaria || 0) * dias * 100) / 100).toFixed(2);
    }
    $("cb-interes-hint").textContent = dias > 0 ? `${dias} días de atraso (vencía el ${fmtDate(venc)}) · ${numero(c.tasa_mora_diaria)}% diario` : `Sin atraso (vence el ${fmtDate(venc)})`;
    const p = {
      monto_alquiler: Number($("cb-alquiler").value || 0),
      monto_mora: Number($("cb-interes").value || 0),
      monto_multa: Number($("cb-multa").value || 0),
      conceptos: leerLineas("cb-conceptos"),
      bonificacion: Number($("cb-bonif").value || 0),
      recargo: Number($("cb-recargo").value || 0),
      a_favor: Number($("cb-afavor").value || 0),
    };
    const t = totalesRecibo(p);
    const mes = mesDeContrato(c.fecha_inicio, c.fecha_fin, per);
    const ya = pagoDelPeriodo(c.id, per);
    const ult = pagosDe(c.id).sort((a, b) => b.periodo.localeCompare(a.periodo))[0];
    $("cb-resumen").innerHTML = `
      <h3>Resumen del recibo</h3>
      <div class="res-ctx">
        <b>${esc(c.inquilino_nombre)}</b>${c.inquilino_dni ? ` · DNI ${esc(c.inquilino_dni)}` : ""}<br/>
        ${codHtml(c.inmueble_codigo)}${esc(c.inmueble_direccion)}<br/>
        Propietario: ${esc(c.propietario_nombre)}<br/>
        Contrato N° ${esc(c.numero ?? c.id)} · ${periodoTitulo(per)} — Mes ${mes.mes}/${mes.total}<br/>
        Último pago: ${ult ? `${periodoTitulo(ult.periodo)} (recibo ${ult.numero_recibo})` : "ninguno"}
        ${ya ? `<br/><span class="pill pill-danger">Este período ya se cobró (recibo ${ya.numero_recibo})</span>` : ""}
      </div>
      <div class="res-fila"><span>Alquiler</span><span>${money(t.alquiler)}</span></div>
      ${t.interes ? `<div class="res-fila"><span>Intereses</span><span>${money(t.interes)}</span></div>` : ""}
      ${t.multa ? `<div class="res-fila"><span>Multa</span><span>${money(t.multa)}</span></div>` : ""}
      ${t.conceptos.map((x) => `<div class="res-fila"><span>${esc(x.concepto || "Concepto")}</span><span>${money(x.monto)}</span></div>`).join("")}
      ${t.bonificacion ? `<div class="res-fila"><span>Bonificación</span><span>- ${money(t.bonificacion)}</span></div>` : ""}
      ${t.recargo ? `<div class="res-fila"><span>Recargo</span><span>${money(t.recargo)}</span></div>` : ""}
      ${t.aFavor ? `<div class="res-fila"><span>A favor</span><span>- ${money(t.aFavor)}</span></div>` : ""}
      <div class="res-fila total"><span>Total</span><span>${money(t.total)}</span></div>
      <div class="res-letras">Son pesos ${montoEnLetras(t.total).toLowerCase()}</div>`;
    modalInfo.innerHTML = `Total a cobrar: <b class="total">${money(t.total)}</b>`;
  };

  const elegirContrato = async (id, per = null) => {
    c = byId(state.contratos, Number(id));
    $("cb-contrato").value = c.id;
    $("cb-periodo").value = per || periodoSugerido(c);
    $("cb-conceptos-wrap").innerHTML = lineasHtml("cb-conceptos", c.conceptos_fijos || []);
    actualizaciones = await invoke("get_actualizaciones", { contratoId: c.id }).catch(() => []);
    recalcular(true);
  };

  openModal({
    title: "Cobrar alquiler",
    size: "xl",
    html,
    saveLabel: "Registrar cobro y ver recibo",
    onMount: () => {
      $("cb-contrato").addEventListener("change", (e) => elegirContrato(e.target.value));
      $("cb-buscar").addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        const sel = $("cb-contrato");
        let primero = null;
        Array.from(sel.options).forEach((o) => {
          const ok = !q || o.textContent.toLowerCase().includes(q);
          o.hidden = !ok;
          if (ok && !primero) primero = o;
        });
        if (primero && sel.selectedOptions[0]?.hidden) elegirContrato(primero.value);
      });
      $("cb-periodo").addEventListener("change", () => recalcular(true));
      $("cb-fecha").addEventListener("change", () => recalcular(true));
      $("cb-layout").addEventListener("input", (e) => {
        if (["cb-periodo", "cb-fecha", "cb-buscar"].includes(e.target.id)) return;
        recalcular(false);
      });
      elegirContrato(contratoId || activos[0].id, periodo);
      setTimeout(() => $("cb-buscar").focus(), 50);
    },
    onSave: async () => {
      const per = $("cb-periodo").value;
      if (!c || !per) throw new Error("Elegí el contrato y el período");
      const ya = pagoDelPeriodo(c.id, per);
      if (ya && !confirm(`${periodoTitulo(per)} ya tiene el recibo N° ${ya.numero_recibo}. ¿Registrar otro cobro igual (ej. pago parcial o servicios)?`)) return false;
      const nuevo = {
        contrato_id: c.id,
        periodo: per,
        fecha_pago: $("cb-fecha").value || hoy,
        metodo_pago: $("cb-metodo").value,
        notas: $("cb-notas").value.trim() || null,
        monto_alquiler: Number($("cb-alquiler").value || 0),
        monto_mora: Number($("cb-interes").value || 0),
        monto_multa: Number($("cb-multa").value || 0),
        conceptos: leerLineas("cb-conceptos"),
        bonificacion: Number($("cb-bonif").value || 0),
        recargo: Number($("cb-recargo").value || 0),
        a_favor: Number($("cb-afavor").value || 0),
        usuario: usuarioNombre(),
      };
      const id = await call("registrar_pago", { nuevo });
      toast("Cobro registrado");
      await loadAll();
      setTimeout(() => verRecibo(id), 0);
    },
  });
}

async function verRecibo(pagoId) {
  const r = await call("get_recibo", { pagoId });
  const conf = configCompleta();
  openPrint(htmlRecibo(r, conf), {
    titulo: `Recibo N° ${r.numero_recibo}`,
    apaisado: true,
    whatsapp: async () => {
      const inq = r.contratos?.inquilinos || {};
      const inm = r.contratos?.inmuebles || {};
      const datos = { ...datosBaseMensaje(), nombre: primerNombre(inq.nombre), monto: money(totalesRecibo(r).total), periodo: periodoTitulo(r.periodo).toLowerCase(), inmueble: inm.direccion, recibo: r.numero_recibo };
      await enviarWhatsapp({ telefono: inq.telefono, nombre: inq.nombre, contrato_id: r.contrato_id, tipo: "recibo", referencia: String(r.numero_recibo), mensaje: completarPlantilla(cfg("plantilla_recibo"), datos) });
      toast("Tip: guardá el recibo en PDF y adjuntalo en el chat que se abrió.");
    },
  });
}

// ---------- LIQUIDACIONES ----------

function pagosSinLiquidar() {
  const liquidados = new Set(state.liquidaciones.map((l) => l.pago_id));
  return state.pagos.filter((p) => !liquidados.has(p.id));
}

function propietarioDePago(p) {
  const c = byId(state.contratos, p.contrato_id);
  return c ? c.propietario_id : null;
}

function gruposLiquidacion() {
  const grupos = new Map();
  for (const l of state.liquidaciones) {
    if (!grupos.has(l.numero_comprobante)) grupos.set(l.numero_comprobante, []);
    grupos.get(l.numero_comprobante).push(l);
  }
  return [...grupos.entries()].map(([numero, filas]) => {
    const pago = byId(state.pagos, filas[0].pago_id);
    const c = pago ? byId(state.contratos, pago.contrato_id) : null;
    return {
      numero, filas, fecha: filas[0].fecha, propietario_id: c?.propietario_id, propietario: c?.propietario_nombre || "-",
      cobrado: filas.reduce((a, f) => a + Number(f.monto_cobrado ?? f.monto_alquiler), 0),
      comision: filas.reduce((a, f) => a + f.monto_comision, 0),
      neto: filas.reduce((a, f) => a + f.monto_neto, 0),
    };
  });
}

function renderLiquidaciones() {
  // pendientes por propietario
  const pend = new Map();
  for (const p of pagosSinLiquidar()) {
    const pid = propietarioDePago(p);
    if (pid == null) continue;
    const x = pend.get(pid) || { n: 0, total: 0 };
    x.n++;
    x.total += p.monto_alquiler + p.monto_mora + (p.monto_multa || 0);
    pend.set(pid, x);
  }
  $("liq-pendientes").innerHTML = `<div class="panel-header"><h2>Pendientes de liquidar</h2><span class="panel-sub">alquileres cobrados que todavía no se rindieron al propietario</span></div>
    <div class="pend-lista">${
      pend.size
        ? [...pend.entries()]
            .map(([pid, x]) => {
              const p = byId(state.propietarios, pid);
              return `<div class="pend-item"><div><b>${esc(p?.nombre || "-")}</b><small class="muted">${x.n} recibo${x.n > 1 ? "s" : ""} · ${money(x.total)}</small></div><button class="btn-gold btn-sm" data-liquidar="${pid}">Liquidar</button></div>`;
            })
            .join("")
        : '<span class="muted">No hay cobros pendientes de liquidar 👌</span>'
    }</div>`;

  const tbody = $("tbl-liquidaciones");
  const grupos = gruposLiquidacion().sort((a, b) => b.numero - a.numero);
  tbody.innerHTML = grupos.length
    ? grupos
        .map(
          (g) => `<tr><td><b>${g.numero}</b></td><td>${fmtDate(g.fecha)}</td><td>${esc(g.propietario)}</td><td>${g.filas.length}</td>
          <td class="num">${money(g.cobrado)}</td><td class="num">${money(g.comision)}</td><td class="num"><b>${money(g.neto)}</b></td>
          <td class="actions"><button class="btn-link" data-ver-liq="${g.numero}">Ver</button><button class="btn-link peligro" data-del-liq="${g.numero}">Eliminar</button></td></tr>`
        )
        .join("")
    : vacio(8, "Todavía no hay liquidaciones");
  aplicarBusqueda("tbl-liquidaciones");
}

$("btn-nueva-liquidacion").addEventListener("click", () => abrirLiquidacion());
$("liq-pendientes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-liquidar]");
  if (b) abrirLiquidacion(Number(b.dataset.liquidar));
});
$("tbl-liquidaciones").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.verLiq) verLiquidacion(Number(b.dataset.verLiq));
  if (b.dataset.delLiq && confirm("¿Eliminar esta liquidación? Los recibos vuelven a quedar pendientes de liquidar.")) {
    await call("eliminar_liquidacion", { numero: Number(b.dataset.delLiq) });
    toast("Liquidación eliminada");
    await loadAll();
  }
});

const TIPOS_GASTO = [
  { value: "descuento", label: "Descontar" },
  { value: "suma", label: "Sumar" },
];

function abrirLiquidacion(propietarioId = null) {
  const pend = pagosSinLiquidar();
  const props = [...new Set(pend.map(propietarioDePago).filter((x) => x != null))].map((id) => byId(state.propietarios, id)).filter(Boolean);
  if (!props.length) return toast("No hay cobros pendientes de liquidar", true);
  const pid = propietarioId || props[0].id;
  const html = `
    <div class="cobro-layout" id="lq-layout">
      <div>
        <div class="form-grid">
          <div class="form-field full"><label>Propietario</label><select id="lq-prop">${props.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.nombre)}</option>`).join("")}</select></div>
          <div class="form-field full"><label>Recibos a liquidar</label><div id="lq-recibos"></div></div>
          <div class="form-field"><label>Honorarios (%)</label><input type="number" step="any" id="lq-comision" placeholder="El de cada contrato" /><small class="field-hint">Vacío = el % pactado en cada contrato</small></div>
          <div class="form-field form-check"><input type="checkbox" id="lq-intereses" checked /><label for="lq-intereses">Rendir intereses y multas al propietario</label></div>
          <div class="form-section">Gastos o importes a descontar / sumar</div>
          <div class="form-field full">${lineasHtml("lq-items", [], TIPOS_GASTO).replace("+ Agregar concepto", "+ Agregar gasto o importe")}</div>
          <div class="form-field"><label>Fecha</label><input type="date" id="lq-fecha" value="${hoyIso()}" /></div>
          <div class="form-field full"><label>Observaciones</label><input type="text" id="lq-notas" /></div>
        </div>
      </div>
      <div class="cobro-resumen" id="lq-resumen"></div>
    </div>`;

  const leerItems = () =>
    leerLineas("lq-items").map((l) => ({ concepto: l.concepto, monto: l.tipo === "descuento" ? -Math.abs(l.monto) : Math.abs(l.monto) }));

  const pintarRecibos = () => {
    const prop = Number($("lq-prop").value);
    const lista = pend.filter((p) => propietarioDePago(p) === prop).sort((a, b) => a.periodo.localeCompare(b.periodo));
    $("lq-recibos").innerHTML = `<table class="mini-tabla"><thead><tr><th></th><th>Recibo</th><th>Propiedad</th><th>Período</th><th class="num">Alquiler</th><th class="num">Int./multa</th></tr></thead><tbody>${lista
      .map((p) => {
        const c = byId(state.contratos, p.contrato_id);
        return `<tr><td><input type="checkbox" class="lq-pago" value="${p.id}" checked /></td><td>${p.numero_recibo}</td><td>${codHtml(c?.inmueble_codigo)}${esc(c?.inmueble_direccion || "")}</td><td>${periodoTitulo(p.periodo)}</td><td class="num">${money(p.monto_alquiler)}</td><td class="num">${money(p.monto_mora + (p.monto_multa || 0))}</td></tr>`;
      })
      .join("")}</tbody></table>`;
    resumen();
  };

  const resumen = () => {
    const ids = Array.from(document.querySelectorAll(".lq-pago:checked")).map((i) => Number(i.value));
    const pctManual = $("lq-comision").value;
    const incl = $("lq-intereses").checked;
    let cobrado = 0;
    let comision = 0;
    for (const id of ids) {
      const p = byId(state.pagos, id);
      const c = byId(state.contratos, p.contrato_id);
      const pct = pctManual !== "" ? Number(pctManual) : c?.comision_porcentaje || 0;
      cobrado += p.monto_alquiler + (incl ? p.monto_mora + (p.monto_multa || 0) : 0);
      comision += Math.round(p.monto_alquiler * pct) / 100;
    }
    const items = leerItems();
    const totItems = items.reduce((a, i) => a + i.monto, 0);
    const neto = cobrado - comision + totItems;
    $("lq-resumen").innerHTML = `<h3>Resumen</h3>
      <div class="res-fila"><span>${ids.length} recibo(s) cobrados</span><span>${money(cobrado)}</span></div>
      <div class="res-fila"><span>Honorarios de administración</span><span>- ${money(comision)}</span></div>
      ${items.map((i) => `<div class="res-fila"><span>${esc(i.concepto || "Gasto")}</span><span>${i.monto < 0 ? "- " : ""}${money(Math.abs(i.monto))}</span></div>`).join("")}
      <div class="res-fila total"><span>Neto al propietario</span><span>${money(neto)}</span></div>
      <div class="res-letras">Son pesos ${montoEnLetras(neto).toLowerCase()}</div>`;
    modalInfo.innerHTML = `Neto a liquidar: <b class="total">${money(neto)}</b>`;
  };

  openModal({
    title: "Nueva liquidación al propietario",
    size: "xl",
    html,
    saveLabel: "Generar liquidación",
    onMount: () => {
      $("lq-prop").addEventListener("change", pintarRecibos);
      $("lq-layout").addEventListener("input", resumen);
      $("lq-layout").addEventListener("change", resumen);
      pintarRecibos();
    },
    onSave: async () => {
      const ids = Array.from(document.querySelectorAll(".lq-pago:checked")).map((i) => Number(i.value));
      if (!ids.length) throw new Error("Elegí al menos un recibo");
      const pct = $("lq-comision").value;
      const numeroLiq = await call("generar_liquidacion", {
        pagoIds: ids,
        comisionPorcentaje: pct === "" ? null : Number(pct),
        fecha: $("lq-fecha").value || hoyIso(),
        notas: $("lq-notas").value.trim() || null,
        items: leerItems(),
        incluirIntereses: $("lq-intereses").checked,
        usuario: usuarioNombre(),
      });
      toast("Liquidación generada");
      await loadAll();
      setTimeout(() => verLiquidacion(numeroLiq), 0);
    },
  });
}

async function verLiquidacion(numeroLiq) {
  const filas = await call("get_comprobante", { numero: numeroLiq });
  const prop = filas[0].pagos?.contratos?.inmuebles?.propietarios || {};
  openPrint(htmlLiquidacion(filas, configCompleta()), {
    titulo: `Liquidación N° ${numeroLiq}`,
    whatsapp: async () => {
      const datos = { ...datosBaseMensaje(), nombre: primerNombre(prop.nombre), numero: numeroLiq, monto: money(totalesLiquidacion(filas).neto) };
      await enviarWhatsapp({ telefono: prop.telefono, nombre: prop.nombre, tipo: "liquidacion", referencia: String(numeroLiq), mensaje: completarPlantilla(cfg("plantilla_liquidacion"), datos) });
      toast("Tip: guardá la liquidación en PDF y adjuntala en el chat que se abrió.");
    },
  });
}

// ---------- CONFIGURACIÓN ----------

let cfgTab = "inmobiliaria";
const cfgBorrador = {};

function abrirTabConfig(tab) {
  cfgTab = tab;
  renderConfig();
}

$("cfg-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  guardarBorradorConfig();
  cfgTab = t.dataset.tab;
  renderConfig();
});

function campoCfg(k, label, { type = "text", hint = "", full = false, placeholder = "" } = {}) {
  const v = cfgBorrador[k] ?? cfg(k);
  const ctrl = type === "textarea" ? `<textarea data-cfg="${k}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>` : `<input type="${type}" data-cfg="${k}" value="${esc(v)}" placeholder="${esc(placeholder)}" />`;
  return `<div class="form-field ${full ? "full" : ""}"><label>${label}</label>${ctrl}${hint ? `<small class="field-hint">${hint}</small>` : ""}</div>`;
}

function guardarBorradorConfig() {
  document.querySelectorAll("#cfg-body [data-cfg]").forEach((el) => (cfgBorrador[el.dataset.cfg] = el.value));
}

const VARIABLES = {
  plantilla_recordatorio: ["nombre", "inmueble", "periodo", "vencimiento", "monto", "datos_pago", "inmobiliaria"],
  plantilla_deuda: ["nombre", "inmueble", "periodos", "monto", "inmobiliaria"],
  plantilla_aumento: ["nombre", "inmueble", "fecha", "indice", "porcentaje", "monto", "inmobiliaria"],
  plantilla_vencimiento: ["nombre", "inmueble", "fecha", "inmobiliaria"],
  plantilla_recibo: ["nombre", "monto", "periodo", "inmueble", "recibo", "inmobiliaria"],
  plantilla_liquidacion: ["nombre", "numero", "monto", "inmobiliaria"],
  plantilla_cumple: ["nombre", "inmobiliaria"],
};

async function renderConfig() {
  document.querySelectorAll("#cfg-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === cfgTab));
  const body = $("cfg-body");
  $("cfg-guardar").classList.toggle("hidden", cfgTab === "ipc");
  if (cfgTab === "inmobiliaria") {
    const logo = cfgBorrador.recibo_logo ?? cfg("recibo_logo");
    body.innerHTML = `<div class="cfg-grid">
      <div class="panel"><h3>Datos de la inmobiliaria</h3><div class="form-grid">
        ${campoCfg("inmobiliaria_nombre", "Nombre", { full: true })}
        ${campoCfg("inmobiliaria_matricula", "Matrícula")}
        ${campoCfg("inmobiliaria_cuit", "CUIT")}
        ${campoCfg("inmobiliaria_direccion", "Dirección")}
        ${campoCfg("inmobiliaria_localidad", "Localidad")}
        ${campoCfg("inmobiliaria_telefono", "Teléfono")}
        ${campoCfg("inmobiliaria_email", "Email")}
      </div></div>
      <div class="panel"><h3>Recibos</h3><div class="form-grid">
        ${campoCfg("recibo_numero_desde", "Seguir numeración desde el N°", { type: "number", hint: "Si venías usando otro sistema, poné el próximo número (ej. 1316). Si los recibos de la app ya pasaron ese número, se sigue el de la app." })}
        ${campoCfg("aumento_redondeo", "Redondear aumentos a múltiplos de $", { type: "number", hint: "1 = pesos exactos, 100 = redondea a cientos" })}
        ${campoCfg("recibo_leyenda", "Leyenda al pie del recibo (opcional)", { full: true, placeholder: "Ej: El pago fuera de término devenga intereses según contrato." })}
        <div class="form-field full"><label>Logo del recibo</label>
          <div style="display:flex;gap:10px;align-items:center"><img class="logo-preview" id="cfg-logo-prev" src="${esc(logo || "logo-recibo.jpg")}" />
          <button type="button" class="btn-secondary btn-sm" id="cfg-logo-cambiar">Cambiar…</button>
          <button type="button" class="btn-link" id="cfg-logo-reset">Usar el de siempre</button>
          <input type="file" id="cfg-logo-file" accept="image/*" class="hidden" /></div></div>
        <div class="form-field full"><button type="button" class="btn-secondary btn-sm" id="cfg-recibo-prueba" style="align-self:flex-start">Ver recibo de ejemplo</button></div>
      </div></div></div>`;
    $("cfg-logo-cambiar").addEventListener("click", () => $("cfg-logo-file").click());
    $("cfg-logo-file").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      cfgBorrador.recibo_logo = await comprimirFoto(f, 600);
      $("cfg-logo-prev").src = cfgBorrador.recibo_logo;
    });
    $("cfg-logo-reset").addEventListener("click", () => {
      cfgBorrador.recibo_logo = "";
      $("cfg-logo-prev").src = "logo-recibo.jpg";
    });
    $("cfg-recibo-prueba").addEventListener("click", () => {
      guardarBorradorConfig();
      const conf = { ...configCompleta(), ...cfgBorrador };
      if (!conf.recibo_logo) conf.recibo_logo = "";
      const ejemplo = {
        numero_recibo: Number(conf.recibo_numero_desde) || 1315, fecha_pago: hoyIso(), periodo: hoyIso().slice(0, 7), monto_alquiler: 350000, monto_mora: 0, monto_multa: 0,
        conceptos: [], bonificacion: 0, recargo: 0, a_favor: 0, metodo_pago: "Efectivo", usuario: usuarioNombre(), dias_mora: 0,
        contratos: { numero: 184, fecha_inicio: "2026-07-01", fecha_fin: "2027-06-30", inquilinos: { nombre: "VILLALBA ENZO SANTIAGO MIGUEL", telefono: "" }, inmuebles: { codigo: 93, direccion: "DORREGO N°806", propietarios: { nombre: "MANUEL DEZZOTI" } } },
      };
      openPrint(htmlRecibo(ejemplo, conf), { titulo: "Recibo de ejemplo", apaisado: true });
    });
  } else if (cfgTab === "whatsapp") {
    const plantillas = [
      ["plantilla_recordatorio", "Recordatorio de pago (antes del vencimiento)"],
      ["plantilla_deuda", "Pago atrasado"],
      ["plantilla_aumento", "Aviso de aumento"],
      ["plantilla_vencimiento", "Fin de contrato"],
      ["plantilla_recibo", "Confirmación de pago (desde el recibo)"],
      ["plantilla_liquidacion", "Liquidación al propietario"],
      ["plantilla_cumple", "Cumpleaños"],
    ];
    body.innerHTML = `<div class="cfg-grid">
      <div class="panel"><h3>Datos generales</h3><div class="form-grid">
        ${campoCfg("wa_codigo_area", "Característica por defecto", { hint: "Para teléfonos cargados sin característica (ej. 3468)" })}
        ${campoCfg("aviso_dias_antes", "Recordar el pago con (días de anticipación)", { type: "number" })}
        ${campoCfg("wa_datos_pago", "Datos para transferir (van en {datos_pago})", { full: true, type: "textarea", placeholder: "Alias: CARRANZA.INMO · CBU 0000… · Titular: …" })}
      </div>
      <p class="hint" style="margin-top:14px">Los mensajes se abren en WhatsApp (app o web) con el texto listo; solo tenés que tocar enviar. Para mandar el recibo, guardalo en PDF y adjuntalo en el chat.</p></div>
      <div class="panel"><h3>Mensajes</h3><div class="form-grid">${plantillas
        .map(
          ([k, label]) => `<div class="form-field full plantilla"><label>${label}</label><textarea data-cfg="${k}">${esc(cfgBorrador[k] ?? cfg(k))}</textarea>
          <div class="chips">${VARIABLES[k].map((v) => `<button type="button" class="chip" data-insertar="${k}" data-var="${v}">{${v}}</button>`).join("")}</div></div>`
        )
        .join("")}</div></div></div>`;
    body.querySelectorAll("[data-insertar]").forEach((b) =>
      b.addEventListener("click", () => {
        const ta = body.querySelector(`textarea[data-cfg="${b.dataset.insertar}"]`);
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, pos) + `{${b.dataset.var}}` + ta.value.slice(ta.selectionEnd ?? pos);
        ta.focus();
      })
    );
  } else if (cfgTab === "ipc") {
    body.innerHTML = `<p class="hint">Cargando datos del INDEC…</p>`;
    let ipc;
    try {
      state.ipc = null;
      ipc = await cargarIpc();
    } catch {
      body.innerHTML = `<p class="hint">No se pudo cargar el IPC.</p>`;
      return;
    }
    const { mapa, ultimo } = ipc.serieCompleta;
    const ultApi = ipc.serie.length ? ipc.serie[ipc.serie.length - 1][0] : null;
    const filas = [];
    if (ultimo) {
      for (let i = 0; i < 14; i++) {
        const p = sumarMeses(ultimo, -i);
        const ant = mapa.get(sumarMeses(p, -1));
        const act = mapa.get(p);
        if (!act || !ant) continue;
        const manual = ipc.manual.find((m) => m.periodo === p && (!ultApi || p > ultApi));
        filas.push(`<tr><td>${periodoTitulo(p)}</td><td class="num">${numero((act / ant - 1) * 100, 1)}%</td><td>${manual ? '<span class="pill pill-gold">cargado a mano</span>' : '<span class="pill pill-ok">INDEC</span>'}</td>
          <td class="actions">${manual ? `<button class="btn-link peligro" data-del-ipc="${p}">Quitar</button>` : ""}</td></tr>`);
      }
    }
    body.innerHTML = `<div class="cfg-grid">
      <div class="panel"><h3>IPC mensual (nivel general nacional)</h3>
        <p class="hint">${ipc.error ? `<b style="color:var(--danger)">No se pudo conectar con datos.gob.ar:</b> ${esc(ipc.error)}` : `Fuente: INDEC vía datos.gob.ar. Último mes publicado ahí: <b>${ultApi ? periodoTitulo(ultApi) : "-"}</b>.`}</p>
        <div class="table-wrap"><table class="data-table compact"><thead><tr><th>Mes</th><th class="num">Variación</th><th>Origen</th><th></th></tr></thead><tbody>${filas.join("") || vacio(4, "Sin datos")}</tbody></table></div></div>
      <div class="panel"><h3>Cargar un mes a mano</h3>
        <p class="hint">El INDEC publica el IPC de cada mes a mitad del mes siguiente, y la API a veces tarda unos días más en actualizarse. Si ya salió el dato y acá no aparece, cargalo (lo ven todas las PCs). Cuando la API lo publique, se usa el oficial.</p>
        <div class="form-grid"><div class="form-field"><label>Mes</label><input type="month" id="ipc-periodo" value="${ultimo ? sumarMeses(ultimo, 1) : ""}" /></div>
        <div class="form-field"><label>Variación mensual (%)</label><input type="number" step="0.1" id="ipc-var" placeholder="Ej: 2,1" /></div></div>
        <button class="btn-primary" id="ipc-guardar" style="margin-top:12px">Guardar mes</button></div></div>`;
    $("ipc-guardar").addEventListener("click", async () => {
      const periodo = $("ipc-periodo").value;
      const variacion = Number(String($("ipc-var").value).replace(",", "."));
      if (!periodo || $("ipc-var").value === "") return toast("Completá mes y variación", true);
      await call("guardar_ipc_manual", { periodo, variacion });
      toast("Mes de IPC guardado");
      renderConfig();
    });
    body.querySelectorAll("[data-del-ipc]").forEach((b) =>
      b.addEventListener("click", async () => {
        await call("eliminar_ipc_manual", { periodo: b.dataset.delIpc });
        renderConfig();
      })
    );
  }
}

$("cfg-guardar").addEventListener("click", async () => {
  guardarBorradorConfig();
  if (!Object.keys(cfgBorrador).length) return toast("No hay cambios");
  await call("guardar_configuracion", { valores: cfgBorrador });
  Object.assign(state.config, cfgBorrador);
  for (const k of Object.keys(cfgBorrador)) delete cfgBorrador[k];
  toast("Configuración guardada");
  renderConfig();
});

// ---------- USUARIOS ----------

function renderUsuarios() {
  const tbody = $("tbl-usuarios");
  tbody.innerHTML = state.usuarios.length
    ? state.usuarios
        .map(
          (u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.nombre_completo)}</td>
      <td><span class="pill ${u.activo ? "pill-ok" : "pill-gris"}">${u.activo ? "Activo" : "Deshabilitado"}</span></td>
      <td class="actions">${u.id === state.usuarioActual?.id ? '<span class="muted">vos</span>' : `<button class="btn-link peligro" data-del-usuario="${u.id}">Eliminar</button>`}</td></tr>`
        )
        .join("")
    : vacio(4, "No hay usuarios");
}

$("btn-nuevo-usuario").addEventListener("click", () =>
  openModal({
    title: "Nuevo usuario",
    fields: [
      { name: "nombre_completo", label: "Nombre completo", required: true, full: true, hint: "Aparece en los recibos (Usuario: …)" },
      { name: "username", label: "Usuario", required: true },
      { name: "password", label: "Contraseña (mínimo 4)", type: "password", required: true },
    ],
    onSave: async (values) => {
      await call("crear_usuario", { nuevo: values });
      toast("Usuario creado");
      await loadAll();
    },
  })
);

$("tbl-usuarios").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-usuario]");
  if (b && confirm("¿Eliminar este usuario?")) {
    await call("eliminar_usuario", { id: Number(b.dataset.delUsuario) });
    toast("Usuario eliminado");
    await loadAll();
  }
});

$("btn-logout").addEventListener("click", () => {
  state.usuarioActual = null;
  $("app").classList.add("hidden");
  mostrarLogin();
});

// ---------- conexión, login y actualización de la base ----------

const conexionScreen = $("conexion-screen");
const conexionError = $("conexion-error");

$("conexion-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  conexionError.textContent = "";
  const boton = $("conexion-submit");
  boton.disabled = true;
  boton.textContent = "Conectando...";
  try {
    await invoke("configurar_conexion", { url: $("conexion-url").value, anonKey: $("conexion-anon-key").value });
    conexionScreen.classList.add("hidden");
    await mostrarLogin();
  } catch (err) {
    conexionError.textContent = typeof err === "string" ? err : "No se pudo conectar";
  } finally {
    boton.disabled = false;
    boton.textContent = "Conectar";
  }
});

const loginScreen = $("login-screen");
const loginForm = $("login-form");
const loginError = $("login-error");

async function mostrarLogin(recordadas) {
  loginError.textContent = "";
  loginForm.reset();
  const esPrimerUso = !(await call("hay_usuarios"));
  $("login-field-nombre").style.display = esPrimerUso ? "flex" : "none";
  $("login-nombre").required = esPrimerUso;
  $("login-subtitle").textContent = esPrimerUso ? "Todavía no hay usuarios — creá el primero para empezar" : "Ingresá tu usuario y contraseña";
  $("login-submit").textContent = esPrimerUso ? "Crear usuario y entrar" : "Ingresar";
  loginForm.dataset.modo = esPrimerUso ? "crear" : "login";
  if (recordadas) {
    $("login-username").value = recordadas.username;
    $("login-password").value = recordadas.password;
  }
  loginScreen.classList.remove("hidden");
}

async function verificarBase() {
  const ok = await invoke("base_actualizada").catch(() => false);
  if (ok) {
    $("migracion-screen").classList.add("hidden");
    return true;
  }
  try {
    $("migracion-sql").value = await (await fetch("migracion-0.3.0.sql")).text();
  } catch {
    $("migracion-sql").value = "No se pudo leer el archivo de migración.";
  }
  $("migracion-screen").classList.remove("hidden");
  return false;
}

$("migracion-copiar").addEventListener("click", async () => {
  const ta = $("migracion-sql");
  ta.select();
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    document.execCommand("copy");
  }
  toast("Código copiado. Pegalo en el SQL Editor de Supabase.");
});
$("migracion-reintentar").addEventListener("click", async () => {
  $("migracion-error").textContent = "";
  if (await verificarBase()) await entrarAlApp(state.usuarioActual);
  else $("migracion-error").textContent = "Todavía no se ven los cambios. Revisá que haya dicho \"Success\" y esperá unos segundos.";
});

async function entrarAlApp(usuario) {
  state.usuarioActual = usuario;
  $("user-name").textContent = usuario.nombre_completo;
  $("user-avatar").textContent = usuario.nombre_completo.trim().charAt(0).toUpperCase() || "?";
  loginScreen.classList.add("hidden");
  invoke("maximizar_ventana").catch(console.error);
  if (!(await verificarBase())) return;
  $("app").classList.remove("hidden");
  await loadAll();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const username = $("login-username").value;
  const password = $("login-password").value;
  try {
    let usuario;
    if (loginForm.dataset.modo === "crear") usuario = await invoke("crear_usuario", { nuevo: { username, password, nombre_completo: $("login-nombre").value } });
    else usuario = await invoke("iniciar_sesion", { username, password });
    try {
      if ($("login-recordar").checked) await invoke("guardar_credenciales", { username, password });
      else await invoke("borrar_credenciales");
    } catch (err) {
      console.error(err);
    }
    await entrarAlApp(usuario);
  } catch (err) {
    loginError.textContent = typeof err === "string" ? err : "No se pudo iniciar sesión";
  }
});

// Atajos: Esc cierra modales
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!printOverlay.classList.contains("hidden")) cerrarPrint();
  else if (!modalOverlay.classList.contains("hidden")) closeModal();
});

// ---------- arranque ----------

async function arrancar() {
  try {
    await invoke("revisar_actualizaciones");
  } catch (err) {
    console.error(err);
  }
  try {
    $("app-version").textContent = `v${await invoke("obtener_version")}`;
  } catch (err) {
    console.error(err);
  }
  let conectado;
  try {
    conectado = await invoke("hay_configuracion_conexion");
  } catch (err) {
    conexionError.textContent = typeof err === "string" ? err : "No se pudo conectar con la base guardada";
    conexionScreen.classList.remove("hidden");
    return;
  }
  if (conectado) {
    let recordadas = null;
    try {
      recordadas = await invoke("leer_credenciales_guardadas");
    } catch (err) {
      console.error(err);
    }
    await mostrarLogin(recordadas);
  } else {
    conexionScreen.classList.remove("hidden");
  }
}

arrancar().catch((e) => console.error(e));
