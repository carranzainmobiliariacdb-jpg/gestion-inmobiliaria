// Contratos desde modelo: modelos base, variables disponibles y el armado
// del documento con los datos de un contrato.
//
// Los modelos son HTML con marcadores {{grupo.dato}}. Se pueden editar desde
// la app (y crear nuevos pegando el texto de un contrato propio).

import { esc, money, fmtDate, hoyIso, mesesEntre, montoEnLetras, numeroEnLetras, fechaLetras, fechaLarga } from "./util.js";

// ---------- variables ----------

/** Grupos de datos que se pueden insertar, para los botones del editor. */
export const VARIABLES = [
  ["Lugar y fecha", [
    ["hoy.lugar", "Localidad de la inmobiliaria"],
    ["hoy.fecha", "Fecha de hoy (12/10/2026)"],
    ["hoy.fecha_letras", "Hoy en letras (12 de octubre de 2026)"],
    ["hoy.fecha_larga", "Hoy formal (a los doce días del mes…)"],
  ]],
  ["Propietario (locador)", [
    ["propietario.nombre", "Nombre"], ["propietario.dni", "DNI"], ["propietario.cuit", "CUIT/CUIL"],
    ["propietario.nacionalidad", "Nacionalidad"], ["propietario.estado_civil", "Estado civil"],
    ["propietario.domicilio", "Domicilio"], ["propietario.localidad", "Localidad"],
    ["propietario.telefono", "Teléfono"], ["propietario.email", "Email"], ["propietario.datos_bancarios", "Datos bancarios"],
  ]],
  ["Inquilino (locatario)", [
    ["inquilino.nombre", "Nombre"], ["inquilino.dni", "DNI"], ["inquilino.cuit", "CUIT/CUIL"],
    ["inquilino.nacionalidad", "Nacionalidad"], ["inquilino.estado_civil", "Estado civil"], ["inquilino.profesion", "Profesión"],
    ["inquilino.domicilio", "Domicilio"], ["inquilino.localidad", "Localidad"],
    ["inquilino.telefono", "Teléfono"], ["inquilino.email", "Email"],
  ]],
  ["Garantes", [
    ["garantes.parrafo", "Párrafo con todos los garantes"], ["garantes.firmas", "Líneas de firma de garantes"],
    ["garante1.nombre", "Garante 1: nombre"], ["garante1.dni", "Garante 1: DNI"], ["garante1.domicilio", "Garante 1: domicilio"], ["garante1.garantia", "Garante 1: garantía"],
    ["garante2.nombre", "Garante 2: nombre"], ["garante2.dni", "Garante 2: DNI"], ["garante2.domicilio", "Garante 2: domicilio"], ["garante2.garantia", "Garante 2: garantía"],
  ]],
  ["Seguro de caución (si hay)", [
    ["caucion.clausula", "Cláusula completa (sale solo si hay seguro de caución)"],
    ["caucion.aseguradora", "Aseguradora: nombre"], ["caucion.cuit", "Aseguradora: CUIT"],
    ["caucion.poliza", "Póliza y detalle (del campo «Detalle de la garantía»)"],
    ["caucion.domicilio", "Aseguradora: domicilio"],
  ]],
  ["Inmueble", [
    ["inmueble.direccion", "Dirección completa"], ["inmueble.localidad", "Localidad"], ["inmueble.provincia", "Provincia"],
    ["inmueble.tipo", "Tipo (casa, depto…)"], ["inmueble.descripcion", "Descripción (ambientes, dormitorios…)"],
    ["inmueble.nomenclatura", "Nomenclatura catastral"], ["inmueble.matricula", "Matrícula"], ["inmueble.cuenta_rentas", "Cuenta Rentas"],
    ["inmueble.cuenta_municipal", "Cuenta municipal"], ["inmueble.servicios", "Servicios (luz, agua, gas)"], ["inmueble.codigo", "Código interno"],
  ]],
  ["Contrato", [
    ["contrato.numero", "N° de contrato"], ["contrato.destino", "Destino"],
    ["contrato.fecha_inicio", "Inicio (01/07/2026)"], ["contrato.fecha_inicio_letras", "Inicio en letras"],
    ["contrato.fecha_fin", "Vencimiento (30/06/2029)"], ["contrato.fecha_fin_letras", "Vencimiento en letras"],
    ["contrato.plazo_meses", "Plazo en meses (36)"], ["contrato.plazo_letras", "Plazo en letras (treinta y seis)"],
    ["contrato.monto", "Alquiler inicial ($ 350.000,00)"], ["contrato.monto_letras", "Alquiler en letras"],
    ["contrato.monto_vigente", "Alquiler vigente hoy"], ["contrato.dia_pago", "Paga hasta el día"], ["contrato.dia_pago_letras", "Día de pago en letras"],
    ["contrato.indice", "Índice de actualización"], ["contrato.frecuencia", "Actualiza cada (meses)"], ["contrato.frecuencia_letras", "Frecuencia en letras"],
    ["contrato.porcentaje_fijo", "% fijo de aumento"], ["contrato.interes_diario", "Interés diario por mora (%)"],
    ["contrato.deposito", "Depósito en garantía"], ["contrato.deposito_letras", "Depósito en letras"],
    ["contrato.conceptos", "Conceptos mensuales (expensas…)"],
  ]],
  ["Inmobiliaria", [
    ["inmobiliaria.nombre", "Nombre"], ["inmobiliaria.matricula", "Matrícula"], ["inmobiliaria.direccion", "Dirección"],
    ["inmobiliaria.localidad", "Localidad"], ["inmobiliaria.telefono", "Teléfono"], ["inmobiliaria.email", "Email"],
    ["inmobiliaria.cuit", "CUIT"], ["inmobiliaria.jurisdiccion", "Tribunales (jurisdicción)"],
  ]],
];

