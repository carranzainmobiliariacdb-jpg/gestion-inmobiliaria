// Se inyecta en la ventana de la Municipalidad (municipalidad.com/cbus) que
// abre la app para consultar el agua. La página pide una verificación de
// Cloudflare en cada consulta: eso lo hace la persona. El script solo
// (1) deja elegido «Servicio de Agua» con el N° de cuenta escrito y
// (2) cuando aparece el listado de deuda, lo lee y se lo pasa a la app
// navegando a una dirección especial que la app intercepta y cancela.
(function () {
  if (window.top !== window) return;
  if (!/(^|\.)municipalidad\.com$/.test(location.hostname)) return;
  if (window.__revisorAgua) return;
  window.__revisorAgua = true;

  var REPORTE = "https://reporte.gestion-inmobiliaria.invalid/agua#";

  function reportar(obj) {
    try {
      window.location.href = REPORTE + encodeURIComponent(JSON.stringify(obj));
    } catch (e) {}
  }

  function numero(txt) {
    // "15.123,20" → 15123.2
    var s = String(txt || "").replace(/[^\d,.-]/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function texto(el) {
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function cuentaPedida() {
    var m = location.hash.match(/cuenta=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  // ---- 1) Formulario: elegir «Servicio de Agua» y escribir la cuenta ----
  var preparado = "";
  function prepararFormulario() {
    var cuenta = cuentaPedida();
    if (!cuenta || preparado === cuenta) return;
    var opcion = document.querySelector('.opcion-tipo-cuenta[data-tipo_bien="OBSA"]');
    if (!opcion || !window.jQuery) return;
    preparado = cuenta;
    opcion.click();
    var intentos = 0;
    var t = setInterval(function () {
      intentos++;
      var input = document.querySelector('input[name="TipoCuenta.cuenta"]');
      if (input && input.offsetParent !== null) {
        input.value = cuenta;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        clearInterval(t);
        reportar({ estado: "login", paso: "verificar", cuenta: cuenta });
      } else if (intentos > 40) {
        clearInterval(t);
        reportar({ estado: "esperando", ruta: location.pathname });
      }
    }, 250);
  }

  // ---- 2) Listado de deuda ----
  function leerListado() {
    var celdasInfo = {};
    document.querySelectorAll("td, th, div, span, label").forEach(function (el) {
      if (el.children.length > 2) return;
      var k = texto(el);
      if (/^(Contribuyente|Cuenta|Documento)$/.test(k)) {
        var sig = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
        if (sig && !celdasInfo[k]) celdasInfo[k] = texto(sig);
      }
    });
    var migas = texto(document.querySelector(".breadcrumb"));
    var cuenta = celdasInfo["Cuenta"] || (migas.match(/Agua\s*-\s*(\d+)/) || [])[1] || cuentaPedida();

    var tabla = null;
    document.querySelectorAll("table").forEach(function (t) {
      var cab = texto(t.querySelector("thead") || t.rows[0]);
      if (!tabla && /Vencimiento/i.test(cab) && /Total/i.test(cab)) tabla = t;
    });
    var documentos = [];
    if (tabla) {
      var cabeceras = Array.prototype.map.call((tabla.querySelector("thead tr") || tabla.rows[0]).cells, function (c) {
        return texto(c).toLowerCase();
      });
      var col = function (nombre) {
        for (var i = 0; i < cabeceras.length; i++) if (cabeceras[i].indexOf(nombre) === 0) return i;
        return -1;
      };
      var iPer = col("per"), iDes = col("desc"), iBol = col("bol"), iVen = col("venc"), iTot = col("total"), iHis = col("hist");
      var filas = tabla.tBodies.length ? tabla.tBodies[0].rows : [];
      Array.prototype.forEach.call(filas, function (tr) {
        var c = Array.prototype.map.call(tr.cells, texto);
        if (c.length < 4 || !/\d{2}\/\d{2}\/\d{4}/.test(c[iVen] || "")) return;
        documentos.push({
          periodo: c[iPer] || "",
          tipo: c[iDes] || "Servicio de agua",
          numero: c[iBol] || "",
          importe: numero(iTot >= 0 ? c[iTot] : c[c.length - 2]),
          historico: iHis >= 0 ? numero(c[iHis]) : null,
          vencimiento: ((c[iVen] || "").match(/\d{2}\/\d{2}\/\d{4}/) || [""])[0],
          estado: "a pagar",
        });
      });
    }
    var sinDeuda = !tabla && /no (registra|posee|tiene|existe) deuda|sin deuda/i.test(document.body.textContent);
    var resultado = { cuenta: cuenta, documentos: documentos, error: !(tabla || sinDeuda) };
    reportar({
      estado: "fin",
      contratos: [
        {
          cuenta: cuenta,
          cliente: cuenta,
          titular: celdasInfo["Contribuyente"] || "",
          direccion: "",
          referencia: celdasInfo["Documento"] || "",
          documentos: documentos,
          financiados: 0,
          error: tabla || sinDeuda ? null : "No se encontró el listado de deuda en la página.",
        },
      ],
    });
    return resultado;
  }

  // Barra arriba de la página: confirma que la app ya guardó la deuda y
  // permite guardar esta misma página en PDF (Ctrl+P → «Guardar como PDF»).
  function mostrarBarra(r) {
    if (document.getElementById("__barraApp")) return;
    var b = document.createElement("div");
    b.id = "__barraApp";
    b.setAttribute("style", "position:sticky;top:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 16px;background:#15181e;color:#fff;font:14px Segoe UI,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)");
    b.innerHTML =
      (r.error
        ? '<span>⚠ <b>Gestión Inmobiliaria</b> no encontró el listado de deuda de la cuenta ' + r.cuenta + ". Revisá la página; podés guardarla en PDF igual.</span>"
        : '<span>✓ <b>Gestión Inmobiliaria</b> ya guardó la deuda de la cuenta ' + r.cuenta + (r.documentos.length ? "" : " (sin deuda)") + ". La constancia en PDF está en la app.</span>") +
      '<span><button id="__pdfApp" style="background:#c39b4a;color:#15181e;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer">Guardar esta página en PDF</button></span>';
    document.body.insertBefore(b, document.body.firstChild);
    document.getElementById("__pdfApp").addEventListener("click", function () {
      b.style.display = "none";
      setTimeout(function () {
        window.print();
        b.style.display = "flex";
      }, 50);
    });
  }

  function vigilar() {
    if (/\/deuda\/listadodeuda/i.test(location.pathname)) {
      if (!window.__aguaLeido) {
        window.__aguaLeido = true;
        var r = leerListado();
        setTimeout(function () {
          mostrarBarra(r);
        }, 300);
      }
      return;
    }
    if (/\/cbus\/deuda\/?$/i.test(location.pathname)) {
      prepararFormulario();
      // Si la Municipalidad responde en la misma página que la cuenta no tiene deuda.
      var aviso = document.querySelector(".alert, .alert-info, .alert-success, .mensaje, .swal2-html-container");
      if (!window.__aguaLeido && cuentaPedida() && aviso && /no (registra|posee|tiene|existe) deuda|sin deuda|no se encontr/i.test(texto(aviso))) {
        window.__aguaLeido = true;
        var r = leerListado();
        setTimeout(function () {
          mostrarBarra(r);
        }, 300);
      }
    }
  }

  setInterval(vigilar, 800);
  window.addEventListener("hashchange", function () {
    preparado = "";
    vigilar();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", vigilar);
  else vigilar();
})();
