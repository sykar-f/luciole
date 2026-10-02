//! Inside a network namespace, the child's only way out: 127.0.0.1:<port> relayed to a
//! Unix socket of the host (its egress proxy, which checks hosts; the application's
//! Server). The relay runs in the supervising parent, outside the child's seccomp filter,
//! which refuses the child any Unix socket of its own.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;

/// Listens now (before the child exists, so its first connection finds the port).
pub fn listen(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| io::Error::new(e.kind(), format!("relay 127.0.0.1:{port}: {e}")))
}

fn pipe(mut from: impl Read, mut to: impl Write, close: impl FnOnce()) {
    let _ = io::copy(&mut from, &mut to);
    close();
}

/// Serves `listener` forever, one thread pair per connection.
pub fn serve(listener: TcpListener, socket: PathBuf) {
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let socket = socket.clone();
            thread::spawn(move || {
                let Ok(upstream) = UnixStream::connect(&socket) else {
                    let _ = client.shutdown(Shutdown::Both);
                    return;
                };
                let (Ok(client_in), Ok(upstream_in)) = (client.try_clone(), upstream.try_clone())
                else {
                    return;
                };
                let upstream_out = upstream;
                let client_out: TcpStream = client;
                let up = thread::spawn(move || {
                    pipe(client_in, &upstream_out, || {
                        let _ = upstream_out.shutdown(Shutdown::Write);
                    })
                });
                pipe(upstream_in, &client_out, || {
                    let _ = client_out.shutdown(Shutdown::Write);
                });
                let _ = up.join();
            });
        }
    });
}
