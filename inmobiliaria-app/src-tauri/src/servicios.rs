//! Revisión de deudas de servicios (luz de EPEC, gas de Emprendimientos 2001).
//!
//! La app abre una ventana propia con la Oficina Virtual de EPEC. La primera
//! vez la persona inicia sesión ahí (con "Recordar", la sesión dura años y la
//! app nunca ve ni guarda la contraseña). En esa ventana se inyecta
//! `epec_revisor.js`, que recorre los contratos adheridos en la misma página y
//! lee las facturas a pagar. El script le pasa los datos a la app navegando a
//! una dirección especial (`REPORTE_HOST`) que acá se intercepta y se cancela.
//! La ventana de EPEC no tiene acceso a ningún comando de la app
//! (capabilities/default.json sólo habilita la ventana "main").

use crate::commands::DbState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

const REPORTE_HOST: &str = "reporte.gestion-inmobiliaria.invalid";

/// Ventana, página inicial, script y título de cada empresa de servicios.
struct Fuente {
    ventana: &'static str,
    url: &'static str,
    script: &'static str,
    titulo: &'static str,
}

fn fuente(servicio: &str) -> Result<Fuente, String> {
    match servicio {
        "luz" => Ok(Fuente {
            ventana: "epec",
            url: "https://www.epec.com.ar/oficina-virtual/mis-pagos",
            script: include_str!("epec_revisor.js"),
            titulo: "EPEC — Oficina Virtual (Gestión Inmobiliaria)",
        }),
        "gas" => Ok(Fuente {
            ventana: "gas2001",
            url: "https://www.cooponlineweb.com.ar/EMPRENDIMIENTOS2001/Principal",
            script: include_str!("gas_revisor.js"),
            titulo: "Emprendimientos 2001 — Gas (Gestión Inmobiliaria)",
        }),
        _ => Err(format!("Servicio no soportado: {}", servicio)),
    }
}

/// Último estado informado por cada ventana ("luz", "gas").
#[derive(Default)]
pub struct ServiciosState(pub Mutex<HashMap<String, Value>>);

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn recibir_reporte<R: tauri::Runtime>(app: &tauri::AppHandle<R>, servicio: &str, fragmento: &str) {
    let texto = percent_encoding::percent_decode_str(fragmento).decode_utf8_lossy().to_string();
    let Ok(mut valor) = serde_json::from_str::<Value>(&texto) else {
        return;
    };
    if let Some(o) = valor.as_object_mut() {
        o.insert("momento".into(), json!(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()));
    }
    if let Some(st) = app.try_state::<ServiciosState>() {
        if let Ok(mut mapa) = st.0.lock() {
            // "esperando" no pisa un resultado ya terminado.
            let nuevo = valor.get("estado").and_then(Value::as_str).unwrap_or("");
            let previo = mapa.get(servicio).and_then(|v| v.get("estado")).and_then(Value::as_str).unwrap_or("");
            if nuevo == "esperando" && previo == "fin" {
                return;
            }
            mapa.insert(servicio.to_string(), valor);
        }
    }
}

/// Abre (o recarga) la ventana de la empresa y empieza a revisar.
/// Tiene que ser `async`: en Windows, crear una ventana desde un comando
/// sincrónico bloquea la app (limitación conocida de Tauri/WebView2).
/// `visible=false` la abre oculta: el frontend la muestra si hace falta
/// iniciar sesión (`servicio_mostrar`).
#[tauri::command]
pub async fn servicio_revisar<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    estado: State<'_, ServiciosState>,
    servicio: String,
    visible: bool,
) -> Result<(), String> {
    let f = fuente(&servicio)?;
    if let Ok(mut m) = estado.0.lock() {
        m.insert(servicio.clone(), json!({ "estado": "abriendo" }));
    }
    if let Some(v) = app.get_webview_window(f.ventana) {
        v.navigate(f.url.parse().map_err(map_err)?).map_err(map_err)?;
        if visible {
            let _ = v.show();
            let _ = v.set_focus();
        }
        return Ok(());
    }
    let app2 = app.clone();
    let clave = servicio.clone();
    WebviewWindowBuilder::new(&app, f.ventana, WebviewUrl::External(f.url.parse().map_err(map_err)?))
        .title(f.titulo)
        .inner_size(1000.0, 760.0)
        .center()
        .visible(visible)
        .initialization_script(f.script)
        .on_navigation(move |url| {
            if url.host_str() == Some(REPORTE_HOST) {
                recibir_reporte(&app2, &clave, url.fragment().unwrap_or(""));
                return false;
            }
            true
        })
        .build()
        .map_err(map_err)?;
    Ok(())
}

