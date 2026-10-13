# Dependency licenses

The project is MIT licensed. Every direct dependency uses a permissive license. Regenerate
the Rust inventory with `cargo metadata --format-version 1` (see the snippet at the end) and
check the npm packages' `license` fields before each release.

## Rust (direct dependencies)

| Crate | Version | License | Source | Purpose |
|---|---|---|---|---|
| tauri, tauri-build | 2.12 / 2.7 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri | Desktop shell |
| tauri-plugin-dialog | 2.8 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace | Native file dialogs |
| tokio, tokio-util | 1.53 / 0.7 | MIT | github.com/tokio-rs/tokio | Async runtime |
| tokio-postgres | 0.7.18 | MIT OR Apache-2.0 | github.com/rust-postgres/rust-postgres | PostgreSQL driver |
| tokio-postgres-rustls | 0.14 | MIT | github.com/jbg/tokio-postgres-rustls | PostgreSQL TLS |
| mysql_async | 0.37 | MIT OR Apache-2.0 | github.com/blackbeam/mysql_async | MySQL/MariaDB driver |
| rusqlite (bundled SQLite) | 0.40 | MIT (SQLite: public domain) | github.com/rusqlite/rusqlite | SQLite driver and metadata store |
| rustls, rustls-native-certs | 0.23 / 0.8 | Apache-2.0 OR ISC OR MIT | github.com/rustls | TLS |
| sqlparser | 0.63 | Apache-2.0 | github.com/apache/datafusion-sqlparser-rs | Statement classification |
| keyring | 4.2 | MIT OR Apache-2.0 | github.com/open-source-cooperative/keyring-rs | OS credential stores |
| serde, serde_json | 1.x | MIT OR Apache-2.0 | github.com/serde-rs | Serialization |
| thiserror, async-trait | 2.x / 0.1 | MIT OR Apache-2.0 | github.com/dtolnay | Errors, async traits |
| tracing, tracing-subscriber | 0.1 / 0.3 | MIT | github.com/tokio-rs/tracing | Logging |
| url, percent-encoding | 2.x | MIT OR Apache-2.0 | github.com/servo/rust-url | URL parsing |
| uuid | 1.x | Apache-2.0 OR MIT | github.com/uuid-rs/uuid | IDs |
| chrono | 0.4 | MIT OR Apache-2.0 | github.com/chronotope/chrono | Timestamps |
| csv | 1.4 | Unlicense OR MIT | github.com/BurntSushi/rust-csv | CSV (import/export) |
| rust_xlsxwriter | 0.99 | MIT OR Apache-2.0 | github.com/jmcnamara/rust_xlsxwriter | XLSX export |
| russh (ring backend) | 0.64 | Apache-2.0 | github.com/warp-tech/russh | SSH tunnels |
| reqwest (rustls, no default provider) | 0.13 | MIT OR Apache-2.0 | github.com/seanmonstar/reqwest | HTTPS client for optional AI |
| redis | 1.7 | BSD-3-Clause | github.com/redis-rs/redis-rs | Redis client |
| duckdb (bundled engine) | 1.10506 | MIT (DuckDB: MIT) | github.com/duckdb/duckdb-rs | DuckDB driver |
| hex, bytes, futures-util | — | MIT / MIT OR Apache-2.0 | — | Utilities |

### Transitive licenses worth noting
* **MPL-2.0** (file-level weak copyleft): `cssparser`, `cssparser-macros`, `selectors`,
  `dtoa-short`, `option-ext`. These come in through Tauri/wry. We distribute them unmodified,
  which MPL-2.0 permits in a differently licensed work. Their source stays available upstream.
* **CDLA-Permissive-2.0**: `webpki-roots` (Mozilla root certificates, used by mysql_async).
* **Unicode-3.0**: ICU data crates (`idna`).
* `r-efi` offers MIT OR Apache-2.0 OR LGPL; we use it under MIT/Apache.

## JavaScript (runtime dependencies)

| Package | License |
|---|---|
| react, react-dom | MIT |
| @tauri-apps/api, @tauri-apps/plugin-dialog | Apache-2.0 OR MIT |
| codemirror, @codemirror/* , @lezer/highlight | MIT |
| @tanstack/react-virtual | MIT |
| zustand | MIT |
| sql-formatter | MIT |
| lucide-react | ISC |
| @fontsource/ibm-plex-sans, @fontsource/ibm-plex-mono | OFL-1.1 (fonts bundled locally) |

Dev dependencies (Vite, Vitest, TypeScript, ESLint, Testing Library, jsdom) are MIT,
Apache-2.0 or BSD and are not shipped in the app bundle.

## Regenerating the Rust inventory
```sh
cargo metadata --format-version 1 | python3 -c '
import json,sys; m=json.load(sys.stdin)
for p in sorted(m["packages"], key=lambda p: p["name"]): print(p["name"], p["version"], p.get("license"))'
```
