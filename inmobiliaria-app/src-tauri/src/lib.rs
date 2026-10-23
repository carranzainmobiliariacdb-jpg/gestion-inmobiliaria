mod commands;
mod bcra;
mod config;
mod icl;
mod ipc;
mod models;
mod servicios;
mod carga;
mod pdf;
mod dolar;
mod supabase;

pub use commands::DbState;
use tauri::Manager;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(DbState(RwLock::new(None)));
            app.manage(servicios::ServiciosState::default());
            Ok(())
        })
        .invoke_handler(manejador())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Todos los comandos que el frontend puede invocar. Separado de `run()` para
/// poder reutilizarlo en el puente de pruebas (examples/puente_pruebas.rs).
pub fn manejador<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::hay_configuracion_conexion,
        commands::configurar_conexion,
        commands::obtener_version,
        commands::revisar_actualizaciones,
        commands::maximizar_ventana,
        commands::minimizar_ventana,
        commands::cerrar_ventana,
        commands::leer_credenciales_guardadas,
        commands::guardar_credenciales,
        commands::borrar_credenciales,
        commands::get_propietarios,
        commands::guardar_propietario,
        commands::eliminar_propietario,
        commands::get_inquilinos,
        commands::guardar_inquilino,
        commands::eliminar_inquilino,
        commands::get_garantes,
        commands::guardar_garante,
        commands::eliminar_garante,
        commands::get_fotos_dni,
        commands::get_inmuebles,
        commands::guardar_inmueble,
        commands::eliminar_inmueble,
        commands::get_contratos,
        commands::guardar_contrato,
        commands::eliminar_contrato,
        commands::get_actualizaciones,
        commands::agregar_actualizacion,
        commands::eliminar_actualizacion,
        commands::get_pagos,
        commands::registrar_pago,
        commands::registrar_pagos,
        commands::eliminar_pago,
        commands::get_recibo,
        commands::get_liquidaciones,
        commands::generar_liquidacion,
        commands::eliminar_liquidacion,
        commands::get_comprobante,
        commands::get_dashboard,
        commands::estimar_actualizacion_icl,
        commands::confirmar_actualizacion_icl,
        commands::base_actualizada,
        commands::consultar_bcra,
        commands::guardar_bcra,
        commands::get_modelos,
        commands::guardar_modelo,
        commands::eliminar_modelo,
        commands::get_documentos,
        commands::get_documento,
        commands::guardar_documento,
        commands::eliminar_documento,
        commands::abrir_en_word,
        commands::get_fotos_inmueble,
        commands::get_foto_inmueble,
        commands::get_fotos_inmueble_completas,
        commands::guardar_foto_inmueble,
        commands::eliminar_foto_inmueble,
        commands::get_configuracion,
        commands::guardar_configuracion,
        commands::get_ipc,
        commands::guardar_ipc_manual,
        commands::eliminar_ipc_manual,
        commands::registrar_recordatorio,
        commands::get_recordatorios,
        commands::abrir_enlace,
        commands::hay_usuarios,
        commands::get_usuarios,
        commands::crear_usuario,
        commands::eliminar_usuario,
        commands::iniciar_sesion,
        servicios::servicio_revisar,
        servicios::servicio_estado,
        servicios::servicio_mostrar,
        servicios::servicio_cerrar,
        servicios::get_servicios_estado,
        servicios::guardar_servicios_estado,
        carga::importar_carga_inicial,
        pdf::generar_pdf,
        pdf::copiar_pdf_portapapeles,
        pdf::guardar_pdf,
        pdf::carpeta_pdfs_por_defecto,
        pdf::mostrar_en_carpeta,
        pdf::abrir_pdf,
        pdf::elegir_carpeta,
        pdf::pegar_pdf_whatsapp,
        dolar::cotizacion_dolar,
    ]
}

/// Estado ya conectado a una API PostgREST dada (solo para el puente de pruebas).
#[doc(hidden)]
pub fn estado_para_pruebas(base_rest: String, anon_key: String) -> DbState {
    DbState(RwLock::new(Some(supabase::Cliente::con_base_completa(base_rest, anon_key))))
}