const NOMBRE_INDICE = {
  IPC: "el Índice de Precios al Consumidor (IPC) publicado por el INDEC",
  ICL: "el Índice para Contratos de Locación (ICL) publicado por el Banco Central de la República Argentina",
  porcentaje_fijo: "un porcentaje fijo",
  casa_propia: "el índice Casa Propia",
  otro: "lo que las partes acuerden",
};

/** Número en letras delante de un sustantivo: 1 → "un", 21 → "veintiún". */
function cantidad(n) {
  return numeroEnLetras(n).replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");
}

function persona(p) {
  if (!p) return {};
  return {
    nombre: p.nombre,
    dni: p.dni_cuit,
    cuit: p.cuit_cuil,
    nacionalidad: p.nacionalidad ? p.nacionalidad.toLowerCase() : "",
    estado_civil: p.estado_civil ? p.estado_civil.toLowerCase() : "",
    profesion: p.profesion,
    domicilio: p.direccion,
    localidad: p.localidad,
    telefono: p.telefono,
    email: p.email,
    datos_bancarios: p.datos_bancarios,
    garantia: [p.tipo_garantia, p.detalle_garantia].filter(Boolean).join(": "),
  };
}

function frasePersona(p) {
  if (!p?.nombre) return "";
  const partes = [`<b>${esc(p.nombre)}</b>`];
  if (p.dni) partes.push(`DNI N° ${esc(p.dni)}`);
  if (p.cuit) partes.push(`CUIT/CUIL ${esc(p.cuit)}`);
  if (p.nacionalidad) partes.push(esc(p.nacionalidad));
  if (p.estado_civil) partes.push(esc(p.estado_civil));
  if (p.domicilio) partes.push(`con domicilio en ${esc(p.domicilio)}${p.localidad ? `, ${esc(p.localidad)}` : ""}`);
  return partes.join(", ");
}

/**
 * Arma el mapa de valores {"grupo.dato": texto} para un contrato.
 * ctx = { contrato, propietario, inquilino, garantes[], inmueble, cfg }
 */
