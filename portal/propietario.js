// Portal del propietario de Carranza Inmobiliaria.
//
// Cada propietario entra con su link personal (…/#p=CODIGO). Con ese código
// la base devuelve sólo lo suyo (función portal_datos_propietario): sus
// inmuebles, quién los alquila, los cobros, las liquidaciones, los reclamos
// de los inquilinos (con fotos) y las fotos de la propiedad. Puede dejar un
// comentario en cada reclamo, que la inmobiliaria ve en el programa.

import { esc, money, fmtDate, hoyIso, periodoTitulo, sumarMeses, vencimientoDe, telefonoWhatsapp, primerNombre } from "./util.js";
import { htmlLiquidacion, totalesLiquidacion } from "./documentos.js";

const C = window.PORTAL_CONFIG || {};
const $ = (id) => document.getElementById(id);
const app = $("app");

let token = "";
let D = null;
let pestana = "propiedades";
let inmuebleSel = "todos";

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
const fechaHora = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const TIPO_ACT = { porcentaje_fijo: "porcentaje fijo", ipc: "IPC", icl: "ICL", casa_propia: "Casa Propia" };
const direccionDe = (m) => [m?.direccion, m?.piso_depto].filter(Boolean).join(" ");

function montoVigente(c, fecha) {
  const a = (c.actualizaciones || []).filter((x) => x.fecha_vigencia <= fecha).sort((x, y) => x.fecha_vigencia.localeCompare(y.fecha_vigencia)).pop();
  return a ? Number(a.monto_nuevo) : Number(c.monto_inicial);
}
function proximaActualizacion(c) {
  const hoy = hoyIso();
  const frec = Number(c.frecuencia_actualizacion_meses || 0);
  if (!frec) return null;
  const ult = (c.actualizaciones || []).map((a) => a.fecha_vigencia).sort().pop();
  const base = ult || c.fecha_inicio;
  const dia = base.slice(8, 10);
  let f = `${sumarMeses(base.slice(0, 7), frec)}-${dia}`;
  for (let i = 0; i < 40 && f <= hoy; i++) f = `${sumarMeses(f.slice(0, 7), frec)}-${dia}`;
  return f > c.fecha_fin ? null : f;
}

/** Meses del contrato hasta hoy (los últimos `max`), con su estado de cobro. */
function mesesDe(c, max = 12) {
  const hoy = hoyIso();
  const porPeriodo = new Map();
  for (const p of c.pagos || []) if (!porPeriodo.has(p.periodo)) porPeriodo.set(p.periodo, p);
  const desde = c.fecha_inicio.slice(0, 7);
  const hasta = [hoy.slice(0, 7), c.fecha_fin.slice(0, 7)].sort()[0];
  const lista = [];
  for (let p = hasta; p >= desde && lista.length < max; p = sumarMeses(p, -1)) {
    const venc = vencimientoDe(p, c.dia_pago);
    const pago = porPeriodo.get(p);
    const liquidadoAntes = c.liquidado_hasta && p <= c.liquidado_hasta;
    let estado;
    if (pago) estado = pago.liquidado || liquidadoAntes ? "liquidado" : "cobrado";
    else if (liquidadoAntes) estado = "liquidado";
    else if (venc <= hoy) estado = "pendiente";
    else estado = "por_vencer";
    lista.push({ periodo: p, venc, pago, estado, monto: pago ? Number(pago.monto_alquiler) : montoVigente(c, venc) });
  }
  return lista;
}
const ESTADO_MES = {
  liquidado: ["Cobrado y liquidado", "pill-ok"],
  cobrado: ["Cobrado · a liquidar", "pill-warn"],
  pendiente: ["Sin cobrar", "pill-bad"],
  por_vencer: ["Todavía no vence", "pill-gris"],
};

const contratoActual = (m) => (m.contratos || []).find((c) => c.estado === "activo") || (m.contratos || [])[0] || null;
const inmueblesVisibles = () => (D.inmuebles || []).filter((m) => inmuebleSel === "todos" || String(m.id) === inmuebleSel);

/** Liquidaciones agrupadas por número de comprobante. */
function liquidaciones() {
  const grupos = new Map();
  for (const l of D.liquidaciones || []) {
    if (!grupos.has(l.numero_comprobante)) grupos.set(l.numero_comprobante, []);
    grupos.get(l.numero_comprobante).push(l);
  }
  return [...grupos.entries()].map(([numero, filas]) => ({ numero, filas, fecha: filas[0].fecha, ...totalesLiquidacion(filas) })).sort((a, b) => Number(b.numero) - Number(a.numero));
}

