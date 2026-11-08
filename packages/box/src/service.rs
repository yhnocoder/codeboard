//! The service: one per user and data folder, a socket in front of one Index (box-core: the index's lock file keeps a second
//! one out). It listens on a local socket only the user can use (a token file clients send first; no TCP port). Requests
//! and answers are lines of JSON (PROTOCOL.md); everything but hello is the index's. The service exits after `idle` with
//! no connections.

use crate::paths::Paths;
use box_core::index::{Index, OpenError, Reply};
use interprocess::local_socket::{ListenerNonblockingMode, ListenerOptions, prelude::*};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const VERSION: &str = box_core::VERSION;
/// Without connections for this long, the service exits
pub const IDLE: Duration = Duration::from_secs(600);
/// The pause after a failed accept before the next
const ACCEPT_RETRY: Duration = Duration::from_millis(100);
/// The longest line read before hello (a connection that has not said the token yet)
const HELLO_LINE_MAX: u64 = 64 << 10;
/// The longest request (a sync of a large project with its images is the biggest)
const LINE_MAX: u64 = 512 << 20;

pub enum Outcome {
    /// Another service holds the data folder
    AlreadyRunning,
    /// Exited after being idle
    Stopped,
}

fn private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The token in the data folder, made once (random, readable only by the user)
fn token(paths: &Paths) -> std::io::Result<String> {
    if let Ok(t) = std::fs::read_to_string(&paths.token) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
    }
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| std::io::Error::other(e.to_string()))?;
    let t: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let tmp = paths.token.with_extension("tmp");
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(t.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &paths.token)?;
    Ok(t)
}

/// Runs the service for this data folder until it is idle for `idle`
pub fn serve(paths: Paths, idle: Duration) -> std::io::Result<Outcome> {
    private_dir(&paths.home)?;
    let index = match Index::open(&paths.home) {
        Ok(i) => i,
        Err(OpenError::Locked) => return Ok(Outcome::AlreadyRunning),
        Err(OpenError::Other(e)) => return Err(std::io::Error::other(e)),
    };
    let svc = Arc::new(Service {
        token: token(&paths)?,
        index,
        live: Mutex::new(Live {
            conns: 0,
            quiet_since: Instant::now(),
            stop: false,
        }),
        quiet: Condvar::new(),
    });

    #[cfg(unix)]
    let _ = std::fs::remove_file(&paths.socket); // a socket file left by a service that died: ours now (we hold the lock)
    let name = socket_name(&paths)?;
    let opts = ListenerOptions::new()
        .name(name)
        .nonblocking(ListenerNonblockingMode::Neither);
    // Unix: the socket sits in the data folder, which only the user can enter (private_dir, 0700), so no one else can
    // reach it. Not ListenerOptions::mode: macOS refuses it, and the service would never listen
    // Windows: only the user who started the service may open the pipe (the owner; no one else, not even other admins'
    // default access)
    #[cfg(windows)]
    let opts = {
        use interprocess::os::windows::{local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor};
        let sddl =
            widestring::U16CString::from_str("D:P(A;;GA;;;OW)").map_err(|e| std::io::Error::other(e.to_string()))?;
        opts.security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
    };
    let listener = opts
        .create_sync()
        .inspect_err(|e| svc.index.log(&format!("listen on {}: {e}", paths.socket)))?;
    // The listener blocks in accept and nothing polls: an idle service sleeps until a client connects or `idle` is up
    // (a watchdog waits for that on a condition variable, then connects once itself to wake accept)
    let watchdog = {
        let s = svc.clone();
        let name = socket_name(&paths)?;
        std::thread::spawn(move || {
            s.wait_idle(idle);
            if let Err(e) = interprocess::local_socket::Stream::connect(name) {
                s.index.log(&format!("idle: waking the listener: {e}"));
            }
        })
    };
    loop {
        match listener.accept() {
            Ok(conn) => {
                {
                    let mut live = svc.live.lock().unwrap_or_else(|p| p.into_inner());
                    if live.stop {
                        break;
                    }
                    live.conns += 1;
                }
                // macOS (BSD) hands out accepted sockets non-blocking when the listener is; Linux does not. Each
                // connection has its own thread and reads blocking
                if let Err(e) = conn.set_nonblocking(false) {
                    svc.index.log(&format!("accept: {e}"));
                    svc.closed();
                    continue;
                }
                let s = svc.clone();
                std::thread::spawn(move || {
                    s.connection(conn);
                    s.closed();
                });
            }
            Err(e) => {
                svc.index.log(&format!("accept: {e}"));
                if svc.live.lock().unwrap_or_else(|p| p.into_inner()).stop {
                    break;
                }
                std::thread::sleep(ACCEPT_RETRY); // a failing accept does not spin
            }
        }
    }
    let _ = watchdog.join();
    drop(listener);
    #[cfg(unix)]
    let _ = std::fs::remove_file(&paths.socket);
    svc.index.log("idle: exit");
    Ok(Outcome::Stopped)
}