export function valoresContrato({ contrato: c, propietario, inquilino, garantes = [], inmueble = {}, cfg = {} }) {
  const v = {};
  const poner = (grupo, obj) => Object.entries(obj).forEach(([k, val]) => (v[`${grupo}.${k}`] = val));
  const hoy = hoyIso();
  poner("hoy", { lugar: cfg.inmobiliaria_localidad, fecha: fmtDate(hoy), fecha_letras: fechaLetras(hoy), fecha_larga: fechaLarga(hoy) });
  poner("propietario", persona(propietario));
  poner("inquilino", persona(inquilino));
  garantes.forEach((g, i) => poner(`garante${i + 1}`, persona(g)));
  if (garantes.length) {
    v["garantes.parrafo"] = garantes.map((g) => frasePersona(persona(g))).join("; y ");
    v["garantes.firmas"] = garantes
      .map((g) => `<p style="margin-top:46px">______________________________<br/>${esc(g.nombre)} — DNI ${esc(g.dni_cuit || "")}<br/>Garante</p>`)
      .join("");
  } else {
    v["garantes.parrafo"] = "";
    v["garantes.firmas"] = "";
  }
  // Si entre los garantes hay un «Seguro de caución», se arma su cláusula.
  const caucion = garantes.find((g) => /seguro de cauci[óo]n/i.test(g.tipo_garantia || ""));
  if (caucion) {
    const pc = persona(caucion);
    v["caucion.aseguradora"] = pc.nombre;
    v["caucion.cuit"] = pc.dni;
    v["caucion.poliza"] = caucion.detalle_garantia || "";
    v["caucion.domicilio"] = pc.domicilio;
    let encabezado = `EL LOCATARIO acompaña, como garantía del fiel cumplimiento de todas las obligaciones asumidas en el presente contrato, Póliza de Seguro de Caución emitida por <b>${esc(pc.nombre)}</b>${pc.dni ? `, CUIT ${esc(pc.dni)}` : ""}${pc.domicilio ? `, con domicilio en ${esc(pc.domicilio)}` : ""}`;
    if (caucion.detalle_garantia) encabezado += `, conforme al siguiente detalle: ${esc(caucion.detalle_garantia)}`;
    const partes = [encabezado];
    partes.push("Las condiciones generales y particulares de la póliza forman parte integrante de este contrato");
    partes.push("La vigencia de la póliza deberá cubrir todo el plazo locativo y sus eventuales prórrogas; EL LOCATARIO se obliga a mantenerla vigente y a entregar a EL LOCADOR las renovaciones con no menos de treinta (30) días de anticipación a su vencimiento, bajo apercibimiento de ser considerado en mora en el cumplimiento del contrato");
    partes.push("La caución cubre alquileres, intereses, multas, servicios, impuestos, daños, gastos y costas, hasta la efectiva restitución del inmueble y la cancelación de todo lo adeudado");
    v["caucion.clausula"] = `<p><b>DECIMOQUINTA – SEGURO DE CAUCIÓN:</b> ${partes.join(". ")}.</p>`;
  } else {
    v["caucion.aseguradora"] = v["caucion.cuit"] = v["caucion.poliza"] = v["caucion.domicilio"] = "";
    v["caucion.clausula"] = "";
  }
  const dir = [inmueble.direccion, inmueble.piso_depto].filter(Boolean).join(" ");
  const desc = [
    inmueble.ambientes ? `${cantidad(inmueble.ambientes)} (${inmueble.ambientes}) ambiente${inmueble.ambientes > 1 ? "s" : ""}` : "",
    inmueble.dormitorios ? `${cantidad(inmueble.dormitorios)} (${inmueble.dormitorios}) dormitorio${inmueble.dormitorios > 1 ? "s" : ""}` : "",
    inmueble.banos ? `${cantidad(inmueble.banos)} (${inmueble.banos}) baño${inmueble.banos > 1 ? "s" : ""}` : "",
    inmueble.cochera ? "cochera" : "",
    inmueble.patio ? "patio" : "",
    inmueble.amoblado ? "amoblado" : "",
    inmueble.superficie_cubierta ? `${inmueble.superficie_cubierta} m² cubiertos` : "",
    inmueble.superficie ? `sobre un terreno de ${inmueble.superficie} m²` : "",
  ].filter(Boolean);
  poner("inmueble", {
    direccion: dir,
    localidad: inmueble.localidad,
    provincia: inmueble.provincia,
    tipo: inmueble.tipo ? inmueble.tipo.toLowerCase() : "",
    descripcion: desc.join(", "),
    nomenclatura: inmueble.nomenclatura_catastral,
    matricula: inmueble.matricula,
    cuenta_rentas: inmueble.cuenta_rentas,
    cuenta_municipal: inmueble.cuenta_municipal,
    servicios: [
      inmueble.servicio_luz && `luz: ${inmueble.servicio_luz}${inmueble.servicio_luz_contrato ? ` (contrato ${inmueble.servicio_luz_contrato})` : ""}`,
      !inmueble.servicio_luz && inmueble.servicio_luz_contrato && `luz: contrato ${inmueble.servicio_luz_contrato}`,
      inmueble.servicio_agua && `agua: ${inmueble.servicio_agua}`,
      inmueble.servicio_gas && `gas: ${inmueble.servicio_gas}`,
    ].filter(Boolean).join("; "),
    codigo: inmueble.codigo,
  });
  if (c) {
    let plazo = mesesEntre(c.fecha_inicio.slice(0, 7), c.fecha_fin.slice(0, 7)) + 1;
    if (Number(c.fecha_fin.slice(8, 10)) <= Number(c.fecha_inicio.slice(8, 10))) plazo -= 1;
    const conceptos = (c.conceptos_fijos || []).filter((x) => x.concepto);
    poner("contrato", {
      numero: c.numero ?? c.id,
      destino: c.destino ? c.destino.toLowerCase() : "vivienda",
      fecha_inicio: fmtDate(c.fecha_inicio),
      fecha_inicio_letras: fechaLetras(c.fecha_inicio),
      fecha_fin: fmtDate(c.fecha_fin),
      fecha_fin_letras: fechaLetras(c.fecha_fin),
      plazo_meses: plazo,
      plazo_letras: cantidad(plazo),
      monto: money(c.monto_inicial),
      monto_letras: montoEnLetras(c.monto_inicial).replace(" CTS.", "").toLowerCase(),
      monto_vigente: money(c.monto_vigente),
      dia_pago: c.dia_pago,
      dia_pago_letras: numeroEnLetras(c.dia_pago),
      indice: NOMBRE_INDICE[c.tipo_actualizacion] || c.tipo_actualizacion,
      frecuencia: c.frecuencia_actualizacion_meses,
      frecuencia_letras: cantidad(c.frecuencia_actualizacion_meses),
      porcentaje_fijo: c.porcentaje_actualizacion ? `${c.porcentaje_actualizacion}%` : "",
      interes_diario: c.tasa_mora_diaria ? `${String(c.tasa_mora_diaria).replace(".", ",")}%` : "",
      deposito: c.deposito_garantia ? money(c.deposito_garantia) : "",
      deposito_letras: c.deposito_garantia ? montoEnLetras(c.deposito_garantia).replace(" CTS.", "").toLowerCase() : "",
      conceptos: conceptos.map((x) => `${x.concepto} (${money(x.monto)})`).join(", "),
    });
  }
  poner("inmobiliaria", {
    nombre: cfg.inmobiliaria_nombre,
    matricula: cfg.inmobiliaria_matricula,
    direccion: cfg.inmobiliaria_direccion,
    localidad: cfg.inmobiliaria_localidad,
    telefono: cfg.inmobiliaria_telefono,
    email: cfg.inmobiliaria_email,
    cuit: cfg.inmobiliaria_cuit,
    jurisdiccion: cfg.contrato_jurisdiccion,
  });
  return v;
}

