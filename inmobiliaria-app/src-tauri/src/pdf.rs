//! Genera PDFs (recibo, liquidación) a partir del mismo HTML que se imprime,
//! usando Microsoft Edge en modo headless (viene con Windows 10/11, no hay
//! que instalar nada extra). Después deja el PDF en el portapapeles para
//! que la inmobiliaria lo pegue en el chat de WhatsApp con Ctrl+V.
//!
//! Pensado para Windows. En Linux/macOS busca Chrome o Chromium para que
//! también se pueda probar desde desarrollo.
//!
//! Flujo que ve el frontend:
//! 1. `generar_pdf(html, nombre)` → arma un .pdf en %TEMP%\inmobiliaria-pdf
//!    y devuelve la ruta. El HTML llega ya "materializado" (estilos y logos
//!    inlineados en el HTML) desde el frontend.
//! 2. `copiar_pdf_portapapeles(ruta)` → copia el PDF al portapapeles de
//!    Windows para que WhatsApp lo levante con Ctrl+V.

use std::path::{Path, PathBuf};
use std::process::Command;

const CARPETA: &str = "inmobiliaria-pdf";

fn carpeta_salida() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(CARPETA);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Nombre de archivo seguro (sin barras, dos puntos, etc. que molestan en
/// Windows). Deja letras/dígitos/guiones y recorta a algo razonable.
fn nombre_seguro(n: &str) -> String {
    let limpio: String = n
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    let limpio = limpio.trim().replace(' ', "_");
    let corto: String = limpio.chars().take(60).collect();
    if corto.is_empty() { "documento".into() } else { corto }
}

/// Busca msedge/chromium/chrome en lugares típicos.
fn navegador() -> Option<PathBuf> {
    // 1) Variable de entorno (por si se usa un navegador personalizado).
    if let Ok(p) = std::env::var("INMOBILIARIA_PDF_BROWSER") {
        let r = PathBuf::from(&p);
        if r.exists() {
            return Some(r);
        }
    }
    // 2) Rutas típicas de Windows (Dana usa Windows). Edge va primero porque
    //    está en todas las instalaciones recientes.
    const RUTAS_WIN: &[&str] = &[
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    for r in RUTAS_WIN {
        if Path::new(r).exists() {
            return Some(PathBuf::from(r));
        }
    }
    // 3) Linux/macOS (sólo para que funcione desde desarrollo).
    for n in ["msedge", "microsoft-edge", "chromium", "chromium-browser", "google-chrome", "chrome"] {
        if let Ok(out) = Command::new(if cfg!(windows) { "where" } else { "which" }).arg(n).output() {
            if let Some(l) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = PathBuf::from(l.trim());
                if !l.trim().is_empty() && p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Genera un PDF a partir de un HTML autocontenido. Devuelve la ruta al PDF.
#[tauri::command]
pub async fn generar_pdf(html: String, nombre: String) -> Result<String, String> {
    generar_pdf_temporal(&html, &nombre)
}

fn generar_pdf_temporal(html: &str, nombre: &str) -> Result<String, String> {
    let dir = carpeta_salida().map_err(|e| format!("No se pudo crear la carpeta de PDFs: {}", e))?;
    let base = nombre_seguro(nombre);
    let html_path = dir.join(format!("{}.html", base));
    let pdf_path = dir.join(format!("{}.pdf", base));
    std::fs::write(&html_path, html.as_bytes()).map_err(|e| format!("No se pudo guardar el HTML temporal: {}", e))?;

    let edge = navegador().ok_or(
        "No se encontró Microsoft Edge (ni Chrome) para generar el PDF. En Windows debería estar en C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    )?;

    // file:///C:/… para Windows, file:///home/… para Linux. En Windows hay que
    // reemplazar barras invertidas por normales.
    let url = {
        let mut s = html_path.to_string_lossy().replace('\\', "/");
        if !s.starts_with('/') {
            s = format!("/{}", s);
        }
        format!("file://{}", s)
    };
    let pdf_arg = format!("--print-to-pdf={}", pdf_path.to_string_lossy());

    let mut cmd = Command::new(&edge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--no-sandbox",
        &pdf_arg,
        &url,
    ]);
    #[cfg(windows)]
    {
        // Que no se vea una ventanita de consola al correr Edge headless.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let salida = cmd.output().map_err(|e| format!("No se pudo correr Edge para generar el PDF: {}", e))?;
    if !pdf_path.exists() {
        let err = String::from_utf8_lossy(&salida.stderr);
        return Err(format!("Edge no generó el PDF. Detalle: {}", err.lines().take(5).collect::<Vec<_>>().join(" | ")));
    }
    // El .html temporal ya no hace falta; dejamos el PDF para que la persona
    // también lo pueda abrir desde la carpeta si quiere revisarlo.
    let _ = std::fs::remove_file(&html_path);
    Ok(pdf_path.to_string_lossy().to_string())
}

/// Copia un archivo al portapapeles de Windows como "archivo" (CF_HDROP), para
/// que al apretar Ctrl+V en WhatsApp Desktop se pegue como adjunto. Usa
/// PowerShell (`Set-Clipboard -Path`) para no depender de otra librería.
#[tauri::command]
pub async fn copiar_pdf_portapapeles(ruta: String) -> Result<(), String> {
    if !Path::new(&ruta).exists() {
        return Err(format!("No existe el archivo: {}", ruta));
    }
    #[cfg(windows)]
    {
        let script = format!("Set-Clipboard -Path \"{}\"", ruta.replace('"', "`\""));
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let salida = cmd.output().map_err(|e| format!("No se pudo copiar el PDF al portapapeles: {}", e))?;
        if !salida.status.success() {
            return Err(format!("PowerShell no pudo copiar el PDF: {}", String::from_utf8_lossy(&salida.stderr).lines().take(3).collect::<Vec<_>>().join(" | ")));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // Fuera de Windows no hace falta — es sólo para que compile en Linux (desarrollo).
        let _ = ruta;
        Ok(())
    }
}


// ---------- Guardar en una carpeta elegida ----------

/// Carpeta por defecto: Documentos\Carranza Inmobiliaria.
fn carpeta_por_defecto<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    use tauri::Manager;
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Carranza Inmobiliaria")
}

#[tauri::command]
pub fn carpeta_pdfs_por_defecto<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    carpeta_por_defecto(&app).to_string_lossy().to_string()
}

/// Genera el PDF y lo deja en `carpeta` (o la de por defecto) / `subcarpeta`
/// (ej. "Recibos/2026-10"). Si ya existe un archivo con ese nombre, lo
/// reemplaza (es el mismo documento). Devuelve la ruta final.
#[tauri::command]
pub async fn guardar_pdf<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    html: String,
    nombre: String,
    carpeta: Option<String>,
    subcarpeta: Option<String>,
) -> Result<String, String> {
    let temporal = generar_pdf_temporal(&html, &nombre)?;
    let mut destino = match carpeta.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => PathBuf::from(c),
        _ => carpeta_por_defecto(&app),
    };
    for parte in subcarpeta.unwrap_or_default().split(['/', '\\']) {
        let p = nombre_seguro(parte);
        if !parte.trim().is_empty() {
            destino.push(p);
        }
    }
    std::fs::create_dir_all(&destino).map_err(|e| format!("No se pudo crear la carpeta {}: {}", destino.display(), e))?;
    let archivo = destino.join(format!("{}.pdf", nombre_seguro(&nombre)));
    std::fs::copy(&temporal, &archivo).map_err(|e| {
        format!("No se pudo guardar el PDF en {} ({}). Si el PDF está abierto, cerralo y probá de nuevo.", archivo.display(), e)
    })?;
    Ok(archivo.to_string_lossy().to_string())
}

/// Abre el Explorador de Windows con el archivo seleccionado (para
/// arrastrarlo a WhatsApp, a un mail, etc.).
#[tauri::command]
pub async fn mostrar_en_carpeta(ruta: String) -> Result<(), String> {
    if !Path::new(&ruta).exists() {
        return Err(format!("No existe el archivo: {}", ruta));
    }
    #[cfg(windows)]
    {
        Command::new("explorer").arg(format!("/select,{}", ruta)).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = ruta;
    }
    Ok(())
}

/// Abre el PDF con el programa predeterminado.
#[tauri::command]
pub async fn abrir_pdf<R: tauri::Runtime>(app: tauri::AppHandle<R>, ruta: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !ruta.to_lowercase().ends_with(".pdf") || !Path::new(&ruta).exists() {
        return Err("No se encontró el PDF".into());
    }
    app.opener().open_path(ruta, None::<&str>).map_err(|e| e.to_string())
}

/// Ventana para elegir la carpeta donde se guardan los PDFs.
#[tauri::command]
pub async fn elegir_carpeta<R: tauri::Runtime>(app: tauri::AppHandle<R>, actual: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file().set_title("Carpeta donde guardar los PDFs");
    if let Some(a) = actual.filter(|a| Path::new(a).exists()) {
        d = d.set_directory(a);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    d.pick_folder(move |r| {
        let _ = tx.send(r);
    });
    let elegido = rx.await.map_err(|e| e.to_string())?;
    Ok(elegido.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}
