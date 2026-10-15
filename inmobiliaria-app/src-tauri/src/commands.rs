use crate::config::{CredencialesGuardadas, SupabaseConfig};
use crate::icl;
use crate::models::*;
use crate::supabase::{Cliente, ErrorSupabase, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION};
use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, State};
use tokio::sync::RwLock;

pub struct DbState(pub RwLock<Option<Cliente>>);

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn obtener_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Se llama al arrancar la app. Si hay una versión nueva publicada, la baja,
/// la instala (sin diálogos, silenciosa) y reinicia la app ya actualizada —
/// Agustín no tiene que hacer nada. Si no hay internet o no hay versión
/// nueva, sigue todo igual que antes.
#[tauri::command]
pub async fn revisar_actualizaciones<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;

    let actualizacion = app
        .updater()
        .map_err(map_err)?
        .check()
        .await
        .map_err(map_err)?;

    let Some(actualizacion) = actualizacion else {
        return Ok(false);
    };

    actualizacion
        .download_and_install(|_descargado, _total| {}, || {})
        .await
        .map_err(map_err)?;

    app.restart();
}

/// La ventana ya arranca con resizable=true (igual se ve de tamaño fijo
/// porque decorations=false le saca los bordes para agarrar y redimensionar
/// a mano). Si acá se llamara a set_resizable(true) recién al maximizar, en
/// algunos entornos Linux el gestor de ventanas vuelve a dibujar la barra de
/// título nativa en ese momento — por eso resizable se deja fijo desde el
/// arranque y maximizar_ventana sólo pide maximizar.
#[tauri::command]
pub fn maximizar_ventana<R: tauri::Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.maximize().map_err(map_err)
}

/// Sin la barra de título nativa de Windows (decorations=false, para sacar
/// la franja blanca de arriba) la ventana no tiene botones de minimizar ni
/// cerrar — hacen falta estos dos comandos para que la barra propia de la
/// app pueda ofrecerlos.
#[tauri::command]
pub fn minimizar_ventana<R: tauri::Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.minimize().map_err(map_err)
}

#[tauri::command]
pub fn cerrar_ventana<R: tauri::Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.close().map_err(map_err)
}

#[tauri::command]
pub fn leer_credenciales_guardadas<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Option<CredencialesGuardadas>, String> {
    let data_dir = app.path().app_data_dir().map_err(map_err)?;
    Ok(crate::config::leer_credenciales_guardadas(&data_dir))
}

#[tauri::command]
pub fn guardar_credenciales<R: tauri::Runtime>(app: tauri::AppHandle<R>, username: String, password: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(map_err)?;
    crate::config::guardar_credenciales(&data_dir, &CredencialesGuardadas { username, password })
}

#[tauri::command]
pub fn borrar_credenciales<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(map_err)?;
    crate::config::borrar_credenciales(&data_dir)
}

/// Para deserializar la fila devuelta por un INSERT cuando solo hace falta
/// el id (p.ej. contratos, que trae columnas que no están en el modelo
/// `Contrato` usado por el frontend, como `garante_ids`).
#[derive(Deserialize)]
struct FilaId {
    id: i64,
}

pub(crate) async fn obtener_cliente(state: &DbState) -> Result<Cliente, String> {
    state
        .0
        .read()
        .await
        .clone()
        .ok_or_else(|| "La aplicación todavía no está conectada a Supabase. Configurá la conexión primero.".to_string())
}

fn parse_date(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or_else(|_| chrono::Local::now().date_naive())
}

fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .unwrap();
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    (next_month - first).num_days() as u32
}

fn add_months(date: NaiveDate, months: i64) -> NaiveDate {
    let total = date.year() as i64 * 12 + (date.month() as i64 - 1) + months;
    let year = (total.div_euclid(12)) as i32;
    let month = (total.rem_euclid(12) + 1) as u32;
    let day = date.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap()
}

fn due_date_for_periodo(periodo: &str, dia_pago: i64) -> NaiveDate {
    let partes: Vec<&str> = periodo.split('-').collect();
    let year: i32 = partes[0].parse().unwrap_or(today().year());
    let month: u32 = partes[1].parse().unwrap_or(1);
    let dia = (dia_pago as u32).clamp(1, days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, dia).unwrap()
}

fn periodo_de(date: NaiveDate) -> String {
    format!("{:04}-{:02}", date.year(), date.month())
}

/// Próxima fecha (hoy o en el futuro) en que la persona cumple años.
/// 29 de febrero en años no bisiestos se festeja el 28.
fn proxima_fecha_cumpleanos(nacimiento: NaiveDate, hoy: NaiveDate) -> NaiveDate {
    let dia = nacimiento.day().min(days_in_month(hoy.year(), nacimiento.month()));
    let candidato = NaiveDate::from_ymd_opt(hoy.year(), nacimiento.month(), dia).unwrap();
    if candidato >= hoy {
        candidato
    } else {
        let anio = hoy.year() + 1;
        let dia = nacimiento.day().min(days_in_month(anio, nacimiento.month()));
        NaiveDate::from_ymd_opt(anio, nacimiento.month(), dia).unwrap()
    }
}

#[derive(Debug, Deserialize, Clone)]
struct ActualizacionBase {
    fecha_vigencia: String,
    monto_nuevo: f64,
}

/// Monto de alquiler vigente a una fecha dada, según la actualización
/// registrada más reciente con vigencia en o antes de esa fecha.
fn monto_vigente_de(actualizaciones: &[ActualizacionBase], monto_inicial: f64, fecha: NaiveDate) -> f64 {
    actualizaciones
        .iter()
        .filter(|a| parse_date(&a.fecha_vigencia) <= fecha)
        .max_by(|a, b| a.fecha_vigencia.cmp(&b.fecha_vigencia))
        .map(|a| a.monto_nuevo)
        .unwrap_or(monto_inicial)
}

/// Fecha de vigencia de la última actualización registrada (la más reciente,
/// sin importar si es pasada o futura respecto de "hoy"), o la fecha de
/// inicio del contrato si todavía no tuvo ninguna. Es el punto de referencia
/// contra el que se mide la variación del índice para la próxima actualización.
fn fecha_base_de(actualizaciones: &[ActualizacionBase], fecha_inicio: NaiveDate) -> NaiveDate {
    actualizaciones
        .iter()
        .max_by(|a, b| a.fecha_vigencia.cmp(&b.fecha_vigencia))
        .map(|a| parse_date(&a.fecha_vigencia))
        .unwrap_or(fecha_inicio)
}

fn proxima_fecha_actualizacion_de(actualizaciones: &[ActualizacionBase], fecha_inicio: NaiveDate, frecuencia_meses: i64) -> NaiveDate {
    add_months(fecha_base_de(actualizaciones, fecha_inicio), frecuencia_meses.max(1))
}

async fn actualizaciones_de(cliente: &Cliente, contrato_id: i64) -> Result<Vec<ActualizacionBase>, String> {
    cliente
        .select("actualizaciones", &format!("contrato_id=eq.{}&select=fecha_vigencia,monto_nuevo", contrato_id))
        .await
        .map_err(map_err)
}

// ---------- Conexión a Supabase ----------

/// URL y clave "anon" de fábrica, incluidas en el instalador en tiempo de
/// compilación (variables de entorno INMOBILIARIA_SUPABASE_URL e
/// INMOBILIARIA_SUPABASE_ANON_KEY en el build de GitHub Actions). Permiten
/// que la app venga lista para usar sin que la persona que la instala tenga
/// que pegar ningún dato técnico. Si no están presentes (build local de
/// desarrollo), la app pide los datos a mano la primera vez, como antes.
const SUPABASE_URL_DE_FABRICA: Option<&str> = option_env!("INMOBILIARIA_SUPABASE_URL");
const SUPABASE_ANON_KEY_DE_FABRICA: Option<&str> = option_env!("INMOBILIARIA_SUPABASE_ANON_KEY");

async fn conectar_y_guardar<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &State<'_, DbState>, config: SupabaseConfig) -> Result<(), String> {
    let cliente = Cliente::nuevo(&config);
    cliente.probar().await.map_err(|e| {
        format!(
            "No se pudo conectar con Supabase. Verificá la URL, la clave y tu conexión a internet. Detalle: {}",
            e
        )
    })?;
    let data_dir = app.path().app_data_dir().map_err(map_err)?;
    std::fs::create_dir_all(&data_dir).map_err(map_err)?;
    crate::config::guardar(&data_dir, &config)?;
    *state.0.write().await = Some(cliente);
    Ok(())
}

/// true si ya hay una conexión activa, si existe una configuración guardada
/// de una sesión anterior y se pudo restablecer, o si se pudo conectar con
/// los datos de fábrica incluidos en el instalador. false solo si hace falta
/// pedirlos a mano (primera vez en un build sin datos de fábrica).
#[tauri::command]
pub async fn hay_configuracion_conexion<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: State<'_, DbState>) -> Result<bool, String> {
    if state.0.read().await.is_some() {
        return Ok(true);
    }
    let data_dir = app.path().app_data_dir().map_err(map_err)?;
    if let Some(config) = crate::config::leer_guardada(&data_dir) {
        conectar_y_guardar(&app, &state, config).await?;
        return Ok(true);
    }
    if let (Some(url), Some(anon_key)) = (SUPABASE_URL_DE_FABRICA, SUPABASE_ANON_KEY_DE_FABRICA) {
        conectar_y_guardar(&app, &state, SupabaseConfig { url: url.to_string(), anon_key: anon_key.to_string() }).await?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn configurar_conexion<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: State<'_, DbState>, url: String, anon_key: String) -> Result<(), String> {
    let config = SupabaseConfig { url: crate::config::limpiar(&url), anon_key: crate::config::limpiar(&anon_key) };
    conectar_y_guardar(&app, &state, config).await
}

