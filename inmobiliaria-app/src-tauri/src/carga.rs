//! Carga inicial de contratos desde un archivo JSON preparado a partir de la
//! carpeta de contratos (propietarios, inquilinos, garantes, inmuebles,
//! contratos, aumentos ya aplicados y el cobro del mes en curso).
//!
//! Es idempotente: las personas se buscan por DNI/CUIT (o por nombre si no
//! tienen), los inmuebles por dirección + piso/depto y los contratos por
//! inmueble + inquilino + fecha de inicio. Lo que ya existe no se duplica ni
//! se modifica, así que se puede correr más de una vez.

use crate::commands::{obtener_cliente, DbState};
use crate::supabase::Cliente;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tauri::State;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn texto(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn solo_digitos(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Minúsculas, sin tildes ni signos, espacios simples.
fn normalizar(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        };
        out.push(c);
    }
    let sin_palabras: Vec<&str> = out.split_whitespace().filter(|w| !matches!(*w, "n" | "nro" | "calle" | "av" | "avenida")).collect();
    sin_palabras.join(" ")
}

#[derive(Deserialize)]
struct Fila {
    id: i64,
    #[serde(flatten)]
    resto: Map<String, Value>,
}

const COLS_PERSONA: &[&str] = &["nombre", "dni_cuit", "telefono", "email", "direccion", "localidad", "notas"];

struct Personas {
    tabla: &'static str,
    por_dni: HashMap<String, i64>,
    por_nombre: HashMap<String, i64>,
}

impl Personas {
    async fn cargar(cliente: &Cliente, tabla: &'static str) -> Result<Self, String> {
        let filas: Vec<Fila> = cliente.select(tabla, "select=id,nombre,dni_cuit").await.map_err(map_err)?;
        let mut p = Personas { tabla, por_dni: HashMap::new(), por_nombre: HashMap::new() };
        for f in filas {
            let dni = solo_digitos(f.resto.get("dni_cuit").and_then(Value::as_str).unwrap_or(""));
            if dni.len() >= 6 {
                p.por_dni.insert(dni, f.id);
            }
            let n = normalizar(f.resto.get("nombre").and_then(Value::as_str).unwrap_or(""));
            if !n.is_empty() {
                p.por_nombre.insert(n, f.id);
            }
        }
        Ok(p)
    }

    /// Devuelve (id, creada).
    async fn obtener(&mut self, cliente: &Cliente, datos: &Value, extra: &[&str]) -> Result<(i64, bool), String> {
        let nombre = texto(datos, "nombre");
        if nombre.is_empty() {
            return Err("Persona sin nombre".into());
        }
        let dni = solo_digitos(&texto(datos, "dni_cuit"));
        let n = normalizar(&nombre);
        let existente = if dni.len() >= 6 { self.por_dni.get(&dni).copied() } else { None }.or_else(|| self.por_nombre.get(&n).copied());
        if let Some(id) = existente {
            return Ok((id, false));
        }
        let mut body = Map::new();
        for k in COLS_PERSONA.iter().chain(extra.iter()) {
            let v = texto(datos, k);
            if !v.is_empty() {
                body.insert((*k).to_string(), json!(v));
            }
        }
        let fila: Fila = cliente.insert(self.tabla, &Value::Object(body)).await.map_err(map_err)?;
        if dni.len() >= 6 {
            self.por_dni.insert(dni, fila.id);
        }
        self.por_nombre.insert(n, fila.id);
        Ok((fila.id, true))
    }
}

fn redondear_a(m: f64, paso: f64) -> f64 {
    if paso <= 1.0 {
        (m * 100.0).round() / 100.0
    } else {
        (m / paso).round() * paso
    }
}