/**
 * Reemplaza los {{marcadores}} del modelo. Los que no tienen dato quedan
 * resaltados en amarillo para completarlos a mano antes de imprimir.
 * Devuelve { html, faltan: [marcadores sin dato] }.
 */
export function completarModelo(modeloHtml, valores) {
  const faltan = new Set();
  const html = modeloHtml.replace(/\{\{\s*([a-z0-9_]+\.[a-z0-9_]+)\s*\}\}/gi, (m, clave) => {
    const val = valores[clave];
    if (val === undefined || val === null || val === "") {
      faltan.add(clave);
      return `<mark class="falta" title="Falta: ${clave}">[${clave}]</mark>`;
    }
    // Los valores que ya son HTML (párrafo de garantes, firmas) van tal cual.
    return /^(garantes\.|caucion\.clausula$)/.test(clave) ? String(val) : esc(val);
  });
  return { html, faltan: [...faltan] };
}

/** HTML que Word abre como documento (formato .doc), en A4 y vista de impresión. */
export function htmlParaWord(titulo, cuerpo) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(titulo)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page WordSection1 { size: 21cm 29.7cm; margin: 2.5cm 2cm 2.5cm 2.5cm; }
div.WordSection1 { page: WordSection1; }
body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.5; }
p { margin: 0 0 8pt; text-align: justify; }
h1, h2 { text-align: center; font-size: 14pt; margin: 0 0 12pt; }
mark { background: yellow; }
</style></head>
<body><div class="WordSection1">${cuerpo}</div></body></html>`;
}

// ---------- modelos base ----------
// Textos de referencia para empezar. Cada inmobiliaria los adapta a su
// criterio (se editan desde la app y quedan guardados para todas las PCs).

const FIRMAS = `
<table style="width:100%;margin-top:50px"><tr>
<td style="width:50%;text-align:center;vertical-align:top">______________________________<br/>{{propietario.nombre}}<br/>LOCADOR</td>
<td style="width:50%;text-align:center;vertical-align:top">______________________________<br/>{{inquilino.nombre}}<br/>LOCATARIO</td>
</tr></table>
{{garantes.firmas}}`;

export const MODELOS_BASE = [
  {
    nombre: "Contrato de locación de vivienda",
    tipo: "Vivienda",
    contenido: `<h1>CONTRATO DE LOCACIÓN DE INMUEBLE CON DESTINO VIVIENDA</h1>
