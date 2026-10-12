// Lectura del DNI argentino a partir de una foto o del texto de un lector
// de códigos de barras.
//
// El DNI tarjeta trae un código PDF417 (frente en los DNI nuevos, dorso en
// los modelos 2009-2012) con apellido, nombres, sexo, número, fecha de
// nacimiento, etc. separados por "@". Leer ese código es mucho más confiable
// que tratar de leer el texto impreso (OCR), y funciona sin internet.

let zxingListo = null;

function cargarZxing() {
  if (zxingListo) return zxingListo;
  zxingListo = new Promise((resolve, reject) => {
    if (window.ZXingWASM) return resolve(window.ZXingWASM);
    const s = document.createElement("script");
    s.src = "vendor/zxing-reader.js";
    s.onload = () => {
      // El .wasm va incluido en la app (carpeta vendor), no se baja de internet.
      window.ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? "vendor/zxing_reader.wasm" : prefix + path) },
      });
      resolve(window.ZXingWASM);
    };
    s.onerror = () => reject(new Error("No se pudo cargar el lector de códigos"));
    document.head.appendChild(s);
  });
  return zxingListo;
}

/** Busca un código PDF417 en la imagen (Blob/File). Devuelve el texto o null. */
export async function leerCodigoDni(blob) {
  const zx = await cargarZxing();
  const opciones = { formats: ["PDF417"], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1 };
  let res = await zx.readBarcodes(blob, opciones);
  if (res.length && res[0].isValid) return res[0].text;
  // Segundo intento: la foto en escala de grises y más chica suele ayudar
  // con fotos de celular muy grandes o con reflejos.
  try {
    const img = await cargarImagen(blob);
    for (const ancho of [1600, 1100]) {
      const canvas = dibujar(img, ancho, true);
      const datos = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      res = await zx.readBarcodes(datos, opciones);
      if (res.length && res[0].isValid) return res[0].text;
    }
  } catch (e) {
    console.error(e);
  }
  return null;
}

function fechaIso(ddmmaaaa) {
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec((ddmmaaaa || "").trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function titulo(s) {
  return (s || "").replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Interpreta el texto del código del DNI. Acepta los dos formatos conocidos:
 *  - DNI tarjeta actual (frente): tramite@APELLIDO@NOMBRES@SEXO@DNI@EJEMPLAR@NACIMIENTO@EMISION@...
 *  - DNI 2009-2012 (dorso):       @DNI@EJEMPLAR@...@APELLIDO@NOMBRES@NACIONALIDAD@NACIMIENTO@SEXO@EMISION@...
 * Algunos lectores USB con teclado en inglés escriben " en lugar de @.
 */
export function interpretarCodigoDni(texto) {
  if (!texto) return null;
  let t = texto.trim();
  if (!t.includes("@") && (t.match(/"/g) || []).length >= 4) t = t.replace(/"/g, "@");
  const p = t.split("@").map((x) => x.trim());
  if (p.length < 7) return null;

  let datos = null;
  if (p[0] === "" && /^\d{7,8}$/.test(p[1].replace(/\s/g, ""))) {
    // formato 2009-2012
    datos = {
      dni: p[1].replace(/\s/g, ""),
      ejemplar: p[2],
      apellido: titulo(p[4]),
      nombres: titulo(p[5]),
      nacionalidad: titulo(p[6]),
      fecha_nacimiento: fechaIso(p[7]),
      sexo: (p[8] || "").toUpperCase().slice(0, 1),
    };
  } else {
    const idxDni = p.findIndex((x, i) => i >= 3 && /^\d{7,8}$/.test(x));
    if (idxDni < 0) return null;
    datos = {
      tramite: p[0],
      apellido: titulo(p[idxDni - 3]),
      nombres: titulo(p[idxDni - 2]),
      sexo: (p[idxDni - 1] || "").toUpperCase().slice(0, 1),
      dni: p[idxDni],
      ejemplar: p[idxDni + 1],
      fecha_nacimiento: fechaIso(p[idxDni + 2]),
      nacionalidad: "ARGENTINA",
    };
  }
  if (!datos.dni || !datos.apellido) return null;
  datos.nombre_completo = `${datos.apellido} ${datos.nombres}`.trim();
  datos.cuil = calcularCuil(datos.dni, datos.sexo);
  return datos;
}

/** CUIL/CUIT a partir del DNI y el sexo (algoritmo de AFIP/ARCA, módulo 11). */
export function calcularCuil(dni, sexo) {
  const num = String(dni || "").replace(/\D/g, "").padStart(8, "0");
  if (num.length !== 8 || !["M", "F"].includes(sexo)) return null;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const digito = (pref) => {
    const base = pref + num;
    const suma = base.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const r = 11 - (suma % 11);
    return r === 11 ? 0 : r;
  };
  let pref = sexo === "M" ? "20" : "27";
  let d = digito(pref);
  if (d === 10) {
    pref = "23";
    d = sexo === "M" ? 9 : 4;
  }
  return `${pref}-${num}-${d}`;
}

// ---------- imágenes ----------

export function cargarImagen(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo abrir la imagen"));
    };
    img.src = url;
  });
}

function dibujar(img, anchoMax, gris = false) {
  const escala = Math.min(1, anchoMax / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * escala);
  canvas.height = Math.round(img.naturalHeight * escala);
  const ctx = canvas.getContext("2d");
  if (gris) ctx.filter = "grayscale(1) contrast(1.25)";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Achica la foto para guardarla en la base (JPEG ~150-250 KB). */
export async function comprimirFoto(blob, anchoMax = 1400) {
  const img = await cargarImagen(blob);
  return dibujar(img, anchoMax).toDataURL("image/jpeg", 0.8);
}

export function dataUrlABlob(dataUrl) {
  const [cab, b64] = dataUrl.split(",");
  const mime = /data:(.*?);/.exec(cab)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
