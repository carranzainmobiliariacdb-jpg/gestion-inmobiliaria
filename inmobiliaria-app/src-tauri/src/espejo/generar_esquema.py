import subprocess, json
def q(sql):
    out = subprocess.run(["su","postgres","-c",f"psql -d inmo -At -F'|' -c \"{sql}\""],capture_output=True,text=True).stdout
    return [l.split("|") for l in out.strip().splitlines() if l]
cols = q("select table_name, column_name, coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name in (select tablename from pg_tables where schemaname='public') order by table_name, ordinal_position")
fks = q("select c.conrelid::regclass::text, a.attname, c.confrelid::regclass::text, c.confdeltype from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1] where c.contype='f' order by 1,2")
pks = q("select c.conrelid::regclass::text, string_agg(a.attname, ',' order by array_position(c.conkey,a.attnum)) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey) where c.contype='p' group by 1,c.oid order by 1")
uqs = q("select c.conrelid::regclass::text, string_agg(a.attname, ',' order by array_position(c.conkey,a.attnum)) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey) where c.contype='u' group by 1,c.oid order by 1")
def dflt(d):
    if not d or d.startswith("nextval"): return "Defecto::Nada" if not d else "Defecto::Serial"
    if d in ("now()","CURRENT_TIMESTAMP"): return "Defecto::Ahora"
    if d=="CURRENT_DATE": return "Defecto::Hoy"
    if "::" in d: d=d.split("::")[0]
    return f"Defecto::Json(r#\"{json.dumps(json.loads(d[1:-1]) if d.startswith(chr(39)+'[') else (d[1:-1] if d.startswith(chr(39)) else json.loads(d)))}\"#)"
tablas={}
for t,c,d in cols: tablas.setdefault(t,[]).append((c,dflt(d)))
o=["// GENERADO a partir del esquema de la base (supabase-schema.sql + migraciones).","// Si una migración agrega columnas/tablas, regenerarlo o agregarlas a mano.","use super::{Columna, Defecto, Fk, Tabla};","",
   "pub static TABLAS: &[Tabla] = &["]
pkd={t:p for t,p in pks}; uqd={}
for t,u in uqs: uqd.setdefault(t,[]).append(u)
for t,cs in tablas.items():
    o.append(f"    Tabla {{ nombre: \"{t}\", pk: \"{pkd.get(t,'')}\", unicas: &{json.dumps(uqd.get(t,[]))}, columnas: &[")
    for c,d in cs: o.append(f"        Columna {{ nombre: \"{c}\", defecto: {d} }},")
    o.append("    ] },")
o.append("];\n\npub static FKS: &[Fk] = &[")
for t,c,r,dt in fks: o.append(f"    Fk {{ tabla: \"{t}\", columna: \"{c}\", ref_tabla: \"{r}\", al_borrar: '{dt}' }},")
o.append("];")
print("\n".join(o))