<p>En la ciudad de {{hoy.lugar}}, Provincia de Córdoba, {{hoy.fecha_larga}}, entre <b>{{propietario.nombre}}</b>, DNI N° {{propietario.dni}}, CUIT/CUIL {{propietario.cuit}}, de nacionalidad {{propietario.nacionalidad}}, estado civil {{propietario.estado_civil}}, con domicilio en {{propietario.domicilio}}, {{propietario.localidad}}, en adelante "EL LOCADOR", representado en este acto por {{inmobiliaria.nombre}}, {{inmobiliaria.matricula}}; y <b>{{inquilino.nombre}}</b>, DNI N° {{inquilino.dni}}, CUIT/CUIL {{inquilino.cuit}}, de nacionalidad {{inquilino.nacionalidad}}, estado civil {{inquilino.estado_civil}}, de profesión {{inquilino.profesion}}, con domicilio en {{inquilino.domicilio}}, {{inquilino.localidad}}, en adelante "EL LOCATARIO", convienen en celebrar el presente contrato de locación, sujeto a las siguientes cláusulas y, en lo no previsto, a las disposiciones del Código Civil y Comercial de la Nación:</p>
<p><b>PRIMERA – OBJETO:</b> EL LOCADOR da en locación a EL LOCATARIO, y éste acepta, el inmueble ubicado en {{inmueble.direccion}}, de la ciudad de {{inmueble.localidad}}, Provincia de {{inmueble.provincia}}, que consta de {{inmueble.descripcion}}. EL LOCATARIO declara conocer el inmueble y recibirlo en buen estado de conservación, limpieza y funcionamiento, conforme al acta de constatación y las fotografías que forman parte de este contrato.</p>
<p><b>SEGUNDA – PLAZO:</b> El plazo de la locación se fija en {{contrato.plazo_letras}} ({{contrato.plazo_meses}}) meses, comenzando el {{contrato.fecha_inicio_letras}} y finalizando el {{contrato.fecha_fin_letras}}, fecha en la que EL LOCATARIO deberá restituir el inmueble libre de ocupantes y de cosas, sin necesidad de intimación alguna.</p>
<p><b>TERCERA – PRECIO Y FORMA DE PAGO:</b> El alquiler mensual se fija en la suma de pesos {{contrato.monto_letras}} ({{contrato.monto}}), pagadero por mes adelantado del día 1 al día {{contrato.dia_pago_letras}} ({{contrato.dia_pago}}) de cada mes, en el domicilio de {{inmobiliaria.nombre}}, sito en {{inmobiliaria.direccion}}, {{inmobiliaria.localidad}}, o mediante transferencia a la cuenta que se indique, contra entrega del recibo correspondiente.</p>
<p><b>CUARTA – ACTUALIZACIÓN:</b> El precio se actualizará cada {{contrato.frecuencia_letras}} ({{contrato.frecuencia}}) meses, conforme a la variación de {{contrato.indice}} correspondiente a los meses inmediatamente anteriores publicados a la fecha de cada actualización. {{inmobiliaria.nombre}} comunicará a EL LOCATARIO el nuevo importe antes de su vencimiento.</p>
<p><b>QUINTA – MORA:</b> La mora en el pago se producirá de pleno derecho por el solo vencimiento de los plazos, sin necesidad de interpelación alguna. El pago fuera de término devengará un interés punitorio del {{contrato.interes_diario}} diario sobre el monto adeudado, desde el vencimiento hasta su efectivo pago.</p>
<p><b>SEXTA – DESTINO:</b> El inmueble se destinará exclusivamente a vivienda de EL LOCATARIO y su grupo familiar, quedando prohibido darle otro destino, cederlo, subalquilarlo o transferir este contrato, total o parcialmente, sin conformidad previa y por escrito de EL LOCADOR.</p>
<p><b>SÉPTIMA – DEPÓSITO EN GARANTÍA:</b> EL LOCATARIO entrega en este acto la suma de pesos {{contrato.deposito_letras}} ({{contrato.deposito}}) en concepto de depósito en garantía, que será devuelta al finalizar la locación, una vez restituido el inmueble y verificado que no existen deudas por alquileres, servicios, impuestos ni daños, en el monto equivalente al último alquiler pagado.</p>
<p><b>OCTAVA – SERVICIOS, IMPUESTOS Y EXPENSAS:</b> Están a cargo de EL LOCATARIO los servicios de luz, agua, gas, teléfono e internet, las tasas que graven el uso del inmueble y las expensas ordinarias, si las hubiera ({{contrato.conceptos}}). Los impuestos que gravan la propiedad y las expensas extraordinarias están a cargo de EL LOCADOR. EL LOCATARIO deberá exhibir los comprobantes de pago cuando le sean requeridos.</p>
<p><b>NOVENA – CONSERVACIÓN Y MEJORAS:</b> EL LOCATARIO se obliga a mantener el inmueble en el buen estado en que lo recibe y a comunicar de inmediato cualquier desperfecto. Las reparaciones originadas por el uso normal y por deterioros causados por EL LOCATARIO o sus dependientes serán a su cargo. No podrá realizar modificaciones ni mejoras sin autorización escrita de EL LOCADOR; las que realice quedarán en beneficio del inmueble sin derecho a reclamo alguno.</p>
<p><b>DÉCIMA – RESCISIÓN ANTICIPADA:</b> EL LOCATARIO podrá resolver anticipadamente este contrato conforme al artículo 1221 del Código Civil y Comercial de la Nación, notificando su decisión en forma fehaciente con una anticipación no menor a treinta (30) días y abonando la indemnización que corresponda según dicha norma.</p>
<p><b>UNDÉCIMA – RESTITUCIÓN:</b> Al vencimiento del contrato o su resolución, EL LOCATARIO restituirá el inmueble en el mismo estado en que lo recibió, salvo el desgaste por el uso normal, con las llaves y con los servicios pagos, firmándose el acta de entrega correspondiente.</p>
<p><b>DUODÉCIMA – GARANTÍA:</b> {{garantes.parrafo}}, se constituye/n en fiador/es solidario/s, liso/s, llano/s y principal/es pagador/es de todas las obligaciones asumidas por EL LOCATARIO en el presente contrato, con renuncia a los beneficios de excusión y división, hasta la total restitución del inmueble y el pago de todo lo adeudado.</p>
<p><b>DECIMOTERCERA – DOMICILIOS Y JURISDICCIÓN:</b> Las partes constituyen domicilio en los indicados en el encabezamiento, donde serán válidas todas las notificaciones, y se someten a la jurisdicción de {{inmobiliaria.jurisdiccion}}, renunciando a cualquier otro fuero.</p>
<p><b>DECIMOCUARTA – SELLADO:</b> El impuesto de sellos que corresponda a este contrato será soportado por las partes en proporciones iguales.</p>
{{caucion.clausula}}
<p>En prueba de conformidad se firman tres (3) ejemplares de un mismo tenor y a un solo efecto, en el lugar y fecha indicados.</p>
${FIRMAS}`,
  },
  {
    nombre: "Contrato de locación comercial",
    tipo: "Comercial",
    contenido: `<h1>CONTRATO DE LOCACIÓN DE INMUEBLE CON DESTINO COMERCIAL</h1>
