//! Minimal production WebDAV boundary for S2 Lite.
//!
//! This module deliberately contains no publication or discovery policy.  It
//! transports raw bytes and maps provider outcomes into the frozen remote
//! interfaces; the frozen core still decides whether an object is verified.

use std::io::Read;
use std::time::Duration;

use quick_xml::events::{BytesDecl, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::{Method, StatusCode, Url};
use sha2::{Digest, Sha256};

use super::immutable_publish::{
    ImmutableObjectRemoteV1, RemoteExactGetResultV1, RemotePutResultV1,
};
use super::remote_discovery::{
    parse_activation_candidate_path_v1, parse_writer_candidate_path_v1, DirectoryListResultV1,
    DiscoveryExactGetResultV1, DiscoveryRemoteV1,
};
use super::{canonical::validate_canonical_uuid_v4, immutable_publish::SEGMENT_NAME_WIDTH_V1};

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROPFIND_BYTES: usize = 1024 * 1024;

fn is_xml_s(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

fn validate_xml_declaration(declaration: &BytesDecl<'_>) -> bool {
    let bytes: &[u8] = declaration.as_ref();
    if bytes.len() <= 3 || !bytes.starts_with(b"xml") || !is_xml_s(bytes[3]) {
        return false;
    }
    let mut cursor = 3_usize;
    let mut last_order = 0_u8;
    let mut attribute_count = 0_usize;
    while cursor < bytes.len() {
        let whitespace_start = cursor;
        while cursor < bytes.len() && is_xml_s(bytes[cursor]) {
            cursor += 1;
        }
        if cursor == bytes.len() {
            return attribute_count > 0;
        }
        if attribute_count > 0 && cursor == whitespace_start {
            return false;
        }
        let key_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        if cursor == key_start {
            return false;
        }
        let key = &bytes[key_start..cursor];
        while cursor < bytes.len() && is_xml_s(bytes[cursor]) {
            cursor += 1;
        }
        if cursor == bytes.len() || bytes[cursor] != b'=' {
            return false;
        }
        cursor += 1;
        while cursor < bytes.len() && is_xml_s(bytes[cursor]) {
            cursor += 1;
        }
        if cursor == bytes.len() || !matches!(bytes[cursor], b'\'' | b'"') {
            return false;
        }
        let quote = bytes[cursor];
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != quote {
            cursor += 1;
        }
        if cursor == bytes.len() {
            return false;
        }
        let value = &bytes[value_start..cursor];
        cursor += 1;
        let (order, value_is_supported) = match key {
            b"version" => (1, value == b"1.0"),
            b"encoding" => (
                2,
                value.eq_ignore_ascii_case(b"utf-8") || value.eq_ignore_ascii_case(b"utf8"),
            ),
            b"standalone" => (3, matches!(value, b"yes" | b"no")),
            _ => return false,
        };
        if !value_is_supported || order <= last_order || (last_order == 0 && order != 1) {
            return false;
        }
        last_order = order;
        attribute_count += 1;
    }
    attribute_count > 0 && last_order >= 1
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebDavRootV1 {
    pub canonical_url: String,
    pub normalized_account: String,
    pub physical_root_id: String,
}

#[derive(Clone, Debug)]
pub struct WebDavS2ConfigV1 {
    pub root: WebDavRootV1,
    pub username: String,
    pub password: String,
    pub proxy: Option<String>,
    pub timeout: Duration,
}

/// Canonicalizes the root identity independently of installation or target epoch.
pub fn webdav_root_v1(target_url: &str, username: &str) -> Result<WebDavRootV1, &'static str> {
    let mut url = Url::parse(target_url).map_err(|_| "invalid_webdav_root")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid_webdav_root");
    }
    url.set_fragment(None);
    url.set_query(None);
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/"));
    let account = username.trim().to_string();
    if account.is_empty() {
        return Err("invalid_webdav_account");
    }
    let canonical_url = url.to_string();
    let mut hasher = Sha256::new();
    hasher.update(canonical_url.as_bytes());
    hasher.update([0]);
    hasher.update(account.as_bytes());
    let target_id = format!("{:x}", hasher.finalize());
    Ok(WebDavRootV1 {
        canonical_url,
        normalized_account: account,
        physical_root_id: format!("s2-root-v1:{target_id}"),
    })
}

fn safe_relative_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.contains('?')
        || path.contains('#')
        || path.contains('%')
        || path.contains("//")
    {
        return Err("invalid_s2_relative_path");
    }
    if path.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    }) {
        return Err("invalid_s2_relative_path");
    }
    Ok(())
}

fn child_url(root: &WebDavRootV1, path: &str) -> Result<Url, &'static str> {
    safe_relative_path(path)?;
    Url::parse(&root.canonical_url)
        .map_err(|_| "invalid_webdav_root")?
        .join(path)
        .map_err(|_| "invalid_s2_relative_path")
}

fn valid_immutable_object_path(path: &str) -> bool {
    parse_activation_candidate_path_v1(path).is_some()
        || parse_writer_candidate_path_v1(path).is_some()
}

fn valid_segment_name(segment: &str) -> bool {
    segment.len() == SEGMENT_NAME_WIDTH_V1
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_discovery_directory(path: &str) -> bool {
    if matches!(path, "activations" | "writers") {
        return true;
    }
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["writers", writer_id, "segments"] => validate_canonical_uuid_v4(writer_id).is_ok(),
        ["writers", writer_id, "segments", segment] => {
            validate_canonical_uuid_v4(writer_id).is_ok() && valid_segment_name(segment)
        }
        _ => false,
    }
}

