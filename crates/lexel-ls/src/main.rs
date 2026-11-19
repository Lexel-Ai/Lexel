use clap::Parser;
use lexel_ls::LexelLanguageServer;
use tower_lsp_server::{LspService, Server};

#[derive(Parser)]
#[command(
    name = "lexel-ls",
    version,
    about = "Lexel Language Server (LSP) for zero-AI grammar, anti-slop, secrets guard, and team style checks"
)]
struct Args {
    /// Run Language Server Protocol over stdio (default)
    #[arg(long, default_value_t = true)]
    stdio: bool,
}

#[tokio::main]
async fn main() {
    let _args = Args::parse();
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(LexelLanguageServer::new);
    Server::new(stdin, stdout, socket).serve(service).await;
}
