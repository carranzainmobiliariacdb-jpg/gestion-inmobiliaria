//! Copia local de la base ("espejo") para poder trabajar sin internet.
//!
//! - Con internet, la app sigue leyendo y escribiendo en Supabase como
//!   siempre; cada tanto (y después de cada cambio) la copia local se pone
//!   al día.
//! - Sin internet, las lecturas se responden con la copia local
//!   (`consulta::seleccionar`) y los cambios se aplican a la copia local y
//!   se anotan en una cola de "pendientes".
//! - Al volver internet, la cola se sube en orden a Supabase (ver
//!   `Cliente::sincronizar`), reemplazando los ids provisorios (negativos)
//!   por los reales y renumerando recibos si otra PC usó el mismo número.
//!
//! Todo se guarda en archivos JSON en la carpeta de datos de la app
//! (`espejo/`), así sobrevive a cerrar el programa sin conexión.

pub mod consulta;
pub mod esquema;

use crate::supabase::ErrorSupabase;
use consulta::{clave_fila, comparar_valores, filtrar, parametros, pk_de, Tablas};
use esquema::{FKS, TABLAS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

#[allow(dead_code)]
pub enum Defecto {
    Nada,
    Serial,
    Ahora,
    Hoy,
    Json(&'static str),
}
pub struct Columna {
    pub nombre: &'static str,
    pub defecto: Defecto,
}
pub struct Tabla {
    pub nombre: &'static str,
    pub pk: &'static str,
    pub unicas: &'static [&'static str],
    pub columnas: &'static [Columna],
}
/// `al_borrar`: 'c' cascade, 'n' set null, 'r'/'a' restrict / no action.
pub struct Fk {
    pub tabla: &'static str,
    pub columna: &'static str,
    pub ref_tabla: &'static str,
    pub al_borrar: char,
}

pub fn tabla_esquema(nombre: &str) -> Option<&'static Tabla> {
    TABLAS.iter().find(|t| t.nombre == nombre)
}

/// Tablas que se copian a la PC (todas las del esquema).
pub fn tablas_a_copiar() -> Vec<&'static str> {
    TABLAS.iter().map(|t| t.nombre).collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum TipoOp {
    Insertar,
    InsertarIgnorando { on_conflict: String },
    Combinar { on_conflict: String },
    Actualizar,
    Borrar,
}

/// Un cambio hecho sin conexión, pendiente de subir.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Operacion {
    #[serde(flatten)]
    pub tipo: TipoOp,
    pub tabla: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub body: Option<Value>,
    /// Id provisorio asignado a cada fila insertada (mismo orden que el body).
    #[serde(default)]
    pub temp_ids: Vec<Option<i64>>,
    #[serde(default)]
    pub momento: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Meta {
    #[serde(default)]
    url: String,
    #[serde(default)]
    completo: bool,
    #[serde(default)]
    proximo_temp: i64,
    #[serde(default)]
    ultima_sync: Option<String>,
    /// id provisorio → id real (para lo que haya quedado con el viejo).
    #[serde(default)]
    ids: BTreeMap<String, i64>,
    #[serde(default)]
    avisos: Vec<String>,
    /// Números renumerados al subir: "tabla:viejo" → nuevo (se conserva
    /// hasta vaciar la cola, por si se corta a mitad de camino).
    #[serde(default)]
    renumeros: BTreeMap<String, i64>,
}

struct Estado {
    tablas: Tablas,
    pendientes: Vec<Operacion>,
    meta: Meta,
    sin_conexion: bool,
    ultima_descarga: Option<Instant>,
}

pub struct Espejo {
    dir: PathBuf,
    estado: Mutex<Estado>,
    /// Una sola sincronización a la vez.
    pub candado_sync: tokio::sync::Mutex<()>,
}

fn ahora_texto() -> String {
    chrono::Local::now().format("%d/%m/%Y %H:%M").to_string()
}

fn error(codigo: &str, mensaje: impl Into<String>) -> ErrorSupabase {
    ErrorSupabase::nuevo(Some(codigo), mensaje.into())
}

fn escribir_json(ruta: &Path, valor: &impl Serialize) {
    if let Ok(texto) = serde_json::to_vec(valor) {
        let tmp = ruta.with_extension("tmp");
        if std::fs::write(&tmp, texto).is_ok() {
            let _ = std::fs::rename(&tmp, ruta);
        }
    }
}

fn leer_json<T: for<'de> Deserialize<'de>>(ruta: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(ruta).ok()?).ok()
}

static ABIERTOS: OnceLock<Mutex<HashMap<PathBuf, Arc<Espejo>>>> = OnceLock::new();

impl Espejo {
    /// Abre (o reutiliza) la copia local guardada en `data_dir/espejo`. Si
    /// era de otra base (otra URL), la descarta.
    pub fn abrir(data_dir: &Path, url: &str) -> Arc<Espejo> {
        let dir = data_dir.join("espejo");
        let mapa = ABIERTOS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut mapa = mapa.lock().unwrap();
        if let Some(e) = mapa.get(&dir) {
            if e.estado.lock().unwrap().meta.url == url {
                return e.clone();
            }
        }
        let _ = std::fs::create_dir_all(&dir);
        let mut meta: Meta = leer_json(&dir.join("meta.json")).unwrap_or_default();
        let mut tablas = Tablas::new();
        let mut pendientes: Vec<Operacion> = Vec::new();
        if meta.url == url {
            for t in tablas_a_copiar() {
                if let Some(filas) = leer_json::<Vec<Value>>(&dir.join(format!("{}.json", t))) {
                    tablas.insert(t.to_string(), filas);
                }
            }
            pendientes = leer_json(&dir.join("pendientes.json")).unwrap_or_default();
        } else {
            // Copia de otra base (o primera vez): se empieza de cero.
            meta = Meta { url: url.to_string(), ..Default::default() };
            if let Ok(lista) = std::fs::read_dir(&dir) {
                for f in lista.flatten() {
                    let _ = std::fs::remove_file(f.path());
                }
            }
            escribir_json(&dir.join("meta.json"), &meta);
        }
        let e = Arc::new(Espejo {
            dir: dir.clone(),
            estado: Mutex::new(Estado { tablas, pendientes, meta, sin_conexion: false, ultima_descarga: None }),
            candado_sync: tokio::sync::Mutex::new(()),
        });
        mapa.insert(dir, e.clone());
        e
    }

