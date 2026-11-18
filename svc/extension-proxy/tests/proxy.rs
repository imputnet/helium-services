#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::Bytes;
use cup2::aws_lc::MlDsa44Signer;
use extension_proxy::{Config, Proxy, serve};
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use omaha_protocol::*;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

const UBOL: &str = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const OTHER: &str = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
const CRLSET: &str = "hfnkpimlhhgieaddgfemjhofmfblmnib";
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const CRX: &[u8] = b"Cr24 pretend this is a crx";

#[derive(Default)]
struct Seen {
    checks: Vec<(http::HeaderMap, String)>,
    snippets: Vec<(http::Method, http::HeaderMap, Bytes)>,
}

struct Google {
    cup: cup2::Server,
    tamper: bool,
    seen: Mutex<Seen>,
}

impl Google {
    fn answer(&self, body: &[u8]) -> Vec<u8> {
        let request = v4::decode_request(body, &Limits::default()).unwrap();
        let hash = sha256(CRX);
        let apps = request
            .apps
            .iter()
            .map(|app| {
                let mut answer = AppResponse::new(app.appid.clone(), AppStatus::Ok);
                let outcome = if app.appid.as_str() == UBOL || app.appid.as_str() == CRLSET {
                    Outcome::Update {
                        nextversion: "2.0".parse().unwrap(),
                        pipelines: vec![Pipeline {
                            id: "full".into(),
                            operations: vec![
                                Operation::Download {
                                    size: CRX.len() as u64,
                                    out: hash,
                                    urls: vec![
                                        "http://dl.example/a.crx".into(),
                                        "https://dl.example/a.crx".into(),
                                    ],
                                },
                                Operation::Crx3 {
                                    input: hash,
                                    size: None,
                                    path: None,
                                    arguments: None,
                                },
                            ],
                        }],
                    }
                } else {
                    Outcome::NoUpdate
                };
                let mut check = UpdateCheckResponse::new(outcome);
                check.info = Some("upstream-only detail".into());
                answer.updatecheck = Some(check);
                answer.cohort.id = Some("upstream-cohort".into());
                answer
            })
            .collect();
        v4::encode_response(&Response {
            apps,
            daystart: None,
            server: Some("fake".into()),
        })
        .unwrap()
    }
}

fn sha256(bytes: &[u8]) -> Sha256 {
    use aws_lc_rs::digest;
    let d = digest::digest(&digest::SHA256, bytes);
    Sha256::from_bytes(d.as_ref().try_into().unwrap())
}

async fn google_service(
    google: Arc<Google>,
    request: http::Request<hyper::body::Incoming>,
) -> http::Response<Full<Bytes>> {
    let (parts, body) = request.into_parts();
    let body = body.collect().await.unwrap().to_bytes();

    match parts.uri.path() {
        path if path.starts_with("/snippet/") => {
            google
                .seen
                .lock()
                .unwrap()
                .snippets
                .push((parts.method, parts.headers, body));
            http::Response::builder()
                .header("content-type", "application/x-protobuf")
                .body(Full::new(Bytes::from_static(b"\x0a\x03abc")))
                .unwrap()
        }
        "/versions" => http::Response::new(Full::new(Bytes::from(
            r#"[{"version":"150.0.7000.1"},{"version":"150.0.7000.2"}]"#,
        ))),
        "/update" => {
            let query = parts.uri.query().unwrap_or_default().to_owned();
            let param = |name: &str| {
                form_urlencoded::parse(query.as_bytes())
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.into_owned())
            };
            google
                .seen
                .lock()
                .unwrap()
                .checks
                .push((parts.headers, String::from_utf8_lossy(&body).into_owned()));
            let ticket = google
                .cup
                .ticket(
                    &param("cup2key").unwrap(),
                    param("cup2hreq").as_deref(),
                    &body,
                )
                .unwrap();
            let answer = google.answer(&body);
            let mut proof = google
                .cup
                .sign(&ticket, &answer)
                .unwrap()
                .as_str()
                .to_owned();

            if google.tamper {
                proof = proof.replacen('a', "b", 1);
            }

            http::Response::builder()
                .header("x-cup-server-proof", proof)
                .body(Full::new(Bytes::from(answer)))
                .unwrap()
        }
        _ => http::Response::builder()
            .status(404)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    }
}

fn spawn_server<F, Fut>(listener: TcpListener, handler: F)
where
    F: Fn(http::Request<hyper::body::Incoming>) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = http::Response<Full<Bytes>>> + Send + 'static,
{
    let service = service_fn(move |r| {
        let handler = handler.clone();
        async move { Ok::<_, Infallible>(handler(r).await) }
    });
    tokio::spawn(omaha_server::serve(
        listener,
        service,
        omaha_server::ServeOptions::default(),
        std::future::pending(),
    ));
}

