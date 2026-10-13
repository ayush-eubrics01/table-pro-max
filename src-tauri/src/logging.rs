//! Local diagnostic logging. Every line passes through secret redaction before it is
//! written. Logs never leave the machine.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

/// Log files larger than this are truncated at startup.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone)]
struct RedactingFile(Arc<Mutex<File>>);

struct LineWriter(Arc<Mutex<File>>);

impl Write for LineWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let clean = tpm_core::redact::redact(&text);
        if let Ok(mut f) = self.0.lock() {
            f.write_all(clean.as_bytes())?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(mut f) = self.0.lock() {
            f.flush()?;
        }
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for RedactingFile {
    type Writer = LineWriter;
    fn make_writer(&'a self) -> Self::Writer {
        LineWriter(self.0.clone())
    }
}

/// Installs the global subscriber. `level` is an `EnvFilter` directive such as "info";
/// the `TPM_LOG` environment variable overrides it.
pub fn init(log_dir: &Path, level: &str) {
    let _ = std::fs::create_dir_all(log_dir);
    let path = log_dir.join("table-pro-max.log");
    let truncate = std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    let file = OpenOptions::new().create(true).append(!truncate).write(true).truncate(truncate).open(&path);
    let filter = EnvFilter::try_from_env("TPM_LOG").unwrap_or_else(|_| EnvFilter::new(level));
    match file {
        Ok(f) => {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(RedactingFile(Arc::new(Mutex::new(f))))
                .try_init();
        }
        Err(_) => {
            let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
        }
    }
}
