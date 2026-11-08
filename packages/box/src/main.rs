//! box serve [--idle <seconds>]: run the service for this user's data folder (BOX_HOME overrides it) until idle
//! box home: the data folder's paths as JSON (what a client connects to and reads the token from)
use boxlib::{paths, service};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let p = paths::paths(&paths::home());
    match args.first().map(String::as_str) {
        Some("home") => println!(
            "{}",
            serde_json::json!({ "home": p.home, "socket": p.socket, "token": p.token, "version": service::VERSION })
        ),
        Some("serve") => {
            let idle = args
                .iter()
                .position(|a| a == "--idle")
                .and_then(|i| args.get(i + 1))
                .and_then(|s| s.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(service::IDLE);
            match service::serve(p, idle) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("box: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some("--version") => println!("box {}", service::VERSION),
        _ => {
            eprintln!("usage: box serve [--idle <seconds>] | box home | box --version");
            std::process::exit(2);
        }
    }
}
