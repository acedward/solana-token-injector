// midnight-esk-decrypt: JSON lines on stdin -> JSON lines on stdout (protocol I-1).
// Logs go to stderr only and never contain a viewing key.

use midnight_esk_decrypt::protocol::Session;
use std::io::{self, BufRead, BufWriter, Write};

fn main() {
    // A panic inside a request is caught per request (protocol.rs). Replace the default hook so
    // the log line carries only the location, never a payload built from request data.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        eprintln!("midnight-esk-decrypt: panic caught at {location}");
    }));

    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "midnight-esk-decrypt {} (ledger {})",
            env!("CARGO_PKG_VERSION"),
            midnight_esk_decrypt::LEDGER_VERSION
        );
        return;
    }

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut session = Session::new();
    let mut buf = Vec::new();

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("midnight-esk-decrypt: cannot read stdin: {error}");
                break;
            }
        }

        let response = match std::str::from_utf8(&buf) {
            Ok(line) => session.handle_line(line),
            Err(_) => Some(
                r#"{"id":null,"ok":false,"error":"malformed request: line is not valid UTF-8"}"#
                    .to_string(),
            ),
        };

        if let Some(response) = response {
            if writeln!(writer, "{response}").and_then(|_| writer.flush()).is_err() {
                // stdout closed: the parent is gone.
                break;
            }
        }
    }
}