// ---------- pantalla ----------
function botonContacto(texto = "Escribir a la inmobiliaria", mensaje = "") {
  const cfg = D?.config || {};
  const tel = telefonoWhatsapp(cfg.wa_inmobiliaria || cfg.inmobiliaria_telefono || "", cfg.wa_codigo_area || "3468");
  return tel ? `<a class="btn btn-wa" href="https://wa.me/${tel}${mensaje ? `?text=${encodeURIComponent(mensaje)}` : ""}" target="_blank" rel="noopener">💬 ${esc(texto)}</a>` : "";
}

function render() {
  const p = D.propietario || {};
  const cfg = D.config || {};
  if (cfg.recibo_logo) $("cab-logo").src = cfg.recibo_logo;
  if (cfg.inmobiliaria_nombre) $("cab-marca").textContent = cfg.inmobiliaria_nombre.replace(/\s*inmobiliaria\s*/i, "").toUpperCase();
  const inms = D.inmuebles || [];
  if (!inms.length) {
    app.innerHTML = `<div class="card error-caja"><h1>Hola ${esc(primerNombre(p.nombre || ""))}</h1><p>No encontramos propiedades a tu nombre. Consultá con la inmobiliaria.</p>${botonContacto()}</div>`;
    return;
  }
  const avisos = (D.avisos || []).map((a) => `<div class="aviso"><b>${esc(a.titulo)}</b>${a.texto ? `<p>${esc(a.texto)}</p>` : ""}</div>`).join("");
  const abiertos = (D.reclamos || []).filter((r) => r.estado !== "resuelto").length;
  const tabs = `<div class="tabs" id="tabs">${[
    ["propiedades", "Propiedades"],
    ["cobros", "Cobros"],
    ["liquidaciones", "Liquidaciones"],
    ["reclamos", `Reclamos${abiertos ? ` (${abiertos})` : ""}`],
    ["datos", "Mis datos"],
  ]
    .map(([k, l]) => `<button class="${pestana === k ? "activo" : ""}" data-t="${k}">${l}</button>`)
    .join("")}</div>`;
  const filtro =
    inms.length > 1 && ["propiedades", "cobros", "reclamos"].includes(pestana)
      ? `<div class="campo" style="margin:0"><select id="sel-inmueble"><option value="todos">Todas mis propiedades (${inms.length})</option>${inms
          .map((m) => `<option value="${m.id}" ${String(m.id) === inmuebleSel ? "selected" : ""}>${m.codigo != null ? `${esc(m.codigo)} · ` : ""}${esc(direccionDe(m))}</option>`)
          .join("")}</select></div>`
      : "";
  const cuerpo =
    pestana === "cobros" ? vistaCobros() : pestana === "liquidaciones" ? vistaLiquidaciones() : pestana === "reclamos" ? vistaReclamos() : pestana === "datos" ? vistaDatos() : vistaPropiedades();
  app.innerHTML = `
    <div class="hola"><h1>Hola, ${esc(primerNombre(p.nombre || ""))}</h1><p>Portal del propietario · ${inms.length} ${inms.length === 1 ? "propiedad" : "propiedades"}</p></div>
    ${avisos}${tabs}${filtro}${cuerpo}
    <div class="pie">${esc(cfg.inmobiliaria_nombre || "Carranza Inmobiliaria")}${cfg.inmobiliaria_matricula ? ` · ${esc(cfg.inmobiliaria_matricula)}` : ""}${cfg.inmobiliaria_direccion ? `<br/>${esc(cfg.inmobiliaria_direccion)}${cfg.inmobiliaria_localidad ? `, ${esc(cfg.inmobiliaria_localidad)}` : ""}` : ""}</div>`;
}

