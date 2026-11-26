//! runs the whole server against a fake upstream and checks it like a browser.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::Bytes;
use components::bergamot::Bergamot;
use components::crlset::CrlSet;
use components::keys::Keys;
use components::ublock::UBlock;
use components::{Components, Config, Provider, serve};
use crx3::Signer as _;
use http_body_util::Full;
use hyper::service::service_fn;
use omaha_protocol::{AppStatus, Outcome, Pipeline, Response, Sha256, UpdateCheckError, v4};
use sha2::Digest;
use std::collections::HashMap;
use std::convert::Infallible;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;

const CUP_VERSION: u32 = 7;
const MODIFIED: u64 = 1_791_318_438_000;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
struct Upstream {
    base: Mutex<String>,
    files: Mutex<HashMap<String, Vec<u8>>>,
    fetched: Mutex<Vec<String>>,
}

impl Upstream {
    fn put(&self, path: &str, body: Vec<u8>) {
        self.files.lock().unwrap().insert(path.into(), body);
    }

    fn fetched(&self, suffix: &str) -> usize {
        let fetched = self.fetched.lock().unwrap();
        fetched.iter().filter(|p| p.ends_with(suffix)).count()
    }

    fn publish_models(&self) {
        let mut records = Vec::new();

        for (kind, data) in [
            ("model", &b"pretend model weights"[..]),
            ("lex", b"pretend lexical shortlist"),
            ("vocab", b"pretend sentencepiece vocab"),
        ] {
            let compressed = zstd::bulk::compress(data, 3).unwrap();
            let location = format!("models/{kind}.zst");
            records.push(serde_json::json!({
                "fileType": kind,
                "sourceLanguage": "de",
                "targetLanguage": "en",
                "version": "3.1",
                "architecture": "base-memory",
                "filter_expression": "",
                "attachment": {
                    "hash": hex(&sha2::Sha256::digest(&compressed)),
                    "size": compressed.len(),
                    "location": location,
                },
                "decompressedHash": hex(&sha2::Sha256::digest(data)),
                "decompressedSize": data.len(),
                "last_modified": MODIFIED,
            }));
            self.put(&format!("/attachments/{location}"), compressed);
        }

        let changeset = serde_json::json!({ "changes": records });
        self.put("/changeset", serde_json::to_vec(&changeset).unwrap());
    }

    fn publish_crlset(&self, sequence: u64) -> Vec<u8> {
        let build = format!("builds/{sequence}/");
        // hashes and serials, which deflate can't shrink
        let crl_set: Vec<u8> = (0..128)
            .flat_map(|i| sha2::Sha256::digest(format!("revoked as of {sequence}, {i}")))
            .collect();
        let manifest = format!(
            "{{\n  \"manifest_version\": 2,\n  \"name\": \"crl-set-{sequence}.data\",\n  \"version\": \"{sequence}\"\n}}\n"
        )
        .into_bytes();
        let sums = format!(
            "{}  crlset/standard/crl-set\n{}  crlset/standard/manifest.json\n",
            hex(&sha2::Sha256::digest(&crl_set)),
            hex(&sha2::Sha256::digest(&manifest)),
        );
        let latest = serde_json::json!({
            "sequence": sequence,
            "path": build,
            "sha256sums": hex(&sha2::Sha256::digest(sums.as_bytes())),
        });
        self.put(
            &format!("/crls/{build}crlset/standard/crl-set"),
            crl_set.clone(),
        );
        self.put(
            &format!("/crls/{build}crlset/standard/manifest.json"),
            manifest,
        );
        self.put(&format!("/crls/{build}SHA256SUMS"), sums.into_bytes());
        self.put("/crls/latest.json", serde_json::to_vec(&latest).unwrap());
        crl_set
    }

    fn publish_ublock(&self, version: &str, key: &crx3::aws_lc::EcdsaSigner) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(zip, r#"{{"manifest_version": 2, "version": "{version}"}}"#).unwrap();
        let archive = zip.finish().unwrap().into_inner();
        let crx = crx3::Builder::new().signer(key).build(&archive).unwrap();
        let name = format!("uBlock0_{version}.chromium.crx");
        let path = format!("/ublock/download/{name}");
        let release = serde_json::json!({
            "tag_name": version,
            "assets": [{
                "name": name,
                "browser_download_url": format!("{}{path}", self.base.lock().unwrap()),
                "size": crx.len(),
                "digest": format!("sha256:{}", hex(&sha2::Sha256::digest(&crx))),
            }],
        });
        self.put(&path, crx.clone());
        self.put("/ublock/latest", serde_json::to_vec(&release).unwrap());
        crx
    }
}