// ---------- Propietarios, inquilinos, garantes e inmuebles ----------
//
// Estas fichas se manejan como JSON genérico con una lista blanca de columnas
// por tabla: para agregar un dato nuevo alcanza con sumar la columna en la
// base (migración SQL), en la lista de acá abajo y en el formulario del
// frontend — no hace falta tocar structs ni el resto del código.

const COLS_PERSONA: &[&str] = &[
    "nombre", "dni_cuit", "cuit_cuil", "sexo", "fecha_nacimiento", "nacionalidad", "estado_civil", "profesion",
    "telefono", "email", "direccion", "localidad", "notas",
];
const COLS_FOTOS_DNI: &[&str] = &["dni_frente", "dni_dorso"];
const COLS_SOLO_PROPIETARIO: &[&str] = &["datos_bancarios"];
const COLS_SOLO_GARANTE: &[&str] = &["tipo_garantia", "detalle_garantia"];
const COLS_BCRA: &[&str] = &["bcra_situacion", "bcra_fecha", "bcra_detalle"];
const COLS_INMUEBLE: &[&str] = &[
    "propietario_id", "codigo", "direccion", "piso_depto", "localidad", "provincia", "codigo_postal", "tipo", "destino",
    "estado", "superficie", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cochera", "patio", "amoblado",
    "nomenclatura_catastral", "cuenta_rentas", "cuenta_municipal", "matricula", "servicio_luz", "servicio_luz_contrato",
    "servicio_agua", "servicio_gas", "llaves", "notas",
];

fn columnas_de(tabla: &str) -> Result<Vec<&'static str>, String> {
    let mut cols: Vec<&'static str> = match tabla {
        "propietarios" => [COLS_PERSONA, COLS_SOLO_PROPIETARIO].concat(),
        "inquilinos" => [COLS_PERSONA, COLS_BCRA].concat(),
        "garantes" => [COLS_PERSONA, COLS_SOLO_GARANTE, COLS_BCRA].concat(),
        "inmuebles" => COLS_INMUEBLE.to_vec(),
        _ => return Err(format!("Tabla no permitida: {}", tabla)),
    };
    if tabla != "inmuebles" {
        cols.extend_from_slice(COLS_FOTOS_DNI);
    }
    Ok(cols)
}

/// Arma el cuerpo a guardar con solo las columnas permitidas que vinieron en
/// `datos`. Las que no vienen no se tocan (así, por ejemplo, editar una ficha
/// sin volver a mandar las fotos del DNI no las borra).
fn cuerpo_filtrado(tabla: &str, datos: &Value) -> Result<Value, String> {
    let obj = datos.as_object().ok_or("Datos inválidos")?;
    let mut body = serde_json::Map::new();
    for col in columnas_de(tabla)? {
        if let Some(v) = obj.get(col) {
            let v = match v {
                Value::String(t) if t.trim().is_empty() => Value::Null,
                otro => otro.clone(),
            };
            body.insert(col.to_string(), v);
        }
    }
    Ok(Value::Object(body))
}

async fn listar_ficha(state: &DbState, tabla: &str) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(state).await?;
    // Las fotos del DNI no viajan en el listado (pesan); se piden aparte.
    let mut cols: Vec<&str> = columnas_de(tabla)?.into_iter().filter(|c| !COLS_FOTOS_DNI.contains(c)).collect();
    cols.insert(0, "id");
    let orden = if tabla == "inmuebles" { "direccion" } else { "nombre" };
    let extra = if tabla == "inmuebles" { ",propietarios(nombre)" } else { "" };
    let mut filas: Vec<Value> = cliente
        .select(tabla, &format!("select={}{}&order={}", cols.join(","), extra, orden))
        .await
        .map_err(map_err)?;
    if tabla != "inmuebles" {
        // Marca si tiene fotos cargadas sin traerlas.
        #[derive(Deserialize)]
        struct ConFoto {
            id: i64,
        }
        let con_foto: Vec<ConFoto> = cliente
            .select(tabla, "select=id&or=(dni_frente.not.is.null,dni_dorso.not.is.null)")
            .await
            .map_err(map_err)?;
        let ids: std::collections::HashSet<i64> = con_foto.into_iter().map(|f| f.id).collect();
        for f in filas.iter_mut() {
            let tiene = f.get("id").and_then(|v| v.as_i64()).map(|id| ids.contains(&id)).unwrap_or(false);
            f["tiene_fotos_dni"] = Value::Bool(tiene);
        }
    } else {
        for f in filas.iter_mut() {
            let nombre = f.get("propietarios").and_then(|p| p.get("nombre")).cloned().unwrap_or(Value::Null);
            f["propietario_nombre"] = nombre;
        }
    }
    Ok(filas)
}

async fn guardar_ficha(state: &DbState, tabla: &str, datos: Value) -> Result<i64, String> {
    let cliente = obtener_cliente(state).await?;
    let body = cuerpo_filtrado(tabla, &datos)?;
    match datos.get("id").and_then(|v| v.as_i64()) {
        Some(id) => {
            cliente.update(tabla, &format!("id=eq.{}", id), &body).await.map_err(map_err)?;
            Ok(id)
        }
        None => {
            let fila: FilaId = cliente.insert(tabla, &body).await.map_err(map_err)?;
            Ok(fila.id)
        }
    }
}

#[tauri::command]
pub async fn get_propietarios(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    listar_ficha(&state, "propietarios").await
}

#[tauri::command]
pub async fn guardar_propietario(state: State<'_, DbState>, propietario: Value) -> Result<i64, String> {
    guardar_ficha(&state, "propietarios", propietario).await
}

#[tauri::command]
pub async fn eliminar_propietario(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("propietarios", &format!("id=eq.{}", id)).await.map_err(mensaje_borrado_restringido("propietario"))
}

#[tauri::command]
pub async fn get_inquilinos(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    listar_ficha(&state, "inquilinos").await
}

#[tauri::command]
pub async fn guardar_inquilino(state: State<'_, DbState>, inquilino: Value) -> Result<i64, String> {
    guardar_ficha(&state, "inquilinos", inquilino).await
}

#[tauri::command]
pub async fn eliminar_inquilino(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("inquilinos", &format!("id=eq.{}", id)).await.map_err(mensaje_borrado_restringido("inquilino"))
}

#[tauri::command]
pub async fn get_garantes(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    listar_ficha(&state, "garantes").await
}

#[tauri::command]
pub async fn guardar_garante(state: State<'_, DbState>, garante: Value) -> Result<i64, String> {
    guardar_ficha(&state, "garantes", garante).await
}

#[tauri::command]
pub async fn eliminar_garante(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("garantes", &format!("id=eq.{}", id)).await.map_err(mensaje_borrado_restringido("garante"))
}

