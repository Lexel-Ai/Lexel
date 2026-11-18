use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use lexel_db::{default_data_dir, default_db_path, default_models_dir, default_token_path};
use tokio::net::TcpListener;
use tracing::{error, info};

use lexel_daemon::http::build_router;
use lexel_daemon::native_messaging::{install_native_hosts, run_stdio_loop};
use lexel_daemon::service::DaemonService;

pub const DEFAULT_HTTP_PORT: u16 = 42424;

#[derive(Debug, Parser)]
#[command(
    name = "lexel-daemon",
    version,
    about = "Lexel local AI and unified profile daemon"
)]
struct Cli {
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[arg(long, global = true)]
    models_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Start the local loopback HTTP service with Bearer token and strict Origin protection.
    Serve {
        #[arg(long, default_value_t = DEFAULT_HTTP_PORT)]
        port: u16,
    },
    /// Run Chrome/Firefox Native Messaging stdio JSON IPC loop.
    NativeMessaging,
    /// Install Chrome, Chromium, Brave, and Firefox Native Messaging manifests.
    InstallNativeHost {
        #[arg(long = "extension-id")]
        extension_ids: Vec<String>,
    },
    /// Set the active profile's main AI model (0.5b, 1.5b, or custom).
    SetMainModel { model: String },
    /// Print (or create) the local Bearer token used to pair Lexel Lab or CLI tools.
    Token,
    /// Print daemon, model, and active profile status as JSON.
    Status,
}

fn should_auto_enter_native_messaging() -> bool {
    std::env::args().skip(1).any(|arg| {
        arg.starts_with("chrome-extension://")
            || arg.starts_with("moz-extension://")
            || arg.ends_with("com.lexel.daemon.json")
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();

    if should_auto_enter_native_messaging() {
        let data_dir = default_data_dir();
        let service = Arc::new(DaemonService::open(
            data_dir.clone(),
            default_db_path(),
            default_models_dir(),
            default_token_path(),
            DEFAULT_HTTP_PORT,
        )?);
        let _ = service.token()?;
        run_stdio_loop(service).await?;
        return Ok(());
    }

    let cli = Cli::parse();
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);
    let db_path = cli.db.unwrap_or_else(|| data_dir.join("lexel.db"));
    let models_dir = cli.models_dir.unwrap_or_else(|| data_dir.join("models"));
    let token_path = data_dir.join("daemon.token");

    let port = match &cli.command {
        Some(Commands::Serve { port }) => *port,
        _ => DEFAULT_HTTP_PORT,
    };

    let service = Arc::new(DaemonService::open(
        data_dir.clone(),
        db_path,
        models_dir,
        token_path,
        port,
    )?);

    match cli.command.unwrap_or(Commands::Serve {
        port: DEFAULT_HTTP_PORT,
    }) {
        Commands::Serve { port } => {
            let token = service.token()?;
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            let listener = TcpListener::bind(addr).await?;
            info!(%addr, token_file = %service.token_path.display(), "lexel-daemon HTTP listening");

            let idle_svc = Arc::clone(&service);
            let idle_task = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(15));
                loop {
                    ticker.tick().await;
                    idle_svc.maybe_idle_unload().await;
                }
            });

            let router = build_router(Arc::clone(&service), token);
            let server = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            });

            if let Err(err) = server.await {
                error!("lexel-daemon HTTP server exited with error: {err}");
            }
            idle_task.abort();
            service.shutdown().await;
        }
        Commands::NativeMessaging => {
            let _ = service.token()?;
            run_stdio_loop(service).await?;
        }
        Commands::InstallNativeHost { extension_ids } => {
            let _ = service.token()?;
            let exe = std::env::current_exe()?;
            let paths = install_native_hosts(&exe, &data_dir, &extension_ids)?;
            for path in paths {
                println!("{}", path.display());
            }
        }
        Commands::SetMainModel { model } => {
            let profile = service.set_main_model_persisted(&model)?;
            println!("{}", serde_json::to_string_pretty(&profile)?);
        }
        Commands::Token => {
            let token = service.token()?;
            println!("{token}");
        }
        Commands::Status => {
            let _ = service.token()?;
            let status = service.status().await?;
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
    }

    Ok(())
}
