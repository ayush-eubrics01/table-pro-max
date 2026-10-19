//! rustls client configuration shared by the network drivers.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::config::{TlsConfig, TlsMode};
use crate::error::{AppError, ErrorKind, Result};

/// CA bundles larger than this are rejected rather than read into memory.
const MAX_CA_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Makes ring rustls's process-wide default. Drivers that build their own TLS from that default
/// (tiberius, mongodb) then use the same crypto as the rest of the app; AWS-LC is compiled in
/// through tiberius's dependencies, and with two providers rustls would pick neither.
pub(crate) fn install_process_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub(crate) fn client_config(tls: &TlsConfig) -> Result<ClientConfig> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::new(ErrorKind::Tls, "Failed to initialise TLS").with_detail(e.to_string()))?;

    let config = if tls.mode == TlsMode::RequireInsecure {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification {
                algorithms: provider.signature_verification_algorithms,
            }))
            .with_no_client_auth()
    } else {
        builder.with_root_certificates(root_store(tls)?).with_no_client_auth()
    };
    Ok(config)
}

fn root_store(tls: &TlsConfig) -> Result<RootCertStore> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // Individual unparsable system certificates are skipped, as browsers do.
        let _ = roots.add(cert);
    }
    if let Some(path) = tls.ca_cert_path.as_deref().filter(|p| !p.trim().is_empty()) {
        let meta = std::fs::metadata(path)
            .map_err(|e| AppError::new(ErrorKind::Tls, format!("Cannot read CA certificate file: {e}")))?;
        if meta.len() > MAX_CA_FILE_BYTES {
            return Err(AppError::new(ErrorKind::Tls, "CA certificate file is too large"));
        }
        let pem = std::fs::read(path)?;
        let mut added = 0;
        for cert in CertificateDer::pem_slice_iter(&pem) {
            let cert = cert
                .map_err(|e| AppError::new(ErrorKind::Tls, "Invalid CA certificate file").with_detail(e.to_string()))?;
            roots
                .add(cert)
                .map_err(|e| AppError::new(ErrorKind::Tls, "Invalid CA certificate").with_detail(e.to_string()))?;
            added += 1;
        }
        if added == 0 {
            return Err(AppError::new(ErrorKind::Tls, "The CA certificate file contains no PEM certificates"));
        }
    }
    if roots.is_empty() {
        return Err(AppError::new(
            ErrorKind::Tls,
            "No trusted root certificates were found. Provide a CA certificate file.",
        ));
    }
    Ok(roots)
}

/// Accepts any server certificate while still checking handshake signatures. Only used
/// for the explicitly selected "require (no verification)" mode.
#[derive(Debug)]
struct NoCertificateVerification {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
