use crate::config::SupabaseConfig;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use crate::espejo::{self, Espejo, Operacion, TipoOp};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

pub const UNIQUE_VIOLATION: &str = "23505";
pub const FOREIGN_KEY_VIOLATION: &str = "23503";

#[derive(Debug, Deserialize, Default)]
struct ErrorPostgrest {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug)]
pub struct ErrorSupabase {
    pub codigo: Option<String>,
    mensaje: String,
    /// Falla de red (sin internet, servidor caído…), no un error de la base.
    pub red: bool,
    /// La petición no llegó a salir (DNS, conexión rechazada): es seguro
    /// hacerla de nuevo más tarde sin riesgo de duplicarla.
    pub sin_envio: bool,
}

impl ErrorSupabase {
    pub fn nuevo(codigo: Option<&str>, mensaje: String) -> Self {
        Self { codigo: codigo.map(str::to_string), mensaje, red: false, sin_envio: false }
    }

    pub fn es_codigo(&self, codigo: &str) -> bool {
        self.codigo.as_deref() == Some(codigo)
    }
}

impl std::fmt::Display for ErrorSupabase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.mensaje)
    }
}

impl std::error::Error for ErrorSupabase {}

/// Cliente minimalista contra la API REST de Supabase (PostgREST), que
/// reemplaza una conexión directa a Postgres. Se conecta por HTTPS normal
/// (como cualquier sitio web, certificados públicos) en vez de abrir un
/// socket Postgres crudo — Supabase firma el certificado de su pooler de
/// Postgres con un CA propio que ningún almacén de confianza conoce de
/// antes, mientras que su API REST corre detrás de la infraestructura HTTPS
/// estándar de Supabase/Cloudflare, con certificados públicos comunes.
#[derive(Clone)]
pub struct Cliente {
    http: reqwest::Client,
    base: String,
    anon_key: String,
    /// Copia local para trabajar sin internet (None en pruebas / conexiones
    /// de un solo uso).
    espejo: Option<Arc<Espejo>>,
}

/// Dónde se resuelve una operación.
enum Modo {
    Remoto,
    Local,
}

impl Cliente {
    pub fn nuevo(config: &SupabaseConfig) -> Self {
        Self::con_base_completa(format!("{}/rest/v1", normalizar_url(&config.url)), normalizar_clave(config.clave_en_uso()))
    }

