//! Honorarios de alquileres: recibos propios de la inmobiliaria (por
//! ejemplo, el honorario por la celebración del contrato), con numeración
//! separada de los recibos de alquiler.

use crate::commands::{obtener_cliente, DbState};
use serde_json::{json, Map, Value};
use tauri::State;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn get_honorarios(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("honorarios", "select=*&order=numero.desc").await.map_err(err)
}

/// Guarda un honorario nuevo con el siguiente número y lo devuelve completo.
#[tauri::command]
pub async fn registrar_honorario(state: State<'_, DbState>, honorario: Map<String, Value>) -> Result<Value, String> {
    const CAMPOS: &[&str] = &[
        "fecha", "contrato_id", "pagador_tipo", "pagador_nombre", "pagador_dni", "pagador_telefono", "concepto", "detalle", "monto",
        "metodo_pago", "notas", "usuario", "plan_id", "cuota",
    ];
    let cliente = obtener_cliente(&state).await?;
    let ultimo: Option<Value> = cliente.select_uno("honorarios", "select=numero&order=numero.desc&limit=1").await.map_err(err)?;
    let mut numero = ultimo.and_then(|v| v.get("numero").and_then(Value::as_i64)).unwrap_or(0) + 1;
    let desde: Option<Value> = cliente
        .select_uno("configuracion", "clave=eq.honorarios_numero_desde&select=valor")
        .await
        .ok()
        .flatten();
    if let Some(d) = desde.and_then(|v| v.get("valor").and_then(Value::as_str).and_then(|s| s.trim().parse::<i64>().ok())) {
        numero = numero.max(d);
    }
    let mut body: Map<String, Value> = honorario.into_iter().filter(|(k, _)| CAMPOS.contains(&k.as_str())).collect();
    body.insert("numero".into(), json!(numero));
    if body.get("pagador_nombre").and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty() {
        return Err("Falta el nombre de quien paga".into());
    }
    if body.get("monto").and_then(Value::as_f64).unwrap_or(0.0) <= 0.0 {
        return Err("El importe tiene que ser mayor a cero".into());
    }
    let plan = body.get("plan_id").and_then(Value::as_i64);
    let cuota = body.get("cuota").and_then(Value::as_i64);
    let fila: Value = cliente.insert("honorarios", &Value::Object(body)).await.map_err(err)?;
    if let (Some(plan), Some(cuota)) = (plan, cuota) {
        let fecha = fila.get("fecha").cloned().unwrap_or(Value::Null);
        marcar_cuota(&cliente, plan, cuota, json!({ "recibo_id": fila.get("id"), "pagada": fecha })).await?;
    }
    Ok(fila)
}

/// Agrega/actualiza datos de una cuota del plan (recibo_id, pagada).
async fn marcar_cuota(cliente: &crate::supabase::Cliente, plan: i64, cuota: i64, datos: Value) -> Result<(), String> {
    let p: Option<Value> = cliente.select_uno("honorarios_planes", &format!("id=eq.{}&select=cuotas", plan)).await.map_err(err)?;
    let mut cuotas = p.and_then(|v| v.get("cuotas").cloned()).unwrap_or(json!([]));
    if let Some(arr) = cuotas.as_array_mut() {
        for c in arr.iter_mut() {
            if c.get("n").and_then(Value::as_i64) == Some(cuota) {
                if let (Some(o), Some(d)) = (c.as_object_mut(), datos.as_object()) {
                    for (k, v) in d {
                        o.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    cliente.update("honorarios_planes", &format!("id=eq.{}", plan), &json!({ "cuotas": cuotas })).await.map_err(err)
}

#[tauri::command]
pub async fn get_honorarios_planes(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("honorarios_planes", "select=*&order=id.desc").await.map_err(err)
}

/// Crea un plan (pago único o en cuotas) y devuelve la fila.
#[tauri::command]
pub async fn crear_honorario_plan(state: State<'_, DbState>, plan: Map<String, Value>) -> Result<Value, String> {
    const CAMPOS: &[&str] = &[
        "contrato_id", "pagador_tipo", "pagador_nombre", "pagador_dni", "pagador_telefono", "concepto", "detalle", "total", "cuotas", "notas",
        "usuario",
    ];
    let body: Map<String, Value> = plan.into_iter().filter(|(k, _)| CAMPOS.contains(&k.as_str())).collect();
    if body.get("cuotas").and_then(Value::as_array).map(|a| a.is_empty()).unwrap_or(true) {
        return Err("El plan no tiene cuotas".into());
    }
    let cliente = obtener_cliente(&state).await?;
    cliente.insert("honorarios_planes", &Value::Object(body)).await.map_err(err)
}

#[tauri::command]
pub async fn eliminar_honorario_plan(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("honorarios_planes", &format!("id=eq.{}", id)).await.map_err(err)
}

#[tauri::command]
pub async fn eliminar_honorario(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    let fila: Option<Value> = cliente.select_uno("honorarios", &format!("id=eq.{}&select=plan_id,cuota", id)).await.map_err(err)?;
    cliente.delete("honorarios", &format!("id=eq.{}", id)).await.map_err(err)?;
    if let Some(f) = fila {
        if let (Some(plan), Some(cuota)) = (f.get("plan_id").and_then(Value::as_i64), f.get("cuota").and_then(Value::as_i64)) {
            marcar_cuota(&cliente, plan, cuota, json!({ "recibo_id": null, "pagada": null })).await?;
        }
    }
    Ok(())
}
