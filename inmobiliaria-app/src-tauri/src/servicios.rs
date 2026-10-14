//! Revisión de deudas de servicios (luz de EPEC).
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
use std::sync::Mutex;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

const VENTANA_EPEC: &str = "epec";
const URL_EPEC: &str = "https://www.epec.com.ar/oficina-virtual/mis-pagos";
const REPORTE_HOST: &str = "reporte.gestion-inmobiliaria.invalid";
const SCRIPT_EPEC: &str = include_str!("epec_revisor.js");

/// Último estado informado por la ventana de EPEC.
pub struct EpecState(pub Mutex<Value>);

impl Default for EpecState {
    fn default() -> Self {
        EpecState(Mutex::new(json!({ "estado": "inactivo" })))
    }
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn recibir_reporte<R: tauri::Runtime>(app: &tauri::AppHandle<R>, fragmento: &str) {
    let texto = percent_encoding::percent_decode_str(fragmento).decode_utf8_lossy().to_string();
    let Ok(mut valor) = serde_json::from_str::<Value>(&texto) else {
        return;
    };
    if let Some(o) = valor.as_object_mut() {
        o.insert("momento".into(), json!(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()));
    }
    if let Some(st) = app.try_state::<EpecState>() {
        if let Ok(mut actual) = st.0.lock() {
            // "esperando" no pisa un resultado ya terminado.
            let nuevo = valor.get("estado").and_then(Value::as_str).unwrap_or("");
            let previo = actual.get("estado").and_then(Value::as_str).unwrap_or("");
            if nuevo == "esperando" && previo == "fin" {
                return;
            }
            *actual = valor;
        }
    }
}

/// Abre (o reabre) la ventana de EPEC y empieza a revisar.
/// `visible=false` la abre oculta: se muestra sola si hace falta iniciar sesión
/// (el frontend llama a `epec_mostrar`).
#[tauri::command]
pub fn epec_revisar<R: tauri::Runtime>(app: tauri::AppHandle<R>, estado: State<'_, EpecState>, visible: bool) -> Result<(), String> {
    if let Ok(mut e) = estado.0.lock() {
        *e = json!({ "estado": "abriendo" });
    }
    // Si ya está abierta, se recarga "Mis pagos" (el script vuelve a correr).
    if let Some(v) = app.get_webview_window(VENTANA_EPEC) {
        v.navigate(URL_EPEC.parse().map_err(map_err)?).map_err(map_err)?;
        if visible {
            let _ = v.show();
            let _ = v.set_focus();
        }
        return Ok(());
    }
    let app2 = app.clone();
    WebviewWindowBuilder::new(&app, VENTANA_EPEC, WebviewUrl::External(URL_EPEC.parse().map_err(map_err)?))
        .title("EPEC — Oficina Virtual (Gestión Inmobiliaria)")
        .inner_size(1000.0, 760.0)
        .center()
        .visible(visible)
        .initialization_script(SCRIPT_EPEC)
        .on_navigation(move |url| {
            if url.host_str() == Some(REPORTE_HOST) {
                recibir_reporte(&app2, url.fragment().unwrap_or(""));
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
pub fn epec_estado<R: tauri::Runtime>(app: tauri::AppHandle<R>, estado: State<'_, EpecState>) -> Result<Value, String> {
    let mut v = estado.0.lock().map_err(map_err)?.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("ventana_abierta".into(), json!(app.get_webview_window(VENTANA_EPEC).is_some()));
    }
    Ok(v)
}

#[tauri::command]
pub fn epec_mostrar<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let v = app.get_webview_window(VENTANA_EPEC).ok_or("La ventana de EPEC no está abierta")?;
    v.show().map_err(map_err)?;
    let _ = v.unminimize();
    v.set_focus().map_err(map_err)
}

#[tauri::command]
pub fn epec_cerrar<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if let Some(v) = app.get_webview_window(VENTANA_EPEC) {
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