struct Setup {
    google: Arc<Google>,
    proxy: String,
}

async fn setup(tamper: bool) -> Setup {
    let key = MlDsa44Signer::generate(16).unwrap();
    let spki = key.public_key().to_vec();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    let google = Arc::new(Google {
        cup: cup2::Server::new().with(key),
        tamper,
        seen: Mutex::new(Seen::default()),
    });
    let g = google.clone();
    spawn_server(listener, move |r| google_service(g.clone(), r));

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap().to_string();
    let proxy = Proxy::new(Config {
        upstream_url: format!("http://{base}/update"),
        upstream_cup: Some((cup2::KeyId::MlDsa44(16), spki)),
        chrome_versions_url: format!("http://{base}/versions"),
        snippet_url: format!("http://{base}/snippet/{{}}"),
        hmac_secret: Some("x".repeat(40)),
        proxy_base_url: Some(format!("http://{proxy_addr}")),
    })
    .unwrap();
    tokio::spawn(serve(
        Arc::new(proxy),
        proxy_listener,
        16,
        std::future::pending(),
    ));
    Setup {
        google,
        proxy: proxy_addr,
    }
}

fn check_body(apps: &[(&str, &str)]) -> String {
    let apps: Vec<String> = apps
        .iter()
        .map(|(id, v)| {
            format!(
                r#"{{"appid":"{id}","version":"{v}","brand":"GGLS","installdate":7000,"ping":{{"rd":7250,"ping_freshness":"{{11111111-2222-4333-8444-555555555555}}"}},"updatecheck":{{}}}}"#
            )
        })
        .collect();
    format!(
        r#"{{"request":{{"protocol":"4.0","acceptformat":"crx3,download","requestid":"{{aaaaaaaa-0000-4000-8000-000000000000}}","sessionid":"{{bbbbbbbb-0000-4000-8000-000000000000}}","prodversion":"157.0.1.2","apps":[{}]}}}}"#,
        apps.join(",")
    )
}

async fn post(http: &reqwest::Client, url: String, body: String) -> Response {
    let text = http
        .post(url)
        .header("user-agent", "Helium/157 test")
        .body(body)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    v4::decode_response(&text).unwrap().response
}

