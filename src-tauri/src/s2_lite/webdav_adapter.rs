//! Minimal production WebDAV boundary for S2 Lite.
//!
//! This module deliberately contains no publication or discovery policy.  It
//! transports raw bytes and maps provider outcomes into the frozen remote
//! interfaces; the frozen core still decides whether an object is verified.

use std::collections::BTreeSet;
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

fn decode_url_path_segment_v1(segment: &str) -> Option<String> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0_usize;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return None;
        }
        decoded.push((hex(bytes[index + 1])? << 4) | hex(bytes[index + 2])?);
        index += 3;
    }
    let decoded = String::from_utf8(decoded).ok()?;
    if decoded.is_empty() || matches!(decoded.as_str(), "." | "..") || decoded.contains(['/', '\\'])
    {
        return None;
    }
    Some(decoded)
}

/// Validates the provider's href path lexically before URL resolution has an
/// opportunity to remove dot segments.  The URL parse/join below still owns
/// origin, query, fragment, and resolved-root checks.
fn raw_dav_href_path_is_safe_v1(href: &str) -> bool {
    if href.contains('\\') {
        return false;
    }
    let path_end = href.find(['?', '#']).unwrap_or(href.len());
    let before_query_or_fragment = &href[..path_end];
    let path = if before_query_or_fragment.starts_with('/') {
        before_query_or_fragment
    } else {
        let Some(colon) = before_query_or_fragment.find(':') else {
            return raw_dav_href_path_segments_are_safe_v1(before_query_or_fragment, false);
        };
        let scheme = &before_query_or_fragment[..colon];
        let remainder = &before_query_or_fragment[colon + 1..];
        if scheme.is_empty()
            || !scheme.bytes().enumerate().all(|(index, byte)| {
                if index == 0 {
                    byte.is_ascii_alphabetic()
                } else {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                }
            })
            || !remainder.starts_with("//")
        {
            return raw_dav_href_path_segments_are_safe_v1(before_query_or_fragment, false);
        }
        let authority_and_path = &remainder[2..];
        match authority_and_path.find('/') {
            Some(index) => &authority_and_path[index..],
            None => "",
        }
    };
    raw_dav_href_path_segments_are_safe_v1(path, path.starts_with('/'))
}

fn raw_dav_href_path_segments_are_safe_v1(path: &str, absolute: bool) -> bool {
    let path = if absolute {
        let Some(path) = path.strip_prefix('/') else {
            return false;
        };
        if path.starts_with('/') {
            return false;
        }
        path
    } else {
        path
    };
    if path.is_empty() {
        return true;
    }
    let mut segments = path.split('/').collect::<Vec<_>>();
    let trailing_slashes = segments
        .iter()
        .rev()
        .take_while(|segment| segment.is_empty())
        .count();
    if trailing_slashes > 1 {
        return false;
    }
    segments.truncate(segments.len().saturating_sub(trailing_slashes));
    !segments.is_empty()
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && decode_url_path_segment_v1(segment).is_some())
}

#[derive(Debug, Eq, PartialEq)]
struct DecodedUrlPathV1 {
    segments: Vec<String>,
    trailing_slashes: usize,
}

/// Decodes an already-parsed URL path without allowing a percent-encoded
/// separator (or dot segment) to become structural.  URL path boundaries are
/// established before decoding, so equality is insensitive to percent-escape
/// spelling but never broadens containment by decoding an entire path first.
fn decoded_url_path_v1(url: &Url) -> Option<DecodedUrlPathV1> {
    let path = url.path();
    let remainder = path.strip_prefix('/')?;
    let mut raw_segments = remainder.split('/').collect::<Vec<_>>();
    let trailing_slashes = raw_segments
        .iter()
        .rev()
        .take_while(|segment| segment.is_empty())
        .count();
    raw_segments.truncate(raw_segments.len().saturating_sub(trailing_slashes));
    if raw_segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    let segments = raw_segments
        .into_iter()
        .map(decode_url_path_segment_v1)
        .collect::<Option<Vec<_>>>()?;
    Some(DecodedUrlPathV1 {
        segments,
        trailing_slashes,
    })
}

fn observed_path_under_root_v1(root: &Url, observed: &Url) -> Option<DecodedUrlPathV1> {
    let root = decoded_url_path_v1(root)?;
    // webdav_root_v1 always serializes one trailing slash.  Treat any other
    // shape as corrupt instead of weakening the configured root boundary.
    if root.trailing_slashes != 1 {
        return None;
    }
    let observed = decoded_url_path_v1(observed)?;
    if !observed.segments.starts_with(&root.segments) {
        return None;
    }
    Some(observed)
}

fn directory_child_from_observed_href_v1(
    root: &Url,
    directory: &str,
    observed: &Url,
) -> Option<Option<String>> {
    let observed = observed_path_under_root_v1(root, observed)?;
    if observed.trailing_slashes > 1 {
        return None;
    }
    let root = decoded_url_path_v1(root)?;
    let directory_segments = directory.split('/').map(str::to_owned).collect::<Vec<_>>();
    let expected_len = root.segments.len() + directory_segments.len();
    if observed.segments.len() < expected_len
        || observed.segments[..root.segments.len()] != root.segments
        || observed.segments[root.segments.len()..expected_len] != directory_segments
    {
        return None;
    }
    match observed.segments.len() - expected_len {
        0 => Some(None),
        1 => {
            let child = observed.segments.last()?.clone();
            if safe_relative_path(&child).is_err() {
                return None;
            }
            Some(Some(child))
        }
        _ => None,
    }
}

