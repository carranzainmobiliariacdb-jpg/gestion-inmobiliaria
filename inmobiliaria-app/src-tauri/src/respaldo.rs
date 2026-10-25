//! Respaldo completo de los datos: un Excel con una hoja por tabla, un JSON
//! con todo (para poder restaurar) y un PDF con el resumen de los alquileres
//! activos. Se guarda en la carpeta elegida (idealmente la de Google Drive,
//! OneDrive o Dropbox de la PC, que lo sube sola a la nube). Las fotos de los
//! inmuebles se copian como archivos .jpg en una carpeta «Fotos» compartida
//! entre respaldos (sólo se agregan las nuevas).

use crate::commands::{obtener_cliente, DbState};
use base64::Engine;
use rust_xlsxwriter::{Format, Workbook};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::State;

/// (tabla, nombre de la hoja, columnas a pedir, orden)
const TABLAS: &[(&str, &str, &str, &str)] = &[
    ("propietarios", "Propietarios", "*", "id"),
    ("inquilinos", "Inquilinos", "*", "id"),
    ("garantes", "Garantes", "*", "id"),
    ("inmuebles", "Inmuebles", "*", "id"),
    ("contratos", "Contratos", "*", "id"),
    ("contrato_garantes", "Contrato-garantes", "*", "contrato_id,garante_id"),
    ("actualizaciones", "Aumentos", "*", "id"),
    ("pagos", "Cobros", "*", "id"),
    ("liquidaciones", "Liquidaciones", "*", "id"),
    ("servicios_estado", "Servicios", "*", "id"),
    ("recordatorios", "Mensajes enviados", "*", "id"),
    ("inmueble_fotos", "Fotos (lista)", "id,inmueble_id,contrato_id,tipo,descripcion,fecha,usuario", "id"),
    ("documentos_generados", "Contratos generados", "*", "id"),
    ("modelos_contrato", "Modelos de contrato", "*", "id"),
    ("indices_ipc", "IPC manual", "*", "periodo"),
    ("configuracion", "Configuración", "*", "clave"),
    ("usuarios", "Usuarios", "id,username,nombre_completo,activo", "id"),
];

const LOTE: usize = 1000;

async fn todas_las_filas(cliente: &crate::supabase::Cliente, tabla: &str, cols: &str, orden: &str, lote: usize) -> Result<Vec<Value>, String> {
    let mut filas = Vec::new();
    let mut desde = 0usize;
    loop {
        let q = format!("select={}&order={}&limit={}&offset={}", cols, orden, lote, desde);
        let parte: Vec<Value> = cliente.select(tabla, &q).await.map_err(|e| e.to_string())?;
        let n = parte.len();
        filas.extend(parte);
        if n < lote {
            break;
        }
        desde += lote;
    }
    Ok(filas)
}

fn texto_celda(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => (if *b { "Sí" } else { "No" }).to_string(),
        otro => otro.to_string(),
    };
    // Límite de Excel por celda.
    if s.chars().count() > 32000 {
        s.chars().take(32000).collect::<String>() + "…"
    } else {
        s
    }
}