fn download_url(answer: &AppResponse) -> String {
    match &answer.updatecheck.as_ref().unwrap().outcome {
        Outcome::Update { pipelines, .. } => pipelines[0].full_crx().unwrap().0[0].clone(),
        other => panic!("no update: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrites_answers_and_hides_the_client() {
    let s = setup(false).await;
    let http = reqwest::Client::new();
    let response = post(
        &http,
        format!("http://{}/", s.proxy),
        check_body(&[(UBOL, "1.0"), (OTHER, "3.0")]),
    )
    .await;

    assert_eq!(response.apps.len(), 2);
    let ubol = &response.apps[0];
    assert_eq!(ubol.appid.as_str(), UBOL);
    assert_eq!(
        ubol.cohort,
        Cohort::default(),
        "upstream cohorts aren't passed on"
    );
    assert_eq!(ubol.updatecheck.as_ref().unwrap().info, None);
    let url = download_url(ubol);
    let prefix = format!(
        "http://{}/proxy?url=https%3A%2F%2Fdl.example%2Fa.crx&",
        s.proxy
    );
    assert!(url.starts_with(&prefix), "{url}");

    let seen = s.google.seen.lock().unwrap();
    let (headers, body) = &seen.checks[0];
    assert_eq!(headers["user-agent"], CHROME_UA);
    assert_eq!(headers["x-goog-update-interactivity"], "bg");
    for private in [
        "aaaaaaaa",
        "bbbbbbbb",
        "11111111",
        "GGLS",
        "installdate",
        "157.0.1.2",
        "\"rd\"",
    ] {
        assert!(
            !body.contains(private),
            "{private} reached upstream: {body}"
        );
    }
    assert!(
        body.contains("150.0.7000."),
        "presents a listed Chrome version: {body}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mixes_in_apps_others_asked_about() {
    let s = setup(false).await;
    let http = reqwest::Client::new();
    post(
        &http,
        format!("http://{}/", s.proxy),
        check_body(&[(UBOL, "1.0")]),
    )
    .await;
    let response = post(
        &http,
        format!("http://{}/", s.proxy),
        check_body(&[(OTHER, "3.0")]),
    )
    .await;

    assert_eq!(response.apps.len(), 1, "mixins aren't answered");
    assert_eq!(response.apps[0].appid.as_str(), OTHER);
    let seen = s.google.seen.lock().unwrap();
    let second = &seen.checks[1].0["x-goog-update-appid"];
    assert!(second.to_str().unwrap().contains(UBOL), "{second:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_answers_with_a_bad_cup_proof() {
    let s = setup(true).await;
    let http = reqwest::Client::new();
    let response = post(
        &http,
        format!("http://{}/", s.proxy),
        check_body(&[(UBOL, "1.0")]),
    )
    .await;
    assert_eq!(
        response.apps[0].updatecheck.as_ref().unwrap().outcome,
        Outcome::Error(UpdateCheckError::Internal)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn components_only_answer_the_crlset() {
    let s = setup(false).await;
    let http = reqwest::Client::new();
    let response = post(
        &http,
        format!("http://{}/com", s.proxy),
        check_body(&[(CRLSET, "1"), (UBOL, "1.0")]),
    )
    .await;
    assert!(matches!(
        response.apps[0].updatecheck.as_ref().unwrap().outcome,
        Outcome::Update { .. }
    ));
    assert_eq!(response.apps[1].status, AppStatus::UnknownApplication);
    let seen = s.google.seen.lock().unwrap();
    assert_eq!(seen.checks[0].0["x-goog-update-interactivity"], "fg");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_unsigned_downloads() {
    let s = setup(false).await;
    let http = reqwest::Client::new();
    let forged = format!(
        "http://{}/proxy?url=http%3A%2F%2Fexample.com%2F&sig=AAAA&exp=99999999999999",
        s.proxy
    );
    assert_eq!(http.get(forged).send().await.unwrap().status(), 400);
    let missing = format!("http://{}/proxy", s.proxy);
    assert_eq!(http.get(missing).send().await.unwrap().status(), 400);
    let health = format!("http://{}/health", s.proxy);
    assert_eq!(http.get(health).send().await.unwrap().status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_never_mix_in_the_clients_own_apps() {
    let s = setup(false).await;
    let http = reqwest::Client::new();
    post(
        &http,
        format!("http://{}/", s.proxy),
        check_body(&[(UBOL, "1.0")]),
    )
    .await;

    let ids: Vec<String> = (0..60)
        .map(|i: u32| {
            let digits = format!("{i:032x}");
            digits
                .chars()
                .map(|c| (b'a' + c.to_digit(16).unwrap() as u8) as char)
                .collect()
        })
        .collect();
    let mut apps: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), "1.0")).collect();
    apps.push((UBOL, "1.0"));
    let response = post(&http, format!("http://{}/", s.proxy), check_body(&apps)).await;

    assert_eq!(response.apps.len(), 61);
    assert!(matches!(
        response.apps[60].updatecheck.as_ref().unwrap().outcome,
        Outcome::Update { .. }
    ));
    let seen = s.google.seen.lock().unwrap();
    assert_eq!(seen.checks.len(), 3, "61 apps go up in two batches");
    let sent = seen.checks[1..]
        .iter()
        .flat_map(|(headers, _)| headers["x-goog-update-appid"].to_str().unwrap().split(','))
        .filter(|id| *id == UBOL)
        .count();
    assert_eq!(sent, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_for_snippets_as_chromium_does() {
    let s = setup(false).await;
    let response = reqwest::Client::new()
        .get(format!("http://{}/cws_snippet?id={UBOL}", s.proxy))
        .header("user-agent", "Helium/157 test")
        .header("cookie", "secret=1")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"\x0a\x03abc");

    let seen = s.google.seen.lock().unwrap();
    let (method, headers, body) = &seen.snippets[0];
    assert_eq!(method, http::Method::POST);
    assert_eq!(headers["x-http-method-override"], "GET");
    assert_eq!(headers["content-type"], "application/x-protobuf");
    assert_eq!(headers["user-agent"], CHROME_UA);
    assert!(
        headers
            .get("accept")
            .is_none_or(|a| a != "application/x-protobuf")
    );
    assert!(headers.get("cookie").is_none());
    let mut expected = vec![0x0a, 32];
    expected.extend_from_slice(UBOL.as_bytes());
    assert_eq!(body.as_ref(), expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_update2_requests() {
    let s = setup(false).await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let signed = format!(
        "http://{}/proxy?url=https%3A%2F%2Fdl.example%2Fa.crx&",
        s.proxy
    );

    let xml = http
        .get(format!("http://{}/?x=id%3D{UBOL}%26v%3D1.0%26uc", s.proxy))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(xml.contains(r#"version="2.0""#), "{xml}");
    let codebase = xml
        .split(r#"codebase=""#)
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .replace("&amp;", "&");
    assert!(codebase.starts_with(&signed), "{codebase}");

    let redirect = http
        .get(format!(
            "http://{}/?response=redirect&x=id%3D{UBOL}%26v%3D0.0.0.0%26uc",
            s.proxy
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), 302);
    let location = redirect.headers()["location"].to_str().unwrap().to_owned();
    assert!(location.starts_with(&signed), "{location}");

    let download = http.get(&location).send().await.unwrap();
    assert_eq!(
        download.status(),
        502,
        "signed and fetched, but dl.example is unreachable"
    );
}
