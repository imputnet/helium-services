use crate::signed::{UnwrapError, UrlSigner};
use bytes::Bytes;
use futures_util::TryStreamExt;
use http::header::{
    ACCEPT, ACCEPT_RANGES, CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderName, IF_MATCH,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, IF_RANGE, LAST_MODIFIED, RANGE, USER_AGENT, VARY,
};
use http::{HeaderMap, Method, StatusCode, request};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use omaha_protocol::is_valid_crx_id;
use std::time::{SystemTime, UNIX_EPOCH};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

const REQUEST_HEADERS: [HeaderName; 6] = [
    USER_AGENT,
    RANGE,
    IF_MATCH,
    IF_NONE_MATCH,
    IF_MODIFIED_SINCE,
    IF_RANGE,
];

const RESPONSE_HEADERS: [HeaderName; 6] = [
    CONTENT_TYPE,
    ETAG,
    LAST_MODIFIED,
    ACCEPT_RANGES,
    VARY,
    CONTENT_RANGE,
];

pub fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

pub fn error(status: StatusCode, text: &str) -> http::Response<Body> {
    let mut response = http::Response::new(full(format!("error {}: {text}", status.as_u16())));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, http::HeaderValue::from_static("text/plain"));
    response
}

fn filtered(from: &HeaderMap, names: &[HeaderName]) -> HeaderMap {
    let mut headers = HeaderMap::new();

    for name in names {
        if let Some(value) = from.get(name) {
            headers.insert(name.clone(), value.clone());
        }
    }

    headers
}

fn forward(upstream: reqwest::Response) -> http::Response<Body> {
    let status = upstream.status();
    let headers = filtered(upstream.headers(), &RESPONSE_HEADERS);
    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|e| Box::new(e) as BoxError);
    let mut response = http::Response::new(StreamBody::new(stream).boxed());
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub async fn proxy(
    http: &reqwest::Client,
    signer: Option<&UrlSigner>,
    parts: &request::Parts,
) -> http::Response<Body> {
    if parts.method != Method::GET {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let Some(signer) = signer else {
        return error(StatusCode::NOT_FOUND, "content proxying is disabled");
    };

    let url = match signer.unwrap(parts.uri.query().unwrap_or_default(), now_ms()) {
        Ok(url) => url,
        Err(UnwrapError::Expired) => return error(StatusCode::GONE, "URL expired"),
        Err(UnwrapError::BadSignature) => {
            return error(StatusCode::BAD_REQUEST, "signature verification failed");
        }
        Err(UnwrapError::Malformed) => return error(StatusCode::BAD_REQUEST, "malformed url"),
    };

    match http
        .get(url)
        .headers(filtered(&parts.headers, &REQUEST_HEADERS))
        .send()
        .await
    {
        Ok(upstream) => forward(upstream),
        Err(e) => {
            eprintln!("proxy: {e}");
            error(StatusCode::BAD_GATEWAY, "download failed")
        }
    }
}

pub async fn snippet(
    http: &reqwest::Client,
    url_template: &str,
    parts: &request::Parts,
) -> http::Response<Body> {
    if parts.method != Method::GET && parts.method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let id = form_urlencoded::parse(parts.uri.query().unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())
        .filter(|id| is_valid_crx_id(id));
    let Some(id) = id else {
        return error(StatusCode::BAD_REQUEST, "missing or invalid extension id");
    };

    match http
        .post(url_template.replace("{}", &id))
        .header(ACCEPT, "application/x-protobuf")
        .header(CONTENT_TYPE, "application/x-protobuf")
        .header("x-http-method-override", "GET")
        .send()
        .await
    {
        Ok(upstream) => forward(upstream),
        Err(e) => {
            eprintln!("snippet: {e}");
            error(StatusCode::BAD_GATEWAY, "snippet request failed")
        }
    }
}
