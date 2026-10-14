// Se inyecta en la ventana de CoopOnlineWeb (Emprendimientos 2001, gas) que
// abre la app. No usa la contraseña: con la sesión ya iniciada, recorre las
// cuentas agregadas al usuario, pide la página de facturas de cada una (la
// misma que ve una persona) y lee las facturas impagas. Le pasa los datos a la
// app navegando a una dirección especial que la app intercepta y cancela.
(function () {
  if (window.top !== window) return;
  if (!/(^|\.)cooponlineweb\.com\.ar$/.test(location.hostname)) return;
  if (window.__revisorGas) return;
  window.__revisorGas = true;

  var REPORTE = "https://reporte.gestion-inmobiliaria.invalid/gas#";
  var BASE = "/EMPRENDIMIENTOS2001/";

  function reportar(obj) {
    try {
      window.location.href = REPORTE + encodeURIComponent(JSON.stringify(obj));
    } catch (e) {}
  }

  function dormir(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function importe(txt) {
    // "76464.45" o "76.464,45"
    var s = String(txt || "").trim().replace(/\$/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  async function html(url) {
    var r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error("La página respondió " + r.status);
    var t = await r.text();
    return { url: r.url, doc: new DOMParser().parseFromString(t, "text/html") };
  }

  async function revisar() {
    reportar({ estado: "revisando", hechos: 0, total: 0 });
    var principal = await html(BASE + "Principal");
    if (/\/Login/i.test(principal.url)) {
      reportar({ estado: "login" });
      return;
    }
    var vistos = {};
    var cuentas = [];
    principal.doc.querySelectorAll('a[href*="action=Cuenta"]').forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(/cuenta=([^&]+)/);
      if (!m || vistos[m[1]]) return;
      vistos[m[1]] = true;
      var tarjeta = a.closest(".card") || a.parentElement;
      var texto = (tarjeta ? tarjeta.textContent : a.textContent).replace(/\s+/g, " ").trim();
      cuentas.push({ id: decodeURIComponent(m[1]), href: a.getAttribute("href"), texto: texto });
    });
    var resultados = [];
    for (var i = 0; i < cuentas.length; i++) {
      var c = cuentas[i];
      var r = { cuenta: c.id, cliente: c.id, titular: "", direccion: "", referencia: c.texto.slice(0, 120), documentos: [], financiados: 0, error: null };
      try {
        var f = await html(BASE + c.href.replace(/^\.\//, ""));
        var cuerpo = f.doc.body ? f.doc.body.textContent.replace(/\s+/g, " ") : "";
        var mt = cuerpo.match(/Cuenta\s+\S+\s+(.+?)\s+Cuenta:\s*\S+\s*\|\s*(.+?)\s+Ver m/);
        if (mt) {
          r.titular = mt[1].trim();
          r.direccion = mt[2].trim();
        } else {
          r.direccion = c.texto.replace(c.id, "").replace(/[\s.]+$/, "").trim();
        }
        var periodo = "";
        f.doc.querySelectorAll("table tbody tr").forEach(function (tr) {
          var celdas = Array.prototype.map.call(tr.cells, function (td) {
            return td.textContent.replace(/\s+/g, " ").trim();
          });
          if (celdas.length === 1) {
            periodo = celdas[0];
            return;
          }
          if (celdas.length < 7) return;
          var estado = celdas[6];
          if (/pagad/i.test(estado)) return;
          var num = (celdas[1].match(/[A-Z]{2,4}\s*\d{4}-\d{8}/) || [celdas[1]])[0];
          r.documentos.push({
            periodo: periodo,
            tipo: celdas[2],
            numero: num,
            importe: importe(celdas[5]),
            vencimiento: celdas[4],
            estado: /venc/i.test(estado) ? "vencido" : estado.toLowerCase(),
          });
        });
      } catch (e) {
        r.error = String((e && e.message) || e);
      }
      resultados.push(r);
      reportar({ estado: "revisando", hechos: i + 1, total: cuentas.length });
      await dormir(300);
    }
    reportar({ estado: "fin", contratos: resultados });
  }

  var rutaAnterior = null;
  var revisando = false;
  function vigilar() {
    var ruta = location.pathname;
    if (ruta === rutaAnterior) return;
    rutaAnterior = ruta;
    if (/\/Login/i.test(ruta) || /\/Registro/i.test(ruta)) {
      reportar({ estado: "login" });
      return;
    }
    if (!revisando) {
      revisando = true;
      revisar().catch(function (e) {
        revisando = false;
        reportar({ estado: "error", mensaje: String((e && e.message) || e) });
      });
    }
  }

  setInterval(vigilar, 1000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", vigilar);
  else vigilar();
})();