    /// Apunta directo a la base dada, sin asumir el prefijo `/rest/v1` que
    /// agrega Supabase delante de PostgREST (usado por `nuevo`, y en los
    /// tests para hablar directo con un PostgREST local que sirve las
    /// tablas en la raíz).
    pub fn con_base_completa(base: String, anon_key: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http, base, anon_key, espejo: None }
    }

    /// Le agrega la copia local guardada en `data_dir` (modo sin conexión).
    pub fn con_espejo(mut self, data_dir: &std::path::Path) -> Self {
        self.espejo = Some(Espejo::abrir(data_dir, &self.base));
        self
    }

    pub fn espejo(&self) -> Option<&Arc<Espejo>> {
        self.espejo.as_ref()
    }

    /// Rol de la clave en uso ("service_role", "anon", "secret", "publishable").
    pub fn rol(&self) -> Option<String> {
        crate::config::rol_de_clave(&self.anon_key)
    }

    /// Prueba la conexión con una consulta liviana, para detectar
    /// credenciales o red incorrectas de entrada en vez de que fallen recién
    /// en el primer uso real.
    pub async fn probar(&self) -> Result<(), ErrorSupabase> {
        match self.req(Method::GET, "/usuarios?select=id&limit=1").send_verificado().await {
            Ok(_) => Ok(()),
            // Base bloqueada para la clave pública (portal activado): la
            // conexión anda, falta la clave de la oficina en esta PC.
            Err(e) if e.codigo.as_deref() == Some("42501") => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn req(&self, method: Method, ruta: &str) -> PeticionConstruida {
        let mut builder = self
            .http
            .request(method, format!("{}{}", self.base, ruta))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json");
        // Las claves nuevas (sb_…) no son JWT: van sólo en "apikey".
        if !self.anon_key.starts_with("sb_") {
            builder = builder.header("Authorization", format!("Bearer {}", self.anon_key));
        }
        PeticionConstruida(builder)
    }

    // ---------- Decisión con / sin conexión ----------

    /// Sin copia local → siempre Supabase. Marcado sin conexión → local.
    /// Con cambios pendientes de subir → primero se intenta subirlos (para
    /// no mezclar el orden); si no se puede, se sigue en local.
    async fn modo(&self) -> Modo {
        let Some(e) = &self.espejo else { return Modo::Remoto };
        if e.sin_conexion() {
            return if e.tiene_datos() { Modo::Local } else { Modo::Remoto };
        }
        if e.hay_pendientes() {
            if let Err(err) = self.sincronizar().await {
                if err.red {
                    e.marcar_sin_conexion(true);
                }
            }
            if e.hay_pendientes() {
                return Modo::Local;
            }
        }
        Modo::Remoto
    }

    /// Con un error de red y copia local disponible: se pasa a trabajar sin
    /// conexión. Devuelve true si corresponde resolver en local.
    fn pasar_a_local(&self, err: &ErrorSupabase, es_escritura: bool) -> bool {
        let Some(e) = &self.espejo else { return false };
        if !err.red {
            return false;
        }
        e.marcar_sin_conexion(true);
        // Una escritura que quizás llegó al servidor no se repite (podría
        // duplicarse): se informa el error.
        e.tiene_datos() && (!es_escritura || err.sin_envio)
    }

    fn ids(&self) -> BTreeMap<String, i64> {
        self.espejo.as_ref().map(|e| e.mapa_ids()).unwrap_or_default()
    }

    // ---------- API pública (con soporte sin conexión) ----------

    pub async fn select<T: DeserializeOwned>(&self, tabla: &str, query: &str) -> Result<Vec<T>, ErrorSupabase> {
        let filas = self.select_valores(tabla, query).await?;
        filas.into_iter().map(|f| serde_json::from_value(f).map_err(error_de_formato)).collect()
    }

    async fn select_valores(&self, tabla: &str, query: &str) -> Result<Vec<Value>, ErrorSupabase> {
        if let Modo::Local = self.modo().await {
            return Ok(self.espejo.as_ref().unwrap().leer(tabla, query));
        }
        let query = espejo::reescribir_query(query, &self.ids());
        match self.select_remoto(tabla, &query).await {
            Err(err) if self.pasar_a_local(&err, false) => Ok(self.espejo.as_ref().unwrap().leer(tabla, &query)),
            otro => otro,
        }
    }

    pub async fn select_uno<T: DeserializeOwned>(&self, tabla: &str, query: &str) -> Result<Option<T>, ErrorSupabase> {
        let filas: Vec<T> = self.select(tabla, query).await?;
        Ok(filas.into_iter().next())
    }

    /// Inserta una fila y devuelve la fila insertada (equivalente a RETURNING).
    pub async fn insert<T: DeserializeOwned>(&self, tabla: &str, body: &Value) -> Result<T, ErrorSupabase> {
        let filas = self.escribir_insercion(tabla, body, TipoOp::Insertar).await?;
        let fila = filas.into_iter().next().ok_or_else(|| ErrorSupabase::nuevo(None, "Supabase no devolvió la fila insertada".to_string()))?;
        serde_json::from_value(fila).map_err(error_de_formato)
    }

    /// Inserta sin fallar si la fila ya existe (ON CONFLICT DO NOTHING),
    /// usando `on_conflict` como columna(s) de conflicto.
    pub async fn insert_ignorando_conflicto(&self, tabla: &str, body: &Value, on_conflict: &str) -> Result<(), ErrorSupabase> {
        self.escribir_insercion(tabla, body, TipoOp::InsertarIgnorando { on_conflict: on_conflict.to_string() }).await.map(|_| ())
    }

    /// INSERT ... ON CONFLICT DO UPDATE (para tablas clave/valor).
    pub async fn upsert(&self, tabla: &str, body: &Value, on_conflict: &str) -> Result<(), ErrorSupabase> {
        self.escribir_insercion(tabla, body, TipoOp::Combinar { on_conflict: on_conflict.to_string() }).await.map(|_| ())
    }

    async fn escribir_insercion(&self, tabla: &str, body: &Value, tipo: TipoOp) -> Result<Vec<Value>, ErrorSupabase> {
        if let Modo::Local = self.modo().await {
            return self.espejo.as_ref().unwrap().insertar(tabla, body, tipo);
        }
        let mut body = body.clone();
        espejo::reescribir_body(&mut body, &self.ids());
        match self.insercion_remota(tabla, &body, &tipo).await {
            Ok(filas) => {
                if let Some(e) = &self.espejo {
                    e.reflejar_filas(tabla, &filas);
                }
                Ok(filas)
            }
            Err(err) if self.pasar_a_local(&err, true) => self.espejo.as_ref().unwrap().insertar(tabla, &body, tipo),
            Err(err) => Err(err),
        }
    }

    pub async fn update(&self, tabla: &str, filtro: &str, body: &Value) -> Result<(), ErrorSupabase> {
        if let Modo::Local = self.modo().await {
            return self.espejo.as_ref().unwrap().actualizar(tabla, filtro, body).map(|_| ());
        }
        let ids = self.ids();
        let filtro = espejo::reescribir_query(filtro, &ids);
        let mut body = body.clone();
        espejo::reescribir_body(&mut body, &ids);
        match self.update_remoto(tabla, &filtro, &body).await {
            Ok(filas) => {
                if let Some(e) = &self.espejo {
                    e.reflejar_filas(tabla, &filas);
                }
                Ok(())
            }
            Err(err) if self.pasar_a_local(&err, true) => self.espejo.as_ref().unwrap().actualizar(tabla, &filtro, &body).map(|_| ()),
            Err(err) => Err(err),
        }
    }

    pub async fn delete(&self, tabla: &str, filtro: &str) -> Result<(), ErrorSupabase> {
        if let Modo::Local = self.modo().await {
            return self.espejo.as_ref().unwrap().borrar(tabla, filtro);
        }
        let filtro = espejo::reescribir_query(filtro, &self.ids());
        match self.delete_remoto(tabla, &filtro).await {
            Ok(()) => {
                if let Some(e) = &self.espejo {
                    e.reflejar_borrado(tabla, &filtro);
                }
                Ok(())
            }
            Err(err) if self.pasar_a_local(&err, true) => self.espejo.as_ref().unwrap().borrar(tabla, &filtro),
            Err(err) => Err(err),
        }
    }

    /// Llama a una función de la base (POST /rpc/nombre) y devuelve el
    /// resultado. Necesita conexión.
    pub async fn rpc(&self, funcion: &str, body: &Value) -> Result<Value, ErrorSupabase> {
        if let Some(e) = &self.espejo {
            if e.sin_conexion() {
                return Err(ErrorSupabase { codigo: None, mensaje: "Sin conexión a internet".into(), red: true, sin_envio: true });
            }
        }
        let resp = self.req(Method::POST, &format!("/rpc/{}", funcion)).json(body).send_verificado().await?;
        resp.json::<Value>().await.map_err(error_de_red)
    }

    // ---------- Peticiones directas a Supabase ----------

    async fn select_remoto(&self, tabla: &str, query: &str) -> Result<Vec<Value>, ErrorSupabase> {
        let resp = self.req(Method::GET, &format!("/{}?{}", tabla, query)).send_verificado().await?;
        resp.json::<Vec<Value>>().await.map_err(error_de_red)
    }

    async fn insercion_remota(&self, tabla: &str, body: &Value, tipo: &TipoOp) -> Result<Vec<Value>, ErrorSupabase> {
        let (ruta, prefer) = match tipo {
            TipoOp::InsertarIgnorando { on_conflict } => (format!("/{}?on_conflict={}", tabla, on_conflict), "return=representation,resolution=ignore-duplicates"),
            TipoOp::Combinar { on_conflict } => (format!("/{}?on_conflict={}", tabla, on_conflict), "return=representation,resolution=merge-duplicates"),
            _ => (format!("/{}", tabla), "return=representation"),
        };
        let resp = self.req(Method::POST, &ruta).header("Prefer", prefer).json(body).send_verificado().await?;
        resp.json::<Vec<Value>>().await.map_err(error_de_red)
    }

    async fn update_remoto(&self, tabla: &str, filtro: &str, body: &Value) -> Result<Vec<Value>, ErrorSupabase> {
        let resp = self
            .req(Method::PATCH, &format!("/{}?{}", tabla, filtro))
            .header("Prefer", "return=representation")
            .json(body)
            .send_verificado()
            .await?;
        resp.json::<Vec<Value>>().await.map_err(error_de_red)
    }

    async fn delete_remoto(&self, tabla: &str, filtro: &str) -> Result<(), ErrorSupabase> {
        self.req(Method::DELETE, &format!("/{}?{}", tabla, filtro)).send_verificado().await?;
        Ok(())
    }

    // ---------- Sincronización ----------

    /// ¿Hay internet y responde Supabase? (Un error de permisos también
    /// cuenta como "hay conexión".)
    pub async fn hay_conexion(&self) -> bool {
        match self.select_remoto("configuracion", "select=clave&limit=1").await {
            Ok(_) => true,
            Err(e) => !e.red,
        }
    }

    /// Sube a Supabase, en orden, los cambios hechos sin conexión. Si se
    /// corta internet a mitad de camino, lo que falta queda para después.
    /// Si un cambio es rechazado por la base (p.ej. otra PC borró ese
    /// inquilino), se descarta y queda un aviso para mostrar.
    pub async fn sincronizar(&self) -> Result<usize, ErrorSupabase> {
        let Some(e) = &self.espejo else { return Ok(0) };
        let _candado = e.candado_sync.lock().await;
        let mut subidos = 0;
        while let Some(mut op) = e.primera_pendiente() {
            if matches!(op.tipo, TipoOp::Insertar) {
                if let Some(col) = columna_numerada(&op.tabla) {
                    self.renumerar_si_hace_falta(e, &mut op, col).await?;
                }
            }
            let res = match &op.tipo {
                TipoOp::Actualizar => self.update_remoto(&op.tabla, &op.query, op.body.as_ref().unwrap_or(&Value::Null)).await,
                TipoOp::Borrar => self.delete_remoto(&op.tabla, &op.query).await.map(|_| vec![]),
                tipo => self.insercion_remota(&op.tabla, op.body.as_ref().unwrap_or(&Value::Null), tipo).await,
            };
            match res {
                Ok(filas) => {
                    self.registrar_ids_nuevos(e, &op, &filas);
                    e.quitar_primera_pendiente();
                    subidos += 1;
                }
                Err(err) if err.red => return Err(err),
                Err(err) => {
                    e.agregar_aviso(format!("No se pudo subir: {} — {}", espejo::describir(&op), err));
                    e.quitar_primera_pendiente();
                }
            }
        }
        if subidos > 0 {
            e.marcar_sincronizado();
        }
        Ok(subidos)
    }

    fn registrar_ids_nuevos(&self, e: &Espejo, op: &Operacion, filas: &[Value]) {
        let items: Vec<Value> = match &op.body {
            Some(Value::Array(a)) => a.clone(),
            Some(o) => vec![o.clone()],
            None => vec![],
        };
        let on_conflict: Option<Vec<&str>> = match &op.tipo {
            TipoOp::Combinar { on_conflict } | TipoOp::InsertarIgnorando { on_conflict } => Some(on_conflict.split(',').map(str::trim).collect()),
            _ => None,
        };
        for (i, temp) in op.temp_ids.iter().enumerate() {
            let Some(temp) = temp else { continue };
            let fila = match &on_conflict {
                Some(cols) => items.get(i).and_then(|it| filas.iter().find(|f| cols.iter().all(|c| it.get(*c) == f.get(*c)))),
                None => filas.get(i),
            };
            if let Some(real) = fila.and_then(|f| f.get("id")).and_then(|v| v.as_i64()) {
                e.registrar_id(&op.tabla, *temp, real);
            }
        }
    }

    /// Si el número (de recibo, comprobante…) que se usó sin conexión ya lo
    /// usó otra PC, se cambia por el siguiente libre y se deja un aviso.
    async fn renumerar_si_hace_falta(&self, e: &Espejo, op: &mut Operacion, col: &str) -> Result<(), ErrorSupabase> {
        let items: Vec<i64> = match &op.body {
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.get(col).and_then(|v| v.as_i64())).collect(),
            Some(o) => o.get(col).and_then(|v| v.as_i64()).into_iter().collect(),
            None => vec![],
        };
        for viejo in items {
            if viejo <= 0 {
                continue;
            }
            let nuevo = match e.numero_decidido(&op.tabla, viejo) {
                Some(n) => n,
                None => {
                    let ya_usado = !self.select_remoto(&op.tabla, &format!("{}=eq.{}&select={}&limit=1", col, viejo, col)).await?.is_empty();
                    let n = if ya_usado {
                        let max: i64 = self
                            .select_remoto(&op.tabla, &format!("select={}&order={}.desc.nullslast&limit=1", col, col))
                            .await?
                            .first()
                            .and_then(|f| f.get(col))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        let n = max.max(viejo) + 1;
                        e.agregar_aviso(format!(
                            "El {} N° {} que se hizo sin conexión pasó a ser el N° {} (ese número ya se había usado en otra PC). Si ya lo imprimiste o lo enviaste, volvé a generarlo.",
                            match op.tabla.as_str() {
                                "pagos" => "recibo de alquiler",
                                "liquidaciones" => "comprobante de liquidación",
                                "honorarios" => "recibo de honorarios",
                                _ => "contrato",
                            },
                            viejo,
                            n
                        ));
                        n
                    } else {
                        viejo
                    };
                    e.renumerar(&op.tabla, col, viejo, n);
                    n
                }
            };
            if nuevo != viejo {
                if let Some(b) = op.body.as_mut() {
                    cambiar_numero(b, col, viejo, nuevo);
                }
            }
        }
        Ok(())
    }

    /// Baja todas las tablas a la copia local. Las fotos (pesadas) se bajan
    /// solo las que todavía no están en la PC.
    pub async fn descargar_todo(&self) -> Result<(), ErrorSupabase> {
        let Some(e) = &self.espejo else { return Ok(()) };
        if e.hay_pendientes() {
            return Ok(());
        }
        e.descarga_intentada();
        let mut nuevas: Vec<(&str, Vec<Value>)> = Vec::new();
        for tabla in espejo::tablas_a_copiar() {
            let esquema = espejo::tabla_esquema(tabla).unwrap();
            let orden = if esquema.pk.is_empty() { "" } else { esquema.pk };
            let cols = if tabla == "inmueble_fotos" {
                esquema.columnas.iter().map(|c| c.nombre).filter(|c| *c != "foto").collect::<Vec<_>>().join(",")
            } else {
                "*".to_string()
            };
            match self.todas_las_filas(tabla, &cols, orden).await {
                Ok(mut filas) => {
                    if tabla == "inmueble_fotos" {
                        self.completar_fotos(e, &mut filas).await?;
                    }
                    nuevas.push((tabla, filas));
                }
                Err(err) if err.red => return Err(err),
                // Tabla que no existe o sin permiso con esta clave: se saltea.
                Err(_) => {}
            }
        }
        if e.hay_pendientes() {
            return Ok(());
        }
        for (tabla, filas) in nuevas {
            e.reemplazar_tabla(tabla, filas);
        }
        e.descarga_completa();
        Ok(())
    }

    async fn todas_las_filas(&self, tabla: &str, cols: &str, orden: &str) -> Result<Vec<Value>, ErrorSupabase> {
        const LOTE: usize = 1000;
        let mut filas = Vec::new();
        let mut desde = 0usize;
        loop {
            let orden_q = if orden.is_empty() { String::new() } else { format!("&order={}", orden) };
            let parte = self.select_remoto(tabla, &format!("select={}{}&limit={}&offset={}", cols, orden_q, LOTE, desde)).await?;
            let n = parte.len();
            filas.extend(parte);
            if n < LOTE {
                return Ok(filas);
            }
            desde += LOTE;
        }
    }

    async fn completar_fotos(&self, e: &Espejo, filas: &mut [Value]) -> Result<(), ErrorSupabase> {
        let locales: HashMap<i64, Value> = e
            .filas_de("inmueble_fotos")
            .into_iter()
            .filter_map(|f| Some((f.get("id")?.as_i64()?, f.get("foto").cloned().filter(|v| !v.is_null())?)))
            .collect();
        let faltan: Vec<i64> = filas.iter().filter_map(|f| f.get("id")?.as_i64()).filter(|id| !locales.contains_key(id)).collect();
        let mut bajadas: HashMap<i64, Value> = HashMap::new();
        for grupo in faltan.chunks(10) {
            let ids = grupo.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            for f in self.select_remoto("inmueble_fotos", &format!("id=in.({})&select=id,foto", ids)).await? {
                if let (Some(id), Some(foto)) = (f.get("id").and_then(|v| v.as_i64()), f.get("foto")) {
                    bajadas.insert(id, foto.clone());
                }
            }
        }
        for f in filas.iter_mut() {
            if let Some(id) = f.get("id").and_then(|v| v.as_i64()) {
                if let Some(foto) = locales.get(&id).or_else(|| bajadas.get(&id)) {
                    f["foto"] = foto.clone();
                }
            }
        }
        Ok(())
    }
}

