//! Evaluador local de las consultas PostgREST que usa la app, para poder
//! responderlas sin internet a partir de la copia local de la base.
//!
//! Cubre lo que la app realmente usa: `select` con columnas y relaciones
//! anidadas (`inmuebles(direccion,propietarios(nombre))`), filtros
//! `eq/neq/gt/gte/lt/lte/like/ilike/is/in` (con `not.`), `or=(...)`,
//! `order` (asc/desc, nullsfirst/nullslast), `limit` y `offset`.

use super::esquema::{FKS, TABLAS};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;

pub type Tablas = HashMap<String, Vec<Value>>;

pub fn decodificar(s: &str) -> String {
    percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().to_string()
}

/// Separa por `sep` respetando paréntesis y comillas dobles.
pub fn partir_nivel0(s: &str, sep: char) -> Vec<String> {
    let mut partes = Vec::new();
    let mut prof = 0i32;
    let mut comillas = false;
    let mut actual = String::new();
    for c in s.chars() {
        match c {
            '"' => comillas = !comillas,
            '(' if !comillas => prof += 1,
            ')' if !comillas => prof -= 1,
            _ => {}
        }
        if c == sep && prof == 0 && !comillas {
            partes.push(std::mem::take(&mut actual));
        } else {
            actual.push(c);
        }
    }
    if !actual.is_empty() || !partes.is_empty() {
        partes.push(actual);
    }
    partes
}

/// Parámetros de la query como (clave, valor) ya decodificados.
pub fn parametros(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (decodificar(k), decodificar(v)),
            None => (decodificar(p), String::new()),
        })
        .collect()
}

// ---------- Comparaciones ----------

fn clave_texto(s: &str) -> String {
    // Aproxima la intercalación de Postgres (sin distinguir mayúsculas ni acentos).
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            otro => otro,
        })
        .collect()
}

pub fn comparar_valores(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64().unwrap_or(0.0).partial_cmp(&y.as_f64().unwrap_or(0.0)).unwrap_or(Ordering::Equal),
        (Value::String(x), Value::String(y)) => clave_texto(x).cmp(&clave_texto(y)).then_with(|| x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Number(x), Value::String(y)) => match y.parse::<f64>() {
            Ok(f) => x.as_f64().unwrap_or(0.0).partial_cmp(&f).unwrap_or(Ordering::Equal),
            Err(_) => Ordering::Less,
        },
        (Value::String(_), Value::Number(_)) => comparar_valores(b, a).reverse(),
        _ => a.to_string().cmp(&b.to_string()),
    }
}

/// Compara el valor de la fila con el literal del filtro (texto).
fn comparar_con_literal(v: &Value, lit: &str) -> Option<Ordering> {
    match v {
        Value::Null => None,
        Value::Number(n) => {
            let f: f64 = lit.parse().ok()?;
            n.as_f64()?.partial_cmp(&f)
        }
        Value::Bool(b) => {
            let l = match lit {
                "true" | "t" => true,
                "false" | "f" => false,
                _ => return None,
            };
            Some(b.cmp(&l))
        }
        Value::String(s) => Some(s.as_str().cmp(lit)),
        otro => Some(otro.to_string().cmp(&lit.to_string())),
    }
}

fn como_texto(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        otro => Some(otro.to_string()),
    }
}

fn coincide_patron(texto: &str, patron: &str, sin_mayus: bool) -> bool {
    let (t, p): (Vec<char>, Vec<char>) = if sin_mayus {
        (texto.to_lowercase().chars().collect(), patron.to_lowercase().chars().collect())
    } else {
        (texto.chars().collect(), patron.chars().collect())
    };
    // Comodines de PostgREST: * (o %) = cualquier cosa, _ = un caracter.
    fn rec(t: &[char], p: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') | Some('%') => (0..=t.len()).any(|i| rec(&t[i..], &p[1..])),
            Some('_') => !t.is_empty() && rec(&t[1..], &p[1..]),
            Some(c) => t.first() == Some(c) && rec(&t[1..], &p[1..]),
        }
    }
    rec(&t, &p)
}