/// Fotos del DNI (frente y dorso) de una persona, como data URL JPEG.
#[tauri::command]
pub async fn get_fotos_dni(state: State<'_, DbState>, tabla: String, id: i64) -> Result<Value, String> {
    if !["propietarios", "inquilinos", "garantes"].contains(&tabla.as_str()) {
        return Err("Tabla no permitida".to_string());
    }
    let cliente = obtener_cliente(&state).await?;
    let fila: Option<Value> = cliente
        .select_uno(&tabla, &format!("id=eq.{}&select=dni_frente,dni_dorso", id))
        .await
        .map_err(map_err)?;
    Ok(fila.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn get_inmuebles(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    listar_ficha(&state, "inmuebles").await
}

#[tauri::command]
pub async fn guardar_inmueble(state: State<'_, DbState>, inmueble: Value) -> Result<i64, String> {
    guardar_ficha(&state, "inmuebles", inmueble).await
}

#[tauri::command]
pub async fn eliminar_inmueble(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("inmuebles", &format!("id=eq.{}", id)).await.map_err(mensaje_borrado_restringido("inmueble"))
}

// ---------- Contratos ----------

#[derive(Debug, Deserialize)]
struct PropietarioNombre {
    nombre: String,
    #[serde(default)]
    telefono: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InquilinoNombre {
    nombre: String,
    #[serde(default)]
    telefono: Option<String>,
    #[serde(default)]
    dni_cuit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GaranteEmbed {
    id: i64,
    nombre: String,
}

#[derive(Debug, Deserialize)]
struct ContratoGaranteEmbed {
    garantes: GaranteEmbed,
}

#[derive(Debug, Deserialize)]
struct InmuebleDeContrato {
    direccion: String,
    propietario_id: i64,
    #[serde(default)]
    codigo: Option<i64>,
    #[serde(default)]
    localidad: Option<String>,
    #[serde(default)]
    piso_depto: Option<String>,
    propietarios: PropietarioNombre,
}

#[derive(Debug, Deserialize)]
struct ContratoEmbed {
    id: i64,
    inmueble_id: i64,
    inquilino_id: i64,
    fecha_inicio: String,
    fecha_fin: String,
    dia_pago: i64,
    monto_inicial: f64,
    comision_porcentaje: f64,
    tasa_mora_diaria: f64,
    frecuencia_actualizacion_meses: i64,
    tipo_actualizacion: String,
    porcentaje_actualizacion: f64,
    estado: String,
    notas: Option<String>,
    #[serde(default)]
    numero: Option<i64>,
    #[serde(default)]
    destino: Option<String>,
    #[serde(default)]
    deposito_garantia: Option<f64>,
    #[serde(default)]
    multa_diaria: Option<f64>,
    #[serde(default)]
    conceptos_fijos: Value,
    #[serde(default)]
    liquidado_hasta: Option<String>,
    inmuebles: InmuebleDeContrato,
    inquilinos: InquilinoNombre,
    contrato_garantes: Vec<ContratoGaranteEmbed>,
    actualizaciones: Vec<ActualizacionBase>,
}

const SELECT_CONTRATO_DETALLADO: &str = "select=*,inmuebles(direccion,propietario_id,codigo,localidad,piso_depto,propietarios(nombre,telefono)),inquilinos(nombre,telefono,dni_cuit),contrato_garantes(garantes(id,nombre)),actualizaciones(fecha_vigencia,monto_nuevo)";

fn direccion_completa(direccion: &str, piso_depto: &Option<String>) -> String {
    match piso_depto.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => format!("{} {}", direccion, p),
        _ => direccion.to_string(),
    }
}

fn contrato_embed_a_detallado(c: ContratoEmbed, hoy: NaiveDate) -> ContratoDetallado {
    let fecha_inicio = parse_date(&c.fecha_inicio);
    let monto_vig = monto_vigente_de(&c.actualizaciones, c.monto_inicial, hoy);
    let proxima = proxima_fecha_actualizacion_de(&c.actualizaciones, fecha_inicio, c.frecuencia_actualizacion_meses);
    let mut ordenadas = c.actualizaciones.clone();
    ordenadas.sort_by(|a, b| a.fecha_vigencia.cmp(&b.fecha_vigencia));
    let ultima_actualizacion_fecha = ordenadas.last().map(|a| a.fecha_vigencia.clone());
    let ultima_actualizacion_monto = ordenadas.last().map(|a| a.monto_nuevo);
    let monto_anterior = match ordenadas.len() {
        0 => None,
        1 => Some(c.monto_inicial),
        n => Some(ordenadas[n - 2].monto_nuevo),
    };
    let mut garantes: Vec<GaranteEmbed> = c.contrato_garantes.into_iter().map(|g| g.garantes).collect();
    garantes.sort_by(|a, b| a.nombre.cmp(&b.nombre));
    ContratoDetallado {
        id: c.id,
        inmueble_id: c.inmueble_id,
        inmueble_direccion: direccion_completa(&c.inmuebles.direccion, &c.inmuebles.piso_depto),
        inmueble_codigo: c.inmuebles.codigo,
        inmueble_localidad: c.inmuebles.localidad,
        inquilino_telefono: c.inquilinos.telefono,
        inquilino_dni: c.inquilinos.dni_cuit,
        propietario_telefono: c.inmuebles.propietarios.telefono,
        ultima_actualizacion_fecha,
        ultima_actualizacion_monto,
        monto_anterior,
        numero: c.numero,
        destino: c.destino,
        deposito_garantia: c.deposito_garantia.unwrap_or(0.0),
        multa_diaria: c.multa_diaria.unwrap_or(0.0),
        conceptos_fijos: if c.conceptos_fijos.is_array() { c.conceptos_fijos } else { json!([]) },
        liquidado_hasta: c.liquidado_hasta,
        inquilino_id: c.inquilino_id,
        inquilino_nombre: c.inquilinos.nombre,
        propietario_id: c.inmuebles.propietario_id,
        propietario_nombre: c.inmuebles.propietarios.nombre,
        garantes: garantes.iter().map(|g| g.nombre.clone()).collect(),
        garante_ids: garantes.iter().map(|g| g.id).collect(),
        fecha_inicio: c.fecha_inicio,
        fecha_fin: c.fecha_fin,
        dia_pago: c.dia_pago,
        monto_inicial: c.monto_inicial,
        monto_vigente: monto_vig,
        comision_porcentaje: c.comision_porcentaje,
        tasa_mora_diaria: c.tasa_mora_diaria,
        frecuencia_actualizacion_meses: c.frecuencia_actualizacion_meses,
        tipo_actualizacion: c.tipo_actualizacion,
        porcentaje_actualizacion: c.porcentaje_actualizacion,
        proxima_actualizacion: Some(proxima.format("%Y-%m-%d").to_string()),
        estado: c.estado,
        notas: c.notas,
    }
}

#[tauri::command]
pub async fn get_contratos(state: State<'_, DbState>) -> Result<Vec<ContratoDetallado>, String> {
    let cliente = obtener_cliente(&state).await?;
    let filas: Vec<ContratoEmbed> = cliente
        .select("contratos", &format!("{}&order=fecha_fin", SELECT_CONTRATO_DETALLADO))
        .await
        .map_err(map_err)?;
    let hoy = today();
    Ok(filas.into_iter().map(|c| contrato_embed_a_detallado(c, hoy)).collect())
}

#[tauri::command]
pub async fn guardar_contrato(state: State<'_, DbState>, contrato: Contrato) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let body = json!({
        "inmueble_id": contrato.inmueble_id, "inquilino_id": contrato.inquilino_id,
        "fecha_inicio": contrato.fecha_inicio, "fecha_fin": contrato.fecha_fin, "dia_pago": contrato.dia_pago,
        "monto_inicial": contrato.monto_inicial, "comision_porcentaje": contrato.comision_porcentaje,
        "tasa_mora_diaria": contrato.tasa_mora_diaria, "frecuencia_actualizacion_meses": contrato.frecuencia_actualizacion_meses,
        "tipo_actualizacion": contrato.tipo_actualizacion, "porcentaje_actualizacion": contrato.porcentaje_actualizacion,
        "estado": contrato.estado, "notas": contrato.notas,
        "destino": contrato.destino, "deposito_garantia": contrato.deposito_garantia, "multa_diaria": contrato.multa_diaria,
        "conceptos_fijos": if contrato.conceptos_fijos.is_array() { contrato.conceptos_fijos.clone() } else { json!([]) },
        "liquidado_hasta": contrato.liquidado_hasta,
    });
    let mut body = body;
    // Número de contrato: el que se cargó a mano o el siguiente libre.
    let numero = match contrato.numero {
        Some(n) => n,
        None if contrato.id.is_none() => siguiente_numero(&cliente, "contratos", "numero").await?,
        None => 0,
    };
    if numero > 0 {
        body["numero"] = json!(numero);
    }
    let id = match contrato.id {
        Some(id) => {
            cliente.update("contratos", &format!("id=eq.{}", id), &body).await.map_err(map_err)?;
            cliente.delete("contrato_garantes", &format!("contrato_id=eq.{}", id)).await.map_err(map_err)?;
            id
        }
        None => {
            let fila: FilaId = cliente.insert("contratos", &body).await.map_err(map_err)?;
            fila.id
        }
    };
    for garante_id in contrato.garante_ids {
        cliente
            .insert_ignorando_conflicto("contrato_garantes", &json!({"contrato_id": id, "garante_id": garante_id}), "contrato_id,garante_id")
            .await
            .map_err(map_err)?;
    }
    Ok(id)
}

#[tauri::command]
pub async fn eliminar_contrato(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("contratos", &format!("id=eq.{}", id)).await.map_err(mensaje_borrado_restringido("contrato"))
}

// ---------- Actualizaciones de alquiler ----------

#[tauri::command]
pub async fn get_actualizaciones(state: State<'_, DbState>, contrato_id: i64) -> Result<Vec<Actualizacion>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente
        .select("actualizaciones", &format!("contrato_id=eq.{}&select=*&order=fecha_vigencia.desc", contrato_id))
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn agregar_actualizacion(state: State<'_, DbState>, actualizacion: Actualizacion) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let body = json!({
        "contrato_id": actualizacion.contrato_id, "fecha_vigencia": actualizacion.fecha_vigencia,
        "monto_nuevo": actualizacion.monto_nuevo, "motivo": actualizacion.motivo,
    });
    let fila: Actualizacion = cliente.insert("actualizaciones", &body).await.map_err(map_err)?;
    Ok(fila.id.unwrap())
}

#[tauri::command]
pub async fn eliminar_actualizacion(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("actualizaciones", &format!("id=eq.{}", id)).await.map_err(map_err)
}

// ---------- Ingresos (pagos de inquilinos / recibos) ----------

#[tauri::command]
pub async fn get_pagos(state: State<'_, DbState>) -> Result<Vec<Pago>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("pagos", "select=*&order=fecha_pago.desc").await.map_err(map_err)
}

#[derive(Debug, Deserialize)]
struct ContratoParaPago {
    dia_pago: i64,
    tasa_mora_diaria: f64,
    monto_inicial: f64,
    #[serde(default)]
    multa_diaria: Option<f64>,
}