fn semantic_path_matches_with_optional_trailing_slash_v1(
    root: &Url,
    expected: &Url,
    observed: &Url,
) -> bool {
    let Some(expected) = observed_path_under_root_v1(root, expected) else {
        return false;
    };
    let Some(observed) = observed_path_under_root_v1(root, observed) else {
        return false;
    };
    expected.trailing_slashes <= 1
        && observed.trailing_slashes <= 1
        && expected.segments == observed.segments
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CollectionProvisionResultV1 {
    Ready,
    AuthOrCapabilityFailure,
    Indeterminate,
}

fn collection_href_matches(root: &WebDavRootV1, path: &str, href: &str) -> bool {
    if !raw_dav_href_path_is_safe_v1(href) {
        return false;
    }
    let Ok(root_url) = Url::parse(&root.canonical_url) else {
        return false;
    };
    let Ok(expected) = child_url(root, path) else {
        return false;
    };
    let Ok(observed) = root_url.join(href) else {
        return false;
    };
    observed.origin() == root_url.origin()
        && observed.query().is_none()
        && observed.fragment().is_none()
        && semantic_path_matches_with_optional_trailing_slash_v1(&root_url, &expected, &observed)
}

fn is_success_http_status_line(status: &str) -> bool {
    let mut tokens = status.split_ascii_whitespace();
    let Some(version) = tokens.next() else {
        return false;
    };
    let Some(code) = tokens.next() else {
        return false;
    };
    version.starts_with("HTTP/")
        && code.len() == 3
        && code.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(code.parse::<u16>(), Ok(200..=299))
}

/// Verifies the one DAV fact needed after a concurrent MKCOL: the response
/// for this exact resource describes it as a DAV collection.  The parser is
/// intentionally narrower than discovery parsing: no listing data is trusted
/// from this response.
fn depth_zero_response_is_dav_collection(root: &WebDavRootV1, path: &str, xml: &[u8]) -> bool {
    #[derive(Clone)]
    struct Element {
        local: Vec<u8>,
        is_dav: bool,
    }
    #[derive(Default)]
    struct Propstat {
        has_collection: bool,
        status_success: Option<bool>,
    }
    #[derive(Default)]
    struct Response {
        href: Option<String>,
        collection: bool,
    }
    enum Capture {
        Href(String),
        ResponseStatus(String),
        PropstatStatus(String),
    }
    #[derive(Eq, PartialEq)]
    enum DocumentPhase {
        Before,
        Inside,
        After,
    }

    let mut reader = NsReader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut stack = Vec::<Element>::new();
    let mut response = None::<Response>;
    let mut propstat = None::<Propstat>;
    let mut capture = None::<Capture>;
    let mut matched = false;
    let mut root_closed = false;
    let mut phase = DocumentPhase::Before;
    let mut declaration_seen = false;
    let mut prolog_consumed = false;

    let start = |namespace: ResolveResult<'_>, local: Vec<u8>, stack: &mut Vec<Element>| {
        let is_dav = matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
        stack.push(Element { local, is_dav });
    };

    loop {
        match reader.read_resolved_event() {
            Ok((namespace, Event::Start(event))) => {
                if root_closed || phase == DocumentPhase::After {
                    return false;
                }
                let local = event.local_name().as_ref().to_vec();
                let depth = stack.len();
                let is_dav =
                    matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                if depth == 0 {
                    if phase != DocumentPhase::Before || !is_dav || local != b"multistatus" {
                        return false;
                    }
                    phase = DocumentPhase::Inside;
                }
                if depth == 1 {
                    if !is_dav || local != b"response" || response.is_some() {
                        return false;
                    }
                    response = Some(Response::default());
                } else if response.is_some() {
                    match (depth, local.as_slice()) {
                        (2, b"href") if is_dav && capture.is_none() => {
                            capture = Some(Capture::Href(String::new()));
                        }
                        (2, b"status") if is_dav && capture.is_none() => {
                            capture = Some(Capture::ResponseStatus(String::new()));
                        }
                        (2, b"propstat") if is_dav && propstat.is_none() => {
                            propstat = Some(Propstat::default());
                        }
                        (3, b"status")
                            if is_dav
                                && stack.last().is_some_and(|parent| {
                                    parent.is_dav && parent.local == b"propstat"
                                })
                                && capture.is_none() =>
                        {
                            capture = Some(Capture::PropstatStatus(String::new()));
                        }
                        (5, b"collection")
                            if is_dav
                                && matches!(
                                    stack.as_slice(),
                                    [
                                        Element { local, is_dav: true },
                                        Element { local: response, is_dav: true },
                                        Element { local: propstat, is_dav: true },
                                        Element { local: prop, is_dav: true },
                                        Element { local: resource_type, is_dav: true },
                                    ] if local == b"multistatus"
                                        && response == b"response"
                                        && propstat == b"propstat"
                                        && prop == b"prop"
                                        && resource_type == b"resourcetype"
                                ) =>
                        {
                            let Some(current) = propstat.as_mut() else {
                                return false;
                            };
                            current.has_collection = true;
                        }
                        _ => {}
                    }
                }
                start(namespace, local, &mut stack);
            }
            Ok((namespace, Event::Empty(event))) => {
                if root_closed || phase == DocumentPhase::After {
                    return false;
                }
                let local = event.local_name().as_ref().to_vec();
                let depth = stack.len();
                let is_dav =
                    matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                if depth == 0 {
                    if phase != DocumentPhase::Before || !is_dav || local != b"multistatus" {
                        return false;
                    }
                    phase = DocumentPhase::Inside;
                }
                if depth == 1 {
                    return false;
                }
                if depth == 5
                    && local == b"collection"
                    && is_dav
                    && matches!(
                        stack.as_slice(),
                        [
                            Element { local, is_dav: true },
                            Element { local: response, is_dav: true },
                            Element { local: propstat, is_dav: true },
                            Element { local: prop, is_dav: true },
                            Element { local: resource_type, is_dav: true },
                        ] if local == b"multistatus"
                            && response == b"response"
                            && propstat == b"propstat"
                            && prop == b"prop"
                            && resource_type == b"resourcetype"
                    )
                {
                    let Some(current) = propstat.as_mut() else {
                        return false;
                    };
                    current.has_collection = true;
                }
                start(namespace, local.clone(), &mut stack);
                let Some(closed) = stack.pop() else {
                    return false;
                };
                if closed.local != local || closed.is_dav != is_dav {
                    return false;
                }
                if local == b"multistatus" {
                    root_closed = true;
                    phase = DocumentPhase::After;
                }
            }
            Ok((_, Event::Text(event))) => {
                if let Some(value) = capture.as_mut() {
                    let Ok(text) = event.unescape() else {
                        return false;
                    };
                    match value {
                        Capture::Href(text_out)
                        | Capture::ResponseStatus(text_out)
                        | Capture::PropstatStatus(text_out) => text_out.push_str(&text),
                    }
                } else if stack.is_empty() {
                    let raw: &[u8] = event.as_ref();
                    if !raw.iter().all(|byte| is_xml_s(*byte)) {
                        return false;
                    }
                    if phase == DocumentPhase::Before {
                        prolog_consumed = true;
                    }
                }
            }
            Ok((_, Event::CData(event))) => {
                let Ok(text) = std::str::from_utf8(event.as_ref()) else {
                    return false;
                };
                let Some(value) = capture.as_mut() else {
                    return false;
                };
                match value {
                    Capture::Href(text_out)
                    | Capture::ResponseStatus(text_out)
                    | Capture::PropstatStatus(text_out) => text_out.push_str(text),
                }
            }
            Ok((namespace, Event::End(event))) => {
                let local = event.local_name().as_ref().to_vec();
                let is_dav =
                    matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:");
                let Some(closed) = stack.pop() else {
                    return false;
                };
                if closed.local != local || closed.is_dav != is_dav {
                    return false;
                }
                match local.as_slice() {
                    b"href" => {
                        let Some(Capture::Href(value)) = capture.take() else {
                            return false;
                        };
                        let Some(current) = response.as_mut() else {
                            return false;
                        };
                        if value.is_empty() || current.href.replace(value).is_some() {
                            return false;
                        }
                    }
                    b"status" => match capture.take() {
                        Some(Capture::ResponseStatus(value)) => {
                            if !is_success_http_status_line(&value) {
                                return false;
                            }
                        }
                        Some(Capture::PropstatStatus(value)) => {
                            let Some(current) = propstat.as_mut() else {
                                return false;
                            };
                            if current
                                .status_success
                                .replace(is_success_http_status_line(&value))
                                .is_some()
                            {
                                return false;
                            }
                        }
                        _ => return false,
                    },
                    b"propstat" => {
                        let Some(current_propstat) = propstat.take() else {
                            return false;
                        };
                        if current_propstat.has_collection
                            && current_propstat.status_success == Some(true)
                        {
                            let Some(current_response) = response.as_mut() else {
                                return false;
                            };
                            current_response.collection = true;
                        }
                    }
                    b"response" => {
                        let Some(current) = response.take() else {
                            return false;
                        };
                        let Some(href) = current.href else {
                            return false;
                        };
                        if collection_href_matches(root, path, &href) {
                            if matched || !current.collection {
                                return false;
                            }
                            matched = true;
                        }
                    }
                    b"multistatus" => {
                        if !stack.is_empty() || root_closed {
                            return false;
                        }
                        root_closed = true;
                        phase = DocumentPhase::After;
                    }
                    _ => {}
                }
            }
            Ok((_, Event::Comment(_) | Event::PI(_))) => {
                if phase == DocumentPhase::Before {
                    prolog_consumed = true;
                }
            }
            Ok((_, Event::Decl(declaration))) => {
                if phase != DocumentPhase::Before || declaration_seen || prolog_consumed {
                    return false;
                }
                if !validate_xml_declaration(&declaration) {
                    return false;
                }
                declaration_seen = true;
            }
            Ok((_, Event::DocType(_))) => return false,
            Ok((_, Event::Eof)) => {
                return phase == DocumentPhase::After
                    && root_closed
                    && stack.is_empty()
                    && capture.is_none()
                    && matched
            }
            Err(_) => return false,
        }
    }
}

