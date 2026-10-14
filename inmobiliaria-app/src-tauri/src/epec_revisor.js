// Se inyecta en la ventana de la Oficina Virtual de EPEC que abre la app.
// No usa ninguna clave ni la contraseña: recorre los contratos adheridos en la
// misma página (como si los fuera eligiendo una persona) y lee las facturas
// que la página muestra. Le pasa los datos a la app "navegando" a una
// dirección especial que la app intercepta y cancela (la página no se mueve).
(function () {
  if (window.top !== window) return;
  if (!/(^|\.)epec\.com\.ar$/.test(location.hostname)) return;
  if (window.__revisorEpec) return;
  window.__revisorEpec = true;

  var REPORTE = "https://reporte.gestion-inmobiliaria.invalid/epec#";
  var contratos = null;
  var ultimo = null;

  function reportar(obj) {
    try {
      window.location.href = REPORTE + encodeURIComponent(JSON.stringify(obj));
    } catch (e) {}
  }

  // Escuchar las respuestas que la propia página pide a EPEC.
  var P = XMLHttpRequest.prototype;
  var abrir = P.open;
  var enviar = P.send;
  P.open = function (metodo, url) {
    this.__urlRevisor = String(url || "");
    return abrir.apply(this, arguments);
  };
  P.send = function (cuerpo) {
    var xhr = this;
    xhr.addEventListener("load", function () {
      try {
        var u = xhr.__urlRevisor;
        if (/\/api\/usuarios\/contratos$/.test(u.split("?")[0]) && xhr.status === 200) {
          contratos = JSON.parse(xhr.responseText);
        } else if (u.indexOf("/api/documentos/a-pagar") >= 0) {
          ultimo = { cuerpo: String(cuerpo || ""), estado: xhr.status, datos: xhr.status === 200 ? JSON.parse(xhr.responseText) : null };
        }
      } catch (e) {}
    });
    return enviar.apply(this, arguments);
  };

  function dormir(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function esperar(cond, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await dormir(250);
    }
    return cond();
  }

  function filaDe(id) {
    var filas = document.querySelectorAll("#collapseContratos tr");
    for (var i = 0; i < filas.length; i++) {
      var tds = filas[i].querySelectorAll("td");
      for (var j = 0; j < tds.length; j++) if (tds[j].textContent.trim() === id) return filas[i];
    }
    return null;
  }

  function importe(txt) {
    var n = parseFloat(String(txt || "").trim().replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  }

  async function revisar() {
    reportar({ estado: "revisando", hechos: 0, total: 0 });
    var ok = await esperar(function () {
      return contratos !== null && document.querySelectorAll("#collapseContratos tr").length > 0;
    }, 40000);
    if (!ok) {
      reportar({ estado: "error", mensaje: "No se pudo leer la lista de contratos de EPEC." });
      return;
    }
    var resultados = [];
    for (var i = 0; i < contratos.length; i++) {
      var c = contratos[i];
      var r = {
        cuenta: String(c.id),
        cliente: c.nroCliente != null ? String(c.nroCliente) : "",
        titular: c.razonSocial || "",
        direccion: c.direccion || "",
        referencia: (c.referencia || "").trim(),
        documentos: [],
        financiados: 0,
        error: null,
      };
      var fila = filaDe(r.cuenta);
      if (!fila) {
        r.error = "No aparece en la lista de la página";
      } else {
        ultimo = null;
        fila.click();
        var llego = await esperar(function () {
          return ultimo !== null && ultimo.cuerpo.indexOf(r.cuenta) >= 0;
        }, 25000);
        if (!llego || !ultimo.datos) {
          r.error = llego ? "EPEC respondió con error " + ultimo.estado : "EPEC no respondió a tiempo";
        } else {
          var d = ultimo.datos;
          r.documentos = (d.documentosAPagar || []).map(function (x) {
            return {
              periodo: x.periodo || "",
              tipo: x.tipoDocumento || "",
              numero: x.documento || "",
              importe: importe(x.importe),
              vencimiento: x.vencimiento || "",
              estado: x.estado || "",
            };
          });
          r.financiados = (d.documentosFinanciados || []).length;
        }
      }
      resultados.push(r);
      reportar({ estado: "revisando", hechos: i + 1, total: contratos.length });
      await dormir(400);
    }
    reportar({ estado: "fin", contratos: resultados });
  }

  // La página es una "SPA": al iniciar sesión cambia de ruta sin recargar,
  // así que se vigila la ruta en vez de mirarla una sola vez.
  var rutaAnterior = null;
  var revisando = false;
  function vigilar() {
    var ruta = location.pathname;
    if (ruta === rutaAnterior) return;
    rutaAnterior = ruta;
    if (ruta.indexOf("/usuario/ingreso") === 0) {
      reportar({ estado: "login" });
      return;
    }
    if (ruta.indexOf("/oficina-virtual/mis-pagos") === 0) {
      if (!revisando) {
        revisando = true;
        revisar().catch(function (e) {
          reportar({ estado: "error", mensaje: String((e && e.message) || e) });
        });
      }
      return;
    }
    // Logueada pero en otra página (inicio, etc.): volver a "Mis pagos".
    var sesion = null;
    try {
      sesion = JSON.parse(localStorage.getItem("epecUserData") || "null");
    } catch (e) {}
    if (sesion && sesion.token && (ruta === "/" || ruta === "/oficina-virtual" || ruta === "/oficina-virtual/")) {
      location.href = "/oficina-virtual/mis-pagos";
    } else {
      reportar({ estado: "esperando", ruta: ruta });
    }
  }

  setInterval(vigilar, 1000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", vigilar);
  else vigilar();
})();