pub struct WebDavS2RemoteV1 {
    config: WebDavS2ConfigV1,
    client: Client,
}

impl WebDavS2RemoteV1 {
    pub fn new(mut config: WebDavS2ConfigV1) -> Result<Self, &'static str> {
        let canonical_account = config.username.trim().to_string();
        let expected_root = webdav_root_v1(&config.root.canonical_url, &canonical_account)?;
        if config.root != expected_root {
            return Err("webdav_root_credentials_mismatch");
        }
        config.username = canonical_account;
        let mut builder = Client::builder()
            .timeout(config.timeout)
            .redirect(Policy::none());
        if let Some(proxy) = &config.proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "invalid_proxy")?);
        }
        Ok(Self {
            config,
            client: builder.build().map_err(|_| "webdav_client_failure")?,
        })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&[u8]>,
        depth_one: bool,
    ) -> Result<(StatusCode, Vec<u8>), ()> {
        let url = child_url(&self.config.root, path).map_err(|_| ())?;
        let mut request = self
            .client
            .request(method, url)
            .basic_auth(&self.config.username, Some(&self.config.password));
        if depth_one {
            request = request.header("Depth", "1");
        }
        if let Some(bytes) = body {
            request = request.header("If-None-Match", "*").body(bytes.to_vec());
        }
        let response = request.send().map_err(|_| ())?;
        let limit = if depth_one {
            MAX_PROPFIND_BYTES
        } else {
            MAX_BODY_BYTES
        };
        if response
            .content_length()
            .is_some_and(|n| n as usize > limit)
        {
            return Err(());
        }
        let status = response.status();
        let mut bytes = Vec::new();
        response
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > limit {
            return Err(());
        }
        Ok((status, bytes))
    }

    fn get(&self, path: &str) -> RemoteExactGetResultV1 {
        assert!(
            valid_immutable_object_path(path),
            "invalid_s2_immutable_path"
        );
        match self.request(Method::GET, path, None, false) {
            Ok((status, bytes)) if status.is_success() => {
                RemoteExactGetResultV1::DefinitelyPresent(bytes)
            }
            Ok((StatusCode::NOT_FOUND, _)) => RemoteExactGetResultV1::DefinitelyAbsent,
            Ok((StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _)) => {
                RemoteExactGetResultV1::AuthOrCapabilityFailure
            }
            _ => RemoteExactGetResultV1::Indeterminate,
        }
    }

    fn list(&self, path: &str) -> DirectoryListResultV1 {
        let directory = path.trim_end_matches('/');
        assert!(
            valid_discovery_directory(directory),
            "invalid_s2_discovery_directory"
        );
        let directory_url = match Url::parse(&self.config.root.canonical_url)
            .and_then(|root| root.join(&format!("{directory}/")))
        {
            Ok(url) => url,
            Err(_) => return DirectoryListResultV1::Indeterminate,
        };
        let response = self
            .client
            .request(
                Method::from_bytes(b"PROPFIND").unwrap(),
                directory_url.clone(),
            )
            .basic_auth(&self.config.username, Some(&self.config.password))
            .header("Depth", "1")
            .send();
        let response = match response {
            Ok(value) => value,
            Err(_) => return DirectoryListResultV1::Indeterminate,
        };
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return DirectoryListResultV1::AuthOrCapabilityFailure;
        }
        if response.status() != StatusCode::MULTI_STATUS
            || response
                .content_length()
                .is_some_and(|n| n as usize > MAX_PROPFIND_BYTES)
        {
            return DirectoryListResultV1::Indeterminate;
        }
        let mut xml = Vec::new();
        if response
            .take((MAX_PROPFIND_BYTES + 1) as u64)
            .read_to_end(&mut xml)
            .is_err()
            || xml.len() > MAX_PROPFIND_BYTES
        {
            return DirectoryListResultV1::Indeterminate;
        }
        let mut reader = NsReader::from_reader(xml.as_slice());
        reader.config_mut().trim_text(false);
        let mut hrefs = Vec::new();
        let mut depth = 0_usize;
        let mut response_href = None;
        let mut response_status = None;
        let mut in_href = false;
        let mut in_status = false;
        let mut text = String::new();
        #[derive(Eq, PartialEq)]
        enum DocumentPhase {
            Before,
            Inside,
            After,
        }
        let mut phase = DocumentPhase::Before;
        let mut declaration_seen = false;
        let mut prolog_consumed = false;
        macro_rules! start_element {
            ($is_dav:expr, $local:expr) => {{
                if phase == DocumentPhase::After {
                    return DirectoryListResultV1::Indeterminate;
                }
                if depth == 0 {
                    if phase != DocumentPhase::Before || !$is_dav || $local != b"multistatus" {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    phase = DocumentPhase::Inside;
                } else if depth == 1 {
                    if !$is_dav || $local != b"response" {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    response_href = None;
                    response_status = None;
                } else if $local == b"href" {
                    if !$is_dav || depth != 2 || in_href {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    in_href = true;
                    text.clear();
                } else if $local == b"status" {
                    if !$is_dav || in_status {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    in_status = true;
                    text.clear();
                }
                depth += 1;
            }};
        }
        macro_rules! end_element {
            ($is_dav:expr, $local:expr) => {{
                if depth == 0 {
                    return DirectoryListResultV1::Indeterminate;
                }
                if $local == b"href" {
                    if !$is_dav || !in_href || depth != 3 || text.is_empty() {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    response_href = Some(text.clone());
                    in_href = false;
                } else if $local == b"status" {
                    if !$is_dav || !in_status {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    response_status = Some(text.clone());
                    in_status = false;
                } else if $local == b"response" {
                    if depth != 2
                        || !$is_dav
                        || response_href.is_none()
                        || response_status.as_deref().is_some_and(|status| {
                            !status.starts_with("HTTP/") || !status.contains(" 2")
                        })
                    {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    hrefs.push(response_href.take().unwrap());
                } else if $local == b"multistatus" {
                    if !$is_dav || depth != 1 {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    phase = DocumentPhase::After;
                }
                depth -= 1;
            }};
        }
        loop {
            match reader.read_resolved_event() {
                Ok((namespace, Event::Start(e))) => {
                    let is_dav = matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                    let local = e.local_name().as_ref().to_vec();
                    start_element!(is_dav, local);
                }
                Ok((namespace, Event::Empty(e))) => {
                    let is_dav = matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                    let local = e.local_name().as_ref().to_vec();
                    start_element!(is_dav, local);
                    end_element!(is_dav, local);
                }
                Ok((_, Event::Text(e))) => {
                    if in_href || in_status {
                        match e.unescape() {
                            Ok(value) => text.push_str(&value),
                            Err(_) => return DirectoryListResultV1::Indeterminate,
                        }
                    } else {
                        let raw: &[u8] = e.as_ref();
                        if !raw.iter().all(|byte| is_xml_s(*byte)) {
                            return DirectoryListResultV1::Indeterminate;
                        }
                        if phase == DocumentPhase::Before {
                            prolog_consumed = true;
                        }
                    }
                }
                Ok((_, Event::CData(e))) => {
                    if in_href || in_status {
                        let raw: &[u8] = e.as_ref();
                        let Ok(value) = std::str::from_utf8(raw) else {
                            return DirectoryListResultV1::Indeterminate;
                        };
                        text.push_str(value);
                    } else {
                        return DirectoryListResultV1::Indeterminate;
                    }
                }
                Ok((namespace, Event::End(e))) => {
                    let is_dav = matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                    let local = e.local_name().as_ref().to_vec();
                    end_element!(is_dav, local);
                }
                Ok((_, Event::Comment(_) | Event::PI(_))) => {
                    if phase == DocumentPhase::Before {
                        prolog_consumed = true;
                    }
                }
                Ok((_, Event::Decl(declaration))) => {
                    if phase != DocumentPhase::Before || declaration_seen || prolog_consumed {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    if !validate_xml_declaration(&declaration) {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    declaration_seen = true;
                }
                Ok((_, Event::DocType(_))) => return DirectoryListResultV1::Indeterminate,
                Ok((_, Event::Eof))
                    if phase == DocumentPhase::After && depth == 0 && !in_href && !in_status =>
                {
                    break
                }
                Ok((_, Event::Eof)) => return DirectoryListResultV1::Indeterminate,
                Err(_) => return DirectoryListResultV1::Indeterminate,
            }
        }
        let root = match Url::parse(&self.config.root.canonical_url) {
            Ok(value) => value,
            Err(_) => return DirectoryListResultV1::Indeterminate,
        };
        let root_base = root.path();
        let directory_base = format!("{}{}", root_base, directory);
        let directory_base = format!("{}/", directory_base.trim_end_matches('/'));
        let mut entries = Vec::new();
        for href in hrefs {
            let Ok(url) = directory_url.join(&href) else {
                return DirectoryListResultV1::Indeterminate;
            };
            if url.origin() != root.origin()
                || !url.path().starts_with(root_base)
                || !url.path().starts_with(&directory_base)
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return DirectoryListResultV1::Indeterminate;
            }
            let relative = &url.path()[directory_base.len()..];
            let relative = relative.trim_end_matches('/');
            if relative.is_empty() {
                continue;
            }
            if safe_relative_path(relative).is_err() || relative.contains('/') {
                return DirectoryListResultV1::Indeterminate;
            }
            entries.push(format!("{directory}/{relative}"));
        }
        entries.sort();
        entries.dedup();
        DirectoryListResultV1::Entries(entries)
    }
}

impl ImmutableObjectRemoteV1 for WebDavS2RemoteV1 {
    fn physical_root_id(&self) -> Option<&str> {
        Some(&self.config.root.physical_root_id)
    }
    fn execution_context_identity(&self) -> u64 {
        self as *const Self as usize as u64
    }
    fn get_exact(&mut self, path: &str) -> RemoteExactGetResultV1 {
        self.get(path)
    }
    fn put_exact(
        &mut self,
        path: &str,
        bytes: &[u8],
        _if_none_match_star: bool,
    ) -> RemotePutResultV1 {
        assert!(
            valid_immutable_object_path(path),
            "invalid_s2_immutable_path"
        );
        match self.request(Method::PUT, path, Some(bytes), false) {
            Ok((status, _)) if status.is_success() => RemotePutResultV1::Success,
            Ok((StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _)) => {
                RemotePutResultV1::AuthOrCapabilityFailure
            }
            _ => RemotePutResultV1::Indeterminate,
        }
    }
}
impl DiscoveryRemoteV1 for WebDavS2RemoteV1 {
    fn list_directory(&mut self, path: &str) -> DirectoryListResultV1 {
        self.list(path)
    }
    fn get_exact(&mut self, path: &str) -> DiscoveryExactGetResultV1 {
        match self.get(path) {
            RemoteExactGetResultV1::DefinitelyPresent(v) => {
                DiscoveryExactGetResultV1::DefinitelyPresent(v)
            }
            RemoteExactGetResultV1::DefinitelyAbsent => DiscoveryExactGetResultV1::DefinitelyAbsent,
            RemoteExactGetResultV1::AuthOrCapabilityFailure => {
                DiscoveryExactGetResultV1::AuthOrCapabilityFailure
            }
            RemoteExactGetResultV1::Indeterminate => DiscoveryExactGetResultV1::Indeterminate,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use super::{
        child_url, safe_relative_path, valid_discovery_directory, valid_immutable_object_path,
        webdav_root_v1, WebDavS2ConfigV1, WebDavS2RemoteV1,
    };
    use crate::s2_lite::canonical::sha256_hex;
    use crate::s2_lite::immutable_publish::{
        ImmutableObjectRemoteV1, RemoteExactGetResultV1, RemotePutResultV1,
    };
    use crate::s2_lite::remote_discovery::{
        create_discovery_state_v1, run_discovery_round_v1, ActivationValidatorResultV1,
        ActivationVerificationV1, DirectoryListResultV1, DiscoveryBudgetsV1, DiscoveryRemoteV1,
    };

    const ACTIVATION_PATH: &str =
        "activations/123e4567-e89b-12d3-a456-426614174000--0000000000000000000000000000000000000000000000000000000000000000.json";

    fn server(responses: Vec<Option<Vec<u8>>>) -> (String, Arc<Mutex<Vec<Vec<u8>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let captured = received.clone();
        thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let raw = read_request(&mut stream);
                captured.lock().unwrap().push(raw);
                if let Some(response) = response {
                    stream.write_all(&response).unwrap();
                    let _ = stream.flush();
                }
            }
        });
        (format!("http://{address}/dav/"), received)
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut raw = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return raw,
                Ok(count) => raw.extend_from_slice(&chunk[..count]),
            }
            let Some(header_end) = raw.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let header_end = header_end + 4;
            let header = String::from_utf8_lossy(&raw[..header_end]).to_ascii_lowercase();
            let body_length = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if raw.len() >= header_end + body_length {
                return raw;
            }
        }
    }

    fn response(status: &str, body: &[u8]) -> Vec<u8> {
        [
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes(),
            body.to_vec(),
        ]
        .concat()
    }

    fn redirect(location: &str) -> Vec<u8> {
        format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    fn delayed_drop_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            thread::sleep(Duration::from_millis(300));
        });
        format!("http://{address}/dav/")
    }

    fn remote(url: &str) -> WebDavS2RemoteV1 {
        WebDavS2RemoteV1::new(WebDavS2ConfigV1 {
            root: webdav_root_v1(url, "alice").unwrap(),
            username: "alice".into(),
            password: "secret".into(),
            proxy: None,
            timeout: Duration::from_millis(150),
        })
        .unwrap()
    }

    #[test]
    fn root_identity_is_stable_and_account_scoped() {
        let a = webdav_root_v1("HTTPS://dav.example.test/root", " Alice ").unwrap();
        let b = webdav_root_v1("https://dav.example.test/root/", "Alice").unwrap();
        let other = webdav_root_v1("https://dav.example.test/root/", "bob").unwrap();
        let case_distinct = webdav_root_v1("https://dav.example.test/root/", "alice").unwrap();
        let different_target = webdav_root_v1("https://dav.example.test/other/", "alice").unwrap();
        assert_eq!(a, b);
        assert_ne!(a.physical_root_id, other.physical_root_id);
        assert_ne!(a.physical_root_id, case_distinct.physical_root_id);
        assert_ne!(a.physical_root_id, different_target.physical_root_id);
        assert!(a.physical_root_id.starts_with("s2-root-v1:"));
        assert!(webdav_root_v1("https://dav.example.test/root/?q=1", "alice").is_err());
        assert!(webdav_root_v1("https://dav.example.test/root/#fragment", "alice").is_err());
    }

    #[test]
    fn relative_paths_cannot_escape_the_physical_root() {
        for path in ["/absolute", "a/../b", "a/%2e%2e/b", "a?x=1", "a#x", "a\\b"] {
            assert!(safe_relative_path(path).is_err(), "{path}");
        }
        let root = webdav_root_v1("https://dav.example.test/root/", "alice").unwrap();
        assert_eq!(
            child_url(&root, "writers/a/file.json").unwrap().as_str(),
            "https://dav.example.test/root/writers/a/file.json"
        );
        assert!(safe_relative_path("activations/2/activation.json").is_ok());
        assert!(safe_relative_path("writers/alice/commits/0001.json").is_ok());
    }

    #[test]
    fn raw_get_put_and_response_loss_are_conservative() {
        let binary = vec![0, 255, 128, b'{', 0, 13];
        let (url, received) = server(vec![
            Some(response("200 OK", &binary)),
            None,
            Some(response("200 OK", &binary)),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::DefinitelyPresent(binary.clone())
        );
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &binary, true),
            RemotePutResultV1::Indeterminate
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::DefinitelyPresent(binary.clone())
        );
        let requests = received.lock().unwrap();
        assert!(requests[1]
            .windows(binary.len())
            .any(|window| window == binary));
        assert!(String::from_utf8_lossy(&requests[1])
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[test]
    fn ignored_condition_put_success_has_no_verification_authority() {
        let prepared = vec![0, 255, 7, 0];
        let overwritten = vec![9, 9, 9];
        let (url, received) = server(vec![
            Some(response("204 No Content", b"")),
            Some(response("200 OK", &overwritten)),
        ]);
        let mut webdav = remote(&url);
        // The fake provider accepts the PUT despite the conditional header.  A
        // transport success remains only a transport result; exact GET exposes
        // that it did not establish the prepared bytes.
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &prepared, true),
            RemotePutResultV1::Success
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::DefinitelyPresent(overwritten)
        );
        assert!(String::from_utf8_lossy(&received.lock().unwrap()[0])
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[test]
    fn get_classifies_http_and_bounded_failures() {
        let huge = vec![b'x'; 8 * 1024 * 1024 + 1];
        let (url, _) = server(vec![
            Some(response("404 Not Found", b"")),
            Some(response("401 Unauthorized", b"")),
            Some(response("500 Server Error", b"")),
            Some(response("200 OK", &huge)),
            Some(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nx".to_vec()),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::DefinitelyAbsent
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::AuthOrCapabilityFailure
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
        let mut timeout_remote = remote(&delayed_drop_server());
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut timeout_remote, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
    }

    #[test]
    fn propfind_is_depth_one_sorted_and_hostile_entries_fail_closed() {
        let good = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/</d:href></d:response><d:response><d:href>/dav/writers/b</d:href></d:response><d:response><d:href>/dav/writers/a</d:href></d:response><d:response><d:href>/dav/writers/a</d:href></d:response></d:multistatus>"#;
        let hostile = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://evil.example/x</d:href></d:response></d:multistatus>"#;
        let outside = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/other/x</d:href></d:response></d:multistatus>"#;
        let traversal = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/%2e%2e/secret</d:href></d:response></d:multistatus>"#;
        let encoded_separator = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/a%2fb</d:href></d:response></d:multistatus>"#;
        let encoded_backslash = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/a%5cb</d:href></d:response></d:multistatus>"#;
        let nested = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/a/b</d:href></d:response></d:multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", good)),
            Some(response("207 Multi-Status", hostile)),
            Some(response("207 Multi-Status", b"<broken")),
            Some(response("207 Multi-Status", outside)),
            Some(response("207 Multi-Status", traversal)),
            Some(response("207 Multi-Status", encoded_separator)),
            Some(response("207 Multi-Status", encoded_backslash)),
            Some(response("207 Multi-Status", nested)),
        ]);
        let mut remote = remote(&url);
        assert_eq!(
            remote.list_directory("writers"),
            DirectoryListResultV1::Entries(vec!["writers/a".into(), "writers/b".into()])
        );
        assert_eq!(
            remote.list_directory("writers"),
            DirectoryListResultV1::Indeterminate
        );
        assert_eq!(
            remote.list_directory("writers"),
            DirectoryListResultV1::Indeterminate
        );
        for _ in 0..5 {
            assert_eq!(
                remote.list_directory("writers"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn listing_omission_is_only_the_next_observation() {
        let first = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/</d:href></d:response><d:response><d:href>/dav/writers/x</d:href></d:response></d:multistatus>"#;
        let second = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/</d:href></d:response></d:multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", first)),
            Some(response("207 Multi-Status", second)),
        ]);
        let mut remote = remote(&url);
        assert_eq!(
            remote.list_directory("writers"),
            DirectoryListResultV1::Entries(vec!["writers/x".into()])
        );
        assert_eq!(
            remote.list_directory("writers"),
            DirectoryListResultV1::Entries(vec![])
        );
    }

    #[test]
    fn discovery_consumes_root_relative_adapter_entries_end_to_end() {
        let bytes = br#"{"activationId":"123e4567-e89b-12d3-a456-426614174000"}"#.to_vec();
        let path = format!(
            "activations/123e4567-e89b-12d3-a456-426614174000--{}.json",
            sha256_hex(&bytes)
        );
        let activations = format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/activations/</d:href></d:response><d:response><d:href>{}</d:href></d:response></d:multistatus>",
            path.strip_prefix("activations/").unwrap()
        );
        let writers = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/writers/</d:href></d:response></d:multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", activations.as_bytes())),
            Some(response("207 Multi-Status", writers)),
            Some(response("200 OK", &bytes)),
        ]);
        let mut webdav = remote(&url);
        let mut validator = |_bytes: &[u8]| -> ActivationValidatorResultV1 {
            Ok(ActivationVerificationV1 {
                activation_id: "123e4567-e89b-12d3-a456-426614174000".into(),
                legacy_fingerprint: None,
                semantic_profile_supported: true,
                required_features_supported: true,
            })
        };
        let state = run_discovery_round_v1(
            &create_discovery_state_v1(),
            &mut webdav,
            &mut validator,
            &DiscoveryBudgetsV1::default(),
        )
        .unwrap();
        assert_eq!(state.last_round_scheduled_gets, vec![path.clone()]);
        assert_eq!(state.verified_objects.len(), 1);
        assert_eq!(state.verified_objects[0].path, path);
    }

    #[test]
    fn redirects_are_never_followed_for_get_put_or_propfind() {
        let (url, received) = server(vec![
            Some(redirect("/dav/redirected")),
            Some(redirect("http://evil.example/redirected")),
            Some(redirect("/dav/redirected")),
            Some(redirect("http://evil.example/redirected")),
            Some(redirect("/dav/redirected")),
            Some(redirect("http://evil.example/redirected")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::Indeterminate
        );
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
            RemotePutResultV1::Indeterminate
        );
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
            RemotePutResultV1::Indeterminate
        );
        assert_eq!(
            webdav.list_directory("activations/"),
            DirectoryListResultV1::Indeterminate
        );
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Indeterminate
        );
        assert_eq!(
            received.lock().unwrap().len(),
            6,
            "redirect targets were not requested"
        );
    }

    #[test]
    fn invalid_operation_paths_fail_locally_and_root_credentials_are_bound() {
        for path in [
            "records-v3.json",
            "foo.json",
            "foo/bar.json",
            "activations/nope.json",
        ] {
            assert!(!valid_immutable_object_path(path), "{path}");
        }
        for path in [
            "foo",
            "writers/not-a-uuid",
            "writers/123e4567-e89b-42d3-a456-426614174000/segments/nothex",
        ] {
            assert!(!valid_discovery_directory(path), "{path}");
        }
        let root = webdav_root_v1("https://dav.example.test/root/", "Alice").unwrap();
        let mismatched = WebDavS2ConfigV1 {
            root: root.clone(),
            username: "Bob".into(),
            password: "secret".into(),
            proxy: None,
            timeout: Duration::from_secs(1),
        };
        assert!(WebDavS2RemoteV1::new(mismatched).is_err());
        let mut forged = root;
        forged.physical_root_id = "s2-root-v1:forged".into();
        let forged = WebDavS2ConfigV1 {
            root: forged,
            username: "Alice".into(),
            password: "secret".into(),
            proxy: None,
            timeout: Duration::from_secs(1),
        };
        assert!(WebDavS2RemoteV1::new(forged).is_err());
    }

    #[test]
    fn dav_multistatus_requires_dav_structure_complete_xml_and_success_status() {
        let relative = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href></d:response></d:multistatus>"#;
        let non_dav_href = br#"<d:multistatus xmlns:d="DAV:" xmlns:x="urn:not-dav"><d:response><x:href>child</x:href></d:response></d:multistatus>"#;
        let incomplete =
            br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href></d:response>"#;
        let failed_status = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", relative)),
            Some(response("207 Multi-Status", non_dav_href)),
            Some(response("207 Multi-Status", incomplete)),
            Some(response("207 Multi-Status", failed_status)),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec!["writers/child".into()])
        );
        for _ in 0..3 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_namespace_bindings_are_resolved_by_uri_not_prefix() {
        let d = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>"#;
        let upper = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>child</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response></D:multistatus>"#;
        let x = r#"<x:multistatus xmlns:x="DAV:"><x:response><x:href>child</x:href><x:status>HTTP/1.1 200 OK</x:status></x:response></x:multistatus>"#;
        let default = r#"<multistatus xmlns="DAV:"><response><href>child</href><status>HTTP/1.1 200 OK</status></response></multistatus>"#;
        let mixed = r#"<a:multistatus xmlns:a="DAV:" xmlns:b="DAV:"><b:response><a:href>child</a:href><b:status>HTTP/1.1 200 OK</b:status></b:response></a:multistatus>"#;
        let non_dav_href = r#"<d:multistatus xmlns:d="DAV:" xmlns:x="urn:not-dav"><d:response><x:href>child</x:href></d:response></d:multistatus>"#;
        let non_dav_root = r#"<x:multistatus xmlns:x="urn:not-dav"><x:response><x:href>child</x:href></x:response></x:multistatus>"#;
        let unbound =
            r#"<x:multistatus><x:response><x:href>child</x:href></x:response></x:multistatus>"#;
        let local_name_spoof =
            r#"<multistatus><response><href>child</href></response></multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", d.as_bytes())),
            Some(response("207 Multi-Status", upper.as_bytes())),
            Some(response("207 Multi-Status", x.as_bytes())),
            Some(response("207 Multi-Status", default.as_bytes())),
            Some(response("207 Multi-Status", mixed.as_bytes())),
            Some(response("207 Multi-Status", non_dav_href.as_bytes())),
            Some(response("207 Multi-Status", non_dav_root.as_bytes())),
            Some(response("207 Multi-Status", unbound.as_bytes())),
            Some(response("207 Multi-Status", local_name_spoof.as_bytes())),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..5 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Entries(vec!["writers/child".into()])
            );
        }
        for _ in 0..4 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_empty_elements_and_eof_cannot_create_partial_success() {
        let valid = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>"#;
        let empty_response = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response><d:response/></d:multistatus>"#;
        let non_dav_empty_root = br#"<x:multistatus xmlns:x="urn:not-dav"/>"#;
        let two_roots = br#"<d:multistatus xmlns:d="DAV:"/><d:multistatus xmlns:d="DAV:"/>"#;
        let truncated_after_valid =
            br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href></d:response>"#;
        let missing_root_close =
            br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href></d:response>"#;
        let empty_valid_root = br#"<d:multistatus xmlns:d="DAV:"/>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", empty_response)),
            Some(response("207 Multi-Status", b"")),
            Some(response("207 Multi-Status", b" \r\n\t ")),
            Some(response("207 Multi-Status", non_dav_empty_root)),
            Some(response("207 Multi-Status", two_roots)),
            Some(response("207 Multi-Status", truncated_after_valid)),
            Some(response("207 Multi-Status", missing_root_close)),
            Some(response("207 Multi-Status", valid)),
            Some(response("207 Multi-Status", empty_valid_root)),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..7 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec!["writers/child".into()])
        );
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec![])
        );
    }

    #[test]
    fn dav_document_phase_rejects_invalid_epilog_and_allows_xml_trivia() {
        let valid = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>"#;
        let trailing_cdata = format!("{valid}<![CDATA[invalid trailing document content]]>");
        let trailing_text = format!("{valid}invalid trailing text");
        let second_root = format!("{valid}<d:multistatus xmlns:d=\"DAV:\"/>");
        let trailing_declaration = format!("{valid}<?xml version=\"1.0\"?>");
        let trailing_doctype = format!("{valid}<!DOCTYPE invalid>");
        let legal_epilog = format!("{valid}\n <!-- legal --> <?legal instruction?> \t");
        let legal_prolog = format!(" \n<!-- legal --><?legal instruction?>{valid}");
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", trailing_cdata.as_bytes())),
            Some(response("207 Multi-Status", trailing_text.as_bytes())),
            Some(response("207 Multi-Status", second_root.as_bytes())),
            Some(response(
                "207 Multi-Status",
                trailing_declaration.as_bytes(),
            )),
            Some(response("207 Multi-Status", trailing_doctype.as_bytes())),
            Some(response("207 Multi-Status", legal_epilog.as_bytes())),
            Some(response("207 Multi-Status", legal_prolog.as_bytes())),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..5 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
        for _ in 0..2 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Entries(vec!["writers/child".into()])
            );
        }
    }

    #[test]
    fn dav_declaration_is_accepted_only_at_true_document_start() {
        let valid = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>"#;
        let declaration_utf8 = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>{valid}");
        let declaration_plain = format!("<?xml version=\"1.0\"?>{valid}");
        let after_whitespace = format!(" \n<?xml version=\"1.0\"?>{valid}");
        let after_comment = format!("<!-- prior --><?xml version=\"1.0\"?>{valid}");
        let after_pi = format!("<?prior instruction?><?xml version=\"1.0\"?>{valid}");
        let duplicate = format!("<?xml version=\"1.0\"?><?xml version=\"1.0\"?>{valid}");
        let inside_root = "<d:multistatus xmlns:d=\"DAV:\"><?xml version=\"1.0\"?><d:response><d:href>child</d:href></d:response></d:multistatus>".to_string();
        let after_root = format!("{valid}<?xml version=\"1.0\"?>");
        let unsupported_encoding =
            format!("<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>{valid}");
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", declaration_utf8.as_bytes())),
            Some(response("207 Multi-Status", declaration_plain.as_bytes())),
            Some(response("207 Multi-Status", after_whitespace.as_bytes())),
            Some(response("207 Multi-Status", after_comment.as_bytes())),
            Some(response("207 Multi-Status", after_pi.as_bytes())),
            Some(response("207 Multi-Status", duplicate.as_bytes())),
            Some(response("207 Multi-Status", inside_root.as_bytes())),
            Some(response("207 Multi-Status", after_root.as_bytes())),
            Some(response(
                "207 Multi-Status",
                unsupported_encoding.as_bytes(),
            )),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..2 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Entries(vec!["writers/child".into()])
            );
        }
        for _ in 0..7 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_declaration_accepts_utf8_bom_but_requires_xml_1_0() {
        let empty = r#"<d:multistatus xmlns:d="DAV:"/>"#;
        let response_body = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>"#;
        let bom = "\u{feff}";
        let bom_declaration_empty =
            format!("{bom}<?xml version=\"1.0\" encoding=\"utf-8\"?>{empty}");
        let bom_declaration_response =
            format!("{bom}<?xml version=\"1.0\" encoding=\"UTF8\"?>{response_body}");
        let bom_without_declaration = format!("{bom}{empty}");
        let no_bom = format!("<?xml version=\"1.0\"?>{empty}");
        let banana = format!("<?xml version=\"banana\"?>{empty}");
        let two = format!("<?xml version=\"2.0\"?>{empty}");
        let one = format!("<?xml version=\"1\"?>{empty}");
        let missing = format!("<?xml encoding=\"utf-8\"?>{empty}");
        let unsupported_with_bom =
            format!("{bom}<?xml version=\"1.0\" encoding=\"windows-1252\"?>{empty}");
        let (url, _) = server(vec![
            Some(response(
                "207 Multi-Status",
                bom_declaration_empty.as_bytes(),
            )),
            Some(response(
                "207 Multi-Status",
                bom_declaration_response.as_bytes(),
            )),
            Some(response(
                "207 Multi-Status",
                bom_without_declaration.as_bytes(),
            )),
            Some(response("207 Multi-Status", no_bom.as_bytes())),
            Some(response("207 Multi-Status", banana.as_bytes())),
            Some(response("207 Multi-Status", two.as_bytes())),
            Some(response("207 Multi-Status", one.as_bytes())),
            Some(response("207 Multi-Status", missing.as_bytes())),
            Some(response(
                "207 Multi-Status",
                unsupported_with_bom.as_bytes(),
            )),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec![])
        );
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec!["writers/child".into()])
        );
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec![])
        );
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec![])
        );
        for _ in 0..5 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_declaration_requires_one_complete_supported_attribute_sequence() {
        let empty = r#"<d:multistatus xmlns:d="DAV:"/>"#;
        let body = |declaration: &str| format!("{declaration}{empty}");
        let canonical = body(r#"<?xml version="1.0"?>"#);
        let encoding = body(r#"<?xml version="1.0" encoding="utf-8"?>"#);
        let standalone_yes = body(r#"<?xml version="1.0" encoding="utf-8" standalone="yes"?>"#);
        let standalone_no = body(r#"<?xml version="1.0" standalone="no"?>"#);
        let bom = format!("\u{feff}{}", body(r#"<?xml version="1.0"?>"#));
        let duplicate_encoding =
            body(r#"<?xml version="1.0" encoding="utf-8" encoding="windows-1252"?>"#);
        let duplicate_same_encoding =
            body(r#"<?xml version="1.0" encoding="utf-8" encoding="utf-8"?>"#);
        let duplicate_version = body(r#"<?xml version="1.0" version="1.0"?>"#);
        let duplicate_standalone =
            body(r#"<?xml version="1.0" standalone="yes" standalone="no"?>"#);
        let unknown = body(r#"<?xml version="1.0" vendor="x"?>"#);
        let encoding_first = body(r#"<?xml encoding="utf-8" version="1.0"?>"#);
        let standalone_first = body(r#"<?xml standalone="yes" version="1.0"?>"#);
        let encoding_after_standalone =
            body(r#"<?xml version="1.0" standalone="yes" encoding="utf-8"?>"#);
        let malformed_tail = body(r#"<?xml version="1.0" encoding="utf-8" malformed?>"#);
        let invalid_standalone = body(r#"<?xml version="1.0" standalone="banana"?>"#);
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", canonical.as_bytes())),
            Some(response("207 Multi-Status", encoding.as_bytes())),
            Some(response("207 Multi-Status", standalone_yes.as_bytes())),
            Some(response("207 Multi-Status", standalone_no.as_bytes())),
            Some(response("207 Multi-Status", bom.as_bytes())),
            Some(response("207 Multi-Status", duplicate_encoding.as_bytes())),
            Some(response(
                "207 Multi-Status",
                duplicate_same_encoding.as_bytes(),
            )),
            Some(response("207 Multi-Status", duplicate_version.as_bytes())),
            Some(response(
                "207 Multi-Status",
                duplicate_standalone.as_bytes(),
            )),
            Some(response("207 Multi-Status", unknown.as_bytes())),
            Some(response("207 Multi-Status", encoding_first.as_bytes())),
            Some(response("207 Multi-Status", standalone_first.as_bytes())),
            Some(response(
                "207 Multi-Status",
                encoding_after_standalone.as_bytes(),
            )),
            Some(response("207 Multi-Status", malformed_tail.as_bytes())),
            Some(response("207 Multi-Status", invalid_standalone.as_bytes())),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..5 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Entries(vec![])
            );
        }
        for _ in 0..10 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_declaration_accepts_xml_whitespace_around_equals_only() {
        let empty = r#"<d:multistatus xmlns:d="DAV:"/>"#;
        let body = |declaration: &str| format!("{declaration}{empty}");
        let version_before = body(r#"<?xml version ="1.0"?>"#);
        let version_after = body(r#"<?xml version= "1.0"?>"#);
        let version_both = body(r#"<?xml version = "1.0"?>"#);
        let encoding = body(r#"<?xml version = "1.0" encoding = "utf-8"?>"#);
        let standalone = body(r#"<?xml version = "1.0" standalone = "yes"?>"#);
        let all_xml_space =
            body("<?xml version\t=\r\n\"1.0\"\nencoding\r=\t\"utf-8\" standalone = \"no\"?>");
        let missing_equals = body(r#"<?xml version "1.0"?>"#);
        let missing_quote = body(r#"<?xml version = 1.0?>"#);
        let missing_value = body(r#"<?xml version =?>"#);
        let empty_value = body(r#"<?xml version = ""?>"#);
        let double_equals = body(r#"<?xml version == "1.0"?>"#);
        let extra_equals = body(r#"<?xml version = = "1.0"?>"#);
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", version_before.as_bytes())),
            Some(response("207 Multi-Status", version_after.as_bytes())),
            Some(response("207 Multi-Status", version_both.as_bytes())),
            Some(response("207 Multi-Status", encoding.as_bytes())),
            Some(response("207 Multi-Status", standalone.as_bytes())),
            Some(response("207 Multi-Status", all_xml_space.as_bytes())),
            Some(response("207 Multi-Status", missing_equals.as_bytes())),
            Some(response("207 Multi-Status", missing_quote.as_bytes())),
            Some(response("207 Multi-Status", missing_value.as_bytes())),
            Some(response("207 Multi-Status", empty_value.as_bytes())),
            Some(response("207 Multi-Status", double_equals.as_bytes())),
            Some(response("207 Multi-Status", extra_equals.as_bytes())),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..6 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Entries(vec![])
            );
        }
        for _ in 0..6 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn dav_xml_s_excludes_vertical_tab_and_form_feed() {
        let empty = r#"<d:multistatus xmlns:d="DAV:"/>"#;
        let body = |declaration: &str| format!("{declaration}{empty}");
        let legal_document_s = format!(" \t\r\n{empty}\n\r\t ");
        let vt_before_eq = body("<?xml version\x0b=\"1.0\"?>");
        let vt_after_eq = body("<?xml version=\x0b\"1.0\"?>");
        let ff_before_eq = body("<?xml version\x0c=\"1.0\"?>");
        let ff_after_eq = body("<?xml version=\x0c\"1.0\"?>");
        let vt_between = body("<?xml version=\"1.0\"\x0bencoding=\"utf-8\"?>");
        let ff_between = body("<?xml version=\"1.0\"\x0cencoding=\"utf-8\"?>");
        let vt_prolog = format!("\x0b{empty}");
        let ff_prolog = format!("\x0c{empty}");
        let vt_epilog = format!("{empty}\x0b");
        let ff_epilog = format!("{empty}\x0c");
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", legal_document_s.as_bytes())),
            Some(response("207 Multi-Status", vt_before_eq.as_bytes())),
            Some(response("207 Multi-Status", vt_after_eq.as_bytes())),
            Some(response("207 Multi-Status", ff_before_eq.as_bytes())),
            Some(response("207 Multi-Status", ff_after_eq.as_bytes())),
            Some(response("207 Multi-Status", vt_between.as_bytes())),
            Some(response("207 Multi-Status", ff_between.as_bytes())),
            Some(response("207 Multi-Status", vt_prolog.as_bytes())),
            Some(response("207 Multi-Status", ff_prolog.as_bytes())),
            Some(response("207 Multi-Status", vt_epilog.as_bytes())),
            Some(response("207 Multi-Status", ff_epilog.as_bytes())),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.list_directory("writers/"),
            DirectoryListResultV1::Entries(vec![])
        );
        for _ in 0..10 {
            assert_eq!(
                webdav.list_directory("writers/"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }
}