function vistaPropiedades() {
  return inmueblesVisibles()
    .map((m) => {
      const c = contratoActual(m);
      const reclamos = (D.reclamos || []).filter((r) => r.inmueble_id === m.id && r.estado !== "resuelto").length;
      let alquiler = `<div class="estado bad" style="margin-bottom:8px"><b>Sin contrato vigente</b></div>`;
      if (c) {
        const meses = mesesDe(c, 24);
        const sinCobrar = meses.filter((x) => x.estado === "pendiente");
        const act = proximaActualizacion(c);
        const estado = sinCobrar.length
          ? `<div class="estado bad"><b>${sinCobrar.length === 1 ? "1 mes sin cobrar" : `${sinCobrar.length} meses sin cobrar`}</b><small>${sinCobrar.map((x) => periodoTitulo(x.periodo)).join(", ")}</small></div>`
          : `<div class="estado ok"><b>✓ Alquiler al día</b><small>Último cobro: ${meses.find((x) => x.pago) ? periodoTitulo(meses.find((x) => x.pago).periodo) : "—"}</small></div>`;
        alquiler = `${c.estado === "activo" ? estado : `<div class="estado bad"><b>Contrato ${esc(c.estado)}</b></div>`}
          <div class="fila"><span>Inquilino</span><b>${esc(c.inquilino?.nombre || "")}</b></div>
          <div class="fila"><span>Alquiler actual</span><b class="grande">${money(montoVigente(c, hoyIso()))}</b></div>
          <div class="fila"><span>Contrato</span><b>${c.numero ? `N° ${esc(c.numero)} · ` : ""}${fmtDate(c.fecha_inicio)} al ${fmtDate(c.fecha_fin)}</b></div>
          ${act ? `<div class="fila"><span>Próxima actualización</span><b>${fmtDate(act)}<br/><small>por ${esc(TIPO_ACT[c.tipo_actualizacion] || c.tipo_actualizacion || "")}, cada ${esc(c.frecuencia_actualizacion_meses)} meses</small></b></div>` : ""}
          <div class="fila"><span>Vence cada mes el día</span><b>${esc(c.dia_pago)}</b></div>`;
      }
      const fotos = (m.fotos || []).slice(0, 12);
      return `<section class="card"><h2>${m.codigo != null ? `${esc(m.codigo)} · ` : ""}${esc(direccionDe(m))}${m.localidad ? ` · ${esc(m.localidad)}` : ""}</h2>
        ${alquiler}
        ${reclamos ? `<button class="btn btn-claro" style="margin-top:10px" data-t="reclamos" data-inm="${m.id}">🛠 ${reclamos} ${reclamos === 1 ? "reclamo abierto" : "reclamos abiertos"} — ver</button>` : ""}
        ${
          fotos.length
            ? `<h2 style="margin-top:14px">Fotos de la propiedad</h2><div class="galeria">${fotos
                .map((f) => `<button class="foto-mini" data-foto-inm="${f.id}" title="${esc(f.descripcion || f.tipo || "")}">${f.miniatura ? `<img src="${esc(f.miniatura)}" alt="" />` : "📷"}<span>${esc(f.tipo || "")}${f.fecha ? ` · ${fmtDate(f.fecha)}` : ""}</span></button>`)
                .join("")}</div>`
            : ""
        }
      </section>`;
    })
    .join("");
}

function vistaCobros() {
  const html = inmueblesVisibles()
    .map((m) => {
      const c = contratoActual(m);
      if (!c) return "";
      const filas = mesesDe(c, 12)
        .map((x) => {
          const [t, cl] = ESTADO_MES[x.estado];
          return `<div class="item"><div class="item-txt"><b>${periodoTitulo(x.periodo)} · ${money(x.monto)}</b><small>${x.pago ? `Cobrado el ${fmtDate(x.pago.fecha_pago)}${x.pago.numero_recibo ? ` · recibo N° ${esc(x.pago.numero_recibo)}` : ""}` : `Vence ${fmtDate(x.venc)}`}</small></div><span class="pill ${cl}">${t}</span></div>`;
        })
        .join("");
      return `<section class="card"><h2>${m.codigo != null ? `${esc(m.codigo)} · ` : ""}${esc(direccionDe(m))} — ${esc(c.inquilino?.nombre || "")}</h2><div class="lista">${filas || '<p class="vacio">Todavía no hay meses.</p>'}</div></section>`;
    })
    .join("");
  return (
    html ||
    `<section class="card"><p class="vacio">No hay contratos para mostrar.</p></section>`
  ) + `<p class="vacio" style="text-align:center">«Cobrado · a liquidar»: la inmobiliaria ya cobró ese mes y te lo incluye en la próxima liquidación.</p>`;
}