/// Importa la carga inicial. `incluir` = índices de los contratos a cargar,
/// `redondeo` = múltiplo para los aumentos (1 = pesos exactos con centavos).
#[tauri::command]
pub async fn importar_carga_inicial(
    state: State<'_, DbState>,
    datos: Value,
    incluir: Vec<usize>,
    redondeo: f64,
    usuario: String,
) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let contratos = datos.get("contratos").and_then(Value::as_array).ok_or("El archivo no tiene contratos")?;

    let mut propietarios = Personas::cargar(&cliente, "propietarios").await?;
    let mut inquilinos = Personas::cargar(&cliente, "inquilinos").await?;
    let mut garantes = Personas::cargar(&cliente, "garantes").await?;

    let filas_inm: Vec<Fila> = cliente.select("inmuebles", "select=id,direccion,piso_depto").await.map_err(map_err)?;
    let clave_inm = |d: &str, p: &str| format!("{}|{}", normalizar(d), normalizar(p));
    let mut inmuebles: HashMap<String, i64> = filas_inm
        .iter()
        .map(|f| {
            (
                clave_inm(f.resto.get("direccion").and_then(Value::as_str).unwrap_or(""), f.resto.get("piso_depto").and_then(Value::as_str).unwrap_or("")),
                f.id,
            )
        })
        .collect();
    let filas_con: Vec<Fila> = cliente.select("contratos", "select=id,inmueble_id,inquilino_id,fecha_inicio").await.map_err(map_err)?;
    let mut contratos_existentes: HashMap<String, i64> = filas_con
        .iter()
        .map(|f| {
            (
                format!(
                    "{}|{}|{}",
                    f.resto.get("inmueble_id").and_then(Value::as_i64).unwrap_or(0),
                    f.resto.get("inquilino_id").and_then(Value::as_i64).unwrap_or(0),
                    f.resto.get("fecha_inicio").and_then(Value::as_str).unwrap_or("")
                ),
                f.id,
            )
        })
        .collect();
    let mut numero: i64 = {
        #[derive(Deserialize)]
        struct N {
            numero: Option<i64>,
        }
        let v: Vec<N> = cliente.select("contratos", "select=numero&order=numero.desc.nullslast&limit=1").await.map_err(map_err)?;
        v.first().and_then(|n| n.numero).unwrap_or(0)
    };

    let mut resultado = Vec::new();
    let (mut n_creados, mut n_existentes, mut n_personas, mut n_inmuebles, mut n_pagos) = (0, 0, 0, 0, 0);

    for (i, c) in contratos.iter().enumerate() {
        if !incluir.contains(&i) {
            continue;
        }
        let nombre_inq = c.pointer("/inquilino/nombre").and_then(Value::as_str).unwrap_or("").to_string();
        let r: Result<Value, String> = async {
            let (prop_id, nuevo) = propietarios.obtener(&cliente, &c["propietario"], &["datos_bancarios"]).await?;
            n_personas += nuevo as i32;
            let (inq_id, nuevo) = inquilinos.obtener(&cliente, &c["inquilino"], &[]).await?;
            n_personas += nuevo as i32;
            let mut garante_ids = Vec::new();
            for g in c["garantes"].as_array().cloned().unwrap_or_default() {
                let (gid, nuevo) = garantes.obtener(&cliente, &g, &["tipo_garantia", "detalle_garantia"]).await?;
                n_personas += nuevo as i32;
                garante_ids.push(gid);
            }

            let inm = &c["inmueble"];
            let clave = clave_inm(&texto(inm, "direccion"), &texto(inm, "piso_depto"));
            let inm_id = match inmuebles.get(&clave) {
                Some(id) => *id,
                None => {
                    let mut body = Map::new();
                    body.insert("propietario_id".into(), json!(prop_id));
                    for k in [
                        "direccion", "piso_depto", "localidad", "tipo", "destino", "servicio_luz", "servicio_luz_contrato", "servicio_gas",
                        "servicio_agua", "matricula", "nomenclatura_catastral", "cuenta_rentas",
                    ] {
                        let v = texto(inm, k);
                        if !v.is_empty() {
                            body.insert(k.into(), json!(v));
                        }
                    }
                    body.insert("provincia".into(), json!("Córdoba"));
                    let f: Fila = cliente.insert("inmuebles", &Value::Object(body)).await.map_err(map_err)?;
                    inmuebles.insert(clave, f.id);
                    n_inmuebles += 1;
                    f.id
                }
            };

            let k = &c["contrato"];
            let ini = texto(k, "fecha_inicio");
            let clave_c = format!("{}|{}|{}", inm_id, inq_id, ini);
            if let Some(id) = contratos_existentes.get(&clave_c) {
                n_existentes += 1;
                return Ok(json!({"estado": "ya estaba", "contrato_id": id}));
            }
            numero += 1;
            let notas = {
                let n = texto(k, "notas");
                let base = format!("Carga inicial desde {} / {}", texto(c, "carpeta"), texto(c, "archivo"));
                if n.is_empty() { base } else { format!("{}\n{}", n, base) }
            };
            // Marca el contrato como saldado hasta el mes pagado por fuera de la app
            // (por defecto, octubre 2026). Así los meses anteriores no se suman como
            // deuda del inquilino en el tablero.
            let periodo_pagado = datos.get("periodo_pagado").and_then(Value::as_str).unwrap_or("2026-10").to_string();
            let liquidado_hasta = if c["pagar_octubre"].as_bool().unwrap_or(false) && ini.as_str() <= format!("{}-01", periodo_pagado).as_str() {
                Some(periodo_pagado.clone())
            } else {
                None
            };
            let body = json!({
                "inmueble_id": inm_id, "inquilino_id": inq_id, "fecha_inicio": ini, "fecha_fin": texto(k, "fecha_fin"),
                "dia_pago": k["dia_pago"].as_i64().unwrap_or(10), "monto_inicial": k["monto_inicial"].as_f64().unwrap_or(0.0),
                "comision_porcentaje": 0, "tasa_mora_diaria": k["tasa_mora_diaria"].as_f64().unwrap_or(0.0),
                "frecuencia_actualizacion_meses": k["frecuencia_actualizacion_meses"].as_i64().unwrap_or(12),
                "tipo_actualizacion": texto(k, "tipo_actualizacion"), "porcentaje_actualizacion": 0,
                "estado": "activo", "notas": notas,
                "destino": texto(k, "destino"), "deposito_garantia": 0, "multa_diaria": 0, "conceptos_fijos": [], "numero": numero,
                "liquidado_hasta": liquidado_hasta,
            });
            let f: Fila = cliente.insert("contratos", &body).await.map_err(map_err)?;
            let cid = f.id;
            contratos_existentes.insert(clave_c, cid);
            for gid in garante_ids {
                cliente
                    .insert_ignorando_conflicto("contrato_garantes", &json!({"contrato_id": cid, "garante_id": gid}), "contrato_id,garante_id")
                    .await
                    .map_err(map_err)?;
            }

            // Aumentos ya aplicados según el índice del contrato.
            let mut monto = k["monto_inicial"].as_f64().unwrap_or(0.0);
            for p in c["pasos"].as_array().cloned().unwrap_or_default() {
                let ratio = p["ratio"].as_f64().unwrap_or(1.0);
                monto = redondear_a(monto * ratio, redondeo);
                cliente
                    .insert::<Value>(
                        "actualizaciones",
                        &json!({"contrato_id": cid, "fecha_vigencia": texto(&p, "fecha_vigencia"), "monto_nuevo": monto,
                                "motivo": format!("Carga inicial · {}", texto(&p, "detalle"))}),
                    )
                    .await
                    .map_err(map_err)?;
            }

            // Octubre ya pagado (sin recibo: número 0). El contrato ya quedó
            // marcado como "liquidado_hasta" ese mes, así que lo anterior tampoco
            // aparece como deuda.
            let mut pagado = false;
            if liquidado_hasta.is_some() {
                let periodo = periodo_pagado.clone();
                cliente
                    .insert::<Value>(
                        "pagos",
                        &json!({"contrato_id": cid, "periodo": periodo, "fecha_pago": format!("{}-10", periodo), "monto_alquiler": monto,
                                "dias_mora": 0, "monto_mora": 0, "monto_total": monto, "metodo_pago": "Carga inicial", "numero_recibo": 0,
                                "notas": "Pagado antes de usar la app (carga inicial, sin recibo)", "usuario": usuario}),
                    )
                    .await
                    .map_err(map_err)?;
                n_pagos += 1;
                pagado = true;
            }
            n_creados += 1;
            Ok(json!({"estado": "cargado", "contrato_id": cid, "numero": numero, "monto_vigente": monto, "octubre_pagado": pagado}))
        }
        .await;
        resultado.push(match r {
            Ok(mut v) => {
                v["indice"] = json!(i);
                v["inquilino"] = json!(nombre_inq);
                v
            }
            Err(e) => json!({"indice": i, "inquilino": nombre_inq, "estado": "error", "error": e}),
        });
    }

    Ok(json!({
        "contratos_cargados": n_creados, "contratos_que_ya_estaban": n_existentes, "personas_nuevas": n_personas,
        "inmuebles_nuevos": n_inmuebles, "pagos_octubre": n_pagos, "detalle": resultado,
    }))
}
