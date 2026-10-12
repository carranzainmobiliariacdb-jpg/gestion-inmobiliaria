# Gestión Inmobiliaria

Programa de escritorio para gestión de alquileres: propietarios, inquilinos,
garantes, inmuebles, contratos, ingresos (recibos de alquiler) y egresos
(comprobantes de comisión), con un tablero de control de deudas y
vencimientos.

Hecho con [Tauri](https://tauri.app) (Rust + WebView del sistema) y
[Supabase](https://supabase.com) como base de datos compartida, a la que se
conecta por su **API REST** (igual que cualquier app hecha con el cliente
`supabase-js`) en vez de abrir una conexión directa a Postgres. Todas las
PCs que se conecten al mismo proyecto ven y cargan los mismos datos.

## Qué incluye

- **Tablero**: cobrado y pendiente del mes, deuda vencida (con intereses a
  hoy), lo que falta liquidar a propietarios, contratos por vencer y
  cumpleaños, con botones directos para cobrar o avisar por WhatsApp.
- **Propietarios, inquilinos y garantes**: ficha completa (DNI, CUIL,
  estado civil, profesión, contacto, datos bancarios, tipo de garantía).
  **Carga desde el DNI**: se arrastra, se elige o se pega (Ctrl+V) la foto
  del DNI y se leen apellido, nombres, DNI, sexo y fecha de nacimiento del
  código de barras PDF417 (con [zxing-wasm](https://github.com/Sec-ant/zxing-wasm),
  incluido en `src/vendor`, funciona sin internet); el CUIL se calcula
  solo. También acepta el texto de un lector de códigos USB. Las fotos
  quedan guardadas en la ficha.
- **Inmuebles**: código de propiedad (el que sale en el recibo), dirección,
  características, nomenclatura catastral, cuentas de Rentas y municipal,
  matrícula, números de cliente de luz/agua/gas, llaves.
- **Contratos**: número, partes, garantes, plazo, destino, depósito,
  honorarios de administración, índice de actualización (IPC, ICL, % fijo
  o a mano) y frecuencia, interés y multa por atraso, y conceptos que se
  cobran todos los meses (expensas, servicios…).
- **Cobros y recibos**: el cobro calcula el alquiler vigente del período,
  los días de atraso, intereses y multa (editables), suma conceptos,
  bonificación, recargo y saldo a favor. El recibo replica el modelo de la
  inmobiliaria: A4 apaisado con duplicado y original, monto en letras,
  para imprimir o guardar en PDF.
- **Liquidaciones**: agrupa los recibos cobrados de un propietario,
  descuenta honorarios y gastos (o suma importes a favor) y genera el
  comprobante con los datos para transferir.
- **Aumentos IPC / ICL**: calcula los aumentos que vienen con IPC (INDEC,
  vía datos.gob.ar), ICL (BCRA) o % fijo, y se aplican de a uno o todos
  juntos. Si un mes de IPC todavía no está en la API, se carga a mano en
  Configuración.
- **Avisos por WhatsApp**: recordatorio antes del vencimiento, pagos
  atrasados, aumentos, fin de contrato y cumpleaños. Cada botón abre
  WhatsApp con el mensaje listo y queda registrado quién avisó y cuándo.
  Los mensajes se editan en Configuración.
- **Generar contrato** (botón dorado arriba en el menú): modelos editables
  (vivienda, comercial, fianza, acta de entrega de llaves, o propios pegados
  desde Word) con marcadores `{{inquilino.nombre}}`, `{{contrato.monto_letras}}`,
  etc. que se completan con los datos del contrato. Vista previa editable,
  impresión/PDF y "Abrir en Word" (se guarda en Documentos\Contratos Carranza).
  Los documentos generados quedan guardados para reimprimir.
- **Alerta al iniciar**: contratos que vencen y aumentos que tocan desde hoy
  hasta fin del mes que viene.
- **DNI**: si el código de barras no se lee, se leen las 3 líneas con «<<<»
  del dorso (OCR con [Tesseract.js](https://github.com/naptha/tesseract.js),
  incluido en `src/vendor/tesseract`, sin internet).
- **Fotos del inmueble**: galería por propiedad (entrega, devolución,
  inspección…) y acta de constatación de estado con las fotos para imprimir.
- **Central de Deudores del BCRA** para inquilinos y garantes (API pública
  `api.bcra.gob.ar/CentralDeDeudores/v1.0`), guardando la última consulta.
- **WhatsApp de la inmobiliaria**: los chats se abren en la app de WhatsApp
  de la PC (vinculada con el número de la inmobiliaria como dispositivo),
  mensaje libre a cualquier persona, mensaje a varios (inquilinos activos,
  propietarios, garantes) e historial de mensajes enviados.
- **Configuración** compartida entre PCs: datos de la inmobiliaria, logo y
  numeración del recibo, mensajes de WhatsApp, IPC manual.
- **Login** con usuarios compartidos entre todas las PCs.

## Actualizar la base (una sola vez por versión)

La v0.5.0 agrega los modelos y documentos generados
([`src/migracion-0.5.0.sql`](./src/migracion-0.5.0.sql)). La v0.4.0 agrega la tabla de fotos y la consulta al BCRA
([`src/migracion-0.4.0.sql`](./src/migracion-0.4.0.sql)); la app muestra
las migraciones pendientes juntas con un botón **Copiar**.

### v0.3.0

La v0.3.0 agrega columnas y tablas. La primera vez que se abre, la app
muestra el código SQL con un botón **Copiar**: se pega en Supabase → SQL
Editor → New query → Run (es el archivo
[`src/migracion-0.3.0.sql`](./src/migracion-0.3.0.sql); se puede correr más
de una vez sin problema). Para proyectos nuevos, `supabase-schema.sql` ya lo
incluye.

## Probar sin Windows

`src-tauri/examples/puente_pruebas.rs` corre los comandos reales de la app
(runtime de prueba de Tauri) y los expone por HTTP junto con el frontend,
para probar la interfaz en un navegador contra un PostgREST local. No entra
en el instalador.

## Varias personas, varias PCs

La primera vez que se abre la app en una PC, pide la URL del proyecto de
Supabase y la clave "anon" (ver "Puesta en marcha con Supabase" abajo) y las
guarda en `%APPDATA%\com.inmobiliaria.app\conexion.json`. Cualquier PC que
se conecte con los mismos datos ve y carga los mismos contratos, pagos,
usuarios, etc. — no hace falta configurar nada más por PC.

## Puesta en marcha con Supabase

1. Crear una cuenta y un proyecto gratis en [supabase.com](https://supabase.com).
2. Ir a **SQL Editor** → **New query**, pegar el contenido de
   [`supabase-schema.sql`](./supabase-schema.sql) (en la raíz del
   repositorio) y correrlo. Crea las tablas que usa la app y les da permiso
   a la clave "anon" — es el único paso manual, se hace una sola vez por
   proyecto, no por PC.
3. Ir a **Settings → API** y copiar la **Project URL** y la clave
   **anon public** (no la `service_role`, que tiene permisos de
   administrador y no debería viajar en un instalador).
4. Pegar esos dos datos en la app la primera vez que se abra en cada PC.
5. El primer usuario que se crea queda disponible para cualquier otra PC que
   se conecte después con los mismos datos; desde la sección "Usuarios" se
   pueden cargar las cuentas de todo el equipo.

La clave "anon" está pensada para viajar en el cliente (así la usa
`supabase-js` en cualquier app web) — no es secreta en el mismo sentido que
una contraseña de base de datos. Como el proyecto no usa Row Level Security
(ver `supabase-schema.sql`), cualquiera que tenga esa clave y la URL puede
leer y escribir datos; si en algún momento hace falta revocar el acceso, se
puede rotar la clave desde el panel de Supabase (Settings → API).

## Requisitos para compilar

- [Node.js](https://nodejs.org/) 18 o superior
- [Rust](https://www.rust-lang.org/tools/install) (estable)
- En Windows: Tauri usa el WebView2 del sistema (viene incluido en Windows
  10/11 actualizados) y necesita las "Build Tools for Visual Studio" con el
  workload de C++ (se instalan automáticamente si faltan al compilar, o
  desde https://visualstudio.microsoft.com/visual-cpp-build-tools/).

## Cómo generar el instalador para Windows

Desde una PC con Windows (o siguiendo la guía de compilación cruzada de
Tauri si se compila desde otro sistema):

```bash
npm install
npm run tauri build
```

Al finalizar, los instaladores quedan en:

- `src-tauri/target/release/bundle/nsis/Gestión Inmobiliaria_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Gestión Inmobiliaria_0.1.0_x64_en-US.msi`

Cualquiera de los dos instala el programa normalmente en la PC (acceso
directo, desinstalador, etc.). Los datos viven en Supabase, no en la PC, así
que reinstalar o actualizar la aplicación no los afecta; lo único que queda
guardado localmente son la URL y la clave de conexión (ver "Varias personas,
varias PCs").

## Actualización automática

La app se actualiza sola: al abrirse, revisa en silencio si hay una versión
más nueva publicada en GitHub Releases y, si la hay, la baja, la instala y
reinicia la app — sin que el usuario tenga que hacer nada ni descargar un
instalador a mano. Si no hay internet o no hay versión nueva, sigue
funcionando con la versión que ya tenía instalada.

Para que esto funcione, cada build de CI (`.github/workflows/build-inmobiliaria-windows.yml`)
compila, firma y publica un GitHub Release con el instalador y un
`latest.json` usando [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action).
Eso requiere dos secrets del repo además de los de Supabase:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

(generados una sola vez con `npx tauri signer generate`; la clave pública
correspondiente ya está en `src-tauri/tauri.conf.json`, bajo `plugins.updater.pubkey`).

Para que el updater detecte una versión nueva, hay que subir el número de
versión en `src-tauri/tauri.conf.json` y `src-tauri/Cargo.toml` (y lo ideal
es mantener `package.json` igual) antes de pushear — CI publica un release
nuevo por cada versión distinta.

## Desarrollo

```bash
npm install
npm run tauri dev
```

Esto abre la aplicación en una ventana con recarga automática del frontend
(`src/`). El código está en `src-tauri/src/` (Rust): `supabase.rs` (cliente
REST contra PostgREST), `config.rs` (guardar/leer la URL y clave de
conexión), `models.rs` (estructuras de datos) y `commands.rs` (comandos que
usa la interfaz, incluyendo el cálculo de mora, montos vigentes y el
tablero de control).

`commands.rs` incluye un test de integración (`cargo test --lib
tests_rest`) que corre contra un PostgREST real y valida el cliente REST y
la lógica de negocio más sensible (altas con `Prefer: return=representation`,
upsert con `ignore-duplicates`, joins anidados del contrato, numeración
secuencial, violación de usuario único, `DELETE` restringido por clave
foránea). Se salta solo si no están definidas las variables
`TEST_SUPABASE_URL` y `TEST_SUPABASE_ANON_KEY` (apuntando a un PostgREST de
prueba, no al proyecto real).

## Notas sobre el cálculo de mora y actualizaciones

- La **mora** se calcula como `alquiler vigente × (tasa diaria % / 100) ×
  días de atraso`, tomando como vencimiento el "día de pago" configurado en
  el contrato para el período que se está abonando.
- El **monto vigente** de un contrato en una fecha dada es el monto inicial,
  salvo que exista una actualización registrada con fecha de vigencia
  anterior o igual a esa fecha (se usa la más reciente).
- La **próxima actualización** se calcula sumando la frecuencia configurada
  (en meses) a la fecha de la última actualización registrada, o a la fecha
  de inicio del contrato si todavía no hubo ninguna.

## Actualización automática por índice ICL (BCRA)

Para contratos con tipo de actualización "ICL", el tablero de control agrega
una columna con un botón que consulta en vivo la API pública del BCRA
(`api.bcra.gob.ar/estadisticas/v4.0/monetarias`, variable ICL):

- **Mientras falta más de un mes** para la actualización: el botón "Estimar
  con ICL" compara el valor del índice de hoy contra el valor que tenía
  cuando se fijó el monto actual, y muestra un porcentaje y monto
  **aproximados** (el valor real todavía no existe, porque corresponde a una
  fecha futura).
- **El día de la actualización (o después)**: el botón "Traer valor real ICL"
  consulta el valor del índice publicado exactamente para esa fecha y
  calcula el monto definitivo. Desde ahí se puede aplicar directamente con
  un clic, lo que registra la actualización del contrato sin tipear nada a
  mano.

Esto requiere que la PC tenga conexión a internet en el momento de
consultar; si no hay conexión o el BCRA no responde, se muestra un aviso y
un botón para reintentar. El id de la variable ICL se busca por nombre en el
catálogo del BCRA en cada consulta (por si cambiara con el tiempo); si esa
búsqueda falla, se usa como respaldo el id conocido actualmente (40).

<!-- build 2026-10-12T19:13:46Z -->