function vistaLiquidaciones() {
  const lista = liquidaciones();
  if (!lista.length) return `<section class="card"><h2>Liquidaciones</h2><p class="vacio">Todavía no hay liquidaciones emitidas en el sistema.</p></section>`;
  return `<section class="card"><h2>Liquidaciones</h2><div class="lista">${lista
    .map(
      (l, i) => `<div class="item"><div class="item-txt"><b>N° ${esc(l.numero)} · ${money(l.neto)}</b><small>${fmtDate(l.fecha)} · ${l.filas
        .map((f) => periodoTitulo(f.pagos?.periodo || ""))
        .filter(Boolean)
        .join(", ")}</small></div><button class="btn btn-negro" data-liq="${i}">Ver</button></div>`
    )
    .join("")}</div></section>`;
}

const ESTADO_RECLAMO = { nuevo: ["Nuevo", "pill-warn"], recibido: ["Recibido", "pill-gris"], en_arreglo: ["En arreglo", "pill-warn"], resuelto: ["Resuelto", "pill-ok"] };

function vistaReclamos() {
  const ids = new Set(inmueblesVisibles().map((m) => m.id));
  const lista = (D.reclamos || []).filter((r) => ids.has(r.inmueble_id));
  const inm = (id) => (D.inmuebles || []).find((m) => m.id === id);
  if (!lista.length) return `<section class="card"><h2>Reclamos de los inquilinos</h2><p class="vacio">No hay reclamos. 👍</p></section>`;
  return `<section class="card"><h2>Reclamos de los inquilinos</h2><p class="vacio" style="margin-top:0">Lo que comentes acá lo ve la inmobiliaria (por ejemplo: «autorizo el arreglo», «llamen a tal plomero»).</p><div class="lista">${lista
    .map((r) => {
      const [t, cl] = ESTADO_RECLAMO[r.estado] || [r.estado, "pill-gris"];
      const m = inm(r.inmueble_id);
      return `<div class="reclamo">
        <div class="item" style="border:0;padding-bottom:4px"><div class="item-txt"><b>${esc(r.titulo)}</b><small>${fechaHora(r.creado)} · ${esc(direccionDe(m))}${r.inquilino ? ` · ${esc(r.inquilino)}` : ""}</small></div><span class="pill ${cl}">${t}</span></div>
        ${r.descripcion ? `<p class="reclamo-desc">${esc(r.descripcion)}</p>` : ""}
        ${r.tiene_foto ? `<button class="btn btn-claro" data-foto-rec="${r.id}">📷 Ver foto que mandó el inquilino</button>` : ""}
        ${r.respuesta ? `<div class="respuesta"><b>Inmobiliaria:</b> ${esc(r.respuesta)}</div>` : ""}
        <div class="campo" style="margin:10px 0 0"><label>Tu comentario</label><textarea data-com="${r.id}" placeholder="Escribí tu comentario para la inmobiliaria">${esc(r.comentario_propietario || "")}</textarea>
        ${r.comentario_propietario_fecha ? `<small>Guardado ${fechaHora(r.comentario_propietario_fecha)}</small>` : ""}</div>
        <button class="btn btn-oro" data-com-guardar="${r.id}">Enviar comentario</button>
      </div>`;
    })
    .join("")}</div></section>`;
}

function vistaDatos() {
  const p = D.propietario || {};
  return `<section class="card"><h2>Mis datos en la inmobiliaria</h2>
      <div class="fila"><span>Nombre</span><b>${esc(p.nombre || "")}</b></div>
      ${p.dni_cuit ? `<div class="fila"><span>DNI / CUIT</span><b>${esc(p.dni_cuit)}</b></div>` : ""}
      ${p.cuit_cuil ? `<div class="fila"><span>CUIT / CUIL</span><b>${esc(p.cuit_cuil)}</b></div>` : ""}
      ${p.telefono ? `<div class="fila"><span>Teléfono</span><b>${esc(p.telefono)}</b></div>` : ""}
      ${p.email ? `<div class="fila"><span>Email</span><b>${esc(p.email)}</b></div>` : ""}
    </section>
    <section class="card"><h2>Cuenta para las transferencias</h2>
      ${p.datos_bancarios ? `<div class="transferir">${esc(p.datos_bancarios)}</div>` : '<p class="vacio">No tenemos cargada tu cuenta bancaria.</p>'}
      <p class="vacio">Si algo está mal o cambió, avisanos.</p>
      ${botonContacto("Avisar un cambio de datos", "Hola! Quiero actualizar mis datos: ")}
    </section>`;
}

