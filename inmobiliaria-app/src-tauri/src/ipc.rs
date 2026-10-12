use serde_json::Value;

/// IPC Nacional, nivel general, base dic-2016 (INDEC) en la API de series de
/// tiempo de datos.gob.ar.
const URL_IPC: &str =
    "https://apis.datos.gob.ar/series/api/series/?ids=148.3_INIVELNAL_DICI_M_26&limit=5000&format=json";

/// Devuelve [(periodo "YYYY-MM", valor del índice)] ordenado por fecha.
pub async fn serie_ipc() -> Result<Vec<(String, f64)>, String> {
    let client = crate::icl::cliente_http()?;
    let resp = client.get(URL_IPC).send().await.map_err(|e| {
        format!("No se pudo consultar el IPC del INDEC (datos.gob.ar). Verificá tu conexión. Detalle: {}", e)
    })?;
    if !resp.status().is_success() {
        return Err(format!("datos.gob.ar respondió un error ({}) al consultar el IPC", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| format!("Respuesta del IPC inválida: {}", e))?;
    parsear(&data)
}

fn parsear(data: &Value) -> Result<Vec<(String, f64)>, String> {
    let filas = data.get("data").and_then(|d| d.as_array()).ok_or("La respuesta del IPC no trae datos")?;
    let mut serie: Vec<(String, f64)> = filas
        .iter()
        .filter_map(|f| {
            let fecha = f.get(0)?.as_str()?;
            let valor = f.get(1)?.as_f64()?;
            Some((fecha.chars().take(7).collect::<String>(), valor))
        })
        .collect();
    serie.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(serie)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_la_respuesta_real_de_datos_gob_ar() {
        let data: Value = serde_json::from_str(
            r#"{"data": [["2026-07-01", 12076.3937], ["2026-06-01", 11826.4103]], "count": 2}"#,
        )
        .unwrap();
        let s = parsear(&data).unwrap();
        assert_eq!(s, vec![("2026-06".to_string(), 11826.4103), ("2026-07".to_string(), 12076.3937)]);
    }
}