/// Estado de la revisión + si la ventana sigue abierta.
#[tauri::command]
pub fn servicio_estado<R: tauri::Runtime>(app: tauri::AppHandle<R>, estado: State<'_, ServiciosState>, servicio: String) -> Result<Value, String> {
    let f = fuente(&servicio)?;
    let mut v = estado.0.lock().map_err(map_err)?.get(&servicio).cloned().unwrap_or(json!({ "estado": "inactivo" }));
    if let Some(o) = v.as_object_mut() {
        o.insert("ventana_abierta".into(), json!(app.get_webview_window(f.ventana).is_some()));
    }
    Ok(v)
}

#[tauri::command]
pub async fn servicio_mostrar<R: tauri::Runtime>(app: tauri::AppHandle<R>, servicio: String) -> Result<(), String> {
    let f = fuente(&servicio)?;
    let v = app.get_webview_window(f.ventana).ok_or("La ventana no está abierta")?;
    v.show().map_err(map_err)?;
    let _ = v.unminimize();
    v.set_focus().map_err(map_err)
}

#[tauri::command]
pub async fn servicio_cerrar<R: tauri::Runtime>(app: tauri::AppHandle<R>, servicio: String) -> Result<(), String> {
    let f = fuente(&servicio)?;
    if let Some(v) = app.get_webview_window(f.ventana) {
        v.close().map_err(map_err)?;
    }
    Ok(())
}

// ---------- Guardado compartido (Supabase) ----------

/// Estado guardado de todas las cuentas de servicios.
#[tauri::command]
pub async fn get_servicios_estado(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let cliente = crate::commands::obtener_cliente(&state).await?;
    cliente.select::<Value>("servicios_estado", "select=*&order=servicio,cuenta").await.map_err(map_err)
}

/// Guarda el resultado de una revisión (una fila por cuenta).
#[tauri::command]
pub async fn guardar_servicios_estado(state: State<'_, DbState>, servicio: String, filas: Vec<Value>) -> Result<(), String> {
    if !["luz", "gas", "agua"].contains(&servicio.as_str()) {
        return Err("Servicio no válido".into());
    }
    let cliente = crate::commands::obtener_cliente(&state).await?;
    let ahora = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let cuerpo: Vec<Value> = filas
        .iter()
        .filter_map(|f| {
            let o = f.as_object()?;
            let cuenta = o.get("cuenta")?.as_str()?.trim().to_string();
            if cuenta.is_empty() {
                return None;
            }
            let texto = |k: &str| o.get(k).and_then(Value::as_str).map(|s| s.to_string());
            Some(json!({
                "servicio": servicio,
                "cuenta": cuenta,
                "cliente": texto("cliente"),
                "titular": texto("titular"),
                "direccion": texto("direccion"),
                "referencia": texto("referencia"),
                "documentos": o.get("documentos").cloned().unwrap_or(json!([])),
                "financiados": o.get("financiados").and_then(Value::as_i64).unwrap_or(0),
                "error": texto("error"),
                "actualizado": ahora,
            }))
        })
        .collect();
    if cuerpo.is_empty() {
        return Ok(());
    }
    cliente.upsert("servicios_estado", &Value::Array(cuerpo), "servicio,cuenta").await.map_err(map_err)
}