fn quitar_comillas(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Evalúa una expresión de filtro (`eq.5`, `not.is.null`, `in.(1,2)`).
pub fn cumple(v: &Value, expr: &str) -> bool {
    if let Some(resto) = expr.strip_prefix("not.") {
        return !cumple(v, resto);
    }
    let (op, lit) = expr.split_once('.').unwrap_or((expr, ""));
    match op {
        "eq" => comparar_con_literal(v, lit) == Some(Ordering::Equal),
        "neq" => matches!(comparar_con_literal(v, lit), Some(o) if o != Ordering::Equal),
        "gt" => comparar_con_literal(v, lit) == Some(Ordering::Greater),
        "gte" => matches!(comparar_con_literal(v, lit), Some(Ordering::Greater | Ordering::Equal)),
        "lt" => comparar_con_literal(v, lit) == Some(Ordering::Less),
        "lte" => matches!(comparar_con_literal(v, lit), Some(Ordering::Less | Ordering::Equal)),
        "like" => como_texto(v).map(|t| coincide_patron(&t, lit, false)).unwrap_or(false),
        "ilike" => como_texto(v).map(|t| coincide_patron(&t, lit, true)).unwrap_or(false),
        "is" => match lit {
            "null" => v.is_null(),
            "true" => v == &Value::Bool(true),
            "false" => v == &Value::Bool(false),
            _ => false,
        },
        "in" => {
            let dentro = lit.trim().trim_start_matches('(').trim_end_matches(')');
            partir_nivel0(dentro, ',').iter().any(|item| comparar_con_literal(v, &quitar_comillas(item)) == Some(Ordering::Equal))
        }
        _ => false,
    }
}

/// Evalúa `or=(a.eq.1,b.not.is.null)` (también anidado: `and(...)`, `or(...)`).
fn cumple_logico(fila: &Value, lista: &str, es_or: bool) -> bool {
    let dentro = lista.trim().trim_start_matches('(');
    let dentro = dentro.strip_suffix(')').unwrap_or(dentro);
    let conds = partir_nivel0(dentro, ',');
    let mut res = conds.iter().map(|c| {
        let c = c.trim();
        if let Some(r) = c.strip_prefix("or(").or_else(|| c.strip_prefix("or=(")) {
            cumple_logico(fila, &format!("({}", r), true)
        } else if let Some(r) = c.strip_prefix("and(") {
            cumple_logico(fila, &format!("({}", r), false)
        } else {
            let (col, expr) = c.split_once('.').unwrap_or((c, ""));
            cumple(fila.get(col).unwrap_or(&Value::Null), expr)
        }
    });
    if es_or {
        res.any(|b| b)
    } else {
        res.all(|b| b)
    }
}

// ---------- Esquema ----------

pub fn pk_de(tabla: &str) -> Vec<&'static str> {
    TABLAS.iter().find(|t| t.nombre == tabla).map(|t| t.pk.split(',').filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}

pub fn clave_fila(tabla: &str, fila: &Value) -> String {
    let pk = pk_de(tabla);
    if pk.is_empty() {
        return fila.to_string();
    }
    pk.iter().map(|c| fila.get(*c).map(|v| v.to_string()).unwrap_or_default()).collect::<Vec<_>>().join("|")
}

enum Relacion {
    /// La tabla actual tiene la FK `columna` hacia la tabla embebida → objeto.
    AUno { columna: &'static str },
    /// La tabla embebida tiene la FK `columna` hacia la actual → lista.
    AMuchos { columna: &'static str },
}

fn relacion(desde: &str, hacia: &str) -> Option<Relacion> {
    if let Some(fk) = FKS.iter().find(|f| f.tabla == desde && f.ref_tabla == hacia) {
        return Some(Relacion::AUno { columna: fk.columna });
    }
    FKS.iter().find(|f| f.tabla == hacia && f.ref_tabla == desde).map(|fk| Relacion::AMuchos { columna: fk.columna })
}

// ---------- Select ----------

#[derive(Debug, Clone)]
enum ItemSelect {
    Todo,
    Columna { alias: String, nombre: String },
    Relacion { alias: String, tabla: String, hijos: Vec<ItemSelect> },
}

fn parsear_select(s: &str) -> Vec<ItemSelect> {
    if s.trim().is_empty() {
        return vec![ItemSelect::Todo];
    }
    partir_nivel0(s, ',')
        .into_iter()
        .map(|item| {
            let item = item.trim().to_string();
            if item == "*" {
                return ItemSelect::Todo;
            }
            let (alias, resto) = match item.split_once(':') {
                Some((a, r)) if !a.contains('(') && !r.starts_with(':') => (Some(a.trim().to_string()), r.trim().to_string()),
                _ => (None, item.clone()),
            };
            if let Some(i) = resto.find('(') {
                let nombre = resto[..i].split('!').next().unwrap_or("").trim().to_string();
                let interior = resto[i + 1..].strip_suffix(')').unwrap_or(&resto[i + 1..]);
                ItemSelect::Relacion { alias: alias.unwrap_or_else(|| nombre.clone()), tabla: nombre, hijos: parsear_select(interior) }
            } else {
                let nombre = resto.split("::").next().unwrap_or("").trim().to_string();
                ItemSelect::Columna { alias: alias.unwrap_or_else(|| nombre.clone()), nombre }
            }
        })
        .collect()
}

fn proyectar(tablas: &Tablas, tabla: &str, fila: &Value, items: &[ItemSelect]) -> Value {
    let mut out = Map::new();
    for item in items {
        match item {
            ItemSelect::Todo => {
                if let Some(o) = fila.as_object() {
                    for (k, v) in o {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            ItemSelect::Columna { alias, nombre } => {
                out.insert(alias.clone(), fila.get(nombre).cloned().unwrap_or(Value::Null));
            }
            ItemSelect::Relacion { alias, tabla: hacia, hijos } => {
                let vacio = Vec::new();
                let filas_hacia = tablas.get(hacia).unwrap_or(&vacio);
                let valor = match relacion(tabla, hacia) {
                    Some(Relacion::AUno { columna }) => {
                        let fk = fila.get(columna).cloned().unwrap_or(Value::Null);
                        let pk = pk_de(hacia);
                        let pk = pk.first().copied().unwrap_or("id");
                        if fk.is_null() {
                            Value::Null
                        } else {
                            filas_hacia
                                .iter()
                                .find(|f| f.get(pk).map(|v| comparar_valores(v, &fk) == Ordering::Equal).unwrap_or(false))
                                .map(|f| proyectar(tablas, hacia, f, hijos))
                                .unwrap_or(Value::Null)
                        }
                    }
                    Some(Relacion::AMuchos { columna }) => {
                        let pk = pk_de(tabla);
                        let id = fila.get(pk.first().copied().unwrap_or("id")).cloned().unwrap_or(Value::Null);
                        Value::Array(
                            filas_hacia
                                .iter()
                                .filter(|f| f.get(columna).map(|v| !v.is_null() && comparar_valores(v, &id) == Ordering::Equal).unwrap_or(false))
                                .map(|f| proyectar(tablas, hacia, f, hijos))
                                .collect(),
                        )
                    }
                    None => Value::Null,
                };
                out.insert(alias.clone(), valor);
            }
        }
    }
    Value::Object(out)
}

// ---------- Filtros y orden ----------

/// Filtra las filas de la tabla según los parámetros de filtro de la query
/// (ignora select/order/limit/offset y los parámetros de escritura).
pub fn filtrar<'a>(filas: &'a [Value], params: &[(String, String)]) -> Vec<&'a Value> {
    filas.iter().filter(|f| cumple_filtros(f, params)).collect()
}

pub fn cumple_filtros(fila: &Value, params: &[(String, String)]) -> bool {
    params.iter().all(|(k, v)| match k.as_str() {
        "select" | "order" | "limit" | "offset" | "on_conflict" | "columns" => true,
        "or" => cumple_logico(fila, v, true),
        "and" => cumple_logico(fila, v, false),
        col if col.contains('.') => true, // filtros sobre relaciones embebidas: no se usan
        col => cumple(fila.get(col).unwrap_or(&Value::Null), v),
    })
}

fn ordenar(filas: &mut [&Value], orden: &str) {
    let criterios: Vec<(String, bool, Option<bool>)> = orden
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|c| {
            let partes: Vec<&str> = c.trim().split('.').collect();
            let desc = partes.contains(&"desc");
            let nulls_first = if partes.contains(&"nullsfirst") {
                Some(true)
            } else if partes.contains(&"nullslast") {
                Some(false)
            } else {
                None
            };
            (partes[0].to_string(), desc, nulls_first)
        })
        .collect();
    filas.sort_by(|a, b| {
        for (col, desc, nf) in &criterios {
            let va = a.get(col).unwrap_or(&Value::Null);
            let vb = b.get(col).unwrap_or(&Value::Null);
            // Postgres: ASC deja los NULL al final, DESC al principio.
            let nulls_first = nf.unwrap_or(*desc);
            let o = match (va.is_null(), vb.is_null()) {
                (true, true) => Ordering::Equal,
                (true, false) => {
                    if nulls_first {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    }
                }
                (false, true) => {
                    if nulls_first {
                        Ordering::Greater
                    } else {
                        Ordering::Less
                    }
                }
                _ => {
                    let o = comparar_valores(va, vb);
                    if *desc {
                        o.reverse()
                    } else {
                        o
                    }
                }
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });
}

/// Responde un GET `/tabla?query` con los datos locales.
pub fn seleccionar(tablas: &Tablas, tabla: &str, query: &str) -> Vec<Value> {
    let params = parametros(query);
    let vacio = Vec::new();
    let filas = tablas.get(tabla).unwrap_or(&vacio);
    let mut elegidas = filtrar(filas, &params);
    if let Some((_, o)) = params.iter().find(|(k, _)| k == "order") {
        ordenar(&mut elegidas, o);
    }
    let offset: usize = params.iter().find(|(k, _)| k == "offset").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let limit: usize = params.iter().find(|(k, _)| k == "limit").and_then(|(_, v)| v.parse().ok()).unwrap_or(usize::MAX);
    let items = parsear_select(params.iter().find(|(k, _)| k == "select").map(|(_, v)| v.as_str()).unwrap_or("*"));
    elegidas.into_iter().skip(offset).take(limit).map(|f| proyectar(tablas, tabla, f, &items)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn datos() -> Tablas {
        let mut t = Tablas::new();
        t.insert("propietarios".into(), vec![json!({"id":1,"nombre":"Ana"}), json!({"id":2,"nombre":"beto"})]);
        t.insert("inmuebles".into(), vec![json!({"id":10,"propietario_id":1,"direccion":"Mitre 1"}), json!({"id":11,"propietario_id":2,"direccion":"Álamo 3"})]);
        t.insert(
            "contratos".into(),
            vec![
                json!({"id":5,"inmueble_id":10,"inquilino_id":7,"estado":"activo","numero":null}),
                json!({"id":6,"inmueble_id":11,"inquilino_id":7,"estado":"finalizado","numero":3}),
            ],
        );
        t.insert("inquilinos".into(), vec![json!({"id":7,"nombre":"Carla","dni_frente":null,"dni_dorso":"x"})]);
        t.insert("actualizaciones".into(), vec![json!({"id":1,"contrato_id":5,"monto_nuevo":100.0})]);
        t
    }

    #[test]
    fn embebe_y_filtra() {
        let r = seleccionar(&datos(), "contratos", "estado=eq.activo&select=id,inmuebles(direccion,propietarios(nombre)),inquilinos(nombre),actualizaciones(monto_nuevo)");
        assert_eq!(r, vec![json!({"id":5,"inmuebles":{"direccion":"Mitre 1","propietarios":{"nombre":"Ana"}},"inquilinos":{"nombre":"Carla"},"actualizaciones":[{"monto_nuevo":100.0}]})]);
    }

    #[test]
    fn ordena_con_nulls_y_acentos() {
        let r = seleccionar(&datos(), "contratos", "select=numero&order=numero.desc&limit=1");
        assert_eq!(r, vec![json!({"numero":null})]);
        let r = seleccionar(&datos(), "contratos", "select=numero&order=numero.desc.nullslast&limit=1");
        assert_eq!(r, vec![json!({"numero":3})]);
        let r = seleccionar(&datos(), "inmuebles", "select=direccion&order=direccion");
        assert_eq!(r[0]["direccion"], "Álamo 3");
    }

    #[test]
    fn or_in_y_not() {
        let r = seleccionar(&datos(), "inquilinos", "select=id&or=(dni_frente.not.is.null,dni_dorso.not.is.null)");
        assert_eq!(r.len(), 1);
        let r = seleccionar(&datos(), "contratos", "id=in.(5,99)&select=id");
        assert_eq!(r, vec![json!({"id":5})]);
        let r = seleccionar(&datos(), "propietarios", "nombre=ilike.*BE*&select=id");
        assert_eq!(r, vec![json!({"id":2})]);
    }
}