    fn guardar_meta(&self, st: &Estado) {
        escribir_json(&self.dir.join("meta.json"), &st.meta);
    }
    fn guardar_tabla(&self, st: &Estado, tabla: &str) {
        if let Some(filas) = st.tablas.get(tabla) {
            escribir_json(&self.dir.join(format!("{}.json", tabla)), filas);
        }
    }
    fn guardar_pendientes(&self, st: &Estado) {
        escribir_json(&self.dir.join("pendientes.json"), &st.pendientes);
    }

    // ---------- Estado ----------

    pub fn tiene_datos(&self) -> bool {
        self.estado.lock().unwrap().meta.completo
    }
    pub fn sin_conexion(&self) -> bool {
        self.estado.lock().unwrap().sin_conexion
    }
    pub fn marcar_sin_conexion(&self, sin: bool) {
        self.estado.lock().unwrap().sin_conexion = sin;
    }
    pub fn hay_pendientes(&self) -> bool {
        !self.estado.lock().unwrap().pendientes.is_empty()
    }
    pub fn descarga_vencida(&self, segundos: u64) -> bool {
        let st = self.estado.lock().unwrap();
        st.ultima_descarga.map(|i| i.elapsed().as_secs() >= segundos).unwrap_or(true)
    }
    pub fn agregar_aviso(&self, aviso: String) {
        let mut st = self.estado.lock().unwrap();
        st.meta.avisos.push(aviso);
        self.guardar_meta(&st);
    }
    pub fn limpiar_avisos(&self) {
        let mut st = self.estado.lock().unwrap();
        st.meta.avisos.clear();
        self.guardar_meta(&st);
    }

    pub fn resumen(&self) -> Value {
        let st = self.estado.lock().unwrap();
        json!({
            "sin_conexion": st.sin_conexion,
            "pendientes": st.pendientes.len(),
            "detalle_pendientes": st.pendientes.iter().take(30).map(describir).collect::<Vec<_>>(),
            "ultima_sync": st.meta.ultima_sync,
            "copia_local": st.meta.completo,
            "avisos": st.meta.avisos,
        })
    }

    // ---------- Lectura ----------

    pub fn leer(&self, tabla: &str, query: &str) -> Vec<Value> {
        let st = self.estado.lock().unwrap();
        let query = reescribir_query(query, &st.meta.ids);
        consulta::seleccionar(&st.tablas, tabla, &query)
    }

    pub fn filas_de(&self, tabla: &str) -> Vec<Value> {
        self.estado.lock().unwrap().tablas.get(tabla).cloned().unwrap_or_default()
    }

    // ---------- Reflejo de lo que pasó en Supabase (con conexión) ----------

    /// Guarda (o reemplaza por clave primaria) filas devueltas por Supabase.
    pub fn reflejar_filas(&self, tabla: &str, filas: &[Value]) {
        let mut st = self.estado.lock().unwrap();
        if !st.meta.completo || filas.is_empty() {
            return;
        }
        let lista = st.tablas.entry(tabla.to_string()).or_default();
        for f in filas {
            let clave = clave_fila(tabla, f);
            match lista.iter_mut().find(|x| clave_fila(tabla, x) == clave) {
                Some(x) => {
                    // Las columnas que no vinieron (p.ej. fotos) se conservan.
                    if let (Some(dst), Some(src)) = (x.as_object_mut(), f.as_object()) {
                        for (k, v) in src {
                            dst.insert(k.clone(), v.clone());
                        }
                    }
                }
                None => lista.push(f.clone()),
            }
        }
        self.guardar_tabla(&st, tabla);
    }

    /// Borra localmente lo que ya se borró en Supabase (incluye cascadas).
    pub fn reflejar_borrado(&self, tabla: &str, filtro: &str) {
        let mut st = self.estado.lock().unwrap();
        if !st.meta.completo {
            return;
        }
        let params = parametros(filtro);
        let objetivo: Vec<Value> = st.tablas.get(tabla).map(|f| filtrar(f, &params).into_iter().cloned().collect()).unwrap_or_default();
        let mut tocadas = HashSet::new();
        borrar_en_cascada(&mut st.tablas, tabla, &objetivo, &mut tocadas, false).ok();
        for t in tocadas {
            self.guardar_tabla(&st, &t);
        }
    }

    pub fn reemplazar_tabla(&self, tabla: &str, filas: Vec<Value>) {
        let mut st = self.estado.lock().unwrap();
        st.tablas.insert(tabla.to_string(), filas);
        self.guardar_tabla(&st, tabla);
    }

    pub fn descarga_completa(&self) {
        let mut st = self.estado.lock().unwrap();
        st.meta.completo = true;
        st.meta.ultima_sync = Some(ahora_texto());
        st.ultima_descarga = Some(Instant::now());
        self.guardar_meta(&st);
    }
    pub fn descarga_intentada(&self) {
        self.estado.lock().unwrap().ultima_descarga = Some(Instant::now());
    }

    // ---------- Cambios sin conexión ----------

    fn encolar(&self, st: &mut Estado, op: Operacion) {
        st.pendientes.push(op);
        self.guardar_pendientes(st);
    }

    fn sin_copia() -> ErrorSupabase {
        ErrorSupabase::nuevo(
            None,
            "Sin conexión a internet y todavía no hay una copia de los datos en esta PC (se hace sola la primera vez que el programa se usa con internet).".into(),
        )
    }