/// Columnas con numeración correlativa que hay que cuidar al subir lo hecho
/// sin conexión (dos PCs podrían haber usado el mismo número).
fn columna_numerada(tabla: &str) -> Option<&'static str> {
    match tabla {
        "pagos" => Some("numero_recibo"),
        "liquidaciones" => Some("numero_comprobante"),
        "honorarios" => Some("numero"),
        "contratos" => Some("numero"),
        _ => None,
    }
}

fn cambiar_numero(v: &mut Value, columna: &str, viejo: i64, nuevo: i64) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(|x| cambiar_numero(x, columna, viejo, nuevo)),
        Value::Object(o) => {
            if o.get(columna).and_then(|x| x.as_i64()) == Some(viejo) {
                o.insert(columna.to_string(), serde_json::json!(nuevo));
            }
        }
        _ => {}
    }
}

fn error_de_formato(e: serde_json::Error) -> ErrorSupabase {
    ErrorSupabase::nuevo(None, format!("Respuesta con formato inesperado: {}", e))
}

/// Envoltorio liviano para poder encadenar `.send_verificado()` después de
/// agregarle headers/json extra a una petición sin repetir el manejo de errores.
struct PeticionConstruida(reqwest::RequestBuilder);

impl PeticionConstruida {
    fn header(self, clave: &str, valor: impl AsRef<str>) -> Self {
        Self(self.0.header(clave, valor.as_ref()))
    }