pub fn socket_name(paths: &Paths) -> std::io::Result<interprocess::local_socket::Name<'static>> {
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        paths
            .socket
            .trim_start_matches(r"\\.\pipe\")
            .to_string()
            .to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        std::path::PathBuf::from(&paths.socket).to_fs_name::<GenericFilePath>()
    }
}

pub struct Service {
    index: Index,
    token: String,
    live: Mutex<Live>,
    /// Signalled when the last connection closes
    quiet: Condvar,
}

/// The connections the service has, and since when it has had none
struct Live {
    conns: usize,
    quiet_since: Instant,
    /// The watchdog found the service idle: the listener takes no more connections
    stop: bool,
}

impl Service {
    /// One connection closed
    fn closed(&self) {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        live.conns -= 1;
        if live.conns == 0 {
            live.quiet_since = Instant::now();
            self.quiet.notify_all();
        }
    }

    /// Returns once the service has had no connection for `idle`, having stopped the listener taking more. Sleeps
    /// while there are connections and until the quiet time is up otherwise; wakes for nothing else
    fn wait_idle(&self, idle: Duration) {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if live.conns > 0 {
                live = self.quiet.wait(live).unwrap_or_else(|p| p.into_inner());
                continue;
            }
            let left = idle.saturating_sub(live.quiet_since.elapsed());
            if left.is_zero() {
                live.stop = true;
                return;
            }
            live = self.quiet.wait_timeout(live, left).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    fn connection(&self, conn: interprocess::local_socket::Stream) {
        let mut reader = BufReader::new(&conn);
        let mut writer = &conn;
        let mut line = String::new();
        let mut hello = false;
        loop {
            line.clear();
            let cap = if hello { LINE_MAX } else { HELLO_LINE_MAX };
            match (&mut reader).take(cap + 1).read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(n) if n as u64 > cap => {
                    let _ = writeln!(
                        writer,
                        "{}",
                        json!({ "id": null, "error": format!("request over {cap} bytes") })
                    );
                    return;
                }
                Ok(_) => {}
            }
            let req: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let _ = writeln!(writer, "{}", json!({ "id": null, "error": format!("not JSON: {e}") }));
                    continue;
                }
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
            let op = op.as_str();
            let reply: Reply = if !hello {
                if op == "hello" && req.get("token").and_then(Value::as_str) == Some(self.token.as_str()) {
                    hello = true;
                    Ok(json!({ "version": VERSION, "pid": std::process::id() }))
                } else {
                    Err("say hello with the token first".into())
                }
            } else {
                self.request(op, req)
            };
            let out = match reply {
                Ok(r) => json!({ "id": id, "result": r }),
                Err(e) => json!({ "id": id, "error": e }),
            };
            if writeln!(writer, "{out}").is_err() {
                return;
            }
            if !hello {
                return;
            }
        }
    }

    fn request(&self, op: &str, req: Value) -> Reply {
        match op {
            "hello" => Ok(json!({ "version": VERSION, "pid": std::process::id() })),
            _ => self.index.request(op, req),
        }
    }
}
