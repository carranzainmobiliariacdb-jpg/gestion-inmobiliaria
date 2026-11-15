//! Trabajo sin conexión: tarea de fondo que vigila la conexión, sube los
//! cambios pendientes y mantiene al día la copia local; y los comandos para
//! que la pantalla muestre el estado.

use crate::commands::{obtener_cliente, DbState};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Manager, State};

static INICIADO: AtomicBool = AtomicBool::new(false);

/// Cada cuánto se vuelve a bajar todo para tener la copia al día (segundos).
const REFRESCO: u64 = 5 * 60;

/// Un ciclo: si estaba sin conexión, prueba si volvió; con conexión, sube
/// lo pendiente y refresca la copia si hace falta.
pub async fn ciclo(cliente: &crate::supabase::Cliente, forzar_descarga: bool) {
    let Some(e) = cliente.espejo().cloned() else { return };
    if e.sin_conexion() {
        if !cliente.hay_conexion().await {
            return;
        }
        e.marcar_sin_conexion(false);
    }
    if e.hay_pendientes() {
        match cliente.sincronizar().await {
            Ok(_) => {}
            Err(err) => {
                if err.red {
                    e.marcar_sin_conexion(true);
                }
                return;
            }
        }
        // Después de subir, se baja todo de nuevo (ids reales, lo de la otra PC).
        if let Err(err) = cliente.descargar_todo().await {
            if err.red {
                e.marcar_sin_conexion(true);
            }
        }
        return;
    }
    if forzar_descarga || !e.tiene_datos() || e.descarga_vencida(REFRESCO) {
        if let Err(err) = cliente.descargar_todo().await {
            if err.red {
                e.marcar_sin_conexion(true);
            }
        }
    }
}

/// Arranca (una sola vez) la tarea de fondo.
pub fn iniciar<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if INICIADO.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let cliente = app.state::<DbState>().0.read().await.clone();
            if let Some(c) = cliente {
                ciclo(&c, false).await;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

/// Estado para el cartel de "Sin conexión" de la pantalla.
#[tauri::command]
pub async fn estado_conexion(state: State<'_, DbState>) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    Ok(cliente.espejo().map(|e| e.resumen()).unwrap_or(Value::Null))
}

/// Botón "Sincronizar ahora".
#[tauri::command]
pub async fn sincronizar_ahora(state: State<'_, DbState>) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let Some(e) = cliente.espejo().cloned() else { return Ok(Value::Null) };
    if e.sin_conexion() && !cliente.hay_conexion().await {
        return Err("Todavía no hay conexión a internet. Los cambios quedan guardados en esta PC y se suben solos cuando vuelva.".into());
    }
    e.marcar_sin_conexion(false);
    ciclo(&cliente, true).await;
    Ok(e.resumen())
}

#[tauri::command]
pub async fn limpiar_avisos_sincronizacion(state: State<'_, DbState>) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    if let Some(e) = cliente.espejo() {
        e.limpiar_avisos();
    }
    Ok(())
}
