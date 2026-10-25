//! Lado oficina del Portal del inquilino: links de acceso, pagos informados,
//! reclamos y avisos. El portal web (carpeta `portal/` del repositorio) sólo
//! puede llamar a las funciones portal_* de la base; acá el programa de la
//! oficina lee y responde con la clave de la oficina.

use crate::commands::{obtener_cliente, DbState};
use serde_json::{json, Map, Value};
use tauri::State;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// (tabla, columnas para listar, columnas que la oficina puede cambiar)
fn tabla(nombre: &str) -> Result<(&'static str, &'static str, &'static [&'static str]), String> {
    match nombre {
        "accesos" => Ok(("portal_accesos", "token,inquilino_id,creado,activo,ultimo_acceso", &["activo"])),
        "pagos" => Ok((
            "portal_pagos_informados",
            "id,inquilino_id,contrato_id,periodos,monto,fecha,metodo,nota,estado,respuesta,pago_id,creado,revisado",
            &["estado", "respuesta", "pago_id", "revisado"],
        )),
        "reclamos" => Ok((
            "portal_reclamos",
            "id,inquilino_id,contrato_id,titulo,descripcion,estado,respuesta,creado,actualizado",
            &["estado", "respuesta", "actualizado"],
        )),
        "avisos" => Ok(("portal_avisos", "id,inquilino_id,titulo,texto,activo,creado", &["titulo", "texto", "activo", "inquilino_id"])),
        _ => Err("Tabla del portal no válida".into()),
    }
}

#[tauri::command]
pub async fn portal_listar(state: State<'_, DbState>, que: String) -> Result<Vec<Value>, String> {
    let (t, cols, _) = tabla(&que)?;
    let orden = if que == "accesos" { "creado.desc" } else { "id.desc" };
    let cliente = obtener_cliente(&state).await?;
    cliente.select(t, &format!("select={}&order={}&limit=500", cols, orden)).await.map_err(err)
}

#[tauri::command]
pub async fn portal_actualizar(state: State<'_, DbState>, que: String, id: Value, cambios: Map<String, Value>) -> Result<(), String> {
    let (t, _, permitidas) = tabla(&que)?;
    let body: Map<String, Value> = cambios.into_iter().filter(|(k, _)| permitidas.contains(&k.as_str())).collect();
    if body.is_empty() {
        return Ok(());
    }
    let filtro = match (&id, que.as_str()) {
        (Value::String(tok), "accesos") => format!("token=eq.{}", tok),
        (Value::Number(n), _) => format!("id=eq.{}", n),
        _ => return Err("Identificador no válido".into()),
    };
    let cliente = obtener_cliente(&state).await?;
    cliente.update(t, &filtro, &Value::Object(body)).await.map_err(err)
}

/// Crea el link de un inquilino (o devuelve el que ya tiene activo).
/// `token` lo genera el programa con un generador seguro; si `renovar`, se
/// desactivan los links anteriores (el link viejo deja de andar).
#[tauri::command]
pub async fn portal_crear_acceso(state: State<'_, DbState>, inquilino_id: i64, token: String, renovar: bool) -> Result<String, String> {
    let cliente = obtener_cliente(&state).await?;
    if !renovar {
        let actual: Option<Value> = cliente
            .select_uno("portal_accesos", &format!("inquilino_id=eq.{}&activo=eq.true&select=token&order=creado.desc", inquilino_id))
            .await
            .map_err(err)?;
        if let Some(t) = actual.and_then(|v| v.get("token").and_then(Value::as_str).map(String::from)) {
            return Ok(t);
        }
    } else {
        cliente
            .update("portal_accesos", &format!("inquilino_id=eq.{}", inquilino_id), &json!({ "activo": false }))
            .await
            .map_err(err)?;
    }
    if token.len() < 24 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Código de acceso no válido".into());
    }
    let _: Value = cliente
        .insert("portal_accesos", &json!({ "token": token, "inquilino_id": inquilino_id }))
        .await
        .map_err(err)?;
    Ok(token)
}

#[tauri::command]
pub async fn portal_crear_aviso(state: State<'_, DbState>, titulo: String, texto: String, inquilino_id: Option<i64>) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    let _: Value = cliente
        .insert("portal_avisos", &json!({ "titulo": titulo.trim(), "texto": texto.trim(), "inquilino_id": inquilino_id }))
        .await
        .map_err(err)?;
    Ok(())
}

/// Imagen adjunta: comprobante de un pago informado o foto de un reclamo.
#[tauri::command]
pub async fn portal_imagen(state: State<'_, DbState>, que: String, id: i64) -> Result<Option<String>, String> {
    let (t, col) = match que.as_str() {
        "pagos" => ("portal_pagos_informados", "comprobante"),
        "reclamos" => ("portal_reclamos", "foto"),
        _ => return Err("No válido".into()),
    };
    let cliente = obtener_cliente(&state).await?;
    let fila: Option<Value> = cliente.select_uno(t, &format!("id=eq.{}&select={}", id, col)).await.map_err(err)?;
    Ok(fila.and_then(|v| v.get(col).and_then(Value::as_str).map(String::from)))
}