    fn json(self, body: &Value) -> Self {
        Self(self.0.json(body))
    }

    async fn send_verificado(self) -> Result<reqwest::Response, ErrorSupabase> {
        let resp = self.0.send().await.map_err(error_de_red)?;
        if resp.status().is_success() {
            Ok(resp)
        } else {
            let status = resp.status();
            let cuerpo = resp.text().await.unwrap_or_default();
            let detalle: ErrorPostgrest = serde_json::from_str(&cuerpo).unwrap_or_default();
            // Servidor caído / en pausa / Cloudflare sin llegar a la base:
            // se trata como falta de conexión.
            let caido = matches!(status.as_u16(), 502 | 503 | 504 | 520..=530) && detalle.code.is_none();
            Err(ErrorSupabase {
                codigo: detalle.code,
                mensaje: detalle.message.unwrap_or_else(|| format!("Error HTTP {}: {}", status, cuerpo)),
                red: caido,
                sin_envio: false,
            })
        }
    }
}

fn error_de_red(e: reqwest::Error) -> ErrorSupabase {
    // reqwest sólo dice "error sending request": se agrega la causa real.
    let mut detalle = e.to_string();
    let mut fuente = std::error::Error::source(&e);
    while let Some(f) = fuente {
        detalle.push_str(" → ");
        detalle.push_str(&f.to_string());
        fuente = f.source();
    }
    let d = detalle.to_lowercase();
    let pista = if d.contains("certificate") || d.contains("certificado") || d.contains("cert") || d.contains("expired") || d.contains("unknownissuer") || d.contains("schannel") || d.contains("tls") || d.contains("ssl") {
        "Revisá que la FECHA y la HORA de esta PC sean correctas (si están mal, la conexión segura falla). Si tiene antivirus con «análisis HTTPS/web», probá desactivarlo un momento."
    } else if d.contains("dns") || d.contains("resolve") || d.contains("no such host") || d.contains("nombre") {
        "Esta PC no encuentra el servidor: revisá que tenga internet (abrí cualquier página en el navegador)."
    } else if d.contains("timed out") || d.contains("timeout") || d.contains("connect") || d.contains("refused") {
        "No se pudo llegar al servidor: revisá internet, el firewall o el antivirus de esta PC."
    } else {
        "Revisá la conexión a internet, la fecha y hora de la PC y el antivirus."
    };
    // Si ni siquiera se pudo conectar (DNS, conexión rechazada), la
    // petición no salió: se puede repetir más tarde sin riesgo.
    let sin_envio = e.is_connect() || d.contains("dns") || d.contains("resolve");
    ErrorSupabase { codigo: None, mensaje: format!("No se pudo comunicar con Supabase. {} (Detalle técnico: {})", pista, detalle), red: e.is_connect() || e.is_timeout() || e.is_request() || sin_envio, sin_envio }
}