pub struct WebDavS2RemoteV1 {
    config: WebDavS2ConfigV1,
    client: Client,
    prepared_immutable_paths: BTreeSet<String>,
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
            prepared_immutable_paths: BTreeSet::new(),
        })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&[u8]>,
        depth: Option<&str>,
    ) -> Result<(StatusCode, Vec<u8>), ()> {
        let url = child_url(&self.config.root, path).map_err(|_| ())?;
        let mut request = self
            .client
            .request(method, url)
            .basic_auth(&self.config.username, Some(&self.config.password));
        if let Some(depth) = depth {
            request = request.header("Depth", depth);
        }
        if let Some(bytes) = body {
            request = request.header("If-None-Match", "*").body(bytes.to_vec());
        }
        let response = request.send().map_err(|_| ())?;
        let limit = if depth.is_some() {
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
        match self.request(Method::GET, path, None, None) {
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
        let mut response_status_seen = false;
        let mut propstat_seen = false;
        let mut in_propstat = false;
        let mut propstat_status_seen = false;
        let mut prop_depth = None;
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
                    response_status_seen = false;
                    propstat_seen = false;
                    in_propstat = false;
                    propstat_status_seen = false;
                    prop_depth = None;
                } else if prop_depth.is_some() {
                    // A DAV:prop value is opaque provider data.  In
                    // particular, nested extension elements (or DAV names
                    // such as href/status) are not response control fields.
                } else if $is_dav && $local == b"prop" && depth == 3 && in_propstat {
                    prop_depth = Some(depth + 1);
                } else if $local == b"propstat" {
                    if !$is_dav || depth != 2 || in_propstat || response_status_seen {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    propstat_seen = true;
                    in_propstat = true;
                    propstat_status_seen = false;
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
                    if depth == 2 {
                        if response_status_seen || propstat_seen {
                            return DirectoryListResultV1::Indeterminate;
                        }
                        response_status_seen = true;
                    } else if depth == 3 && in_propstat {
                        if propstat_status_seen {
                            return DirectoryListResultV1::Indeterminate;
                        }
                        propstat_status_seen = true;
                    } else {
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
                if let Some(open_depth) = prop_depth {
                    if depth == open_depth {
                        if !$is_dav || $local != b"prop" {
                            return DirectoryListResultV1::Indeterminate;
                        }
                        prop_depth = None;
                    }
                } else if $local == b"href" {
                    if !$is_dav || !in_href || depth != 3 || text.is_empty() {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    response_href = Some(text.clone());
                    in_href = false;
                } else if $local == b"status" {
                    if !$is_dav || !in_status || !is_success_http_status_line(&text) {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    in_status = false;
                } else if $local == b"propstat" {
                    if !$is_dav
                        || depth != 3
                        || !in_propstat
                        || !propstat_status_seen
                        || in_status
                        || prop_depth.is_some()
                    {
                        return DirectoryListResultV1::Indeterminate;
                    }
                    in_propstat = false;
                } else if $local == b"response" {
                    if depth != 2
                        || !$is_dav
                        || response_href.is_none()
                        || in_propstat
                        || in_status
                        || prop_depth.is_some()
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
                    } else if prop_depth.is_some_and(|open_depth| depth > open_depth) {
                        if e.unescape().is_err() {
                            return DirectoryListResultV1::Indeterminate;
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
                    } else if prop_depth.is_some_and(|open_depth| depth > open_depth) {
                        if std::str::from_utf8(e.as_ref()).is_err() {
                            return DirectoryListResultV1::Indeterminate;
                        }
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
                    if phase == DocumentPhase::After
                        && depth == 0
                        && !in_href
                        && !in_status
                        && prop_depth.is_none() =>
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
        let mut entries = Vec::new();
        for href in hrefs {
            if !raw_dav_href_path_is_safe_v1(&href) {
                return DirectoryListResultV1::Indeterminate;
            }
            let Ok(url) = directory_url.join(&href) else {
                return DirectoryListResultV1::Indeterminate;
            };
            if url.origin() != root.origin() || url.query().is_some() || url.fragment().is_some() {
                return DirectoryListResultV1::Indeterminate;
            }
            match directory_child_from_observed_href_v1(&root, directory, &url) {
                Some(None) => {}
                Some(Some(child)) => entries.push(format!("{directory}/{child}")),
                None => return DirectoryListResultV1::Indeterminate,
            }
        }
        entries.sort();
        entries.dedup();
        DirectoryListResultV1::Entries(entries)
    }

    fn verify_collection(&self, path: &str) -> CollectionProvisionResultV1 {
        let response = match self.request(
            Method::from_bytes(b"PROPFIND").unwrap(),
            path,
            None,
            Some("0"),
        ) {
            Ok(value) => value,
            Err(()) => return CollectionProvisionResultV1::Indeterminate,
        };
        match response {
            (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _) => {
                CollectionProvisionResultV1::AuthOrCapabilityFailure
            }
            (StatusCode::MULTI_STATUS, xml)
                if depth_zero_response_is_dav_collection(&self.config.root, path, &xml) =>
            {
                CollectionProvisionResultV1::Ready
            }
            _ => CollectionProvisionResultV1::Indeterminate,
        }
    }

    fn ensure_collection(&self, path: &str) -> CollectionProvisionResultV1 {
        match self.request(Method::from_bytes(b"MKCOL").unwrap(), path, None, None) {
            Ok((StatusCode::CREATED, _)) => CollectionProvisionResultV1::Ready,
            Ok((StatusCode::METHOD_NOT_ALLOWED, _)) => self.verify_collection(path),
            Ok((StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _)) => {
                CollectionProvisionResultV1::AuthOrCapabilityFailure
            }
            _ => CollectionProvisionResultV1::Indeterminate,
        }
    }

    fn ensure_immutable_parent_collections(&self, path: &str) -> CollectionProvisionResultV1 {
        let parts = path.split('/').collect::<Vec<_>>();
        let parents = match parts.as_slice() {
            ["activations", _] => vec!["activations".to_string()],
            ["writers", writer_id, "segments", segment_name, _] => vec![
                "writers".to_string(),
                format!("writers/{writer_id}"),
                format!("writers/{writer_id}/segments"),
                format!("writers/{writer_id}/segments/{segment_name}"),
            ],
            _ => return CollectionProvisionResultV1::Indeterminate,
        };
        for parent in parents {
            match self.ensure_collection(&parent) {
                CollectionProvisionResultV1::Ready => {}
                result => return result,
            }
        }
        CollectionProvisionResultV1::Ready
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
    fn prepare_normal_s2_discovery_infrastructure(&mut self) -> RemotePutResultV1 {
        match self.ensure_collection("writers") {
            CollectionProvisionResultV1::Ready => RemotePutResultV1::Success,
            CollectionProvisionResultV1::AuthOrCapabilityFailure => {
                RemotePutResultV1::AuthOrCapabilityFailure
            }
            CollectionProvisionResultV1::Indeterminate => RemotePutResultV1::Indeterminate,
        }
    }
    fn prepare_immutable_parent_collections(&mut self, path: &str) -> RemotePutResultV1 {
        assert!(
            valid_immutable_object_path(path),
            "invalid_s2_immutable_path"
        );
        match self.ensure_immutable_parent_collections(path) {
            CollectionProvisionResultV1::Ready => {
                self.prepared_immutable_paths.insert(path.to_string());
                RemotePutResultV1::Success
            }
            CollectionProvisionResultV1::AuthOrCapabilityFailure => {
                RemotePutResultV1::AuthOrCapabilityFailure
            }
            CollectionProvisionResultV1::Indeterminate => RemotePutResultV1::Indeterminate,
        }
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
        if !self.prepared_immutable_paths.remove(path) {
            match self.ensure_immutable_parent_collections(path) {
                CollectionProvisionResultV1::Ready => {}
                CollectionProvisionResultV1::AuthOrCapabilityFailure => {
                    return RemotePutResultV1::AuthOrCapabilityFailure;
                }
                CollectionProvisionResultV1::Indeterminate => {
                    return RemotePutResultV1::Indeterminate
                }
            }
        }
        match self.request(Method::PUT, path, Some(bytes), None) {
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
        child_url, collection_href_matches, depth_zero_response_is_dav_collection,
        is_success_http_status_line, raw_dav_href_path_is_safe_v1, safe_relative_path,
        valid_discovery_directory, valid_immutable_object_path, webdav_root_v1, WebDavS2ConfigV1,
        WebDavS2RemoteV1,
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
    const WRITER_PATH: &str = "writers/123e4567-e89b-42d3-a456-426614174000/segments/00000000000000/00000000000000000001--123e4567-e89b-42d3-a456-426614174001--0000000000000000000000000000000000000000000000000000000000000000.json";

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

    fn depth_zero_collection_with_status(path: &str, status: &str) -> Vec<u8> {
        format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{path}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>{status}</d:status></d:propstat></d:response></d:multistatus>"
        )
        .into_bytes()
    }

    fn depth_zero_collection(path: &str) -> Vec<u8> {
        depth_zero_collection_with_status(path, "HTTP/1.1 200 OK")
    }

    fn depth_zero_non_collection(path: &str) -> Vec<u8> {
        format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{path}/</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"
        )
        .into_bytes()
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
            Some(response("201 Created", b"")),
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
        assert!(requests[2]
            .windows(binary.len())
            .any(|window| window == binary));
        assert!(String::from_utf8_lossy(&requests[2])
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[test]
    fn ignored_condition_put_success_has_no_verification_authority() {
        let prepared = vec![0, 255, 7, 0];
        let overwritten = vec![9, 9, 9];
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
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
        assert!(String::from_utf8_lossy(&received.lock().unwrap()[1])
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[test]
    fn fresh_activation_collections_precede_exact_file_put_without_file_headers() {
        let bytes = [0, 255, 7, 10];
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
            Some(response("201 Created", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &bytes, true),
            RemotePutResultV1::Success
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let collection = String::from_utf8_lossy(&requests[0]).to_ascii_lowercase();
        assert!(collection.starts_with("mkcol /dav/activations http/1.1"));
        assert!(!collection.contains("if-none-match"));
        assert!(!collection.contains("content-length:"));
        let file = String::from_utf8_lossy(&requests[1]).to_ascii_lowercase();
        assert!(file.starts_with("put /dav/activations/"));
        assert!(file.contains("if-none-match: *"));
        assert!(requests[1].ends_with(&bytes));
    }

    #[test]
    fn fresh_writer_collections_are_parent_first_before_exact_file_put() {
        let bytes = [1, 2, 3];
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
            Some(response("201 Created", b"")),
            Some(response("201 Created", b"")),
            Some(response("201 Created", b"")),
            Some(response("204 No Content", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.put_exact(WRITER_PATH, &bytes, true),
            RemotePutResultV1::Success
        );
        let requests = received.lock().unwrap();
        let request_lines = requests
            .iter()
            .map(|raw| {
                String::from_utf8_lossy(raw)
                    .lines()
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            request_lines,
            vec![
                "MKCOL /dav/writers HTTP/1.1".to_string(),
                "MKCOL /dav/writers/123e4567-e89b-42d3-a456-426614174000 HTTP/1.1"
                    .to_string(),
                "MKCOL /dav/writers/123e4567-e89b-42d3-a456-426614174000/segments HTTP/1.1"
                    .to_string(),
                "MKCOL /dav/writers/123e4567-e89b-42d3-a456-426614174000/segments/00000000000000 HTTP/1.1"
                    .to_string(),
                format!("PUT /dav/{WRITER_PATH} HTTP/1.1"),
            ]
        );
        for raw in requests.iter().take(4) {
            let text = String::from_utf8_lossy(raw).to_ascii_lowercase();
            assert!(!text.contains("if-none-match"));
            assert!(!text.contains("content-length:"));
        }
    }

    #[test]
    fn normal_discovery_infrastructure_strictly_prepares_only_writers() {
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
            Some(response("405 Method Not Allowed", b"")),
            Some(response(
                "207 Multi-Status",
                &depth_zero_collection("writers"),
            )),
            Some(response("401 Unauthorized", b"")),
            Some(response("500 Server Error", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.prepare_normal_s2_discovery_infrastructure(),
            RemotePutResultV1::Success
        );
        assert_eq!(
            webdav.prepare_normal_s2_discovery_infrastructure(),
            RemotePutResultV1::Success
        );
        assert_eq!(
            webdav.prepare_normal_s2_discovery_infrastructure(),
            RemotePutResultV1::AuthOrCapabilityFailure
        );
        assert_eq!(
            webdav.prepare_normal_s2_discovery_infrastructure(),
            RemotePutResultV1::Indeterminate
        );

        let requests = received.lock().unwrap();
        let request_lines = requests
            .iter()
            .map(|raw| {
                String::from_utf8_lossy(raw)
                    .lines()
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            request_lines,
            vec![
                "MKCOL /dav/writers HTTP/1.1",
                "MKCOL /dav/writers HTTP/1.1",
                "PROPFIND /dav/writers HTTP/1.1",
                "MKCOL /dav/writers HTTP/1.1",
                "MKCOL /dav/writers HTTP/1.1",
            ]
        );
        assert!(requests.iter().all(|raw| {
            let text = String::from_utf8_lossy(raw).to_ascii_lowercase();
            !text.starts_with("put ") && !text.contains("if-none-match")
        }));
        assert!(String::from_utf8_lossy(&requests[2])
            .to_ascii_lowercase()
            .contains("depth: 0"));
    }

    #[test]
    fn concurrent_existing_collection_is_verified_before_file_put() {
        let bytes = [4, 5, 6];
        let declared_collection = [
            b"<?xml version=\"1.0\"?>".as_slice(),
            depth_zero_collection("activations").as_slice(),
        ]
        .concat();
        let (url, received) = server(vec![
            Some(response("405 Method Not Allowed", b"")),
            Some(response("207 Multi-Status", &declared_collection)),
            Some(response("201 Created", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &bytes, true),
            RemotePutResultV1::Success
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(
            String::from_utf8_lossy(&requests[1]).starts_with("PROPFIND /dav/activations HTTP/1.1")
        );
        assert!(String::from_utf8_lossy(&requests[1])
            .to_ascii_lowercase()
            .contains("depth: 0"));
    }

    #[test]
    fn collection_depth_zero_status_lines_require_exact_2xx_codes() {
        for status in [
            "HTTP/1.1 200 OK",
            "HTTP/1.1 207 Multi-Status",
            "HTTP/1.1 299 Anything",
        ] {
            assert!(is_success_http_status_line(status), "{status}");
        }
        for status in [
            "HTTP/1.1 199 Nope",
            "HTTP/1.1 300 Nope",
            "HTTP/1.1 404 2 Nope",
            "HTTP/1.1 20 OK",
            "HTTP/1.1 2000 OK",
            "HTTP/1.1 xyz Nope",
        ] {
            assert!(!is_success_http_status_line(status), "{status}");
        }
    }

    #[test]
    fn malformed_depth_zero_status_or_document_never_reaches_file_put() {
        let bad_status =
            depth_zero_collection_with_status("activations", "HTTP/1.1 404 2 Not Found");
        let valid = depth_zero_collection("activations");
        let duplicate_declaration = [
            b"<?xml version=\"1.0\"?><?xml version=\"1.0\"?>".as_slice(),
            valid.as_slice(),
        ]
        .concat();
        let trailing_declaration =
            [valid.as_slice(), b"<?xml version=\"1.0\"?>".as_slice()].concat();
        let (url, received) = server(vec![
            Some(response("405 Method Not Allowed", b"")),
            Some(response("207 Multi-Status", &bad_status)),
            Some(response("405 Method Not Allowed", b"")),
            Some(response("207 Multi-Status", &duplicate_declaration)),
            Some(response("405 Method Not Allowed", b"")),
            Some(response("207 Multi-Status", &trailing_declaration)),
        ]);
        let mut webdav = remote(&url);
        for _ in 0..3 {
            assert_eq!(
                webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
                RemotePutResultV1::Indeterminate
            );
        }
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests
            .iter()
            .all(|raw| !String::from_utf8_lossy(raw).starts_with("PUT ")));
    }

    #[test]
    fn non_collection_or_provision_failure_never_reaches_file_put() {
        let failures = vec![
            Some(response("405 Method Not Allowed", b"")),
            Some(response(
                "207 Multi-Status",
                &depth_zero_non_collection("activations"),
            )),
            Some(response("401 Unauthorized", b"")),
            Some(response("403 Forbidden", b"")),
            Some(response("400 Bad Request", b"")),
            Some(response("409 Conflict", b"")),
            Some(response("500 Server Error", b"")),
            Some(redirect("/dav/activations")),
            Some(response("405 Method Not Allowed", b"")),
            Some(response("207 Multi-Status", b"<broken")),
        ];
        let (url, received) = server(failures);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
            RemotePutResultV1::Indeterminate
        );
        for _ in 0..2 {
            assert_eq!(
                webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
                RemotePutResultV1::AuthOrCapabilityFailure
            );
        }
        for _ in 0..5 {
            assert_eq!(
                webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
                RemotePutResultV1::Indeterminate
            );
        }
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, b"bytes", true),
            RemotePutResultV1::Indeterminate
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 10);
        assert!(requests
            .iter()
            .all(|raw| !String::from_utf8_lossy(raw).starts_with("PUT ")));
    }

    #[test]
    fn retry_after_existing_collection_keeps_exact_immutable_put_behavior() {
        let first = [0, 255, 1];
        let second = [2, 128, 3];
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
            Some(response("201 Created", b"")),
            Some(response("405 Method Not Allowed", b"")),
            Some(response(
                "207 Multi-Status",
                &depth_zero_collection("activations"),
            )),
            Some(response("204 No Content", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &first, true),
            RemotePutResultV1::Success
        );
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &second, true),
            RemotePutResultV1::Success
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 5);
        for index in [1_usize, 4] {
            let text = String::from_utf8_lossy(&requests[index]).to_ascii_lowercase();
            assert!(text.starts_with("put /dav/activations/"));
            assert!(text.contains("if-none-match: *"));
        }
        assert!(requests[1].ends_with(&first));
        assert!(requests[4].ends_with(&second));
    }

    #[test]
    fn admitted_preparation_is_consumed_by_the_exact_file_put() {
        let bytes = [0, 255, 7, 10];
        let (url, received) = server(vec![
            Some(response("201 Created", b"")),
            Some(response("404 Not Found", b"")),
            Some(response("201 Created", b"")),
        ]);
        let mut webdav = remote(&url);
        assert_eq!(
            ImmutableObjectRemoteV1::prepare_immutable_parent_collections(
                &mut webdav,
                ACTIVATION_PATH,
            ),
            RemotePutResultV1::Success
        );
        assert_eq!(
            ImmutableObjectRemoteV1::get_exact(&mut webdav, ACTIVATION_PATH),
            RemoteExactGetResultV1::DefinitelyAbsent
        );
        assert_eq!(
            webdav.put_exact(ACTIVATION_PATH, &bytes, true),
            RemotePutResultV1::Success
        );
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(String::from_utf8_lossy(&requests[0]).starts_with("MKCOL /dav/activations"));
        assert!(String::from_utf8_lossy(&requests[1]).starts_with("GET /dav/activations/"));
        assert!(String::from_utf8_lossy(&requests[2]).starts_with("PUT /dav/activations/"));
    }

    #[test]
    fn get_classifies_http_and_bounded_failures() {
        let huge = vec![b'x'; 8 * 1024 * 1024 + 1];
        let (url, _) = server(vec![
            Some(response("404 Not Found", b"")),
            Some(response("400 Bad Request", b"")),
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
            RemoteExactGetResultV1::Indeterminate
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
    fn depth_one_collection_self_href_is_exactly_delimited() {
        // Jianguoyun emits the collection self href without the trailing slash
        // while retaining the slash on direct children.
        let response_for = |hrefs: &[&str], status: &str| {
            let responses = hrefs
                .iter()
                .map(|href| {
                    format!(
                        "<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>{status}</d:status></d:propstat></d:response>"
                    )
                })
                .collect::<String>();
            format!("<d:multistatus xmlns:d=\"DAV:\">{responses}</d:multistatus>").into_bytes()
        };
        let no_trailing_self = response_for(
            &["/dav/activations", "/dav/activations/immutable.json"],
            "HTTP/1.1 200 OK",
        );
        let trailing_self = response_for(
            &["/dav/activations/", "/dav/activations/immutable.json"],
            "HTTP/1.1 200 OK",
        );
        let no_trailing_self_only = response_for(&["/dav/activations"], "HTTP/1.1 200 OK");
        let trailing_self_only = response_for(&["/dav/activations/"], "HTTP/1.1 200 OK");
        let double_trailing_self = response_for(&["/dav/activations//"], "HTTP/1.1 200 OK");
        let triple_trailing_self = response_for(&["/dav/activations///"], "HTTP/1.1 200 OK");
        let trailing_child = response_for(&["/dav/activations/immutable.json/"], "HTTP/1.1 200 OK");
        let double_trailing_child =
            response_for(&["/dav/activations/immutable.json//"], "HTTP/1.1 200 OK");
        let triple_trailing_child =
            response_for(&["/dav/activations/immutable.json///"], "HTTP/1.1 200 OK");
        let sibling_prefix = response_for(&["/dav/activations-evil"], "HTTP/1.1 200 OK");
        let nested_child = response_for(
            &["/dav/activations/immutable.json/nested.json"],
            "HTTP/1.1 200 OK",
        );
        let foreign_origin = response_for(
            &["https://evil.example/dav/activations/immutable.json"],
            "HTTP/1.1 200 OK",
        );
        let outside_root = response_for(&["/other/immutable.json"], "HTTP/1.1 200 OK");
        let query = response_for(
            &["/dav/activations/immutable.json?unexpected=1"],
            "HTTP/1.1 200 OK",
        );
        let fragment = response_for(
            &["/dav/activations/immutable.json#unexpected"],
            "HTTP/1.1 200 OK",
        );
        let duplicate_child = response_for(
            &[
                "/dav/activations",
                "/dav/activations/immutable.json",
                "/dav/activations/immutable.json",
            ],
            "HTTP/1.1 200 OK",
        );
        let malformed_success = response_for(
            &["/dav/activations/immutable.json"],
            "HTTP/1.1 404 2 Not Found",
        );
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", &no_trailing_self)),
            Some(response("207 Multi-Status", &trailing_self)),
            Some(response("207 Multi-Status", &no_trailing_self_only)),
            Some(response("207 Multi-Status", &trailing_self_only)),
            Some(response("207 Multi-Status", &double_trailing_self)),
            Some(response("207 Multi-Status", &triple_trailing_self)),
            Some(response("207 Multi-Status", &trailing_child)),
            Some(response("207 Multi-Status", &double_trailing_child)),
            Some(response("207 Multi-Status", &triple_trailing_child)),
            Some(response("207 Multi-Status", &sibling_prefix)),
            Some(response("207 Multi-Status", &nested_child)),
            Some(response("207 Multi-Status", &foreign_origin)),
            Some(response("207 Multi-Status", &outside_root)),
            Some(response("207 Multi-Status", &query)),
            Some(response("207 Multi-Status", &fragment)),
            Some(response("207 Multi-Status", &duplicate_child)),
            Some(response("207 Multi-Status", &malformed_success)),
        ]);
        let mut remote = remote(&url);
        let child = DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()]);
        assert_eq!(remote.list_directory("activations"), child);
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()])
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec![])
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec![])
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Indeterminate
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Indeterminate
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()])
        );
        for _ in 0..8 {
            assert_eq!(
                remote.list_directory("activations"),
                DirectoryListResultV1::Indeterminate
            );
        }
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()])
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Indeterminate
        );
    }

    #[test]
    fn percent_equivalent_dav_href_paths_are_segment_safe() {
        let response_for = |hrefs: &[String]| {
            let responses = hrefs
                .iter()
                .map(|href| {
                    format!(
                        "<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                    )
                })
                .collect::<String>();
            format!("<d:multistatus xmlns:d=\"DAV:\">{responses}</d:multistatus>").into_bytes()
        };
        let configured_component = "%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA-S1-Test";
        let provider_component = "%e5%bd%b1%e8%a7%86%e8%bf%bd%e8%b8%aa-S1-Test";
        let unicode_component = "影视追踪-S1-Test";
        let root_suffix = "i5-fresh-20260930-b";
        let child = "immutable.json";
        let (url, _) = server(vec![
            Some(response(
                "207 Multi-Status",
                &response_for(&[
                    format!("/dav/{provider_component}/{root_suffix}/activations"),
                    format!("/dav/{provider_component}/{root_suffix}/activations/{child}"),
                ]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[
                    format!("/dav/{unicode_component}/{root_suffix}/activations/"),
                    format!("/dav/{unicode_component}/{root_suffix}/activations/{child}/"),
                ]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}-evil/activations/{child}"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/%2Fescape/activations/{child}"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/%5Cescape/activations/{child}"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/immutable%2Fnested.json"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/{child}/nested.json"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/{child}//"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "https://evil.example/dav/{provider_component}/{root_suffix}/activations/{child}"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/{child}?unexpected=1"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/{child}#unexpected"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/{root_suffix}/activations/immutable%ZZ.json"
                )]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&["../activations/immutable.json".to_string()]),
            )),
            Some(response(
                "207 Multi-Status",
                &response_for(&[format!(
                    "/dav/{provider_component}/%2e%2e/{root_suffix}/activations/{child}"
                )]),
            )),
        ]);
        let mut remote = remote(&format!("{url}{configured_component}/{root_suffix}/"));
        let expected = DirectoryListResultV1::Entries(vec![format!("activations/{child}")]);
        assert_eq!(remote.list_directory("activations"), expected);
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec![format!("activations/{child}")])
        );
        for _ in 0..12 {
            assert_eq!(
                remote.list_directory("activations"),
                DirectoryListResultV1::Indeterminate
            );
        }
    }

    #[test]
    fn jianguoyun_like_property_values_replay_without_affecting_membership() {
        let configured_component = "%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA-S1-Test";
        let provider_component = "%e5%bd%b1%e8%a7%86%e8%bf%bd%e8%b8%aa-S1-Test";
        let root_suffix = "i5-fresh-20260930-b";
        let child = "immutable.json";
        let response_for = |href: String, collection: &str| {
            format!(
                "<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:getetag/><d:getcontenttype>application&amp;json</d:getcontenttype><d:displayname>provider display name</d:displayname><d:owner>provider owner</d:owner><d:getcontentlength>51</d:getcontentlength><d:getlastmodified>Tue, 30 Sep 2026 00:00:00 GMT</d:getlastmodified><d:resourcetype>{collection}</d:resourcetype><x:provider-value xmlns:x=\"urn:provider-extension\">extension value</x:provider-value></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            )
        };
        let body = format!(
            "<d:multistatus xmlns:d=\"DAV:\">{}{}</d:multistatus>",
            response_for(
                format!("/dav/{provider_component}/{root_suffix}/activations"),
                "<d:collection/>"
            ),
            response_for(
                format!("/dav/{provider_component}/{root_suffix}/activations/{child}"),
                ""
            ),
        );
        let (url, _) = server(vec![Some(response("207 Multi-Status", body.as_bytes()))]);
        let mut remote = remote(&format!("{url}{configured_component}/{root_suffix}/"));

        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec![format!("activations/{child}")])
        );
    }

    #[test]
    fn collection_href_matching_reuses_percent_equivalent_segment_containment() {
        let configured_component = "%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA-S1-Test";
        let provider_component = "%e5%bd%b1%e8%a7%86%e8%bf%bd%e8%b8%aa-S1-Test";
        let root_suffix = "i5-fresh-20260930-b";
        let root = webdav_root_v1(
            &format!("https://dav.example.test/dav/{configured_component}/{root_suffix}/"),
            "alice",
        )
        .unwrap();
        let matching_href = format!("/dav/{provider_component}/{root_suffix}/activations/");
        let absolute_matching_href =
            format!("https://dav.example.test/dav/{provider_component}/{root_suffix}/activations/");
        let outside_href = format!("/dav/{provider_component}/{root_suffix}-evil/activations/");
        assert!(collection_href_matches(
            &root,
            "activations",
            &matching_href
        ));
        assert!(collection_href_matches(
            &root,
            "activations",
            &absolute_matching_href
        ));
        assert!(!collection_href_matches(
            &root,
            "activations",
            &outside_href
        ));
        assert!(!collection_href_matches(
            &root,
            "activations",
            "../activations/immutable.json"
        ));

        let matching_xml = format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{matching_href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"
        );
        let outside_xml = format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{outside_href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"
        );
        let traversal_xml = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>../activations/immutable.json</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
        assert!(depth_zero_response_is_dav_collection(
            &root,
            "activations",
            matching_xml.as_bytes()
        ));
        assert!(!depth_zero_response_is_dav_collection(
            &root,
            "activations",
            outside_xml.as_bytes()
        ));
        assert!(!depth_zero_response_is_dav_collection(
            &root,
            "activations",
            traversal_xml.as_bytes()
        ));
    }

    #[test]
    fn raw_dav_href_validation_precedes_url_normalization() {
        for href in [
            ".",
            "..",
            "%2e",
            "%2E",
            "%2e%2e",
            "%2E%2E",
            ".%2e",
            ".%2E",
            "%2e.",
            "%2E.",
            "%2F",
            "%2f",
            "%5C",
            "%5c",
            "child%2Fgrandchild",
            "child%5Cgrandchild",
            "directory//child",
            "child%ZZ",
            "../activations/immutable.json",
            "/dav/root/%2e%2e/root/activations/immutable.json",
        ] {
            assert!(!raw_dav_href_path_is_safe_v1(href), "{href}");
        }
        for href in [
            "child",
            "/dav/root/activations/child",
            "https://dav.example.test/dav/root/activations/child",
            "/dav/%e5%bd%b1%e8%a7%86/root/activations/child",
        ] {
            assert!(raw_dav_href_path_is_safe_v1(href), "{href}");
        }
    }

    #[test]
    fn depth_one_dav_status_families_are_strict_and_non_mixing() {
        let response_for = |status_body: &str| {
            format!(
                "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/activations/immutable.json</d:href>{status_body}</d:response></d:multistatus>"
            )
            .into_bytes()
        };
        let propstat = |status: &str| {
            format!(
                "<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>{status}</d:status></d:propstat>"
            )
        };
        let response_404_then_propstat_200 = response_for(&format!(
            "<d:status>HTTP/1.1 404 Not Found</d:status>{}",
            propstat("HTTP/1.1 200 OK")
        ));
        let response_200_then_propstat_200 = response_for(&format!(
            "<d:status>HTTP/1.1 200 OK</d:status>{}",
            propstat("HTTP/1.1 200 OK")
        ));
        let duplicate_response_status = response_for(
            "<d:status>HTTP/1.1 200 OK</d:status><d:status>HTTP/1.1 200 OK</d:status>",
        );
        let duplicate_propstat_status = response_for(
            "<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status><d:status>HTTP/1.1 200 OK</d:status></d:propstat>",
        );
        let missing_propstat_status =
            response_for("<d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat>");
        let jianguoyun_propstat_200 = response_for(&propstat("HTTP/1.1 200 OK"));
        let fake_success = response_for(&propstat("HTTP/1.1 404 2 Not Found"));
        let (url, _) = server(vec![
            Some(response(
                "207 Multi-Status",
                &response_404_then_propstat_200,
            )),
            Some(response(
                "207 Multi-Status",
                &response_200_then_propstat_200,
            )),
            Some(response("207 Multi-Status", &duplicate_response_status)),
            Some(response("207 Multi-Status", &duplicate_propstat_status)),
            Some(response("207 Multi-Status", &missing_propstat_status)),
            Some(response("207 Multi-Status", &jianguoyun_propstat_200)),
            Some(response("207 Multi-Status", &fake_success)),
        ]);
        let mut remote = remote(&url);
        for _ in 0..5 {
            assert_eq!(
                remote.list_directory("activations"),
                DirectoryListResultV1::Indeterminate
            );
        }
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()])
        );
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Indeterminate
        );
    }

    #[test]
    fn propstat_property_values_are_opaque_but_control_text_remains_rejected() {
        let jianguoyun_like = concat!(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:x="urn:provider-extension"><d:response><d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop><d:getcontenttype>application&amp;json</d:getcontenttype><d:displayname>"#,
            "显示名",
            r#"</d:displayname><d:owner><![CDATA[owner <provider>]]></d:owner><x:extension>extension value</x:extension><d:reserved><d:href>/some/property/value</d:href><d:status>HTTP/1.1 404 Not Found</d:status><d:propstat><d:status>HTTP/1.1 500 Not Found</d:status></d:propstat></d:reserved></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#,
        )
        .as_bytes();
        let control_text_in_response = br#"<d:multistatus xmlns:d="DAV:"><d:response>unexpected<d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let control_text_in_multistatus = br#"<d:multistatus xmlns:d="DAV:">unexpected<d:response><d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let direct_text_in_prop = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop>unexpected</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let missing_real_propstat_status = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop><d:displayname>allowed property value</d:displayname></d:prop></d:propstat></d:response></d:multistatus>"#;
        let invalid_real_propstat_status = br#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/activations/immutable.json</d:href><d:propstat><d:prop><d:displayname>allowed property value</d:displayname></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>"#;
        let (url, _) = server(vec![
            Some(response("207 Multi-Status", jianguoyun_like)),
            Some(response("207 Multi-Status", control_text_in_response)),
            Some(response("207 Multi-Status", control_text_in_multistatus)),
            Some(response("207 Multi-Status", direct_text_in_prop)),
            Some(response("207 Multi-Status", missing_real_propstat_status)),
            Some(response("207 Multi-Status", invalid_real_propstat_status)),
        ]);
        let mut remote = remote(&url);

        // Nested DAV href/status are opaque property values.  The direct
        // response href and actual propstat status determine the listing.
        assert_eq!(
            remote.list_directory("activations"),
            DirectoryListResultV1::Entries(vec!["activations/immutable.json".into()])
        );
        for _ in 0..5 {
            assert_eq!(
                remote.list_directory("activations"),
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
