//! Consulta a la Central de Deudores del BCRA (API pública, sin clave):
//! https://api.bcra.gob.ar/CentralDeDeudores/v1.0/
use serde_json::{json, Value};

const BASE: &str = "https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas";

/// Resultado de un endpoint: Ok(Some(results)) con datos, Ok(None) si el BCRA
/// no tiene registros para ese CUIT/CUIL (404), Err con el motivo si falló.
/// Mensaje de error con la causa real (reqwest solo dice "error sending request").
fn detalle_error(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut fuente = std::error::Error::source(e);
    while let Some(f) = fuente {
        s.push_str(" → ");
        s.push_str(&f.to_string());
        fuente = f.source();
    }
    s
}

async fn pedir(client: &reqwest::Client, url: &str) -> Result<Option<Value>, String> {
    // El BCRA a veces tarda o corta la primera conexión: se reintenta.
    let mut ultimo_error = String::new();
    let mut resp = None;
    for intento in 0..3 {
        if intento > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
        match client.get(url).send().await {
            Ok(r) => {
                resp = Some(r);
                break;
            }
            Err(e) => ultimo_error = detalle_error(&e),
        }
    }
    let resp = resp.ok_or_else(|| format!("No se pudo conectar con el BCRA. Detalle: {}", ultimo_error))?;
    let status = resp.status();
    let texto = resp.text().await.unwrap_or_default();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    let data: Value = serde_json::from_str(&texto).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = data
            .get("errorMessages")
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("El BCRA respondió un error ({})", status));
        return Err(msg);
    }
    Ok(data.get("results").cloned())
}

pub fn solo_digitos(cuit: &str) -> String {
    cuit.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Peor situación (1 a 5) del último período informado, o 0 si no tiene deudas.
pub fn peor_situacion(deudas: &Value) -> i64 {
    deudas
        .get("periodos")
        .and_then(|p| p.as_array())
        .and_then(|p| p.first())
        .and_then(|p| p.get("entidades"))
        .and_then(|e| e.as_array())
        .map(|ents| ents.iter().filter_map(|e| e.get("situacion").and_then(|s| s.as_i64())).max().unwrap_or(0))
        .unwrap_or(0)
}

pub async fn consultar(cuit: &str) -> Result<Value, String> {
    let id = solo_digitos(cuit);
    if id.len() != 11 {
        return Err("Para consultar al BCRA hace falta el CUIT/CUIL completo (11 números). Cargá el DNI y el sexo para calcularlo, o escribilo.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) GestionInmobiliaria/1.0")
        .build()
        .map_err(|e| format!("No se pudo inicializar el cliente HTTP: {}", e))?;
    let deudas = pedir(&client, &format!("{}/{}", BASE, id)).await?;
    let historicas = pedir(&client, &format!("{}/Historicas/{}", BASE, id)).await.unwrap_or(None);
    let cheques = pedir(&client, &format!("{}/ChequesRechazados/{}", BASE, id)).await.unwrap_or(None);
    let situacion = deudas.as_ref().map(peor_situacion).unwrap_or(0);
    let peor_historica = historicas
        .as_ref()
        .and_then(|h| h.get("periodos"))
        .and_then(|p| p.as_array())
        .map(|ps| {
            ps.iter()
                .flat_map(|p| p.get("entidades").and_then(|e| e.as_array()).cloned().unwrap_or_default())
                .filter_map(|e| e.get("situacion").and_then(|s| s.as_i64()))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let cantidad_cheques = cheques
        .as_ref()
        .and_then(|c| c.get("causales"))
        .and_then(|c| c.as_array())
        .map(|cs| {
            cs.iter()
                .flat_map(|c| c.get("entidades").and_then(|e| e.as_array()).cloned().unwrap_or_default())
                .map(|e| e.get("detalle").and_then(|d| d.as_array()).map(|d| d.len()).unwrap_or(0))
                .sum::<usize>()
        })
        .unwrap_or(0);
    Ok(json!({
        "cuit": id,
        "situacion": situacion,
        "peor_historica": peor_historica,
        "cantidad_cheques": cantidad_cheques,
        "deudas": deudas,
        "historicas": historicas,
        "cheques": cheques,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calcula_la_peor_situacion_del_ultimo_periodo() {
        let d: Value = serde_json::from_str(
            r#"{"identificacion":20123456789,"denominacion":"X","periodos":[
              {"periodo":"202409","entidades":[{"entidad":"A","situacion":1,"monto":10.0},{"entidad":"B","situacion":3,"monto":5.0}]},
              {"periodo":"202408","entidades":[{"entidad":"A","situacion":5,"monto":10.0}]}]}"#,
        )
        .unwrap();
        assert_eq!(peor_situacion(&d), 3);
        assert_eq!(solo_digitos("20-12345678-9"), "20123456789");
    }
}