<p>En la ciudad de {{hoy.lugar}}, Provincia de Córdoba, {{hoy.fecha_larga}}, entre <b>{{propietario.nombre}}</b>, DNI N° {{propietario.dni}}, CUIT/CUIL {{propietario.cuit}}, con domicilio en {{propietario.domicilio}}, {{propietario.localidad}}, en adelante "EL LOCADOR", representado por {{inmobiliaria.nombre}}, {{inmobiliaria.matricula}}; y <b>{{inquilino.nombre}}</b>, DNI N° {{inquilino.dni}}, CUIT {{inquilino.cuit}}, con domicilio en {{inquilino.domicilio}}, {{inquilino.localidad}}, en adelante "EL LOCATARIO", convienen el presente contrato de locación comercial:</p>
<p><b>PRIMERA – OBJETO Y DESTINO:</b> EL LOCADOR da en locación el inmueble sito en {{inmueble.direccion}}, {{inmueble.localidad}}, que EL LOCATARIO destinará exclusivamente a la actividad comercial de ____________________, siendo a su exclusivo cargo la obtención de las habilitaciones municipales y demás permisos necesarios.</p>
<p><b>SEGUNDA – PLAZO:</b> {{contrato.plazo_letras}} ({{contrato.plazo_meses}}) meses, desde el {{contrato.fecha_inicio_letras}} hasta el {{contrato.fecha_fin_letras}}.</p>
<p><b>TERCERA – PRECIO:</b> Pesos {{contrato.monto_letras}} ({{contrato.monto}}) mensuales, más IVA si correspondiera, pagaderos por mes adelantado del 1 al {{contrato.dia_pago}} de cada mes en {{inmobiliaria.direccion}}, {{inmobiliaria.localidad}}.</p>
<p><b>CUARTA – ACTUALIZACIÓN:</b> Cada {{contrato.frecuencia_letras}} ({{contrato.frecuencia}}) meses, según la variación de {{contrato.indice}}.</p>
<p><b>QUINTA – MORA:</b> Automática, con un interés punitorio del {{contrato.interes_diario}} diario sobre lo adeudado.</p>
<p><b>SEXTA – CARGAS:</b> Servicios, tasas por la actividad, expensas ordinarias y seguros del local y su contenido a cargo de EL LOCATARIO. Impuestos sobre la propiedad a cargo de EL LOCADOR.</p>
<p><b>SÉPTIMA – DEPÓSITO:</b> Pesos {{contrato.deposito_letras}} ({{contrato.deposito}}), a devolver al finalizar la locación previa verificación del estado del inmueble y de la inexistencia de deudas.</p>
<p><b>OCTAVA – MEJORAS:</b> Toda modificación requiere autorización escrita de EL LOCADOR y quedará a beneficio del inmueble.</p>
<p><b>NOVENA – GARANTÍA:</b> {{garantes.parrafo}}, se constituye/n en fiador/es solidario/s y principal/es pagador/es de las obligaciones de EL LOCATARIO.</p>
{{caucion.clausula}}
<p><b>DÉCIMA – JURISDICCIÓN:</b> {{inmobiliaria.jurisdiccion}}.</p>
<p>Se firman tres ejemplares de un mismo tenor en el lugar y fecha indicados.</p>
${FIRMAS}`,
  },
  {
    nombre: "Fianza / garantía personal",
    tipo: "Garantía",
    contenido: `<h1>CONVENIO DE FIANZA</h1>