fn ublock_key() -> crx3::aws_lc::EcdsaSigner {
    Keys::new(b"ublock release ci").signer("ublock").unwrap()
}

async fn spawn<F, Fut>(listener: TcpListener, handler: F)
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

async fn upstream_service(
    upstream: Arc<Upstream>,
    request: http::Request<hyper::body::Incoming>,
) -> http::Response<Full<Bytes>> {
    let path = request.uri().path().to_owned();
    let body = upstream.files.lock().unwrap().get(&path).cloned();
    upstream.fetched.lock().unwrap().push(path);

    match body {
        Some(body) => http::Response::new(Full::new(Bytes::from(body))),
        None => http::Response::builder()
            .status(404)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    }
}

/// Takes a second per patch once `<puffin>.slow` exists.
fn fake_puffin(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join("puffin");
    std::fs::write(
        &path,
        "#!/bin/sh\ncase \"$1\" in\n  -puffdiff) [ -e \"$0.slow\" ] && sleep 1; printf %s \"$3\" > \"$4\" ;;\n  -puffpatch) cp \"$(cat \"$4\")\" \"$3\" ;;\nesac\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn failing_puffin(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join("puffin");
    std::fs::write(&path, "#!/bin/sh\necho run >> \"$0.runs\"\nexit 1\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

struct Setup {
    url: String,
    dir: PathBuf,
    upstream: Arc<Upstream>,
    components: Arc<Components>,
    cup: cup2::Client,
    key: crx3::aws_lc::EcdsaSigner,
}

async fn setup(
    data: &Path,
    upstream: Arc<Upstream>,
    key: crx3::aws_lc::EcdsaSigner,
    puffin: PathBuf,
) -> Setup {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    *upstream.base.lock().unwrap() = upstream_url.clone();
    let u = upstream.clone();
    spawn(listener, move |r| upstream_service(u.clone(), r)).await;

    let cup_key = cup2::aws_lc::MlDsa44Signer::generate(CUP_VERSION).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let components = Arc::new(
        Components::new(
            Config {
                dir: data.join("files"),
                base_url: format!("{url}/"),
                key: key.to_pkcs8().unwrap(),
                puffin: Some(puffin),
                cup_keys: vec![(CUP_VERSION, cup_key.to_pkcs8().unwrap())],
            },
            vec![
                Arc::new(Bergamot::new(
                    format!("{upstream_url}/changeset"),
                    format!("{upstream_url}/attachments/"),
                )) as Arc<dyn Provider>,
                Arc::new(CrlSet::new(
                    format!("{upstream_url}/crls/"),
                    "standard".into(),
                )),
                Arc::new(UBlock::new(
                    format!("{upstream_url}/ublock/latest"),
                    crx3::key_hash(ublock_key().public_key()),
                )),
            ],
        )
        .unwrap(),
    );
    components.start().await;
    tokio::spawn(serve(
        components.clone(),
        listener,
        16,
        std::future::pending(),
    ));

    Setup {
        url,
        dir: data.join("files"),
        upstream,
        components,
        cup: cup2::Client::new(cup2::KeyId::MlDsa44(CUP_VERSION), cup_key.public_key()).unwrap(),
        key,
    }
}

fn published() -> Arc<Upstream> {
    let upstream = Arc::new(Upstream::default());
    upstream.publish_models();
    upstream.publish_crlset(100);
    upstream
}

async fn fresh(data: &Path) -> Setup {
    let key = crx3::aws_lc::EcdsaSigner::generate().unwrap();
    setup(data, published(), key, fake_puffin(data)).await
}

impl Setup {
    fn appid(&self, name: &str) -> String {
        let keys = Keys::new(&self.key.to_pkcs8().unwrap());
        keys.appid(name).unwrap().as_str().to_owned()
    }

    async fn check(&self, appid: &str, version: &str, cached: Option<&Sha256>) -> Response {
        let cached = cached
            .map(|h| format!(r#","cached_items":[{{"sha256":"{h}"}}]"#))
            .unwrap_or_default();
        let body = format!(
            r#"{{"request":{{"protocol":"4.0","acceptformat":"crx3,download,puff","apps":[{{"appid":"{appid}","version":"{version}","updatecheck":{{}}{cached}}}]}}}}"#
        )
        .into_bytes();
        let request = self.cup.prepare(&body).unwrap();
        let response = reqwest::Client::new()
            .post(format!("{}/?{}", self.url, request.query()))
            .body(body)
            .send()
            .await
            .unwrap();
        let proof = response.headers()["x-cup-server-proof"]
            .to_str()
            .unwrap()
            .to_owned();
        let answer = response.bytes().await.unwrap();
        self.cup.verify(&request, &answer, &proof).unwrap();
        v4::decode_response(&answer).unwrap().response
    }

    /// Waits for `name`'s job to build `version` and every patch to it.
    async fn settled(&self, name: &str, version: &str) -> serde_json::Value {
        let path = self.dir.join(self.appid(name)).join("state.json");

        for _ in 0..200 {
            if let Ok(json) = std::fs::read(&path) {
                let state: serde_json::Value = serde_json::from_slice(&json).unwrap();
                let releases = state["releases"].as_array().unwrap();
                let newest = &releases[0];
                let tried = newest["patches"].as_array().unwrap().len()
                    + newest["unpatchable"].as_array().unwrap().len();

                if newest["version"] == version && tried == releases.len() - 1 {
                    return state;
                }
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        panic!("{name} {version} wasn't built with its patches");
    }

    async fn download(&self, response: &Response) -> Vec<u8> {
        let (url, size, sha256) = full(response);
        let fetched = reqwest::get(&url).await.unwrap();
        assert_eq!(
            fetched.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        let crx = fetched.bytes().await.unwrap();
        assert_eq!(crx.len() as u64, size);
        assert_eq!(
            Sha256::from_bytes(sha2::Sha256::digest(&crx).into()),
            sha256
        );
        let signed_by = crx3::verify(&crx, &crx3::Policy::default())
            .unwrap()
            .public_key;
        assert_eq!(
            crx3::id_from_public_key(&signed_by),
            response.apps[0].appid.as_str(),
            "signed with the app's own key"
        );
        crx.to_vec()
    }
}

fn pipelines(response: &Response) -> &[Pipeline] {
    match &response.apps[0].updatecheck.as_ref().unwrap().outcome {
        Outcome::Update { pipelines, .. } => pipelines,
        other => panic!("no update: {other:?}"),
    }
}

fn full(response: &Response) -> (String, u64, Sha256) {
    let (urls, sha256, size) = pipelines(response).last().unwrap().full_crx().unwrap();
    (urls[0].clone(), size, *sha256)
}

fn compression(crx: &[u8], name: &str) -> zip::CompressionMethod {
    let archive = crx3::split(crx).unwrap().archive;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive.to_vec())).unwrap();
    zip.by_name(name).unwrap().compression()
}

fn sha256(bytes: &[u8]) -> Sha256 {
    Sha256::from_bytes(sha2::Sha256::digest(bytes).into())
}

fn entry(crx: &[u8], name: &str) -> Vec<u8> {
    let archive = crx3::split(crx).unwrap().archive;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive.to_vec())).unwrap();
    let mut data = Vec::new();
    zip.by_name(name).unwrap().read_to_end(&mut data).unwrap();
    data
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_a_translation_pack_on_first_request() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let de_en = s.appid("translation-de-en");

    let (first, second) = tokio::join!(
        s.check(&de_en, "0.0.0.0", None),
        s.check(&de_en, "0.0.0.0", None)
    );
    assert_eq!(full(&second).0, full(&first).0, "one build serves both");
    assert!(
        full(&first)
            .0
            .starts_with(&format!("{}/files/{de_en}/", s.url))
    );
    assert_eq!(s.upstream.fetched("model.zst"), 1);

    let crx = s.download(&first).await;
    assert_eq!(entry(&crx, "model.bin"), b"pretend model weights");
    let manifest: serde_json::Value =
        serde_json::from_slice(&entry(&crx, "manifest.json")).unwrap();
    assert_eq!(manifest["version"], "1.1791318438");
    assert_eq!(manifest["translation"]["from"], "de");

    let current = s.check(&de_en, "1.1791318438", None).await;
    assert_eq!(
        current.apps[0].updatecheck.as_ref().unwrap().outcome,
        Outcome::NoUpdate
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn packs_opencrlsets_files_and_patches_from_cached_releases() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;

    let first = s.check(&s.appid("crlset"), "1", None).await;
    let old = s.download(&first).await;
    let published =
        s.upstream.files.lock().unwrap()["/crls/builds/100/crlset/standard/crl-set"].clone();
    assert_eq!(entry(&old, "crl-set"), published);
    assert_eq!(pipelines(&first).len(), 1);

    let crl_set = s.upstream.publish_crlset(101);
    s.components.refresh().await;
    let old_sha = Sha256::from_bytes(sha2::Sha256::digest(&old).into());
    let second = s.check(&s.appid("crlset"), "100", Some(&old_sha)).await;
    let new = s.download(&second).await;
    assert_eq!(entry(&new, "crl-set"), crl_set);

    let patch = &pipelines(&second)[0];
    assert_eq!(patch.id, "puff");
    let omaha_protocol::Operation::Download { urls, .. } = &patch.operations[0] else {
        panic!("{patch:?}");
    };
    assert_eq!(reqwest::get(&urls[0]).await.unwrap().status(), 200);

    let again = s.check(&s.appid("crlset"), "100", Some(&old_sha)).await;
    assert_eq!(pipelines(&again)[0].id, "puff", "the patch is kept");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_builds_across_restarts() {
    let data = tempfile::tempdir().unwrap();
    let first = fresh(data.path()).await;
    let de_en = first.appid("translation-de-en");
    let url = full(&first.check(&de_en, "0.0.0.0", None).await).0;

    let second = setup(
        data.path(),
        published(),
        first.key,
        fake_puffin(data.path()),
    )
    .await;
    let again = full(&second.check(&de_en, "0.0.0.0", None).await).0;
    assert_eq!(again.rsplit('/').next(), url.rsplit('/').next());
    assert_eq!(second.upstream.fetched("model.zst"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_from_saved_builds_while_upstream_is_down() {
    let data = tempfile::tempdir().unwrap();
    let first = fresh(data.path()).await;
    let crlset = first.appid("crlset");
    let url = full(&first.check(&crlset, "1", None).await).0;

    let down = Arc::new(Upstream::default());
    let second = setup(data.path(), down, first.key, fake_puffin(data.path())).await;
    let again = full(&second.check(&crlset, "1", None).await).0;
    assert_eq!(again.rsplit('/').next(), url.rsplit('/').next());
}

fn outcome(response: &Response) -> &Outcome {
    &response.apps[0].updatecheck.as_ref().unwrap().outcome
}

#[tokio::test(flavor = "multi_thread")]
async fn waits_out_a_failed_build_before_trying_again() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let de_en = s.appid("translation-de-en");
    s.upstream
        .files
        .lock()
        .unwrap()
        .remove("/attachments/models/model.zst");

    for _ in 0..2 {
        let response = s.check(&de_en, "0.0.0.0", None).await;
        assert_eq!(
            outcome(&response),
            &Outcome::Error(UpdateCheckError::Internal)
        );
    }

    assert_eq!(s.upstream.fetched("model.zst"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_up_on_a_patch_that_fails() {
    let data = tempfile::tempdir().unwrap();
    let key = crx3::aws_lc::EcdsaSigner::generate().unwrap();
    let puffin = failing_puffin(data.path());
    let s = setup(data.path(), published(), key, puffin.clone()).await;

    let old = s
        .download(&s.check(&s.appid("crlset"), "1", None).await)
        .await;
    s.upstream.publish_crlset(101);
    s.components.refresh().await;
    let old_sha = Sha256::from_bytes(sha2::Sha256::digest(&old).into());

    for _ in 0..2 {
        let response = s.check(&s.appid("crlset"), "100", Some(&old_sha)).await;
        let ids: Vec<&str> = pipelines(&response).iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["full"]);
    }

    let runs = std::fs::read_to_string(puffin.with_extension("runs")).unwrap();
    assert_eq!(runs.lines().count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_new_crlsets_and_their_patches_before_anyone_asks() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let crlset = s.appid("crlset");
    assert_eq!(
        s.upstream.fetched("standard/crl-set"),
        0,
        "nothing is built before a browser asks for it"
    );

    let old = s.download(&s.check(&crlset, "1", None).await).await;
    assert_eq!(compression(&old, "crl-set"), zip::CompressionMethod::Stored);

    s.upstream.publish_crlset(101);
    s.components.refresh().await;
    s.settled("crlset", "101").await;
    assert_eq!(s.upstream.fetched("builds/101/crlset/standard/crl-set"), 1);

    let started = Instant::now();
    let first = s.check(&crlset, "100", Some(&sha256(&old))).await;
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "nothing to wait for"
    );
    assert_eq!(pipelines(&first)[0].id, "puff");
}

#[tokio::test(flavor = "multi_thread")]
async fn patches_from_every_release_of_the_last_week() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let crlset = s.appid("crlset");
    let oldest = s.download(&s.check(&crlset, "1", None).await).await;

    for sequence in 101..=106 {
        s.upstream.publish_crlset(sequence);
        s.components.refresh().await;
        s.settled("crlset", &sequence.to_string()).await;
    }

    let response = s.check(&crlset, "100", Some(&sha256(&oldest))).await;
    assert_eq!(pipelines(&response)[0].id, "puff", "six releases behind");

    let dir = s.dir.join(&crlset);
    let mut crxs = 0;
    let mut patches = 0;

    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        if entry.path().is_dir() {
            patches += std::fs::read_dir(entry.path()).unwrap().count();
        } else if entry.path().extension().is_some_and(|e| e == "crx3") {
            crxs += 1;
        }
    }

    assert_eq!(crxs, 7, "every release is kept");
    assert_eq!(patches, 6, "only patches to the newest are kept");
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_once_its_own_patch_is_made() {
    let data = tempfile::tempdir().unwrap();
    let key = crx3::aws_lc::EcdsaSigner::generate().unwrap();
    let puffin = fake_puffin(data.path());
    let s = setup(data.path(), published(), key, puffin.clone()).await;
    let crlset = s.appid("crlset");
    let mut last = s.download(&s.check(&crlset, "1", None).await).await;

    for sequence in 101..=104 {
        s.upstream.publish_crlset(sequence);
        s.components.refresh().await;
        s.settled("crlset", &sequence.to_string()).await;
        last = s.download(&s.check(&crlset, "1", None).await).await;
    }

    // five patches to make, a second each: the newest source goes first
    std::fs::write(puffin.with_extension("slow"), "").unwrap();
    s.upstream.publish_crlset(105);
    s.components.refresh().await;
    let started = Instant::now();
    let response = s.check(&crlset, "104", Some(&sha256(&last))).await;
    assert_eq!(pipelines(&response)[0].id, "puff");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );

    let state = s.settled("crlset", "105").await;
    assert_eq!(state["releases"][0]["patches"].as_array().unwrap().len(), 5);
}

async fn raw_status(url: &str, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(url.trim_start_matches("http://"))
        .await
        .unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response.split(' ').nth(1).unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_unknown_apps_and_paths_outside_the_files() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let response = s.check("aaaabbbbccccddddaaaabbbbccccdddd", "1", None).await;
    assert_eq!(response.apps[0].status, AppStatus::UnknownApplication);
    assert_eq!(raw_status(&s.url, "/health").await, "200");

    let state = format!("/files/{}/state.json", s.appid("crlset"));
    s.check(&s.appid("crlset"), "1", None).await;

    for path in ["/files/../puffin", "/files/..%2fpuffin", &state] {
        assert_eq!(raw_status(&s.url, path).await, "404", "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_ublock_releases_as_published_if_signed_by_its_key() {
    let data = tempfile::tempdir().unwrap();
    let s = fresh(data.path()).await;
    let appid = crx3::id_from_public_key(ublock_key().public_key());

    let published = s.upstream.publish_ublock("1.76.4", &ublock_key());
    s.components.refresh().await;
    let first = s.check(&appid, "0.0.0.0", None).await;
    assert_eq!(s.download(&first).await, published);

    let stranger = crx3::aws_lc::EcdsaSigner::generate().unwrap();
    s.upstream.publish_ublock("1.76.5", &stranger);
    s.components.refresh().await;
    let refused = s.check(&appid, "1.76.4", None).await;
    assert_eq!(outcome(&refused), &Outcome::NoUpdate);

    let newer = s.upstream.publish_ublock("1.77.0", &ublock_key());
    s.components.refresh().await;
    let second = s.check(&appid, "1.76.4", None).await;
    assert_eq!(s.download(&second).await, newer);
}