/// Acepta la URL del proyecto como venga pegada: sin "https://", con
/// "/rest/v1/" al final, con espacios o barras de más.
pub fn normalizar_url(url: &str) -> String {
    let mut u = crate::config::limpiar(url);
    u.retain(|c| !c.is_whitespace());
    let mut u = u.trim_end_matches('/').to_string();
    if let Some(sin) = u.strip_suffix("/rest/v1") {
        u = sin.trim_end_matches('/').to_string();
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{}", u);
    }
    u
}

/// La clave nunca lleva espacios ni saltos de línea: se sacan los que se
/// cuelan al copiarla y pegarla.
pub fn normalizar_clave(clave: &str) -> String {
    let mut c = crate::config::limpiar(clave);
    c.retain(|ch| !ch.is_whitespace());
    c
}

#[cfg(test)]
mod tests_normalizar {
    use super::*;

    #[test]
    fn normaliza_urls_pegadas_de_distintas_formas() {
        for u in [
            "https://abc.supabase.co",
            "https://abc.supabase.co/",
            "https://abc.supabase.co/rest/v1/",
            " abc.supabase.co ",
            "abc.supabase.co/rest/v1",
            "\"https://abc.supabase.co\"",
        ] {
            assert_eq!(normalizar_url(u), "https://abc.supabase.co", "{}", u);
        }
    }

    #[test]
    fn saca_espacios_y_saltos_de_la_clave() {
        assert_eq!(normalizar_clave(" eyJhb\nGci OiJ \r\n"), "eyJhbGciOiJ");
    }
}
