#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if lexel_desktop_lib::should_run_native_messaging_stdio() {
        lexel_desktop_lib::run_headless_native_messaging();
        return;
    }
    lexel_desktop_lib::run();
}