    /// INSERT local (con valores por defecto, id provisorio y controles de
    /// clave única / referencias). Devuelve las filas como las devolvería
    /// Supabase y deja el cambio en la cola de pendientes.
    pub fn insertar(&self, tabla: &str, body: &Value, tipo: TipoOp) -> Result<Vec<Value>, ErrorSupabase> {
        let mut st = self.estado.lock().unwrap();
        if !st.meta.completo {
            return Err(Self::sin_copia());
        }
        let items: Vec<Value> = match body {
            Value::Array(a) => a.clone(),
            otro => vec![otro.clone()],
        };
        let esquema = tabla_esquema(tabla);
        let mut devueltas = Vec::new();
        let mut temp_ids = Vec::new();
        let mut nuevas_tablas = st.tablas.clone();
        let mut proximo = st.meta.proximo_temp;
        for item in &items {
            let obj = item.as_object().cloned().unwrap_or_default();
            // ¿Choca con una fila existente (clave primaria o única)?
            let mut claves: Vec<Vec<&str>> = Vec::new();
            if let Some(t) = esquema {
                if !t.pk.is_empty() {
                    claves.push(t.pk.split(',').collect());
                }
                for u in t.unicas {
                    claves.push(u.split(',').collect());
                }
            }
            let conflicto_cols: Option<Vec<&str>> = match &tipo {
                TipoOp::Combinar { on_conflict } | TipoOp::InsertarIgnorando { on_conflict } => Some(on_conflict.split(',').map(str::trim).collect()),
                _ => None,
            };
            let lista = nuevas_tablas.entry(tabla.to_string()).or_default();
            let choca = |cols: &[&str], fila: &Value| -> bool {
                cols.iter().all(|c| match (obj.get(*c), fila.get(*c)) {
                    (Some(a), Some(b)) if !a.is_null() => comparar_valores(a, b) == Ordering::Equal,
                    _ => false,
                })
            };
            if let Some(cols) = &conflicto_cols {
                if let Some(pos) = lista.iter().position(|f| choca(cols, f)) {
                    if matches!(tipo, TipoOp::Combinar { .. }) {
                        if let Some(dst) = lista[pos].as_object_mut() {
                            for (k, v) in &obj {
                                dst.insert(k.clone(), v.clone());
                            }
                        }
                        devueltas.push(lista[pos].clone());
                    }
                    temp_ids.push(None);
                    continue;
                }
            }
            if let Some(cols) = claves.iter().find(|cols| lista.iter().any(|f| choca(cols, f))) {
                return Err(error(
                    crate::supabase::UNIQUE_VIOLATION,
                    format!("duplicate key value violates unique constraint ({}: {})", tabla, cols.join(",")),
                ));
            }
            // Fila completa con los valores por defecto de la base.
            let mut fila = Map::new();
            let mut temp = None;
            if let Some(t) = esquema {
                for c in t.columnas {
                    let v = match obj.get(c.nombre) {
                        Some(v) => v.clone(),
                        None => match c.defecto {
                            Defecto::Nada => Value::Null,
                            Defecto::Serial => {
                                proximo -= 1;
                                temp = Some(proximo);
                                json!(proximo)
                            }
                            Defecto::Ahora => json!(chrono::Utc::now().to_rfc3339()),
                            Defecto::Hoy => json!(chrono::Local::now().format("%Y-%m-%d").to_string()),
                            Defecto::Json(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                        },
                    };
                    fila.insert(c.nombre.to_string(), v);
                }
            }
            for (k, v) in &obj {
                fila.insert(k.clone(), v.clone());
            }
            let fila = Value::Object(fila);
            verificar_referencias(&nuevas_tablas, tabla, &fila)?;
            nuevas_tablas.entry(tabla.to_string()).or_default().push(fila.clone());
            temp_ids.push(temp);
            devueltas.push(fila);
        }
        st.tablas = nuevas_tablas;
        st.meta.proximo_temp = proximo;
        self.guardar_tabla(&st, tabla);
        self.guardar_meta(&st);
        let op = Operacion { tipo, tabla: tabla.to_string(), query: String::new(), body: Some(body.clone()), temp_ids, momento: ahora_texto() };
        self.encolar(&mut st, op);
        Ok(devueltas)
    }

    pub fn actualizar(&self, tabla: &str, filtro: &str, body: &Value) -> Result<Vec<Value>, ErrorSupabase> {
        let mut st = self.estado.lock().unwrap();
        if !st.meta.completo {
            return Err(Self::sin_copia());
        }
        let filtro = reescribir_query(filtro, &st.meta.ids);
        let params = parametros(&filtro);
        let cambios = body.as_object().cloned().unwrap_or_default();
        let mut nuevas = st.tablas.clone();
        let mut devueltas = Vec::new();
        if let Some(lista) = nuevas.get_mut(tabla) {
            for f in lista.iter_mut() {
                if consulta::cumple_filtros(f, &params) {
                    if let Some(o) = f.as_object_mut() {
                        for (k, v) in &cambios {
                            o.insert(k.clone(), v.clone());
                        }
                    }
                    devueltas.push(f.clone());
                }
            }
        }
        for f in &devueltas {
            verificar_referencias(&nuevas, tabla, f)?;
        }
        st.tablas = nuevas;
        self.guardar_tabla(&st, tabla);
        let op = Operacion { tipo: TipoOp::Actualizar, tabla: tabla.into(), query: filtro, body: Some(body.clone()), temp_ids: vec![], momento: ahora_texto() };
        self.encolar(&mut st, op);
        Ok(devueltas)
    }

    pub fn borrar(&self, tabla: &str, filtro: &str) -> Result<(), ErrorSupabase> {
        let mut st = self.estado.lock().unwrap();
        if !st.meta.completo {
            return Err(Self::sin_copia());
        }
        let filtro = reescribir_query(filtro, &st.meta.ids);
        let params = parametros(&filtro);
        let objetivo: Vec<Value> = st.tablas.get(tabla).map(|f| filtrar(f, &params).into_iter().cloned().collect()).unwrap_or_default();
        let mut nuevas = st.tablas.clone();
        let mut tocadas = HashSet::new();
        borrar_en_cascada(&mut nuevas, tabla, &objetivo, &mut tocadas, true)?;
        st.tablas = nuevas;
        for t in &tocadas {
            self.guardar_tabla(&st, t);
        }
        let op = Operacion { tipo: TipoOp::Borrar, tabla: tabla.into(), query: filtro, body: None, temp_ids: vec![], momento: ahora_texto() };
        self.encolar(&mut st, op);
        Ok(())
    }

    // ---------- Cola de pendientes (la usa Cliente::sincronizar) ----------

    pub fn primera_pendiente(&self) -> Option<Operacion> {
        let st = self.estado.lock().unwrap();
        st.pendientes.first().cloned().map(|op| reescribir_op(op, &st.meta.ids))
    }

    pub fn quitar_primera_pendiente(&self) {
        let mut st = self.estado.lock().unwrap();
        if !st.pendientes.is_empty() {
            st.pendientes.remove(0);
        }
        if st.pendientes.is_empty() && !st.meta.renumeros.is_empty() {
            st.meta.renumeros.clear();
            self.guardar_meta(&st);
        }
        self.guardar_pendientes(&st);
    }

    /// Anota que el id provisorio `temp` pasó a ser `real` en Supabase y lo
    /// cambia en la copia local.
    pub fn registrar_id(&self, tabla: &str, temp: i64, real: i64) {
        let mut st = self.estado.lock().unwrap();
        st.meta.ids.insert(temp.to_string(), real);
        let mut tocadas = HashSet::new();
        let pk_es_id = pk_de(tabla) == vec!["id"];
        for (t, filas) in st.tablas.iter_mut() {
            for f in filas.iter_mut() {
                if let Some(o) = f.as_object_mut() {
                    for (k, v) in o.iter_mut() {
                        let es_ref = (k == "id" && t == tabla && pk_es_id) || FKS.iter().any(|fk| fk.tabla == t && fk.columna == k && fk.ref_tabla == tabla);
                        if es_ref && v.as_i64() == Some(temp) {
                            *v = json!(real);
                            tocadas.insert(t.clone());
                        }
                    }
                }
            }
        }
        for t in tocadas {
            self.guardar_tabla(&st, &t);
        }
        self.guardar_meta(&st);
    }

    /// Cambia un número (de recibo, comprobante…) en las filas locales y en
    /// los pendientes que siguen, cuando al subir se tuvo que renumerar.
    pub fn renumerar(&self, tabla: &str, columna: &str, viejo: i64, nuevo: i64) {
        let mut st = self.estado.lock().unwrap();
        if let Some(filas) = st.tablas.get_mut(tabla) {
            for f in filas.iter_mut() {
                if f.get(columna).and_then(|v| v.as_i64()) == Some(viejo) && f.get("id").and_then(|v| v.as_i64()).map(|i| i < 0).unwrap_or(false) {
                    f[columna] = json!(nuevo);
                }
            }
        }
        st.meta.renumeros.insert(format!("{}:{}", tabla, viejo), nuevo);
        self.guardar_tabla(&st, tabla);
        self.guardar_meta(&st);
    }

    /// Número ya decidido para (tabla, viejo) en esta tanda de subida.
    pub fn numero_decidido(&self, tabla: &str, viejo: i64) -> Option<i64> {
        self.estado.lock().unwrap().meta.renumeros.get(&format!("{}:{}", tabla, viejo)).copied()
    }

    pub fn marcar_sincronizado(&self) {
        let mut st = self.estado.lock().unwrap();
        st.meta.ultima_sync = Some(ahora_texto());
        self.guardar_meta(&st);
    }

    pub fn mapa_ids(&self) -> BTreeMap<String, i64> {
        self.estado.lock().unwrap().meta.ids.clone()
    }
}

/// Texto corto para mostrar un pendiente ("Cobro nuevo", "Cambio en contrato"…).
pub fn describir(op: &Operacion) -> String {
    let que = match op.tabla.as_str() {
        "pagos" => "cobro",
        "liquidaciones" => "liquidación",
        "contratos" => "contrato",
        "contrato_garantes" => "garante de contrato",
        "inquilinos" => "inquilino",
        "propietarios" => "propietario",
        "garantes" => "garante",
        "inmuebles" => "inmueble",
        "actualizaciones" => "aumento",
        "honorarios" => "recibo de honorarios",
        "honorarios_planes" => "plan de honorarios",
        "inmueble_fotos" => "foto",
        "documentos_generados" => "contrato generado",
        "modelos_contrato" => "modelo de contrato",
        "configuracion" => "configuración",
        "recordatorios" => "mensaje",
        "servicios_estado" => "estado de servicios",
        "usuarios" => "usuario",
        otra => otra,
    };
    let accion = match op.tipo {
        TipoOp::Insertar | TipoOp::InsertarIgnorando { .. } => "Alta de",
        TipoOp::Combinar { .. } | TipoOp::Actualizar => "Cambio en",
        TipoOp::Borrar => "Baja de",
    };
    format!("{} {} ({})", accion, que, op.momento)
}

fn verificar_referencias(tablas: &Tablas, tabla: &str, fila: &Value) -> Result<(), ErrorSupabase> {
    for fk in FKS.iter().filter(|f| f.tabla == tabla) {
        let Some(v) = fila.get(fk.columna) else { continue };
        if v.is_null() {
            continue;
        }
        let pk = pk_de(fk.ref_tabla);
        let pk = pk.first().copied().unwrap_or("id");
        let existe = tablas.get(fk.ref_tabla).map(|l| l.iter().any(|f| f.get(pk).map(|x| comparar_valores(x, v) == Ordering::Equal).unwrap_or(false))).unwrap_or(false);
        if !existe {
            return Err(error(
                crate::supabase::FOREIGN_KEY_VIOLATION,
                format!("insert or update on table \"{}\" violates foreign key constraint ({} no existe en {})", tabla, v, fk.ref_tabla),
            ));
        }
    }
    Ok(())
}

/// Borra `filas` de `tabla` aplicando las reglas ON DELETE de la base.
/// Con `controlar`, falla (como Postgres) si alguna fila está referenciada
/// por una FK RESTRICT / NO ACTION.
fn borrar_en_cascada(tablas: &mut Tablas, tabla: &str, filas: &[Value], tocadas: &mut HashSet<String>, controlar: bool) -> Result<(), ErrorSupabase> {
    if filas.is_empty() {
        return Ok(());
    }
    let pk = pk_de(tabla);
    let pk1 = pk.first().copied().unwrap_or("id");
    let claves: HashSet<String> = filas.iter().map(|f| clave_fila(tabla, f)).collect();
    let ids: Vec<Value> = filas.iter().filter_map(|f| f.get(pk1).cloned()).collect();
    for fk in FKS.iter().filter(|f| f.ref_tabla == tabla) {
        let refs: Vec<Value> = tablas
            .get(fk.tabla)
            .map(|l| l.iter().filter(|f| f.get(fk.columna).map(|v| ids.iter().any(|i| comparar_valores(i, v) == Ordering::Equal)).unwrap_or(false)).cloned().collect())
            .unwrap_or_default();
        if refs.is_empty() {
            continue;
        }
        match fk.al_borrar {
            'c' => borrar_en_cascada(tablas, fk.tabla, &refs, tocadas, controlar)?,
            'n' => {
                if let Some(l) = tablas.get_mut(fk.tabla) {
                    for f in l.iter_mut() {
                        if f.get(fk.columna).map(|v| ids.iter().any(|i| comparar_valores(i, v) == Ordering::Equal)).unwrap_or(false) {
                            f[fk.columna] = Value::Null;
                        }
                    }
                }
                tocadas.insert(fk.tabla.to_string());
            }
            _ => {
                if controlar {
                    return Err(error(
                        crate::supabase::FOREIGN_KEY_VIOLATION,
                        format!("update or delete on table \"{}\" violates foreign key constraint on table \"{}\"", tabla, fk.tabla),
                    ));
                }
            }
        }
    }
    if let Some(l) = tablas.get_mut(tabla) {
        l.retain(|f| !claves.contains(&clave_fila(tabla, f)));
    }
    tocadas.insert(tabla.to_string());
    Ok(())
}

// ---------- Reemplazo de ids provisorios ----------

/// Cambia los números negativos (ids provisorios) que tengan equivalente
/// real en los valores de los filtros de la query.
pub fn reescribir_query(query: &str, ids: &BTreeMap<String, i64>) -> String {
    if ids.is_empty() || !query.contains('-') {
        return query.to_string();
    }
    query
        .split('&')
        .map(|p| match p.split_once('=') {
            Some((k, v)) if !matches!(k, "select" | "order" | "limit" | "offset" | "on_conflict" | "columns") => format!("{}={}", k, reescribir_numeros(v, ids)),
            _ => p.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn reescribir_numeros(texto: &str, ids: &BTreeMap<String, i64>) -> String {
    let mut out = String::new();
    let cs: Vec<char> = texto.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let previo_ok = i == 0 || matches!(cs[i - 1], '.' | '(' | ',');
        if cs[i] == '-' && previo_ok && i + 1 < cs.len() && cs[i + 1].is_ascii_digit() {
            let mut j = i + 1;
            while j < cs.len() && cs[j].is_ascii_digit() {
                j += 1;
            }
            let fin_ok = j == cs.len() || matches!(cs[j], ')' | ',' | '&');
            let token: String = cs[i..j].iter().collect();
            match ids.get(&token) {
                Some(real) if fin_ok => out.push_str(&real.to_string()),
                _ => out.push_str(&token),
            }
            i = j;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

pub fn reescribir_body(v: &mut Value, ids: &BTreeMap<String, i64>) {
    if ids.is_empty() {
        return;
    }
    match v {
        Value::Array(a) => a.iter_mut().for_each(|x| reescribir_body(x, ids)),
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                if k == "id" || k.ends_with("_id") {
                    if let Some(n) = x.as_i64().filter(|n| *n < 0) {
                        if let Some(real) = ids.get(&n.to_string()) {
                            *x = json!(real);
                        }
                    }
                } else if k.ends_with("_ids") {
                    reescribir_body(x, ids);
                }
            }
        }
        Value::Number(n) => {
            if let Some(real) = n.as_i64().filter(|n| *n < 0).and_then(|n| ids.get(&n.to_string())) {
                *v = json!(real);
            }
        }
        _ => {}
    }
}

fn reescribir_op(mut op: Operacion, ids: &BTreeMap<String, i64>) -> Operacion {
    op.query = reescribir_query(&op.query, ids);
    if let Some(b) = op.body.as_mut() {
        reescribir_body(b, ids);
    }
    op
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reescribe_ids_provisorios() {
        let mut ids = BTreeMap::new();
        ids.insert("-3".to_string(), 42);
        assert_eq!(reescribir_query("id=eq.-3&select=*", &ids), "id=eq.42&select=*");
        assert_eq!(reescribir_query("id=in.(1,-3,-4)", &ids), "id=in.(1,42,-4)");
        assert_eq!(reescribir_query("fecha=gte.2026-03-01", &ids), "fecha=gte.2026-03-01");
        let mut b = json!({"contrato_id": -3, "monto": -3, "garante_ids": [-3, 5]});
        reescribir_body(&mut b, &ids);
        assert_eq!(b, json!({"contrato_id": 42, "monto": -3, "garante_ids": [42, 5]}));
    }

    #[test]
    fn insertar_actualizar_y_borrar_sin_conexion() {
        let dir = std::env::temp_dir().join(format!("espejo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let e = Espejo::abrir(&dir, "https://x.supabase.co");
        e.reemplazar_tabla("propietarios", vec![json!({"id": 1, "nombre": "Ana"})]);
        e.reemplazar_tabla("inmuebles", vec![]);
        e.descarga_completa();
        let inm = e.insertar("inmuebles", &json!({"propietario_id": 1, "direccion": "Mitre 1"}), TipoOp::Insertar).unwrap();
        assert_eq!(inm[0]["id"], json!(-1));
        // FK inexistente
        assert!(e.insertar("inmuebles", &json!({"propietario_id": 99, "direccion": "x"}), TipoOp::Insertar).unwrap_err().es_codigo("23503"));
        // RESTRICT: el propietario tiene un inmueble
        assert!(e.borrar("propietarios", "id=eq.1").unwrap_err().es_codigo("23503"));
        // Contrato con valores por defecto
        e.reemplazar_tabla("inquilinos", vec![json!({"id": 7, "nombre": "Carla"})]);
        let c = e.insertar("contratos", &json!({"inmueble_id": -1, "inquilino_id": 7, "fecha_inicio": "2026-01-01", "fecha_fin": "2028-01-01", "monto_inicial": 100}), TipoOp::Insertar).unwrap();
        assert_eq!(c[0]["estado"], "activo");
        assert_eq!(c[0]["dia_pago"], 10);
        let leidos = e.leer("contratos", "select=id,inmuebles(direccion)&estado=eq.activo");
        assert_eq!(leidos, vec![json!({"id": -2, "inmuebles": {"direccion": "Mitre 1"}})]);
        e.actualizar("contratos", "id=eq.-2", &json!({"estado": "finalizado"})).unwrap();
        assert_eq!(e.leer("contratos", "estado=eq.activo&select=id").len(), 0);
        // configuración: upsert por clave
        e.insertar("configuracion", &json!([{"clave": "a", "valor": "1"}]), TipoOp::Combinar { on_conflict: "clave".into() }).unwrap();
        e.insertar("configuracion", &json!([{"clave": "a", "valor": "2"}]), TipoOp::Combinar { on_conflict: "clave".into() }).unwrap();
        assert_eq!(e.leer("configuracion", "select=valor"), vec![json!({"valor": "2"})]);
        assert_eq!(e.resumen()["pendientes"], 5);
        // El id real reemplaza al provisorio en las referencias
        e.registrar_id("inmuebles", -1, 500);
        assert_eq!(e.leer("contratos", "id=eq.-2&select=inmueble_id"), vec![json!({"inmueble_id": 500})]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Prueba contra un PostgREST real (como `commands::tests_rest`): las
/// consultas que usa la app tienen que dar lo mismo en la copia local que en
/// la base, y lo hecho sin conexión tiene que subirse bien al volver.
/// Correr con `--test-threads=1` (comparte la base de pruebas).
#[cfg(test)]
mod tests_postgrest {
    use crate::supabase::Cliente;
    use serde_json::{json, Value};

    fn conectar() -> Option<Cliente> {
        let url = std::env::var("TEST_SUPABASE_URL").ok()?;
        let key = std::env::var("TEST_SUPABASE_ANON_KEY").ok()?;
        Some(Cliente::con_base_completa(url, key))
    }

    /// Normaliza números (1 vs 1.0) para comparar.
    fn norm(v: &Value) -> Value {
        match v {
            Value::Number(n) => json!(n.as_f64()),
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
            otro => otro.clone(),
        }
    }

    async fn limpiar(c: &Cliente) {
        for t in [
            "portal_avisos", "portal_reclamos", "portal_pagos_informados", "portal_accesos", "honorarios", "honorarios_planes", "documentos_generados",
            "modelos_contrato", "inmueble_fotos", "recordatorios", "servicios_estado", "configuracion", "indices_ipc", "liquidaciones", "pagos",
            "contrato_garantes", "actualizaciones", "contratos", "inmuebles", "garantes", "inquilinos", "propietarios", "usuarios",
        ] {
            let filtro = match t {
                "configuracion" => "clave=neq.zzz_nunca",
                "indices_ipc" => "periodo=neq.zzz",
                "contrato_garantes" => "contrato_id=gte.0",
                "portal_accesos" => "token=neq.zzz",
                _ => "id=gte.0",
            };
            c.delete(t, filtro).await.unwrap_or_else(|e| panic!("{}: {}", t, e));
        }
    }

    async fn ins(c: &Cliente, t: &str, b: Value) -> i64 {
        let f: Value = c.insert(t, &b).await.unwrap_or_else(|e| panic!("{}: {}", t, e));
        f.get("id").and_then(|v| v.as_i64()).unwrap_or(0)
    }

    #[tokio::test]
    async fn diferencial_y_sincronizacion() {
        let Some(remoto) = conectar() else { return };
        limpiar(&remoto).await;
        ins(&remoto, "usuarios", json!({"username":"dana","password_hash":"h","nombre_completo":"Dana","activo":true})).await;
        let p1 = ins(&remoto, "propietarios", json!({"nombre":"Ánibal Pérez","dni_cuit":"20-1","telefono":"1","datos_bancarios":"CBU","fecha_nacimiento":"1970-05-01"})).await;
        let p2 = ins(&remoto, "propietarios", json!({"nombre":"beatriz Gómez","dni_frente":"data:img"})).await;
        let q1 = ins(&remoto, "inquilinos", json!({"nombre":"Carla","fecha_nacimiento":"1990-11-20","dni_dorso":"x"})).await;
        let q2 = ins(&remoto, "inquilinos", json!({"nombre":"zeta"})).await;
        let g1 = ins(&remoto, "garantes", json!({"nombre":"Garante Uno"})).await;
        let i1 = ins(&remoto, "inmuebles", json!({"propietario_id":p1,"direccion":"Mitre 1","codigo":1,"servicio_luz":"123","localidad":"Corral"})).await;
        let i2 = ins(&remoto, "inmuebles", json!({"propietario_id":p2,"direccion":"Álamo 3","codigo":2})).await;
        let c1 = ins(&remoto, "contratos", json!({"inmueble_id":i1,"inquilino_id":q1,"fecha_inicio":"2025-01-01","fecha_fin":"2027-01-01","monto_inicial":100000,"numero":1,"comision_porcentaje":5})).await;
        ins(&remoto, "contratos", json!({"inmueble_id":i2,"inquilino_id":q2,"fecha_inicio":"2024-01-01","fecha_fin":"2026-01-01","monto_inicial":50000,"estado":"finalizado"})).await;
        remoto.insert_ignorando_conflicto("contrato_garantes", &json!({"contrato_id":c1,"garante_id":g1}), "contrato_id,garante_id").await.unwrap();
        ins(&remoto, "actualizaciones", json!({"contrato_id":c1,"fecha_vigencia":"2025-07-01","monto_nuevo":120000.5})).await;
        ins(&remoto, "actualizaciones", json!({"contrato_id":c1,"fecha_vigencia":"2026-01-01","monto_nuevo":140000})).await;
        let pg1 = ins(&remoto, "pagos", json!({"contrato_id":c1,"periodo":"2025-01","fecha_pago":"2025-01-10","monto_alquiler":100000,"monto_total":100000,"numero_recibo":1})).await;
        ins(&remoto, "pagos", json!({"contrato_id":c1,"periodo":"2025-02","fecha_pago":"2025-02-10","monto_alquiler":100000,"monto_total":100000,"numero_recibo":2})).await;
        ins(&remoto, "pagos", json!({"contrato_id":c1,"periodo":"2025-03","fecha_pago":"2025-02-10","monto_alquiler":100000,"monto_total":100000,"numero_recibo":2})).await;
        ins(&remoto, "liquidaciones", json!({"pago_id":pg1,"fecha":"2025-01-15","monto_alquiler":100000,"comision_porcentaje":5,"monto_comision":5000,"monto_neto":95000,"numero_comprobante":1})).await;
        remoto.upsert("configuracion", &json!([{"clave":"honorarios_numero_desde","valor":"10"},{"clave":"x","valor":null}]), "clave").await.unwrap();
        remoto.upsert("indices_ipc", &json!({"periodo":"2025-01","variacion":2.2}), "periodo").await.unwrap();
        ins(&remoto, "recordatorios", json!({"contrato_id":c1,"fecha":"2026-11-01","tipo":"aviso"})).await;
        ins(&remoto, "inmueble_fotos", json!({"inmueble_id":i1,"tipo":"Entrega","foto":"data:grande","miniatura":"data:mini","fecha":"2025-01-01"})).await;
        let mc = ins(&remoto, "modelos_contrato", json!({"nombre":"Vivienda","contenido":"..."})).await;
        ins(&remoto, "documentos_generados", json!({"contrato_id":c1,"modelo_id":mc,"titulo":"Contrato","contenido":"x","fecha":"2025-01-01"})).await;
        let plan = ins(&remoto, "honorarios_planes", json!({"contrato_id":c1,"total":500000,"cuotas":[{"n":1}],"pagador_nombre":"Carla","concepto":"Honorarios"})).await;
        ins(&remoto, "honorarios", json!({"numero":10,"contrato_id":c1,"plan_id":plan,"monto":250000,"fecha":"2025-01-02","pagador_nombre":"Carla","concepto":"Honorarios"})).await;
        remoto.upsert("servicios_estado", &json!([{"servicio":"agua","cuenta":"301"}]), "servicio,cuenta").await.unwrap();

        let dir = std::env::temp_dir().join(format!("espejo-pgrst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let local = conectar().unwrap().con_espejo(&dir);
        local.descargar_todo().await.unwrap();
        let e = local.espejo().unwrap().clone();
        assert!(e.tiene_datos());

        // --- Mismas respuestas local vs. Supabase ---
        let consultas: Vec<(&str, String, bool)> = vec![
            ("contratos", format!("contrato_id_no=1&select=*,inmuebles(direccion,propietario_id,codigo,localidad,piso_depto,propietarios(nombre,telefono)),inquilinos(nombre,telefono,dni_cuit),contrato_garantes(garantes(id,nombre)),actualizaciones(fecha_vigencia,monto_nuevo)&order=fecha_fin"), true),
            ("contratos", "estado=eq.activo&select=id,fecha_inicio,fecha_fin,dia_pago,monto_inicial,tasa_mora_diaria,frecuencia_actualizacion_meses,tipo_actualizacion,liquidado_hasta,inmuebles(direccion,propietarios(nombre)),inquilinos(nombre),actualizaciones(fecha_vigencia,monto_nuevo)".into(), false),
            ("pagos", "select=*&order=fecha_pago.desc".into(), false),
            ("pagos", format!("id=eq.{}&select=*,contratos(id,numero,fecha_inicio,fecha_fin,dia_pago,inquilinos(nombre,dni_cuit,telefono,email),inmuebles(codigo,direccion,piso_depto,localidad,servicio_luz,servicio_luz_contrato,servicio_agua,servicio_gas,propietarios(nombre,dni_cuit,telefono)))", pg1), true),
            ("pagos", format!("numero_recibo=eq.2&contrato_id=eq.{}&select=*&order=periodo.asc,id.asc", c1), true),
            ("pagos", "select=numero_recibo&order=numero_recibo.desc&limit=1".into(), true),
            ("pagos", "select=contrato_id,periodo".into(), false),
            ("pagos", format!("id=in.({},999)&select=id,contrato_id,monto_alquiler,monto_mora,monto_multa,contratos(comision_porcentaje,inmuebles(propietario_id))", pg1), false),
            ("liquidaciones", "numero_comprobante=eq.1&select=*,pagos(numero_recibo,periodo,fecha_pago,monto_mora,monto_multa,contratos(numero,inquilinos(nombre),inmuebles(codigo,direccion,piso_depto,localidad,propietarios(nombre,dni_cuit,cuit_cuil,telefono,datos_bancarios))))&order=id".into(), true),
            ("liquidaciones", format!("pago_id=in.({})&select=pago_id", pg1), false),
            ("propietarios", "select=id,nombre,dni_cuit,telefono&order=nombre".into(), false),
            ("inmuebles", "select=id,codigo,direccion,propietario_id,propietarios(nombre)&order=direccion".into(), false),
            ("inquilinos", "select=id&or=(dni_frente.not.is.null,dni_dorso.not.is.null)".into(), false),
            ("propietarios", "select=nombre,fecha_nacimiento&fecha_nacimiento=not.is.null".into(), false),
            ("contratos", "select=numero&order=numero.desc.nullslast&limit=1".into(), true),
            ("contratos", "select=numero&order=numero.desc&limit=1".into(), true),
            ("actualizaciones", format!("contrato_id=eq.{}&select=*&order=fecha_vigencia.desc", c1), true),
            ("contrato_garantes", format!("contrato_id=eq.{}&select=garante_id", c1), false),
            ("configuracion", "select=clave,valor".into(), false),
            ("configuracion", "clave=eq.honorarios_numero_desde&select=valor".into(), true),
            ("indices_ipc", "select=periodo,variacion&order=periodo".into(), true),
            ("recordatorios", "fecha=gte.2026-10-01&select=*&order=id.desc&limit=500".into(), true),
            ("inmueble_fotos", format!("inmueble_id=eq.{}&select=id,inmueble_id,contrato_id,tipo,descripcion,fecha,miniatura,usuario&order=fecha.desc,id", i1), true),
            ("inmueble_fotos", format!("inmueble_id=eq.{}&tipo=eq.Entrega&select=*&order=fecha,id", i1), true),
            ("modelos_contrato", "select=*&order=id".into(), true),
            ("documentos_generados", "select=id,contrato_id,modelo_id,titulo,fecha,usuario&order=id.desc&limit=300".into(), true),
            ("honorarios", "select=*&order=numero.desc".into(), true),
            ("honorarios_planes", "select=*&order=id.desc".into(), true),
            ("servicios_estado", "select=*&order=servicio,cuenta".into(), true),
            ("usuarios", "username=eq.dana&select=id,username,password_hash,nombre_completo,activo".into(), true),
            ("usuarios", "select=id,username,nombre_completo,activo&order=nombre_completo".into(), true),
        ];
        for (tabla, q, con_orden) in &consultas {
            let q = q.replace("contrato_id_no=1&", "");
            let a: Vec<Value> = remoto.select(tabla, &q).await.unwrap_or_else(|err| panic!("{} {}: {}", tabla, q, err));
            let b = e.leer(tabla, &q);
            let (mut a, mut b): (Vec<Value>, Vec<Value>) = (a.iter().map(norm).collect(), b.iter().map(norm).collect());
            if !con_orden {
                a.sort_by_key(|v| v.to_string());
                b.sort_by_key(|v| v.to_string());
            }
            assert_eq!(a, b, "\nDistinto en {} ? {}", tabla, q);
            assert!(!a.is_empty() || tabla.contains("garantes_no"), "consulta sin filas (no prueba nada): {} {}", tabla, q);
        }

        // --- Trabajo sin conexión ---
        e.marcar_sin_conexion(true);
        let nuevo_inq: Value = local.insert("inquilinos", &json!({"nombre":"Offline Inquilino"})).await.unwrap();
        let qn = nuevo_inq["id"].as_i64().unwrap();
        assert!(qn < 0);
        let nuevo_c: Value = local
            .insert("contratos", &json!({"inmueble_id":i2,"inquilino_id":qn,"fecha_inicio":"2026-11-01","fecha_fin":"2028-11-01","monto_inicial":300000,"numero":2}))
            .await
            .unwrap();
        let cn = nuevo_c["id"].as_i64().unwrap();
        local.insert_ignorando_conflicto("contrato_garantes", &json!({"contrato_id":cn,"garante_id":g1}), "contrato_id,garante_id").await.unwrap();
        // Dos períodos en un mismo recibo N° 3, y otro recibo N° 4.
        for (per, n) in [("2026-11", 3), ("2026-12", 3), ("2027-01", 4)] {
            let _: Value = local
                .insert("pagos", &json!({"contrato_id":cn,"periodo":per,"fecha_pago":"2026-11-15","monto_alquiler":300000,"monto_total":300000,"numero_recibo":n}))
                .await
                .unwrap();
        }
        local.update("inquilinos", &format!("id=eq.{}", qn), &json!({"telefono":"3468"})).await.unwrap();
        local.upsert("configuracion", &json!([{"clave":"x","valor":"offline"}]), "clave").await.unwrap();
        local.delete("recordatorios", "id=gte.0").await.unwrap();
        // Borrar un inquilino con contrato falla igual que en la base.
        assert!(local.delete("inquilinos", &format!("id=eq.{}", qn)).await.unwrap_err().es_codigo(crate::supabase::FOREIGN_KEY_VIOLATION));
        // Lo nuevo se ve en las consultas locales, con sus relaciones.
        let vistos: Vec<Value> = local.select("contratos", &format!("id=eq.{}&select=id,inquilinos(nombre),contrato_garantes(garantes(nombre))", cn)).await.unwrap();
        assert_eq!(vistos[0]["inquilinos"]["nombre"], "Offline Inquilino");
        assert_eq!(vistos[0]["contrato_garantes"][0]["garantes"]["nombre"], "Garante Uno");
        assert_eq!(e.resumen()["pendientes"], 9);

        // Mientras tanto, otra PC usó el recibo N° 3.
        ins(&remoto, "pagos", json!({"contrato_id":c1,"periodo":"2026-10","fecha_pago":"2026-11-14","monto_alquiler":1,"monto_total":1,"numero_recibo":3})).await;

        // --- Vuelve internet ---
        e.marcar_sin_conexion(false);
        let subidos = local.sincronizar().await.unwrap();
        assert_eq!(subidos, 9);
        assert!(!e.hay_pendientes());
        let inq: Vec<Value> = remoto.select("inquilinos", "nombre=eq.Offline Inquilino&select=id,telefono").await.unwrap();
        assert_eq!(inq.len(), 1);
        assert_eq!(inq[0]["telefono"], "3468");
        let real_inq = inq[0]["id"].as_i64().unwrap();
        let cs: Vec<Value> = remoto.select("contratos", &format!("inquilino_id=eq.{}&select=id,contrato_garantes(garante_id),pagos(periodo,numero_recibo)", real_inq)).await.unwrap();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0]["contrato_garantes"][0]["garante_id"], json!(g1));
        let mut recibos: Vec<(String, i64)> = cs[0]["pagos"].as_array().unwrap().iter().map(|p| (p["periodo"].as_str().unwrap().to_string(), p["numero_recibo"].as_i64().unwrap())).collect();
        recibos.sort();
        // El 3 ya estaba usado → los dos períodos pasan juntos al 4; el 4 → 5.
        assert_eq!(recibos, vec![("2026-11".into(), 4), ("2026-12".into(), 4), ("2027-01".into(), 5)]);
        assert!(e.resumen()["avisos"].as_array().unwrap().iter().any(|a| a.as_str().unwrap().contains("N° 3")));
        let cfg: Vec<Value> = remoto.select("configuracion", "clave=eq.x&select=valor").await.unwrap();
        assert_eq!(cfg[0]["valor"], "offline");
        let rec: Vec<Value> = remoto.select("recordatorios", "select=id").await.unwrap();
        assert!(rec.is_empty());
        // Una consulta con el id provisorio viejo sigue funcionando.
        let por_viejo: Vec<Value> = local.select("contratos", &format!("id=eq.{}&select=id", cn)).await.unwrap();
        assert_eq!(por_viejo.len(), 1);
        local.descargar_todo().await.unwrap();
        assert_eq!(e.leer("pagos", "numero_recibo=eq.5&select=periodo"), vec![json!({"periodo":"2027-01"})]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