fn redondear(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// Suma de los conceptos adicionales de un recibo ([{concepto, tipo, monto}]).
fn suma_conceptos(conceptos: &Value) -> f64 {
    conceptos
        .as_array()
        .map(|arr| arr.iter().filter_map(|c| c.get("monto").and_then(|m| m.as_f64())).sum())
        .unwrap_or(0.0)
}

#[tauri::command]
pub async fn registrar_pago(state: State<'_, DbState>, nuevo: NuevoPago) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let contrato: ContratoParaPago = cliente
        .select_uno("contratos", &format!("id=eq.{}&select=dia_pago,tasa_mora_diaria,monto_inicial,multa_diaria", nuevo.contrato_id))
        .await
        .map_err(map_err)?
        .ok_or_else(|| "El contrato no existe".to_string())?;
    let actualizaciones = actualizaciones_de(&cliente, nuevo.contrato_id).await?;

    let fecha_pago = parse_date(&nuevo.fecha_pago);
    let vencimiento = due_date_for_periodo(&nuevo.periodo, contrato.dia_pago);
    let monto_alquiler = nuevo
        .monto_alquiler
        .unwrap_or_else(|| monto_vigente_de(&actualizaciones, contrato.monto_inicial, vencimiento));
    let dias_mora = (fecha_pago - vencimiento).num_days().max(0);
    let monto_mora = redondear(nuevo.monto_mora.unwrap_or(monto_alquiler * (contrato.tasa_mora_diaria / 100.0) * dias_mora as f64));
    let monto_multa = redondear(nuevo.monto_multa.unwrap_or(contrato.multa_diaria.unwrap_or(0.0) * dias_mora as f64));
    let conceptos = if nuevo.conceptos.is_array() { nuevo.conceptos.clone() } else { json!([]) };
    let monto_total = redondear(
        monto_alquiler + monto_mora + monto_multa + suma_conceptos(&conceptos) + nuevo.recargo - nuevo.bonificacion - nuevo.a_favor,
    );

    let numero_recibo = siguiente_numero_recibo(&cliente).await?;

    let body = json!({
        "contrato_id": nuevo.contrato_id, "periodo": nuevo.periodo, "fecha_pago": nuevo.fecha_pago,
        "monto_alquiler": monto_alquiler, "dias_mora": dias_mora, "monto_mora": monto_mora, "monto_total": monto_total,
        "metodo_pago": nuevo.metodo_pago, "numero_recibo": numero_recibo, "notas": nuevo.notas,
        "monto_multa": monto_multa, "conceptos": conceptos, "bonificacion": nuevo.bonificacion,
        "recargo": nuevo.recargo, "a_favor": nuevo.a_favor, "usuario": nuevo.usuario,
    });
    let fila: FilaId = cliente.insert("pagos", &body).await.map_err(map_err)?;
    Ok(fila.id)
}

/// Lee un valor de la tabla `configuracion` (None si no existe).
async fn config_valor(cliente: &Cliente, clave: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Fila {
        valor: Option<String>,
    }
    cliente
        .select_uno::<Fila>("configuracion", &format!("clave=eq.{}&select=valor", urlencoding(clave)))
        .await
        .ok()
        .flatten()
        .and_then(|f| f.valor)
}

/// Como `siguiente_numero`, pero respetando el número desde el que se quiere
/// seguir la numeración de recibos (ej. continuar la del sistema anterior).
async fn siguiente_numero_recibo(cliente: &Cliente) -> Result<i64, String> {
    let por_tabla = siguiente_numero(cliente, "pagos", "numero_recibo").await?;
    let desde = config_valor(cliente, "recibo_numero_desde").await.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    Ok(por_tabla.max(desde))
}

/// Siguiente valor para una columna de numeración secuencial (equivalente a
/// `COALESCE(MAX(columna),0)+1`), para numerar recibos y comprobantes.
async fn siguiente_numero(cliente: &Cliente, tabla: &str, columna: &str) -> Result<i64, String> {
    #[derive(Deserialize)]
    struct Fila {
        #[serde(flatten)]
        valor: std::collections::HashMap<String, i64>,
    }
    let filas: Vec<Fila> = cliente
        .select(tabla, &format!("select={}&order={}.desc&limit=1", columna, columna))
        .await
        .map_err(map_err)?;
    Ok(filas.first().and_then(|f| f.valor.get(columna)).copied().unwrap_or(0) + 1)
}

#[tauri::command]
pub async fn eliminar_pago(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("liquidaciones", &format!("pago_id=eq.{}", id)).await.map_err(map_err)?;
    cliente.delete("pagos", &format!("id=eq.{}", id)).await.map_err(map_err)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct InmuebleDeContratoSimple {
    direccion: String,
    propietarios: PropietarioNombre,
}

/// Todo lo necesario para imprimir el recibo: pago, contrato, inquilino,
/// propietario e inmueble.
#[tauri::command]
pub async fn get_recibo(state: State<'_, DbState>, pago_id: i64) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let fila: Value = cliente
        .select_uno(
            "pagos",
            &format!(
                "id=eq.{}&select=*,contratos(id,numero,fecha_inicio,fecha_fin,dia_pago,inquilinos(nombre,dni_cuit,telefono,email),inmuebles(codigo,direccion,piso_depto,localidad,propietarios(nombre,dni_cuit,telefono)))",
                pago_id
            ),
        )
        .await
        .map_err(map_err)?
        .ok_or_else(|| "El pago no existe".to_string())?;
    Ok(fila)
}

// ---------- Egresos (liquidaciones a propietarios / comisiones) ----------

#[tauri::command]
pub async fn get_liquidaciones(state: State<'_, DbState>) -> Result<Vec<Liquidacion>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("liquidaciones", "select=*&order=fecha.desc").await.map_err(map_err)
}

#[derive(Debug, Deserialize)]
struct PagoParaLiquidacion {
    id: i64,
    monto_alquiler: f64,
    #[serde(default)]
    monto_mora: f64,
    #[serde(default)]
    monto_multa: f64,
    contratos: ComisionYPropietario,
}

#[derive(Debug, Deserialize)]
struct ComisionYPropietario {
    comision_porcentaje: f64,
    inmuebles: PropietarioIdDeInmueble,
}

#[derive(Debug, Deserialize)]
struct PropietarioIdDeInmueble {
    propietario_id: i64,
}

/// Genera UNA liquidación al propietario que puede agrupar varios recibos
/// cobrados (todos del mismo propietario). Se guarda una fila por recibo,
/// todas con el mismo número de comprobante. `items` son gastos/descuentos
/// (monto negativo) o importes a favor (positivo) que se suman al neto.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generar_liquidacion(
    state: State<'_, DbState>,
    pago_ids: Vec<i64>,
    comision_porcentaje: Option<f64>,
    fecha: String,
    notas: Option<String>,
    items: Option<Value>,
    incluir_intereses: Option<bool>,
    usuario: Option<String>,
) -> Result<i64, String> {
    if pago_ids.is_empty() {
        return Err("Elegí al menos un recibo para liquidar".to_string());
    }
    let cliente = obtener_cliente(&state).await?;
    let ids = pago_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let pagos: Vec<PagoParaLiquidacion> = cliente
        .select(
            "pagos",
            &format!(
                "id=in.({})&select=id,contrato_id,monto_alquiler,monto_mora,monto_multa,contratos(comision_porcentaje,inmuebles(propietario_id))",
                ids
            ),
        )
        .await
        .map_err(map_err)?;
    if pagos.len() != pago_ids.len() {
        return Err("Alguno de los recibos elegidos ya no existe".to_string());
    }
    let propietarios: std::collections::HashSet<i64> = pagos.iter().map(|p| p.contratos.inmuebles.propietario_id).collect();
    if propietarios.len() > 1 {
        return Err("Todos los recibos de una liquidación tienen que ser del mismo propietario".to_string());
    }
    let ya: Vec<Value> = cliente.select("liquidaciones", &format!("pago_id=in.({})&select=pago_id", ids)).await.map_err(map_err)?;
    if !ya.is_empty() {
        return Err("Alguno de los recibos elegidos ya fue liquidado".to_string());
    }

    let items = items.filter(|v| v.is_array()).unwrap_or_else(|| json!([]));
    let total_items = suma_conceptos(&items);
    let incluir = incluir_intereses.unwrap_or(true);
    let numero = siguiente_numero(&cliente, "liquidaciones", "numero_comprobante").await?;

    for (i, pago) in pagos.iter().enumerate() {
        let pct = comision_porcentaje.unwrap_or(pago.contratos.comision_porcentaje);
        let cobrado = pago.monto_alquiler + if incluir { pago.monto_mora + pago.monto_multa } else { 0.0 };
        let comision = redondear(pago.monto_alquiler * pct / 100.0);
        let mut neto = cobrado - comision;
        let mut items_fila = json!([]);
        if i == 0 {
            neto += total_items;
            items_fila = items.clone();
        }
        let body = json!({
            "pago_id": pago.id, "fecha": fecha, "monto_alquiler": pago.monto_alquiler, "comision_porcentaje": pct,
            "monto_comision": comision, "monto_neto": redondear(neto), "numero_comprobante": numero,
            "notas": if i == 0 { notas.clone() } else { None }, "monto_cobrado": redondear(cobrado),
            "items": items_fila, "usuario": usuario,
        });
        cliente.insert::<FilaId>("liquidaciones", &body).await.map_err(map_err)?;
    }
    Ok(numero)
}

#[tauri::command]
pub async fn eliminar_liquidacion(state: State<'_, DbState>, numero: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("liquidaciones", &format!("numero_comprobante=eq.{}", numero)).await.map_err(map_err)
}

/// Todas las filas de una liquidación (mismo número) con los datos de cada
/// recibo, inmueble, inquilino y propietario, para imprimir el comprobante.
#[tauri::command]
pub async fn get_comprobante(state: State<'_, DbState>, numero: i64) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    let filas: Vec<Value> = cliente
        .select(
            "liquidaciones",
            &format!(
                "numero_comprobante=eq.{}&select=*,pagos(numero_recibo,periodo,fecha_pago,monto_mora,monto_multa,contratos(numero,inquilinos(nombre),inmuebles(codigo,direccion,piso_depto,localidad,propietarios(nombre,dni_cuit,cuit_cuil,telefono,datos_bancarios))))&order=id",
                numero
            ),
        )
        .await
        .map_err(map_err)?;
    if filas.is_empty() {
        return Err("El comprobante no existe".to_string());
    }
    Ok(filas)
}

// ---------- Central de Deudores del BCRA ----------

/// Consulta la situación crediticia de un CUIT/CUIL. Si se pasa la persona
/// (tabla + id), guarda el resultado en su ficha.
#[tauri::command]
pub async fn consultar_bcra(state: State<'_, DbState>, cuit: String, tabla: Option<String>, id: Option<i64>) -> Result<Value, String> {
    let resultado = crate::bcra::consultar(&cuit).await?;
    if let (Some(tabla), Some(id)) = (tabla, id) {
        if ["inquilinos", "garantes"].contains(&tabla.as_str()) {
            let cliente = obtener_cliente(&state).await?;
            let body = json!({
                "bcra_situacion": resultado["situacion"],
                "bcra_fecha": today().format("%Y-%m-%d").to_string(),
                "bcra_detalle": resultado,
            });
            cliente.update(&tabla, &format!("id=eq.{}", id), &body).await.map_err(map_err)?;
        }
    }
    Ok(resultado)
}

/// Guarda una consulta al BCRA hecha desde la ventana de la app (respaldo
/// cuando la conexión directa falla).
#[tauri::command]
pub async fn guardar_bcra(state: State<'_, DbState>, tabla: String, id: i64, resultado: Value) -> Result<(), String> {
    if !["inquilinos", "garantes"].contains(&tabla.as_str()) {
        return Err("Tabla no permitida".into());
    }
    let cliente = obtener_cliente(&state).await?;
    let body = json!({
        "bcra_situacion": resultado["situacion"],
        "bcra_fecha": today().format("%Y-%m-%d").to_string(),
        "bcra_detalle": resultado,
    });
    cliente.update(&tabla, &format!("id=eq.{}", id), &body).await.map_err(map_err)
}

// ---------- Fotos del estado de los inmuebles ----------

/// Lista de fotos de un inmueble, solo con la miniatura (la foto grande se
/// pide aparte con get_foto_inmueble).
#[tauri::command]
pub async fn get_fotos_inmueble(state: State<'_, DbState>, inmueble_id: i64) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente
        .select(
            "inmueble_fotos",
            &format!("inmueble_id=eq.{}&select=id,inmueble_id,contrato_id,tipo,descripcion,fecha,miniatura,usuario&order=fecha.desc,id", inmueble_id),
        )
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn get_foto_inmueble(state: State<'_, DbState>, id: i64) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let f: Option<Value> = cliente.select_uno("inmueble_fotos", &format!("id=eq.{}&select=*", id)).await.map_err(map_err)?;
    f.ok_or_else(|| "La foto no existe".to_string())
}

/// Fotos completas de un inmueble para imprimir el acta (opcionalmente solo de un tipo).
#[tauri::command]
pub async fn get_fotos_inmueble_completas(state: State<'_, DbState>, inmueble_id: i64, tipo: Option<String>) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    let filtro_tipo = tipo.map(|t| format!("&tipo=eq.{}", urlencoding(&t))).unwrap_or_default();
    cliente
        .select("inmueble_fotos", &format!("inmueble_id=eq.{}{}&select=*&order=fecha,id", inmueble_id, filtro_tipo))
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn guardar_foto_inmueble(state: State<'_, DbState>, foto: Value) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let o = foto.as_object().ok_or("Datos inválidos")?;
    let mut body = serde_json::Map::new();
    for k in ["inmueble_id", "contrato_id", "tipo", "descripcion", "fecha", "foto", "miniatura", "usuario"] {
        if let Some(v) = o.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    match o.get("id").and_then(|v| v.as_i64()) {
        Some(id) => {
            body.remove("foto");
            body.remove("miniatura");
            cliente.update("inmueble_fotos", &format!("id=eq.{}", id), &Value::Object(body)).await.map_err(map_err)?;
            Ok(id)
        }
        None => {
            let fila: FilaId = cliente.insert("inmueble_fotos", &Value::Object(body)).await.map_err(map_err)?;
            Ok(fila.id)
        }
    }
}

#[tauri::command]
pub async fn eliminar_foto_inmueble(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("inmueble_fotos", &format!("id=eq.{}", id)).await.map_err(map_err)
}

// ---------- Contratos desde modelo ----------

#[tauri::command]
pub async fn get_modelos(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("modelos_contrato", "select=*&order=id").await.map_err(map_err)
}

#[tauri::command]
pub async fn guardar_modelo(state: State<'_, DbState>, modelo: Value) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let o = modelo.as_object().ok_or("Datos inválidos")?;
    let mut body = serde_json::Map::new();
    for k in ["nombre", "tipo", "contenido"] {
        if let Some(v) = o.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    body.insert("actualizado".into(), json!(today().format("%Y-%m-%d").to_string()));
    match o.get("id").and_then(|v| v.as_i64()) {
        Some(id) => {
            cliente.update("modelos_contrato", &format!("id=eq.{}", id), &Value::Object(body)).await.map_err(map_err)?;
            Ok(id)
        }
        None => {
            let fila: FilaId = cliente.insert("modelos_contrato", &Value::Object(body)).await.map_err(map_err)?;
            Ok(fila.id)
        }
    }
}

#[tauri::command]
pub async fn eliminar_modelo(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("modelos_contrato", &format!("id=eq.{}", id)).await.map_err(map_err)
}

/// Documentos ya generados (sin el contenido, que se pide aparte).
#[tauri::command]
pub async fn get_documentos(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente
        .select("documentos_generados", "select=id,contrato_id,modelo_id,titulo,fecha,usuario&order=id.desc&limit=300")
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn get_documento(state: State<'_, DbState>, id: i64) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let d: Option<Value> = cliente.select_uno("documentos_generados", &format!("id=eq.{}&select=*", id)).await.map_err(map_err)?;
    d.ok_or_else(|| "El documento no existe".to_string())
}

#[tauri::command]
pub async fn guardar_documento(state: State<'_, DbState>, documento: Value) -> Result<i64, String> {
    let cliente = obtener_cliente(&state).await?;
    let o = documento.as_object().ok_or("Datos inválidos")?;
    let mut body = serde_json::Map::new();
    for k in ["contrato_id", "modelo_id", "titulo", "contenido", "fecha", "usuario"] {
        if let Some(v) = o.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    match o.get("id").and_then(|v| v.as_i64()) {
        Some(id) => {
            cliente.update("documentos_generados", &format!("id=eq.{}", id), &Value::Object(body)).await.map_err(map_err)?;
            Ok(id)
        }
        None => {
            let fila: FilaId = cliente.insert("documentos_generados", &Value::Object(body)).await.map_err(map_err)?;
            Ok(fila.id)
        }
    }
}

#[tauri::command]
pub async fn eliminar_documento(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("documentos_generados", &format!("id=eq.{}", id)).await.map_err(map_err)
}

/// Guarda el documento como archivo de Word en "Documentos\Contratos Carranza"
/// y lo abre. El contenido es HTML con los encabezados que Word reconoce.
#[tauri::command]
pub fn abrir_en_word<R: tauri::Runtime>(app: tauri::AppHandle<R>, nombre: String, html: String) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let carpeta = app.path().document_dir().map_err(map_err)?.join("Contratos Carranza");
    std::fs::create_dir_all(&carpeta).map_err(map_err)?;
    let limpio: String = nombre
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    let base = if limpio.is_empty() { "Documento".to_string() } else { limpio };
    let mut ruta = carpeta.join(format!("{}.doc", base));
    let mut n = 2;
    while ruta.exists() {
        ruta = carpeta.join(format!("{} ({}).doc", base, n));
        n += 1;
    }
    // BOM para que Word respete los acentos.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(html.as_bytes());
    std::fs::write(&ruta, bytes).map_err(map_err)?;
    let texto = ruta.to_string_lossy().to_string();
    app.opener().open_path(texto.clone(), None::<&str>).map_err(map_err)?;
    Ok(texto)
}

// ---------- Configuración, IPC y recordatorios ----------

/// true si la base ya tiene las tablas/columnas de la versión 0.3.0.
#[tauri::command]
pub async fn base_actualizada(state: State<'_, DbState>) -> Result<bool, String> {
    let cliente = obtener_cliente(&state).await?;
    let chequeos = [
        ("configuracion", "select=clave&limit=1"),
        ("recordatorios", "select=id&limit=1"),
        ("indices_ipc", "select=periodo&limit=1"),
        ("inmuebles", "select=codigo,nomenclatura_catastral&limit=1"),
        ("inquilinos", "select=dni_frente,cuit_cuil&limit=1"),
        ("garantes", "select=tipo_garantia&limit=1"),
        ("contratos", "select=numero,conceptos_fijos,multa_diaria&limit=1"),
        ("pagos", "select=conceptos,monto_multa,bonificacion&limit=1"),
        ("liquidaciones", "select=items,monto_cobrado&limit=1"),
        ("inmueble_fotos", "select=id&limit=1"),
        ("inquilinos", "select=bcra_situacion&limit=1"),
        ("garantes", "select=bcra_detalle&limit=1"),
        ("modelos_contrato", "select=id&limit=1"),
        ("documentos_generados", "select=id&limit=1"),
        ("inmuebles", "select=servicio_luz_contrato&limit=1"),
        ("servicios_estado", "select=id&limit=1"),
    ];
    for (tabla, q) in chequeos {
        if cliente.select::<Value>(tabla, q).await.is_err() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn get_configuracion(state: State<'_, DbState>) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    #[derive(Deserialize)]
    struct Fila {
        clave: String,
        valor: Option<String>,
    }
    let filas: Vec<Fila> = cliente.select("configuracion", "select=clave,valor").await.map_err(map_err)?;
    let mut mapa = serde_json::Map::new();
    for f in filas {
        mapa.insert(f.clave, f.valor.map(Value::String).unwrap_or(Value::Null));
    }
    Ok(Value::Object(mapa))
}

#[tauri::command]
pub async fn guardar_configuracion(state: State<'_, DbState>, valores: Value) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    let obj = valores.as_object().ok_or("Datos inválidos")?;
    let filas: Vec<Value> = obj
        .iter()
        .map(|(k, v)| {
            let valor = match v {
                Value::Null => Value::Null,
                Value::String(s) => Value::String(s.clone()),
                otro => Value::String(otro.to_string()),
            };
            json!({"clave": k, "valor": valor})
        })
        .collect();
    if filas.is_empty() {
        return Ok(());
    }
    cliente.upsert("configuracion", &Value::Array(filas), "clave").await.map_err(map_err)
}

/// Serie del IPC nacional (INDEC, base dic-2016) desde la API de
/// datos.gob.ar, más los meses cargados a mano en `indices_ipc` (variación %
/// mensual) para cuando el INDEC publicó pero la API todavía no se actualizó.
#[tauri::command]
pub async fn get_ipc(state: State<'_, DbState>) -> Result<Value, String> {
    let cliente = obtener_cliente(&state).await?;
    let manual: Vec<Value> = cliente.select("indices_ipc", "select=periodo,variacion&order=periodo").await.map_err(map_err)?;
    let (serie, error) = match crate::ipc::serie_ipc().await {
        Ok(s) => (s, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    Ok(json!({
        "serie": serie.into_iter().map(|(p, v)| json!([p, v])).collect::<Vec<_>>(),
        "manual": manual,
        "error": error,
    }))
}

#[tauri::command]
pub async fn guardar_ipc_manual(state: State<'_, DbState>, periodo: String, variacion: f64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente
        .upsert("indices_ipc", &json!({"periodo": periodo, "variacion": variacion}), "periodo")
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn eliminar_ipc_manual(state: State<'_, DbState>, periodo: String) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("indices_ipc", &format!("periodo=eq.{}", urlencoding(&periodo))).await.map_err(map_err)
}

#[tauri::command]
pub async fn registrar_recordatorio(state: State<'_, DbState>, recordatorio: Value) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    let o = recordatorio.as_object().ok_or("Datos inválidos")?;
    let mut body = serde_json::Map::new();
    for k in ["contrato_id", "tipo", "referencia", "telefono", "mensaje", "fecha", "usuario"] {
        if let Some(v) = o.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    cliente.insert::<FilaId>("recordatorios", &Value::Object(body)).await.map_err(map_err)?;
    Ok(())
}

/// Avisos enviados desde una fecha (YYYY-MM-DD), del más nuevo al más viejo.
#[tauri::command]
pub async fn get_recordatorios(state: State<'_, DbState>, desde: String) -> Result<Vec<Value>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente
        .select("recordatorios", &format!("fecha=gte.{}&select=*&order=id.desc&limit=500", urlencoding(&desde)))
        .await
        .map_err(map_err)
}

/// Abre un enlace (WhatsApp) en el navegador / app predeterminada.
#[tauri::command]
pub fn abrir_enlace<R: tauri::Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("https://wa.me/")
        || url.starts_with("https://api.whatsapp.com/")
        || url.starts_with("whatsapp://")
        || url.starts_with("https://web.whatsapp.com/")
        || url.starts_with("https://www.bcra.gob.ar/")
        || url.starts_with("https://www.epec.com.ar/"))
    {
        return Err("Enlace no permitido".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(map_err)
}

// ---------- Tablero de control ----------

#[derive(Debug, Deserialize)]
struct PagoPeriodo {
    contrato_id: i64,
    periodo: String,
}

#[derive(Debug, Deserialize)]
struct PersonaCumple {
    nombre: String,
    fecha_nacimiento: Option<String>,
}

#[tauri::command]
pub async fn get_dashboard(state: State<'_, DbState>, dias_vencimiento: i64, dias_actualizacion: i64, dias_cumpleanos: i64) -> Result<ResumenDashboard, String> {
    let cliente = obtener_cliente(&state).await?;
    let hoy = today();

    #[derive(Debug, Deserialize)]
    struct ContratoDashRaw {
        id: i64,
        fecha_inicio: String,
        fecha_fin: String,
        dia_pago: i64,
        monto_inicial: f64,
        tasa_mora_diaria: f64,
        frecuencia_actualizacion_meses: i64,
        tipo_actualizacion: String,
        #[serde(default)]
        liquidado_hasta: Option<String>,
        inmuebles: InmuebleDeContratoSimple,
        inquilinos: InquilinoNombre,
        actualizaciones: Vec<ActualizacionBase>,
    }

    let filas: Vec<ContratoDashRaw> = cliente
        .select(
            "contratos",
            "estado=eq.activo&select=id,fecha_inicio,fecha_fin,dia_pago,monto_inicial,tasa_mora_diaria,frecuencia_actualizacion_meses,tipo_actualizacion,liquidado_hasta,inmuebles(direccion,propietarios(nombre)),inquilinos(nombre),actualizaciones(fecha_vigencia,monto_nuevo)",
        )
        .await
        .map_err(map_err)?;

    let pagos: Vec<PagoPeriodo> = cliente.select("pagos", "select=contrato_id,periodo").await.map_err(map_err)?;
    let periodos_pagados: std::collections::HashSet<(i64, String)> = pagos.into_iter().map(|p| (p.contrato_id, p.periodo)).collect();

    let mut deudas = Vec::new();
    let mut vencimientos = Vec::new();
    let mut actualizaciones_pendientes = Vec::new();
    let mut total_adeudado = 0.0;
    let total_contratos_activos = filas.len() as i64;

    for c in &filas {
        let fecha_inicio = parse_date(&c.fecha_inicio);
        let fecha_fin = parse_date(&c.fecha_fin);

        // --- deudas ---
        let mut periodos_impagos = Vec::new();
        let mut monto_adeudado = 0.0;
        // El primer mes a chequear es el siguiente al "liquidado_hasta" (si existe)
        // o el mes de inicio del contrato. Así todo lo anterior o igual a
        // "liquidado_hasta" queda fuera de la deuda (se saldó por fuera de la app).
        let desde_liquidado = c
            .liquidado_hasta
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(&format!("{}-01", s), "%Y-%m-%d").ok())
            .map(|d| add_months(d, 1));
        let inicio_mes = NaiveDate::from_ymd_opt(fecha_inicio.year(), fecha_inicio.month(), 1).unwrap();
        let mut cursor = match desde_liquidado {
            Some(d) if d > inicio_mes => d,
            _ => inicio_mes,
        };
        let limite = NaiveDate::from_ymd_opt(hoy.year(), hoy.month(), 1).unwrap();
        while cursor <= limite {
            let periodo = periodo_de(cursor);
            let vencimiento = due_date_for_periodo(&periodo, c.dia_pago);
            if vencimiento <= hoy && !periodos_pagados.contains(&(c.id, periodo.clone())) {
                let monto = monto_vigente_de(&c.actualizaciones, c.monto_inicial, vencimiento);
                let dias_mora = (hoy - vencimiento).num_days().max(0);
                let mora = monto * (c.tasa_mora_diaria / 100.0) * dias_mora as f64;
                periodos_impagos.push(periodo.clone());
                monto_adeudado += monto + mora;
            }
            cursor = add_months(cursor, 1);
        }
        if !periodos_impagos.is_empty() {
            total_adeudado += monto_adeudado;
            deudas.push(DeudaContrato {
                contrato_id: c.id,
                inmueble_direccion: c.inmuebles.direccion.clone(),
                inquilino_nombre: c.inquilinos.nombre.clone(),
                periodos_impagos,
                monto_adeudado,
            });
        }

        // --- vencimientos de contrato ---
        let dias_restantes = (fecha_fin - hoy).num_days();
        if dias_restantes <= dias_vencimiento {
            vencimientos.push(VencimientoContrato {
                contrato_id: c.id,
                inmueble_direccion: c.inmuebles.direccion.clone(),
                inquilino_nombre: c.inquilinos.nombre.clone(),
                propietario_nombre: c.inmuebles.propietarios.nombre.clone(),
                fecha_fin: fecha_fin.format("%Y-%m-%d").to_string(),
                dias_restantes,
            });
        }

        // --- actualizaciones pendientes ---
        let proxima = proxima_fecha_actualizacion_de(&c.actualizaciones, fecha_inicio, c.frecuencia_actualizacion_meses);
        let dias_restantes_act = (proxima - hoy).num_days();
        if dias_restantes_act <= dias_actualizacion {
            let monto_vig = monto_vigente_de(&c.actualizaciones, c.monto_inicial, hoy);
            actualizaciones_pendientes.push(ActualizacionPendiente {
                contrato_id: c.id,
                inmueble_direccion: c.inmuebles.direccion.clone(),
                inquilino_nombre: c.inquilinos.nombre.clone(),
                tipo_actualizacion: c.tipo_actualizacion.clone(),
                fecha_prevista: proxima.format("%Y-%m-%d").to_string(),
                dias_restantes: dias_restantes_act,
                monto_vigente: monto_vig,
            });
        }
    }

    vencimientos.sort_by_key(|v| v.dias_restantes);
    actualizaciones_pendientes.sort_by_key(|a| a.dias_restantes);

    // --- próximos cumpleaños (propietarios, inquilinos y garantes) ---
    let mut personas: Vec<(String, &str, String)> = Vec::new();
    for (tabla, tipo) in [("propietarios", "Propietario"), ("inquilinos", "Inquilino"), ("garantes", "Garante")] {
        let rows: Vec<PersonaCumple> = cliente
            .select(tabla, "select=nombre,fecha_nacimiento&fecha_nacimiento=not.is.null")
            .await
            .map_err(map_err)?;
        for r in rows {
            if let Some(f) = r.fecha_nacimiento {
                if !f.is_empty() {
                    personas.push((r.nombre, tipo, f));
                }
            }
        }
    }

    let mut cumpleanos_proximos: Vec<CumpleanosProximo> = personas
        .into_iter()
        .map(|(nombre, tipo, fecha_nacimiento)| {
            let nacimiento = parse_date(&fecha_nacimiento);
            let proximo = proxima_fecha_cumpleanos(nacimiento, hoy);
            let dias_restantes = (proximo - hoy).num_days();
            CumpleanosProximo {
                nombre,
                tipo: tipo.to_string(),
                fecha_nacimiento,
                proximo_cumple: proximo.format("%Y-%m-%d").to_string(),
                edad_cumple: (proximo.year() - nacimiento.year()) as i64,
                dias_restantes,
            }
        })
        .filter(|c| c.dias_restantes <= dias_cumpleanos)
        .collect();
    cumpleanos_proximos.sort_by_key(|c| c.dias_restantes);

    Ok(ResumenDashboard { deudas, vencimientos, actualizaciones_pendientes, cumpleanos_proximos, total_contratos_activos, total_adeudado })
}

// ---------- Actualización por índice ICL (BCRA) ----------

/// Consulta la API del BCRA y compara el ICL en `fecha_objetivo` contra el ICL
/// vigente cuando se fijó el monto actual del contrato. `fecha_objetivo` es
/// "hoy" para una estimación aproximada (todavía no se sabe el valor final del
/// día de la actualización) o la fecha real de la próxima actualización para
/// obtener el valor definitivo.
async fn calcular_con_icl(state: &DbState, contrato_id: i64, fecha_objetivo_es_hoy: bool) -> Result<EstimacionIcl, String> {
    #[derive(Deserialize)]
    struct ContratoParaIcl {
        fecha_inicio: String,
        monto_inicial: f64,
        frecuencia_actualizacion_meses: i64,
        tipo_actualizacion: String,
    }

    let cliente = obtener_cliente(state).await?;
    let contrato: ContratoParaIcl = cliente
        .select_uno("contratos", &format!("id=eq.{}&select=fecha_inicio,monto_inicial,frecuencia_actualizacion_meses,tipo_actualizacion", contrato_id))
        .await
        .map_err(map_err)?
        .ok_or_else(|| "El contrato no existe".to_string())?;

    if contrato.tipo_actualizacion != "ICL" {
        return Err("Este contrato no usa el índice ICL como esquema de actualización".to_string());
    }

    let actualizaciones = actualizaciones_de(&cliente, contrato_id).await?;
    let fecha_inicio = parse_date(&contrato.fecha_inicio);
    let fecha_referencia = fecha_base_de(&actualizaciones, fecha_inicio);
    let fecha_objetivo = if fecha_objetivo_es_hoy {
        today()
    } else {
        proxima_fecha_actualizacion_de(&actualizaciones, fecha_inicio, contrato.frecuencia_actualizacion_meses)
    };
    let monto_actual = monto_vigente_de(&actualizaciones, contrato.monto_inicial, today());

    let client = icl::cliente_http()?;
    let id_variable = match icl::id_variable_icl(&client).await {
        Ok(id) => id,
        Err(_) => icl::ICL_ID_FALLBACK,
    };
    let dato_referencia = icl::valor_en_o_antes(&client, id_variable, fecha_referencia).await?;
    let dato_objetivo = icl::valor_en_o_antes(&client, id_variable, fecha_objetivo).await?;
    let ratio = dato_objetivo.valor / dato_referencia.valor;

    Ok(EstimacionIcl {
        es_valor_real: !fecha_objetivo_es_hoy,
        fecha_referencia: dato_referencia.fecha,
        valor_icl_referencia: dato_referencia.valor,
        fecha_consulta: dato_objetivo.fecha,
        valor_icl_consulta: dato_objetivo.valor,
        porcentaje_variacion: (ratio - 1.0) * 100.0,
        monto_actual,
        monto_estimado: monto_actual * ratio,
    })
}

/// Para usar un mes antes de la actualización: compara el ICL de hoy contra
/// el ICL de referencia, como aproximación de a cuánto va a quedar el alquiler.
#[tauri::command]
pub async fn estimar_actualizacion_icl(state: State<'_, DbState>, contrato_id: i64) -> Result<EstimacionIcl, String> {
    calcular_con_icl(&state, contrato_id, true).await
}

/// Para usar el día de la actualización (o después): trae el valor real del
/// ICL para esa fecha exacta.
#[tauri::command]
pub async fn confirmar_actualizacion_icl(state: State<'_, DbState>, contrato_id: i64) -> Result<EstimacionIcl, String> {
    calcular_con_icl(&state, contrato_id, false).await
}

// ---------- Usuarios / login ----------

/// true si todavia no se creo ningun usuario (primer arranque de la app).
#[tauri::command]
pub async fn hay_usuarios(state: State<'_, DbState>) -> Result<bool, String> {
    let cliente = obtener_cliente(&state).await?;
    let filas: Vec<Value> = cliente.select("usuarios", "select=id&limit=1").await.map_err(map_err)?;
    Ok(!filas.is_empty())
}

#[tauri::command]
pub async fn get_usuarios(state: State<'_, DbState>) -> Result<Vec<Usuario>, String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.select("usuarios", "select=id,username,nombre_completo,activo&order=nombre_completo").await.map_err(map_err)
}

/// Crea un usuario nuevo. Cualquiera puede crear el primero (arranque de la
/// app, sin login todavia); a partir de ahi la pantalla de "nuevo usuario"
/// del frontend solo se muestra estando ya logueado.
#[tauri::command]
pub async fn crear_usuario(state: State<'_, DbState>, nuevo: NuevoUsuario) -> Result<Usuario, String> {
    if nuevo.username.trim().is_empty() || nuevo.password.len() < 4 {
        return Err("El usuario no puede estar vacío y la contraseña debe tener al menos 4 caracteres".to_string());
    }
    let hash = bcrypt::hash(&nuevo.password, bcrypt::DEFAULT_COST).map_err(map_err)?;
    let cliente = obtener_cliente(&state).await?;
    let body = json!({
        "username": nuevo.username.trim(), "password_hash": hash, "nombre_completo": nuevo.nombre_completo.trim(), "activo": true,
    });
    cliente.insert("usuarios", &body).await.map_err(|e: ErrorSupabase| {
        if e.es_codigo(UNIQUE_VIOLATION) {
            "Ya existe un usuario con ese nombre de usuario".to_string()
        } else {
            e.to_string()
        }
    })
}

#[tauri::command]
pub async fn eliminar_usuario(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let cliente = obtener_cliente(&state).await?;
    cliente.delete("usuarios", &format!("id=eq.{}", id)).await.map_err(map_err)
}

#[derive(Debug, Deserialize)]
struct UsuarioConHash {
    id: i64,
    username: String,
    password_hash: String,
    nombre_completo: String,
    activo: bool,
}

#[tauri::command]
pub async fn iniciar_sesion(state: State<'_, DbState>, username: String, password: String) -> Result<Usuario, String> {
    let cliente = obtener_cliente(&state).await?;
    let fila: UsuarioConHash = cliente
        .select_uno("usuarios", &format!("username=eq.{}&select=id,username,password_hash,nombre_completo,activo", urlencoding(username.trim())))
        .await
        .map_err(map_err)?
        .ok_or_else(|| "Usuario o contraseña incorrectos".to_string())?;

    if !fila.activo {
        return Err("Este usuario está deshabilitado".to_string());
    }

    let valido = bcrypt::verify(&password, &fila.password_hash).map_err(map_err)?;
    if !valido {
        return Err("Usuario o contraseña incorrectos".to_string());
    }

    Ok(Usuario { id: fila.id, username: fila.username, nombre_completo: fila.nombre_completo, activo: true })
}

/// Mensaje legible cuando un borrado choca contra una clave foránea de otra
/// tabla que todavía referencia la fila (DELETE RESTRICT).
fn mensaje_borrado_restringido(entidad: &'static str) -> impl Fn(ErrorSupabase) -> String {
    move |e| {
        if e.es_codigo(FOREIGN_KEY_VIOLATION) {
            format!("No se puede eliminar: hay otros registros que todavía dependen de este {}.", entidad)
        } else {
            e.to_string()
        }
    }
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Test de integración contra un PostgREST real (y Postgres debajo): valida
/// que el cliente REST y la lógica de negocio de cada comando (RETURNING,
/// ON CONFLICT vía ignore-duplicates, UNIQUE, joins anidados, el conteo
/// dinámico de cumpleaños, DELETE RESTRICT) funcionan tal cual contra la
/// API con la que habla la app, no solo que compilan. Se salta solo si
/// TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY no están definidas.
#[cfg(test)]
mod tests_rest {
    use super::*;

    async fn conectar_test() -> Option<Cliente> {
        let url = std::env::var("TEST_SUPABASE_URL").ok()?;
        let anon_key = std::env::var("TEST_SUPABASE_ANON_KEY").ok()?;
        Some(Cliente::con_base_completa(url, anon_key))
    }

    async fn limpiar_todo(cliente: &Cliente) {
        for tabla in ["recordatorios", "configuracion", "indices_ipc", "liquidaciones", "pagos", "contrato_garantes", "actualizaciones", "contratos", "inmuebles", "garantes", "inquilinos", "propietarios", "usuarios"] {
            let _ = cliente.delete(tabla, "id=gte.0").await;
        }
    }

    #[tokio::test]
    async fn flujo_completo_contra_postgrest() {
        let Some(cliente) = conectar_test().await else {
            eprintln!("TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY no están definidas: se omite el test de integración con PostgREST");
            return;
        };
        limpiar_todo(&cliente).await;

        // --- usuarios: alta, UNIQUE violation, bcrypt ---
        let hash = bcrypt::hash("claveSegura1", bcrypt::DEFAULT_COST).unwrap();
        let usuario: Usuario = cliente
            .insert("usuarios", &json!({"username":"agustin","password_hash":hash,"nombre_completo":"Agustín","activo":true}))
            .await
            .unwrap();
        assert_eq!(usuario.username, "agustin");
        assert!(usuario.activo);

        let duplicado = cliente
            .insert::<Usuario>("usuarios", &json!({"username":"agustin","password_hash":hash,"nombre_completo":"Otro","activo":true}))
            .await;
        assert!(duplicado.unwrap_err().es_codigo(UNIQUE_VIOLATION));

        let fila_login: UsuarioConHash = cliente
            .select_uno("usuarios", "username=eq.agustin&select=id,username,password_hash,nombre_completo,activo")
            .await
            .unwrap()
            .unwrap();
        assert!(bcrypt::verify("claveSegura1", &fila_login.password_hash).unwrap());
        assert!(!bcrypt::verify("claveIncorrecta", &fila_login.password_hash).unwrap());

        // --- propietarios: insert con RETURNING, update ---
        let propietario: Propietario = cliente
            .insert(
                "propietarios",
                &json!({"nombre":"Monchola","dni_cuit":"20111222","fecha_nacimiento":"1980-05-20","datos_bancarios":"CBU 123"}),
            )
            .await
            .unwrap();
        let propietario_id = propietario.id.unwrap();
        cliente.update("propietarios", &format!("id=eq.{}", propietario_id), &json!({"telefono": "1199998888"})).await.unwrap();
        let actualizado: Propietario = cliente.select_uno("propietarios", &format!("id=eq.{}&select=*", propietario_id)).await.unwrap().unwrap();
        assert_eq!(actualizado.telefono, Some("1199998888".to_string()));

        // --- inmueble con FK a propietario ---
        let inmueble: Inmueble = cliente
            .insert("inmuebles", &json!({"propietario_id": propietario_id, "direccion": "Mitre 586", "tipo": "Departamento", "superficie": 45.0, "ambientes": 2}))
            .await
            .unwrap();
        let inmueble_id = inmueble.id.unwrap();

        // --- inquilino y garante ---
        let inquilino: Inquilino = cliente.insert("inquilinos", &json!({"nombre": "Juan Pérez"})).await.unwrap();
        let inquilino_id = inquilino.id.unwrap();
        let garante: Garante = cliente.insert("garantes", &json!({"nombre": "María Gómez"})).await.unwrap();
        let garante_id = garante.id.unwrap();

        // --- contrato con joins anidados (contrato_embed_a_detallado) ---
        let contrato: FilaId = cliente
            .insert(
                "contratos",
                &json!({
                    "inmueble_id": inmueble_id, "inquilino_id": inquilino_id, "fecha_inicio": "2026-01-01", "fecha_fin": "2028-01-01",
                    "dia_pago": 10, "monto_inicial": 400000.0, "comision_porcentaje": 5.0, "tasa_mora_diaria": 0.1,
                    "frecuencia_actualizacion_meses": 3, "tipo_actualizacion": "ICL", "porcentaje_actualizacion": 0.0, "estado": "activo",
                }),
            )
            .await
            .unwrap();
        let contrato_id = contrato.id;

        // ignore-duplicates (equivalente a ON CONFLICT DO NOTHING): insertar el mismo par dos veces no duplica
        for _ in 0..2 {
            cliente
                .insert_ignorando_conflicto("contrato_garantes", &json!({"contrato_id": contrato_id, "garante_id": garante_id}), "contrato_id,garante_id")
                .await
                .unwrap();
        }
        let filas_garantes: Vec<Value> = cliente.select("contrato_garantes", &format!("contrato_id=eq.{}&select=garante_id", contrato_id)).await.unwrap();
        assert_eq!(filas_garantes.len(), 1);

        let filas: Vec<ContratoEmbed> = cliente.select("contratos", &format!("id=eq.{}&{}", contrato_id, SELECT_CONTRATO_DETALLADO)).await.unwrap();
        let detallado = contrato_embed_a_detallado(filas.into_iter().next().unwrap(), today());
        assert_eq!(detallado.inmueble_direccion, "Mitre 586");
        assert_eq!(detallado.inquilino_nombre, "Juan Pérez");
        assert_eq!(detallado.propietario_nombre, "Monchola");
        assert_eq!(detallado.garantes, vec!["María Gómez".to_string()]);
        assert_eq!(detallado.monto_vigente, 400000.0);

        // --- actualizacion de alquiler ---
        cliente
            .insert::<Actualizacion>(
                "actualizaciones",
                &json!({"contrato_id": contrato_id, "fecha_vigencia": "2026-04-01", "monto_nuevo": 440000.0, "motivo": "Actualización ICL"}),
            )
            .await
            .unwrap();
        let actualizaciones = actualizaciones_de(&cliente, contrato_id).await.unwrap();
        assert_eq!(monto_vigente_de(&actualizaciones, 400000.0, parse_date("2026-05-01")), 440000.0);
        assert_eq!(monto_vigente_de(&actualizaciones, 400000.0, parse_date("2026-02-01")), 400000.0);

        // --- pago con numeración secuencial ---
        let numero_recibo = siguiente_numero(&cliente, "pagos", "numero_recibo").await.unwrap();
        assert_eq!(numero_recibo, 1);
        let pago: Pago = cliente
            .insert(
                "pagos",
                &json!({
                    "contrato_id": contrato_id, "periodo": "2026-05", "fecha_pago": "2026-05-10", "monto_alquiler": 440000.0,
                    "dias_mora": 0, "monto_mora": 0.0, "monto_total": 440000.0, "metodo_pago": "Transferencia", "numero_recibo": numero_recibo,
                }),
            )
            .await
            .unwrap();

        // --- liquidacion ---
        let numero_comprobante = siguiente_numero(&cliente, "liquidaciones", "numero_comprobante").await.unwrap();
        assert_eq!(numero_comprobante, 1);
        cliente
            .insert::<Liquidacion>(
                "liquidaciones",
                &json!({
                    "pago_id": pago.id, "fecha": "2026-05-10", "monto_alquiler": 440000.0, "comision_porcentaje": 5.0,
                    "monto_comision": 22000.0, "monto_neto": 418000.0, "numero_comprobante": numero_comprobante,
                }),
            )
            .await
            .unwrap();

        // --- consulta dinámica de cumpleaños (mismo recorrido que usa get_dashboard) ---
        for tabla in ["propietarios", "inquilinos", "garantes"] {
            let filas: Vec<PersonaCumple> = cliente.select(tabla, "select=nombre,fecha_nacimiento&fecha_nacimiento=not.is.null").await.unwrap();
            if tabla == "propietarios" {
                assert_eq!(filas.len(), 1);
                assert_eq!(filas[0].nombre, "Monchola");
            }
        }

        // --- el DELETE RESTRICT de propietarios con inmuebles debe fallar con el código esperado ---
        let borrado_restringido = cliente.delete("propietarios", &format!("id=eq.{}", propietario_id)).await;
        assert!(borrado_restringido.unwrap_err().es_codigo(FOREIGN_KEY_VIOLATION));
    }
}
