//! Cotización del dólar para el tablero: oficial del Banco Nación y blue.
//! Fuente principal: dolarapi.com (el «oficial» es el billete del Banco
//! Nación). Si no responde, se usa bluelytics.com.ar.

use serde_json::{json, Value};

fn par(v: Option<&Value>, compra: &str, venta: &str, fecha: Option<&Value>) -> Option<Value> {
    let v = v?;
    let c = v.get(compra).and_then(Value::as_f64)?;
    let w = v.get(venta).and_then(Value::as_f64)?;
    Some(json!({ "compra": c, "venta": w, "fecha": fecha.and_then(Value::as_str).unwrap_or("") }))
}

/// Interpreta la respuesta de dolarapi.com/v1/dolares.
pub fn de_dolarapi(data: &Value) -> Option<Value> {
    let lista = data.as_array()?;
    let casa = |c: &str| lista.iter().find(|x| x.get("casa").and_then(Value::as_str) == Some(c));
    let oficial = casa("oficial").and_then(|x| par(Some(x), "compra", "venta", x.get("fechaActualizacion")))?;
    let blue = casa("blue").and_then(|x| par(Some(x), "compra", "venta", x.get("fechaActualizacion")));
    Some(json!({ "oficial": oficial, "blue": blue, "fuente": "dolarapi.com" }))
}

/// Interpreta la respuesta de api.bluelytics.com.ar/v2/latest.
pub fn de_bluelytics(data: &Value) -> Option<Value> {
    let fecha = data.get("last_update");
    let oficial = par(data.get("oficial"), "value_buy", "value_sell", fecha)?;
    let blue = par(data.get("blue"), "value_buy", "value_sell", fecha);
    Some(json!({ "oficial": oficial, "blue": blue, "fuente": "bluelytics.com.ar" }))
}

async fn pedir(url: &str) -> Option<Value> {
    let client = crate::icl::cliente_http().ok()?;
    let r = client.get(url).timeout(std::time::Duration::from_secs(10)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().await.ok()
}

#[tauri::command]
pub async fn cotizacion_dolar() -> Result<Value, String> {
    if let Some(v) = pedir("https://dolarapi.com/v1/dolares").await.as_ref().and_then(de_dolarapi) {
        return Ok(v);
    }
    if let Some(v) = pedir("https://api.bluelytics.com.ar/v2/latest").await.as_ref().and_then(de_bluelytics) {
        return Ok(v);
    }
    Err("No se pudo consultar la cotización del dólar (sin conexión o la fuente no responde).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_dolarapi() {
        let d: Value = serde_json::from_str(r#"[{"moneda":"USD","casa":"oficial","nombre":"Oficial","compra":1500,"venta":1550,"fechaActualizacion":"2026-10-22T18:00:00.000Z"},{"moneda":"USD","casa":"blue","nombre":"Blue","compra":1545,"venta":1565,"fechaActualizacion":"2026-10-22T20:59:00.000Z"}]"#).unwrap();
        let v = de_dolarapi(&d).unwrap();
        assert_eq!(v["oficial"]["venta"], 1550.0);
        assert_eq!(v["blue"]["compra"], 1545.0);
    }

    #[test]
    fn lee_bluelytics() {
        let d: Value = serde_json::from_str(r#"{"oficial":{"value_avg":1525.0,"value_sell":1550.0,"value_buy":1500.0},"blue":{"value_avg":1555.0,"value_sell":1565.0,"value_buy":1545.0},"last_update":"2026-10-22T18:00:00-03:00"}"#).unwrap();
        let v = de_bluelytics(&d).unwrap();
        assert_eq!(v["oficial"]["compra"], 1500.0);
        assert_eq!(v["blue"]["venta"], 1565.0);
    }
}
