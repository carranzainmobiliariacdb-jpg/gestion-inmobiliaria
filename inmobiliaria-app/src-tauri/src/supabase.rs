use crate::config::SupabaseConfig;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

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
}

impl ErrorSupabase {
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
}

impl Cliente {
    pub fn nuevo(config: &SupabaseConfig) -> Self {
        Self::con_base_completa(format!("{}/rest/v1", normalizar_url(&config.url)), normalizar_clave(&config.anon_key))
    }

    /// Apunta directo a la base dada, sin asumir el prefijo `/rest/v1` que
    /// agrega Supabase delante de PostgREST (usado por `nuevo`, y en los
    /// tests para hablar directo con un PostgREST local que sirve las
    /// tablas en la raíz).
    pub fn con_base_completa(base: String, anon_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base,
            anon_key,
        }
    }

    /// Prueba la conexión con una consulta liviana, para detectar
    /// credenciales o red incorrectas de entrada en vez de que fallen recién
    /// en el primer uso real.
    pub async fn probar(&self) -> Result<(), ErrorSupabase> {
        self.req(Method::GET, "/usuarios?select=id&limit=1").send_verificado().await?;
        Ok(())
    }

    fn req(&self, method: Method, ruta: &str) -> PeticionConstruida {
        let builder = self
            .http
            .request(method, format!("{}{}", self.base, ruta))
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {}", self.anon_key))
            .header("Content-Type", "application/json");
        PeticionConstruida(builder)
    }

    pub async fn select<T: DeserializeOwned>(&self, tabla: &str, query: &str) -> Result<Vec<T>, ErrorSupabase> {
        let resp = self.req(Method::GET, &format!("/{}?{}", tabla, query)).send_verificado().await?;
        resp.json::<Vec<T>>().await.map_err(error_de_red)
    }

    pub async fn select_uno<T: DeserializeOwned>(&self, tabla: &str, query: &str) -> Result<Option<T>, ErrorSupabase> {
        let filas: Vec<T> = self.select(tabla, query).await?;
        Ok(filas.into_iter().next())
    }

    /// Inserta una fila y devuelve la fila insertada (equivalente a RETURNING).
    pub async fn insert<T: DeserializeOwned>(&self, tabla: &str, body: &Value) -> Result<T, ErrorSupabase> {
        let resp = self
            .req(Method::POST, &format!("/{}", tabla))
            .header("Prefer", "return=representation")
            .json(body)
            .send_verificado()
            .await?;
        let filas: Vec<T> = resp.json().await.map_err(error_de_red)?;
        filas.into_iter().next().ok_or_else(|| ErrorSupabase { codigo: None, mensaje: "Supabase no devolvió la fila insertada".to_string() })
    }

    /// Inserta sin fallar si la fila ya existe (ON CONFLICT DO NOTHING),
    /// usando `on_conflict` como columna(s) de conflicto.
    pub async fn insert_ignorando_conflicto(&self, tabla: &str, body: &Value, on_conflict: &str) -> Result<(), ErrorSupabase> {
        self.req(Method::POST, &format!("/{}?on_conflict={}", tabla, on_conflict))
            .header("Prefer", "resolution=ignore-duplicates")
            .json(body)
            .send_verificado()
            .await?;
        Ok(())
    }

    /// INSERT ... ON CONFLICT DO UPDATE (para tablas clave/valor).
    pub async fn upsert(&self, tabla: &str, body: &Value, on_conflict: &str) -> Result<(), ErrorSupabase> {
        self.req(Method::POST, &format!("/{}?on_conflict={}", tabla, on_conflict))
            .header("Prefer", "resolution=merge-duplicates")
            .json(body)
            .send_verificado()
            .await?;
        Ok(())
    }

    pub async fn update(&self, tabla: &str, filtro: &str, body: &Value) -> Result<(), ErrorSupabase> {
        self.req(Method::PATCH, &format!("/{}?{}", tabla, filtro)).json(body).send_verificado().await?;
        Ok(())
    }

    pub async fn delete(&self, tabla: &str, filtro: &str) -> Result<(), ErrorSupabase> {
        self.req(Method::DELETE, &format!("/{}?{}", tabla, filtro)).send_verificado().await?;
        Ok(())
    }
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
            Err(ErrorSupabase {
                codigo: detalle.code,
                mensaje: detalle.message.unwrap_or_else(|| format!("Error HTTP {}: {}", status, cuerpo)),
            })
        }
    }
}

fn error_de_red(e: reqwest::Error) -> ErrorSupabase {
    ErrorSupabase { codigo: None, mensaje: format!("No se pudo comunicar con Supabase: {}", e) }
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
