//! Puente de pruebas: corre los comandos reales de la app (con el runtime de
//! prueba de Tauri, sin ventana) y los expone por HTTP para probar la
//! interfaz en un navegador contra un PostgREST local. No forma parte del
//! instalador.
//!
//!   cargo run --example puente_pruebas -- http://localhost:3300 ../src 8787

use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let rest = args.get(1).cloned().unwrap_or("http://localhost:3300".into());
    let estaticos = std::path::PathBuf::from(args.get(2).cloned().unwrap_or("../src".into()));
    let puerto = args.get(3).cloned().unwrap_or("8787".into());

    let app = mock_builder()
        .manage(inmobiliaria_app_lib::estado_para_pruebas(rest, std::env::var("ANON_KEY").unwrap_or("anon".into())))
        .invoke_handler(inmobiliaria_app_lib::manejador())
        .build(mock_context(noop_assets()))
        .expect("app de prueba");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

    let listener = TcpListener::bind(format!("127.0.0.1:{}", puerto)).unwrap();
    eprintln!("puente escuchando en http://127.0.0.1:{}", puerto);
    for stream in listener.incoming() {
        let Ok(mut s) = stream else { continue };
        let mut buf = Vec::new();
        let mut tmp = [0u8; 65536];
        // leer cabeceras + cuerpo (Content-Length)
        let (cabeceras, mut cuerpo) = loop {
            let n = s.read(&mut tmp).unwrap_or(0);
            if n == 0 { break (String::new(), Vec::new()); }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break (String::from_utf8_lossy(&buf[..pos]).to_string(), buf[pos + 4..].to_vec());
            }
        };
        let largo: usize = cabeceras
            .lines()
            .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
            .unwrap_or(0);
        while cuerpo.len() < largo {
            let n = s.read(&mut tmp).unwrap_or(0);
            if n == 0 { break; }
            cuerpo.extend_from_slice(&tmp[..n]);
        }
        let primera = cabeceras.lines().next().unwrap_or("").to_string();
        let mut partes = primera.split_whitespace();
        let metodo = partes.next().unwrap_or("");
        let ruta = partes.next().unwrap_or("/").split('?').next().unwrap().to_string();

        let (status, tipo, respuesta): (&str, &str, Vec<u8>) = if metodo == "POST" && ruta == "/invoke" {
            let pedido: serde_json::Value = serde_json::from_slice(&cuerpo).unwrap_or_default();
            let cmd = pedido["cmd"].as_str().unwrap_or("").to_string();
            let argumentos = pedido.get("args").cloned().unwrap_or(serde_json::json!({}));
            let res = if cmd == "abrir_enlace" {
                eprintln!("[WHATSAPP] {}", argumentos["url"]);
                Ok(serde_json::Value::Null)
            } else if cmd == "abrir_en_word" {
                let _ = std::fs::write("/tmp/ultimo-documento.doc", argumentos["html"].as_str().unwrap_or(""));
                Ok(serde_json::json!("C:\\Users\\agustin\\Documents\\Contratos Carranza\\prueba.doc"))
            } else if cmd == "consultar_bcra" && std::env::var("BCRA_FALSO").is_ok() {
                // Respuesta simulada (el entorno de pruebas no llega a api.bcra.gob.ar)
                Ok(serde_json::json!({
                    "cuit": argumentos["cuit"], "situacion": 2, "peor_historica": 3, "cantidad_cheques": 1,
                    "deudas": {"identificacion": 27334445556i64, "denominacion": "GOMEZ CARLA BEATRIZ", "periodos": [{"periodo": "202608", "entidades": [
                        {"entidad": "BANCO DE LA NACION ARGENTINA", "situacion": 1, "monto": 350.0, "diasAtrasoPago": 0, "refinanciaciones": false, "procesoJud": false, "situacionJuridica": false},
                        {"entidad": "TARJETA NARANJA S.A.", "situacion": 2, "monto": 120.5, "diasAtrasoPago": 45, "refinanciaciones": true, "procesoJud": false, "situacionJuridica": false}]}]},
                    "historicas": null, "cheques": null
                }))
            } else if ["revisar_actualizaciones", "maximizar_ventana", "minimizar_ventana", "cerrar_ventana"].contains(&cmd.as_str()) {
                Ok(serde_json::Value::Null)
            } else {
                let r = get_ipc_response(
                    &webview,
                    InvokeRequest {
                        cmd: cmd.clone(),
                        callback: CallbackFn(0),
                        error: CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: InvokeBody::Json(argumentos),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.to_string(),
                    },
                );
                match r {
                    Ok(body) => Ok(body.deserialize::<serde_json::Value>().unwrap_or(serde_json::Value::Null)),
                    Err(e) => Err(e),
                }
            };
            let json = match res {
                Ok(v) => serde_json::json!({"ok": v}),
                Err(e) => serde_json::json!({"err": e}),
            };
            ("200 OK", "application/json", json.to_string().into_bytes())
        } else {
            let rel = if ruta == "/" { "index.html".to_string() } else { ruta.trim_start_matches('/').to_string() };
            let path = estaticos.join(&rel);
            match std::fs::read(&path) {
                Ok(b) => {
                    let t = match path.extension().and_then(|e| e.to_str()) {
                        Some("html") => "text/html; charset=utf-8",
                        Some("js") => "text/javascript",
                        Some("css") => "text/css",
                        Some("wasm") => "application/wasm",
                        Some("png") => "image/png",
                        Some("jpg") => "image/jpeg",
                        Some("sql") => "text/plain; charset=utf-8",
                        _ => "application/octet-stream",
                    };
                    ("200 OK", t, b)
                }
                Err(_) => ("404 Not Found", "text/plain", b"no".to_vec()),
            }
        };
        let cab = format!("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n", status, tipo, respuesta.len());
        let _ = s.write_all(cab.as_bytes());
        let _ = s.write_all(&respuesta);
    }
}
