//! Desktop OAuth only. rclone v1.75.1's Drive flow checks state/loopback but
//! has no PKCE; oauth2 supplies state + S256 here. rclone remains token storage
//! and refresh authority after the initial exchange.
use super::{AuthOperation, SCOPE};
use crate::{document_model::ReadError, read_service::plain_file};
use oauth2::{
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, basic::BasicClient,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    time::{Duration, Instant},
};
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub(super) struct Profile {
    pub id: String,
    pub client_id: String,
    pub client_secret: zeroize::Zeroizing<String>,
}
impl Profile {
    pub fn load(path: Option<&Path>) -> Result<Self, ReadError> {
        let default =
            dirs::config_dir().map(|p| p.join("dev.memoka.desktop/google-desktop-client.json"));
        let bytes = if let Some(path) = path.or(default.as_deref().filter(|p| p.exists())) {
            if !path.is_absolute() {
                return Err(invalid_profile());
            }
            for ancestor in path.parent().ok_or_else(invalid_profile)?.ancestors() {
                crate::read_service::checked_directory(ancestor).map_err(|_| invalid_profile())?;
            }
            let meta = plain_file(path).map_err(|_| invalid_profile())?;
            if meta.len() > 65536 {
                return Err(invalid_profile());
            }
            fs::read(path).map_err(|_| invalid_profile())?
        } else if let Some(embedded) = option_env!("MEMOKA_GOOGLE_DESKTOP_CLIENT_JSON") {
            embedded.as_bytes().to_vec()
        } else {
            return Err(ReadError::new(
                "CLOUD_UNCONFIGURED",
                "Google Drive is experimental and disabled until a Memoka Desktop OAuth client file is configured",
            ));
        };
        Self::parse(&bytes)
    }
    fn parse(bytes: &[u8]) -> Result<Self, ReadError> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid_profile())?;
        let client_id = value["installed"]["client_id"]
            .as_str()
            .filter(|v| v.ends_with(".apps.googleusercontent.com") && v.len() < 256)
            .ok_or_else(invalid_profile)?
            .to_string();
        let client_secret = value["installed"]["client_secret"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() < 1024)
            .ok_or_else(invalid_profile)?
            .to_string();
        let id = format!(
            "google-desktop-{}",
            Sha256::digest(client_id.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        Ok(Self {
            id,
            client_id,
            client_secret: zeroize::Zeroizing::new(client_secret),
        })
    }
}
fn invalid_profile() -> ReadError {
    ReadError::new(
        "CLOUD_CLIENT_INVALID",
        "Provide a Google Desktop app client JSON file (installed.client_id and client_secret)",
    )
}
pub(super) fn http_client() -> Result<reqwest::blocking::Client, ReadError> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| ReadError::new("CLOUD_IO", "Cannot create the verified-TLS cloud client"))
}
pub(super) fn authorize(
    profile: &Profile,
    operation: &AuthOperation,
    open_browser: bool,
) -> Result<Value, ReadError> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| {
        ReadError::new(
            "CLOUD_CALLBACK_UNAVAILABLE",
            "Cannot bind the local OAuth callback",
        )
    })?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let client = BasicClient::new(ClientId::new(profile.client_id.clone()))
        .set_client_secret(ClientSecret::new(profile.client_secret.to_string()))
        .set_auth_type(AuthType::RequestBody)
        .set_auth_uri(AuthUrl::new(AUTH_URL.into()).map_err(|_| invalid_profile())?)
        .set_token_uri(TokenUrl::new(TOKEN_URL.into()).map_err(|_| invalid_profile())?)
        .set_redirect_uri(
            RedirectUrl::new(format!("http://127.0.0.1:{port}/callback"))
                .map_err(|_| invalid_profile())?,
        );
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(SCOPE.into()))
        .set_pkce_challenge(challenge)
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .add_extra_param("include_granted_scopes", "false")
        .url();
    operation.phase("waiting-browser")?;
    operation
        .status
        .lock()
        .map_err(|_| super::state_error())?
        .authorization_url = Some(url.to_string());
    if open_browser {
        open_authorization_url(&url)?;
    }
    let began = Instant::now();
    let code = loop {
        operation.check()?;
        if began.elapsed() >= Duration::from_secs(300) {
            return Err(ReadError::new(
                "TIMEOUT",
                "Google authorization expired after five minutes",
            ));
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 1024];
                while bytes.len() <= 8192 && !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                    }
                }
                let response = if bytes.len() <= 8192 {
                    parse_callback(&bytes, state.secret(), port)
                } else {
                    Err(ReadError::new("CLOUD_CALLBACK_INVALID", "Invalid callback"))
                };
                let ok = response.is_ok();
                let message = if ok {
                    "Authorization received. You can return to Memoka."
                } else {
                    "This callback was not accepted. Return to Memoka to retry or cancel."
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    if ok { "200 OK" } else { "400 Bad Request" },
                    message.len(),
                    message
                );
                match response {
                    Ok(code) => break code,
                    Err(error) if error.code == "CLOUD_AUTH_DENIED" => return Err(error),
                    _ => continue,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25))
            }
            Err(_) => {
                return Err(ReadError::new(
                    "CLOUD_CALLBACK_UNAVAILABLE",
                    "OAuth callback listener stopped",
                ));
            }
        }
    };
    operation.check()?;
    operation.phase("exchanging")?;
    let http = http_client()?;
    let transport = |request: oauth2::HttpRequest| -> Result<oauth2::HttpResponse, std::io::Error> {
        let fail = || std::io::Error::other("OAuth transport failed");
        let (parts, body) = request.into_parts();
        let response = http
            .request(parts.method, parts.uri.to_string())
            .headers(parts.headers)
            .body(body)
            .send()
            .map_err(|_| fail())?;
        let mut output = oauth2::HttpResponse::new(Vec::new());
        *output.status_mut() = response.status();
        *output.headers_mut() = response.headers().clone();
        let mut body = Vec::new();
        response
            .take(1024 * 1024 + 1)
            .read_to_end(&mut body)
            .map_err(|_| fail())?;
        if body.len() > 1024 * 1024 {
            return Err(fail());
        }
        *output.body_mut() = body;
        Ok(output)
    };
    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(verifier)
        .request(&transport)
        .map_err(|_| {
            ReadError::new(
                "CLOUD_AUTH_DENIED",
                "Google token exchange failed; verify the Desktop client and retry authorization",
            )
        })?;
    operation.check()?;
    let scopes = token
        .scopes()
        .map(|s| s.iter().map(|s| s.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();
    validate_scopes(&scopes)?;
    let refresh = token.refresh_token().ok_or_else(|| {
        ReadError::new(
            "CLOUD_REAUTH_REQUIRED",
            "Google did not return an offline refresh token; authorize again",
        )
    })?;
    let expires = chrono::Utc::now()
        + chrono::Duration::from_std(token.expires_in().unwrap_or(Duration::from_secs(3600)))
            .map_err(|_| invalid_profile())?;
    Ok(
        json!({"access_token":token.access_token().secret(),"refresh_token":refresh.secret(),"token_type":"Bearer","expiry":expires.to_rfc3339()}),
    )
}
fn validate_scopes(scopes: &[&str]) -> Result<(), ReadError> {
    if scopes == [SCOPE] {
        Ok(())
    } else {
        Err(ReadError::new(
            "CLOUD_SCOPE_MISMATCH",
            "Google must grant exactly drive.file; broader or missing permissions are not accepted",
        ))
    }
}
fn parse_callback(bytes: &[u8], expected: &str, port: u16) -> Result<String, ReadError> {
    let bad = || ReadError::new("CLOUD_CALLBACK_INVALID", "Invalid OAuth callback");
    let text = std::str::from_utf8(bytes).map_err(|_| bad())?;
    let line = text.lines().next().ok_or_else(bad)?;
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || !parts[1].starts_with("/callback?") {
        return Err(bad());
    }
    let url =
        url::Url::parse(&format!("http://127.0.0.1:{port}{}", parts[1])).map_err(|_| bad())?;
    let mut query = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if query.insert(key.to_string(), value.to_string()).is_some() {
            return Err(bad());
        }
    }
    let actual = query.get("state").ok_or_else(bad)?;
    // Constant-work comparison of hashed fixed-length state values.
    let a = Sha256::digest(actual.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    if a.iter().zip(b).fold(0u8, |diff, (a, b)| diff | (*a ^ b)) != 0 {
        return Err(bad());
    }
    if query.contains_key("error") {
        return Err(ReadError::new(
            "CLOUD_AUTH_DENIED",
            "Google authorization was denied",
        ));
    }
    query
        .remove("code")
        .filter(|s| !s.is_empty() && s.len() < 4096)
        .ok_or_else(bad)
}
fn open_authorization_url(url: &url::Url) -> Result<(), ReadError> {
    if url.scheme() != "https"
        || url.host_str() != Some("accounts.google.com")
        || url.path() != "/o/oauth2/v2/auth"
    {
        return Err(invalid_profile());
    }
    #[cfg(not(windows))]
    let mut command = std::process::Command::new("/usr/bin/xdg-open");
    #[cfg(windows)]
    let mut command = {
        let system = std::env::var_os("SystemRoot").ok_or_else(invalid_profile)?;
        let mut command = std::process::Command::new(
            std::path::PathBuf::from(system).join("System32/rundll32.exe"),
        );
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    crate::sidecar::sanitized(&mut command);
    // Parent process has never received config/Restic secrets via set_var.
    command
        .arg(url.as_str())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|_| {
        ReadError::new(
            "CLOUD_BROWSER",
            "Cannot open the system browser; open the authorization URL manually",
        )
    })?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_loopback_callback_checks_state_scope_pkce_denial_cancel_and_timeout() {
        use std::{
            net::TcpStream,
            sync::{Arc, Mutex, atomic::Ordering},
        };
        for deny in [true, false] {
            let op = Arc::new(AuthOperation {
                status: Mutex::new(super::super::AuthStatus {
                    operation_id: "test".into(),
                    connection_id: "test".into(),
                    phase: "starting".into(),
                    authorization_url: None,
                    error: None,
                }),
                cancel: crate::restic::cancellation(),
                started: Instant::now(),
            });
            let worker = op.clone();
            let thread = std::thread::spawn(move || {
                authorize(
                    &Profile {
                        id: "test".into(),
                        client_id: "offline.apps.googleusercontent.com".into(),
                        client_secret: zeroize::Zeroizing::new("dummy".into()),
                    },
                    &worker,
                    false,
                )
            });
            let url = loop {
                if let Some(url) = op.status.lock().unwrap().authorization_url.clone() {
                    break url::Url::parse(&url).unwrap();
                }
                assert!(op.started.elapsed() < Duration::from_secs(3));
                std::thread::sleep(Duration::from_millis(5));
            };
            let parameters: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
            assert_eq!(parameters["scope"], SCOPE);
            assert_eq!(parameters["code_challenge_method"], "S256");
            assert!(!parameters.contains_key("code_verifier"));
            let redirect = url::Url::parse(&parameters["redirect_uri"]).unwrap();
            assert_eq!(redirect.host_str(), Some("127.0.0.1"));
            let port = redirect.port().unwrap();
            let mut wrong = TcpStream::connect(("127.0.0.1", port)).unwrap();
            wrong.write_all(b"GET /callback?state=wrong&code=do-not-exchange HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            wrong
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut response = String::new();
            wrong.read_to_string(&mut response).unwrap();
            assert!(response.contains("not accepted"));
            assert_eq!(op.status.lock().unwrap().phase, "waiting-browser");
            if deny {
                let mut request = TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(request,"GET /callback?state={}&error=access_denied HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",parameters["state"]).unwrap();
            } else {
                op.cancel.store(true, Ordering::Release);
            }
            assert_eq!(
                thread.join().unwrap().unwrap_err().code,
                if deny {
                    "CLOUD_AUTH_DENIED"
                } else {
                    "CANCELLED"
                }
            );
            assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
            // Expiry is checked before credentials can be committed.
            let expired = AuthOperation {
                status: Mutex::new(op.status.lock().unwrap().clone()),
                cancel: crate::restic::cancellation(),
                started: Instant::now() - Duration::from_secs(301),
            };
            assert_eq!(expired.check().unwrap_err().code, "TIMEOUT");
        }
    }
    #[test]
    fn scope_and_callback_are_fail_closed() {
        assert!(validate_scopes(&[SCOPE]).is_ok());
        for scopes in [
            vec![],
            vec!["https://www.googleapis.com/auth/drive"],
            vec![SCOPE, "email"],
        ] {
            assert!(validate_scopes(&scopes).is_err());
        }
        let valid = b"GET /callback?state=expected&code=code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(parse_callback(valid, "expected", 5).unwrap(), "code");
        assert!(parse_callback(valid, "different", 5).is_err());
        assert!(
            parse_callback(
                b"GET /callback?state=expected&state=expected&code=c HTTP/1.1",
                "expected",
                5
            )
            .is_err()
        );
        assert_eq!(
            parse_callback(
                b"GET /callback?state=expected&error=access_denied HTTP/1.1",
                "expected",
                5
            )
            .unwrap_err()
            .code,
            "CLOUD_AUTH_DENIED"
        );
    }
    #[test]
    fn shared_or_web_client_is_never_a_default() {
        assert!(Profile::parse(b"{}").is_err());
        assert!(Profile::parse(br#"{"web":{"client_id":"id","client_secret":"secret"}}"#).is_err());
    }
}