<p>En la ciudad de {{hoy.lugar}}, {{hoy.fecha_larga}}, {{garantes.parrafo}}, en adelante "EL/LOS FIADOR/ES", se constituye/n en fiador/es solidario/s, liso/s, llano/s y principal/es pagador/es, con renuncia a los beneficios de excusión y división, de todas las obligaciones asumidas por <b>{{inquilino.nombre}}</b>, DNI N° {{inquilino.dni}}, en el contrato de locación N° {{contrato.numero}} celebrado con <b>{{propietario.nombre}}</b> sobre el inmueble ubicado en {{inmueble.direccion}}, {{inmueble.localidad}}, con vigencia desde el {{contrato.fecha_inicio_letras}} hasta el {{contrato.fecha_fin_letras}}, por un alquiler inicial de pesos {{contrato.monto_letras}} ({{contrato.monto}}) mensuales con sus actualizaciones.</p>
<p>La fianza se extiende a alquileres, intereses, servicios, impuestos, daños, gastos y costas, y subsiste hasta la efectiva restitución del inmueble y la cancelación de todo lo adeudado.</p>
<p>Garantía ofrecida: {{garante1.garantia}}.</p>
<p>Para todos los efectos se constituyen domicilios en los indicados y se someten a {{inmobiliaria.jurisdiccion}}.</p>
{{garantes.firmas}}`,
  },
  {
    nombre: "Acta de entrega de llaves",
    tipo: "Acta",
    contenido: `<h1>ACTA DE ENTREGA DE LLAVES Y POSESIÓN</h1>
<p>En la ciudad de {{hoy.lugar}}, el día {{hoy.fecha_letras}}, en el marco del contrato de locación N° {{contrato.numero}}, <b>{{inmobiliaria.nombre}}</b>, en representación de {{propietario.nombre}}, hace entrega a <b>{{inquilino.nombre}}</b>, DNI N° {{inquilino.dni}}, de la tenencia del inmueble ubicado en {{inmueble.direccion}}, {{inmueble.localidad}}, junto con ______ juegos de llaves.</p>
<p>EL LOCATARIO declara recibir el inmueble en el estado que surge del acta de constatación y fotografías adjuntas, con los siguientes medidores y lecturas: {{inmueble.servicios}} — Luz: ________ Agua: ________ Gas: ________.</p>
<p>Observaciones: ___________________________________________________________________________</p>
${FIRMAS}`,
  },
];
