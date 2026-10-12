// Utilidades sin dependencias de la interfaz (se pueden probar con node).

export const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];

export const esc = (s) =>
  (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const money = (n) =>
  "$ " + Number(n ?? 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const numero = (n, dec = 2) =>
  Number(n ?? 0).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const fmtDate = (s) => {
  if (!s) return "-";
  const [y, m, d] = s.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

export const hoyIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "2026-10" → "OCTUBRE 2026" */
export const periodoTexto = (p) => {
  if (!p) return "";
  const [y, m] = p.split("-");
  return `${MESES[Number(m) - 1]} ${y}`;
};

export const periodoTitulo = (p) => {
  const t = periodoTexto(p).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Suma meses a un período "YYYY-MM". */
export function sumarMeses(periodo, n) {
  const [y, m] = periodo.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function mesesEntre(pDesde, pHasta) {
  const [y1, m1] = pDesde.split("-").map(Number);
  const [y2, m2] = pHasta.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

/** "Mes 4/12": número de mes del período dentro del contrato. */
export function mesDeContrato(fechaInicio, fechaFin, periodo) {
  const ini = fechaInicio.slice(0, 7);
  const fin = fechaFin.slice(0, 7);
  let total = mesesEntre(ini, fin) + 1;
  // Contratos que terminan el día anterior al de inicio (ej. 01/07 → 30/06) no suman un mes extra.
  if (Number(fechaFin.slice(8, 10)) <= Number(fechaInicio.slice(8, 10))) total -= 1;
  return { mes: mesesEntre(ini, periodo) + 1, total: Math.max(total, 1) };
}

/** Fecha de vencimiento de un período según el día de pago del contrato. */
export function vencimientoDe(periodo, diaPago) {
  const [y, m] = periodo.split("-").map(Number);
  const ultimo = new Date(y, m, 0).getDate();
  const d = Math.min(Math.max(1, diaPago), ultimo);
  return `${periodo}-${String(d).padStart(2, "0")}`;
}

export function diasEntre(isoDesde, isoHasta) {
  const a = Date.UTC(...isoDesde.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  const b = Date.UTC(...isoHasta.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.round((b - a) / 86400000);
}

// ---------- monto en letras ----------

const UNIDADES = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUN", "VEINTIDOS", "VEINTITRES", "VEINTICUATRO", "VEINTICINCO", "VEINTISEIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function hasta999(n) {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100);
  const r = n % 100;
  let txt = CENTENAS[c];
  if (r > 0) {
    let dec;
    if (r < 30) dec = UNIDADES[r];
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      dec = DECENAS[d] + (u ? " Y " + UNIDADES[u] : "");
    }
    txt = (txt ? txt + " " : "") + dec;
  }
  return txt;
}

function enteroEnLetras(n) {
  if (n === 0) return "CERO";
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? "UN MILLON" : enteroEnLetras(millones) + " MILLONES");
  if (miles) partes.push(miles === 1 ? "MIL" : hasta999(miles) + " MIL");
  if (resto) partes.push(hasta999(resto));
  return partes.join(" ");
}

/** 350000 → "TRESCIENTOS CINCUENTA MIL CON 00/100 CTS." */
export function montoEnLetras(monto) {
  const total = Math.round(Math.abs(Number(monto) || 0) * 100);
  const entero = Math.floor(total / 100);
  const cent = total % 100;
  let txt = enteroEnLetras(entero);
  // "UN" al final se lee "UNO" (ej. "CIENTO UNO"), salvo antes de MIL/MILLON.
  if (/\bUN$/.test(txt)) txt = txt.replace(/UN$/, "UNO");
  if (/\bVEINTIUN$/.test(txt)) txt = txt.replace(/VEINTIUN$/, "VEINTIUNO");
  return `${txt} CON ${String(cent).padStart(2, "0")}/100 CTS.`;
}

// ---------- WhatsApp ----------

/**
 * Normaliza un teléfono argentino al formato internacional que pide WhatsApp
 * (549 + código de área sin 0 + número sin 15). `areaDefecto` se usa cuando
 * el número se cargó sin característica (ej. "563371" → 3468 563371).
 */
export function telefonoWhatsapp(tel, areaDefecto = "3468") {
  let d = String(tel || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("549")) d = d.slice(3);
  else if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  const area = String(areaDefecto || "").replace(/\D/g, "").replace(/^0/, "");
  if (d.length === 12 || d.length === 11) {
    // con "15" después de la característica: 3468 15 563371
    for (const largo of [4, 3, 2]) {
      if (d.slice(largo, largo + 2) === "15" && d.length - 2 === 10) {
        d = d.slice(0, largo) + d.slice(largo + 2);
        break;
      }
    }
  }
  if (d.length < 10) {
    if (d.startsWith("15") && area && area.length + d.length - 2 === 10) d = d.slice(2);
    if (area && area.length + d.length === 10) d = area + d;
  }
  if (d.length !== 10) return null;
  return "549" + d;
}

export function enlaceWhatsapp(telNormalizado, mensaje) {
  return `https://wa.me/${telNormalizado}?text=${encodeURIComponent(mensaje)}`;
}

/** Reemplaza {campos} en una plantilla de mensaje. */
export function completarPlantilla(plantilla, datos) {
  return (plantilla || "").replace(/\{(\w+)\}/g, (m, k) => (datos[k] !== undefined && datos[k] !== null ? String(datos[k]) : m));
}

export function primerNombre(nombreCompleto) {
  // Los nombres se cargan "APELLIDO NOMBRES": para saludar se usa el primer nombre si se puede.
  const partes = (nombreCompleto || "").trim().split(/\s+/);
  const n = partes.length >= 2 ? partes[1] : partes[0] || "";
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

// ---------- IPC ----------

/**
 * Arma la serie de índice IPC (periodo → valor) combinando la de INDEC con
 * los meses cargados a mano (variación %) que vengan después del último
 * mes publicado en la API.
 */
export function serieIpcCompleta(serieApi, manual) {
  const mapa = new Map(serieApi.map(([p, v]) => [p, v]));
  let ultimo = serieApi.length ? serieApi[serieApi.length - 1][0] : null;
  const manualOrdenado = [...manual].sort((a, b) => a.periodo.localeCompare(b.periodo));
  for (const m of manualOrdenado) {
    if (ultimo && m.periodo <= ultimo) continue;
    const anterior = ultimo ? mapa.get(ultimo) : 100;
    const previo = ultimo ? sumarMeses(m.periodo, -1) : null;
    if (ultimo && previo !== ultimo) break; // hay un hueco: no se puede encadenar
    mapa.set(m.periodo, (anterior ?? 100) * (1 + m.variacion / 100));
    ultimo = m.periodo;
  }
  return { mapa, ultimo };
}

/**
 * Aumento por IPC para una actualización que rige desde `fechaVigencia`,
 * acumulando los últimos `meses` meses publicados antes de esa fecha.
 * Devuelve { porcentaje, desde, hasta, meses: [{periodo, variacion}] } o null.
 */
export function calcularIpc(serie, fechaVigencia, meses) {
  const { mapa, ultimo } = serie;
  if (!ultimo) return null;
  let hasta = sumarMeses(fechaVigencia.slice(0, 7), -1);
  if (hasta > ultimo) hasta = ultimo;
  const base = sumarMeses(hasta, -meses);
  if (!mapa.has(hasta) || !mapa.has(base)) return null;
  const detalle = [];
  for (let i = meses - 1; i >= 0; i--) {
    const p = sumarMeses(hasta, -i);
    const ant = mapa.get(sumarMeses(p, -1));
    const act = mapa.get(p);
    detalle.push({ periodo: p, variacion: ant && act ? (act / ant - 1) * 100 : null });
  }
  return {
    porcentaje: (mapa.get(hasta) / mapa.get(base) - 1) * 100,
    desde: sumarMeses(base, 1),
    hasta,
    meses: detalle,
    completo: hasta === sumarMeses(fechaVigencia.slice(0, 7), -1),
  };
}