fn hoja(libro: &mut Workbook, nombre: &str, filas: &[Value], negrita: &Format) -> Result<(), String> {
    let h = libro.add_worksheet();
    h.set_name(nombre).map_err(|e| e.to_string())?;
    let mut cols: Vec<String> = Vec::new();
    for f in filas {
        if let Some(o) = f.as_object() {
            for k in o.keys() {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    if cols.is_empty() {
        h.write_string(0, 0, "Sin datos").map_err(|e| e.to_string())?;
        return Ok(());
    }
    for (c, k) in cols.iter().enumerate() {
        h.write_string_with_format(0, c as u16, k, negrita).map_err(|e| e.to_string())?;
    }
    for (r, f) in filas.iter().enumerate() {
        let fila = (r + 1) as u32;
        for (c, k) in cols.iter().enumerate() {
            let v = f.get(k).unwrap_or(&Value::Null);
            match v {
                Value::Number(n) if n.as_f64().is_some() => {
                    h.write_number(fila, c as u16, n.as_f64().unwrap()).map_err(|e| e.to_string())?;
                }
                Value::Null => {}
                otro => {
                    h.write_string(fila, c as u16, texto_celda(otro)).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    h.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
    h.set_autofit_max_width(320);
    h.autofit();
    Ok(())
}

/// Hoja de resumen que arma el frontend: primera fila = títulos.
fn hoja_resumen(libro: &mut Workbook, filas: &[Vec<Value>], negrita: &Format) -> Result<(), String> {
    let h = libro.add_worksheet();
    h.set_name("Alquileres activos").map_err(|e| e.to_string())?;
    for (r, fila) in filas.iter().enumerate() {
        for (c, v) in fila.iter().enumerate() {
            match v {
                Value::Number(n) if n.as_f64().is_some() => {
                    h.write_number(r as u32, c as u16, n.as_f64().unwrap()).map_err(|e| e.to_string())?;
                }
                otro if r == 0 => {
                    h.write_string_with_format(0, c as u16, texto_celda(otro), negrita).map_err(|e| e.to_string())?;
                }
                otro => {
                    h.write_string(r as u32, c as u16, texto_celda(otro)).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    h.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
    h.set_autofit_max_width(360);
    h.autofit();
    Ok(())
}

/// "data:image/jpeg;base64,...." → (bytes, extensión)
fn decodificar_foto(dato: &str) -> Option<(Vec<u8>, &'static str)> {
    let (cab, b64) = dato.split_once(',')?;
    let ext = if cab.contains("png") { "png" } else if cab.contains("webp") { "webp" } else { "jpg" };
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    Some((bytes, ext))
}

fn limpio(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_°.".contains(c) { c } else { '_' })
        .collect();
    let t = t.trim().to_string();
    if t.is_empty() { "sin_nombre".into() } else { t.chars().take(60).collect() }
}

#[tauri::command]
pub async fn hacer_respaldo(
    state: State<'_, DbState>,
    carpeta: String,
    resumen_html: String,
    resumen_filas: Vec<Vec<Value>>,
    con_fotos: bool,
) -> Result<Value, String> {
    let carpeta = carpeta.trim();
    if carpeta.is_empty() || !Path::new(carpeta).exists() {
        return Err("La carpeta de respaldo no existe. Elegila de nuevo en Configuración → Respaldo.".into());
    }
    let cliente = obtener_cliente(&state).await?;
    let raiz = PathBuf::from(carpeta).join("Respaldos Gestión Inmobiliaria");
    let marca = chrono::Local::now().format("%Y-%m-%d %H-%M").to_string();
    let dir = raiz.join(format!("Respaldo {}", marca));
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta del respaldo: {}", e))?;

    // 1) Datos
    let mut todo = Map::new();
    let mut resumen_tablas = Vec::new();
    let mut errores = Vec::new();
    let mut por_tabla: Vec<(&str, Vec<Value>)> = Vec::new();
    for (tabla, hoja_nombre, cols, orden) in TABLAS {
        match todas_las_filas(&cliente, tabla, cols, orden, LOTE).await {
            Ok(filas) => {
                resumen_tablas.push(json!({ "tabla": hoja_nombre, "filas": filas.len() }));
                todo.insert(tabla.to_string(), Value::Array(filas.clone()));
                por_tabla.push((hoja_nombre, filas));
            }
            Err(e) => errores.push(format!("{}: {}", hoja_nombre, e)),
        }
    }
    let ahora = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let json_todo = json!({ "app": "Gestión Inmobiliaria", "version": env!("CARGO_PKG_VERSION"), "fecha": ahora, "tablas": todo });
    let ruta_json = dir.join("datos-completos.json");
    std::fs::write(&ruta_json, serde_json::to_vec_pretty(&json_todo).map_err(|e| e.to_string())?)
        .map_err(|e| format!("No se pudo guardar el JSON: {}", e))?;

    // 2) Excel
    let mut libro = Workbook::new();
    let negrita = Format::new().set_bold().set_background_color(0xF5ECD8);
    if resumen_filas.len() > 1 {
        hoja_resumen(&mut libro, &resumen_filas, &negrita)?;
    }
    for (nombre, filas) in &por_tabla {
        hoja(&mut libro, nombre, filas, &negrita)?;
    }
    let ruta_xlsx = dir.join(format!("Respaldo {}.xlsx", marca));
    libro.save(&ruta_xlsx).map_err(|e| format!("No se pudo guardar el Excel: {}", e))?;

    // 3) PDF resumen
    let mut archivos = vec![ruta_xlsx.to_string_lossy().to_string(), ruta_json.to_string_lossy().to_string()];
    if !resumen_html.is_empty() {
        match crate::pdf::generar_pdf_temporal(&resumen_html, &format!("Resumen alquileres {}", marca)) {
            Ok(tmp) => {
                let destino = dir.join(format!("Resumen alquileres {}.pdf", marca));
                if std::fs::copy(&tmp, &destino).is_ok() {
                    archivos.push(destino.to_string_lossy().to_string());
                }
            }
            Err(e) => errores.push(format!("PDF resumen: {}", e)),
        }
    }

    // 4) Fotos (sólo las que todavía no están en la carpeta Fotos)
    let mut fotos_nuevas = 0;
    if con_fotos {
        let dir_fotos = raiz.join("Fotos");
        let lista = todo.get("inmueble_fotos").and_then(Value::as_array).cloned().unwrap_or_default();
        let inmuebles = todo.get("inmuebles").and_then(Value::as_array).cloned().unwrap_or_default();
        let nombre_inm = |id: i64| -> String {
            inmuebles
                .iter()
                .find(|i| i.get("id").and_then(Value::as_i64) == Some(id))
                .map(|i| {
                    let cod = i.get("codigo").map(texto_celda).unwrap_or_default();
                    let dir = i.get("direccion").and_then(Value::as_str).unwrap_or("");
                    limpio(&format!("{} {}", cod, dir))
                })
                .unwrap_or_else(|| format!("inmueble {}", id))
        };
        for f in lista {
            let Some(id) = f.get("id").and_then(Value::as_i64) else { continue };
            let inm = f.get("inmueble_id").and_then(Value::as_i64).unwrap_or(0);
            let sub = dir_fotos.join(nombre_inm(inm));
            let base = format!(
                "{} {} {} {}",
                id,
                f.get("tipo").and_then(Value::as_str).unwrap_or(""),
                f.get("fecha").and_then(Value::as_str).unwrap_or(""),
                f.get("descripcion").and_then(Value::as_str).unwrap_or("")
            );
            let base = limpio(&base);
            let ya = ["jpg", "png", "webp"].iter().any(|e| sub.join(format!("{}.{}", base, e)).exists());
            if ya {
                continue;
            }
            let fila: Option<Value> = cliente
                .select_uno("inmueble_fotos", &format!("id=eq.{}&select=foto", id))
                .await
                .ok()
                .flatten();
            if let Some((bytes, ext)) = fila.as_ref().and_then(|v| v.get("foto")).and_then(Value::as_str).and_then(decodificar_foto) {
                if std::fs::create_dir_all(&sub).is_ok() && std::fs::write(sub.join(format!("{}.{}", base, ext)), bytes).is_ok() {
                    fotos_nuevas += 1;
                }
            }
        }
    }

    Ok(json!({
        "carpeta": dir.to_string_lossy(),
        "archivos": archivos,
        "tablas": resumen_tablas,
        "fotos_nuevas": fotos_nuevas,
        "errores": errores,
        "fecha": ahora,
    }))
}

fn agregar_nube(out: &mut Vec<Value>, nombre: &str, p: PathBuf) {
    if p.is_dir() && !out.iter().any(|x| x["ruta"] == p.to_string_lossy().as_ref()) {
        out.push(json!({ "nombre": nombre, "ruta": p.to_string_lossy() }));
    }
}

/// Carpetas de nubes instaladas en la PC (Google Drive, OneDrive, Dropbox, iCloud).
#[tauri::command]
pub fn carpetas_nube() -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (var, nombre) in [("OneDriveConsumer", "OneDrive"), ("OneDrive", "OneDrive"), ("OneDriveCommercial", "OneDrive (trabajo)")] {
        if let Ok(v) = std::env::var(var) {
            agregar_nube(&mut out, nombre, PathBuf::from(v));
        }
    }
    if cfg!(windows) {
        for letra in b'D'..=b'Z' {
            for sub in ["Mi unidad", "My Drive"] {
                agregar_nube(&mut out, "Google Drive", PathBuf::from(format!("{}:\\{}", letra as char, sub)));
            }
        }
    }
    let casa = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map(PathBuf::from);
    if let Ok(h) = casa {
        agregar_nube(&mut out, "Google Drive", h.join("Google Drive").join("Mi unidad"));
        agregar_nube(&mut out, "Google Drive", h.join("Google Drive").join("My Drive"));
        if !out.iter().any(|x| x["nombre"] == "Google Drive") {
            agregar_nube(&mut out, "Google Drive", h.join("Google Drive"));
        }
        agregar_nube(&mut out, "Dropbox", h.join("Dropbox"));
        agregar_nube(&mut out, "iCloud Drive", h.join("iCloudDrive"));
    }
    out
}
