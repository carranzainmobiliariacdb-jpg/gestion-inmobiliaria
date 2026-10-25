use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
    /// Clave privada de la oficina (service_role / sb_secret_…). Se pega una
    /// vez en cada PC y queda sólo en esa PC (nunca en el instalador). Con la
    /// seguridad del portal activada, la clave pública ya no lee las tablas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clave_oficina: Option<String>,
}

impl SupabaseConfig {
    /// Clave con la que habla el programa: la de la oficina si está, si no la pública.
    pub fn clave_en_uso(&self) -> &str {
        match self.clave_oficina.as_deref().map(str::trim) {
            Some(c) if !c.is_empty() => c,
            _ => &self.anon_key,
        }
    }
}

/// Rol que trae una clave de Supabase: "service_role", "anon", o "secret" /
/// "publishable" para las claves nuevas (sb_secret_… / sb_publishable_…).
pub fn rol_de_clave(clave: &str) -> Option<String> {
    use base64::Engine;
    let c = clave.trim();
    if c.starts_with("sb_secret_") {
        return Some("secret".into());
    }
    if c.starts_with("sb_publishable_") {
        return Some("publishable".into());
    }
    let payload = c.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("role").and_then(|r| r.as_str()).map(|r| r.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredencialesGuardadas {
    pub username: String,
    pub password: String,
}

fn archivo_config(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("conexion.json")
}

fn archivo_credenciales(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("credenciales.json")
}

/// Lee la configuración guardada en una instalación anterior, si existe.
pub fn leer_guardada(data_dir: &std::path::Path) -> Option<SupabaseConfig> {
    let contenido = std::fs::read_to_string(archivo_config(data_dir)).ok()?;
    serde_json::from_str(&contenido).ok()
}

pub fn guardar(data_dir: &std::path::Path, config: &SupabaseConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(archivo_config(data_dir), json).map_err(|e| e.to_string())
}

/// Recordar usuario y contraseña localmente (en esta PC) para no tener que
/// tipearlos cada vez que se abre la app — pensado para una PC de uso
/// personal, como la de Agustín.
pub fn leer_credenciales_guardadas(data_dir: &std::path::Path) -> Option<CredencialesGuardadas> {
    let contenido = std::fs::read_to_string(archivo_credenciales(data_dir)).ok()?;
    serde_json::from_str(&contenido).ok()
}

pub fn guardar_credenciales(data_dir: &std::path::Path, credenciales: &CredencialesGuardadas) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(credenciales).map_err(|e| e.to_string())?;
    std::fs::write(archivo_credenciales(data_dir), json).map_err(|e| e.to_string())
}

pub fn borrar_credenciales(data_dir: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(archivo_credenciales(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Las páginas de Supabase muestran a veces la URL o la key como una línea de
/// archivo .env (ej. `NEXT_PUBLIC_SUPABASE_URL="https://..."`). Si alguien
/// copia esa línea entera, le sacamos el nombre de la variable y las comillas
/// para no obligar a que esté perfecto.
pub fn limpiar(valor: &str) -> String {
    let s = valor.trim();
    let s = match s.split_once('=') {
        Some((nombre, resto))
            if !nombre.is_empty()
                && nombre.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && (resto.trim_start().starts_with(['"', '\'']) || resto.trim_start().starts_with("http") || resto.trim_start().starts_with("ey")) =>
        {
            resto.trim()
        }
        _ => s,
    };
    let s = s.trim_matches(|c| c == '"' || c == '\'');
    s.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limpia_url_pegada_como_linea_de_env() {
        assert_eq!(limpiar(r#"NEXT_PUBLIC_SUPABASE_URL="https://abc.supabase.co""#), "https://abc.supabase.co");
        assert_eq!(limpiar("SUPABASE_URL=https://abc.supabase.co"), "https://abc.supabase.co");
        assert_eq!(limpiar("  https://abc.supabase.co/  "), "https://abc.supabase.co");
    }

    #[test]
    fn limpia_anon_key_pegada_como_linea_de_env() {
        let key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.firma";
        assert_eq!(limpiar(&format!(r#"NEXT_PUBLIC_SUPABASE_ANON_KEY="{}""#, key)), key);
        assert_eq!(limpiar(key), key);
    }
}