// ---------- acciones ----------
function verFoto(titulo, src) {
  abrirHoja(titulo, `<img src="${esc(src)}" alt="" style="max-width:100%;border-radius:10px;display:block;margin:0 auto" />
    <div class="botones"><a class="btn btn-negro" href="${esc(src)}" download="foto.jpg">⬇ Descargar</a><button class="btn btn-claro" id="btn-cerrar-f">Cerrar</button></div>`);
  $("btn-cerrar-f").onclick = cerrarHoja;
}

function verLiquidacion(l) {
  const html = htmlLiquidacion(l.filas, D.config || {});
  abrirHoja(`Liquidación N° ${l.numero}`, `<iframe class="recibo-marco" id="liq-marco" title="Liquidación"></iframe>
    <div class="botones"><button class="btn btn-negro" id="btn-imprimir">⬇ Guardar PDF / imprimir</button><button class="btn btn-claro" id="btn-cerrar-l">Cerrar</button></div>
    <p class="vacio">Para guardarla, tocá «Guardar PDF» y elegí «Guardar como PDF».</p>`);
  const fr = $("liq-marco");
  fr.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="recibo.css">
    <style>@page{size:A4 portrait;margin:10mm} html,body{margin:0;background:#fff} .zoom{transform-origin:0 0;width:max-content} @media print{.zoom{transform:none!important}}</style></head>
    <body><div class="zoom" id="z">${html}</div></body></html>`;
  fr.onload = () => {
    const z = fr.contentDocument.getElementById("z");
    const k = Math.min(1, (fr.clientWidth - 2) / (z.scrollWidth || 720));
    z.style.transform = `scale(${k})`;
    fr.style.height = Math.ceil(z.scrollHeight * k + 4) + "px";
  };
  $("btn-imprimir").onclick = () => fr.contentWindow.print();
  $("btn-cerrar-l").onclick = cerrarHoja;
}

function enganchar() {
  $("hoja-x").addEventListener("click", cerrarHoja);
  $("hoja").addEventListener("click", (e) => e.target.id === "hoja" && cerrarHoja());
  app.addEventListener("change", (e) => {
    if (e.target.id === "sel-inmueble") {
      inmuebleSel = e.target.value;
      render();
    }
  });
  app.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.t) {
      pestana = b.dataset.t;
      if (b.dataset.inm) inmuebleSel = b.dataset.inm;
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    if (b.dataset.liq) verLiquidacion(liquidaciones()[Number(b.dataset.liq)]);
    if (b.dataset.fotoInm || b.dataset.fotoRec) {
      const esRec = !!b.dataset.fotoRec;
      b.disabled = true;
      try {
        const src = await rpc("portal_prop_foto", { p_token: token, p_que: esRec ? "reclamo" : "inmueble", p_id: Number(b.dataset.fotoRec || b.dataset.fotoInm) });
        if (!src) return toast("No se encontró la foto", true);
        verFoto(esRec ? "Foto del reclamo" : "Foto de la propiedad", src);
      } catch (err) {
        toast(err.message, true);
      } finally {
        b.disabled = false;
      }
    }
    if (b.dataset.comGuardar) {
      const id = Number(b.dataset.comGuardar);
      const texto = app.querySelector(`[data-com="${id}"]`).value;
      b.disabled = true;
      try {
        await rpc("portal_prop_comentar", { p_token: token, p_id: id, p_texto: texto });
        toast("Comentario enviado a la inmobiliaria ✓");
        await cargar(false);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
    }
  });
}

async function cargar(mostrarSpinner = true) {
  if (mostrarSpinner) app.innerHTML = `<div class="cargando"><div class="spinner"></div>Cargando tus propiedades…</div>`;
  D = await rpc("portal_datos_propietario", { p_token: token });
  render();
}

export async function iniciar(codigo) {
  token = codigo;
  document.title = "Mis propiedades · Carranza Inmobiliaria";
  const sub = document.querySelector(".cab-sub");
  if (sub) sub.textContent = "INMOBILIARIA · Mis propiedades";
  enganchar();
  if (!C.url || !C.anon) {
    app.innerHTML = `<div class="card error-caja"><h1>Portal en preparación</h1><p>Volvé a intentar en unos minutos.</p></div>`;
    return;
  }
  try {
    await cargar();
  } catch (e) {
    app.innerHTML = `<div class="card error-caja"><h1>No pudimos abrir tu cuenta</h1><p>${esc(e.message)}</p></div>`;
  }
}
