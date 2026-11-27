//! answers update checks: builds and signs releases when they're first
//! needed, makes puffin patches from older ones, and keeps them on disk.

use crate::BoxError;
use crate::keys::Keys;
use crate::provider::{Spec, SpecFile};
use omaha_diff::Differ;
use omaha_protocol::{
    App, AppId, AppResponse, AppStatus, Outcome, Protocol, Sha256, UpdateCheckError,
    UpdateCheckResponse, Version,
};
use omaha_server::index::{File, Patch, PatchFormat, Release};
use omaha_server::{BoxFuture, Check, Source};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

const MAX_DOWNLOAD: u64 = 256 << 20;
const MAX_FILE: u64 = 512 << 20;
const PARALLEL_WORK: usize = 2;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const DIFF_TIMEOUT: Duration = Duration::from_secs(300);
const KEEP: usize = 4;
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_KEEP: usize = 32;
/// Releases whose patches are kept: the newest, which is offered, and the one
/// before it, so a patch offered just before a build can still be fetched.
const PATCHED: usize = 2;
const MAX_PATCH_RATIO: f64 = 0.8;
const STORE_RATIO: f64 = 0.8;
const WAIT: Duration = Duration::from_secs(15);
const BUILD_RETRY: Duration = Duration::from_secs(600);

pub struct BuildConfig {
    pub dir: PathBuf,
    pub base: String,
    pub puffin: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct State {
    releases: Vec<Built>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Built {
    version: String,
    sha256: String,
    size: u64,
    /// When it became the newest, in unix seconds.
    #[serde(default)]
    built: u64,
    #[serde(default)]
    patches: Vec<BuiltPatch>,
    #[serde(default)]
    unpatchable: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BuiltPatch {
    from: String,
    sha256: String,
    size: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn crx_path(appid: &AppId, sha256: &str) -> String {
    format!("{appid}/{sha256}.crx3")
}

fn patch_path(appid: &AppId, to: &str, from: &str) -> String {
    format!("{appid}/{to}/{from}.puff")
}

impl Built {
    fn release(&self, appid: &AppId) -> Option<Release> {
        let mut release = Release::new(
            self.version.parse().ok()?,
            File {
                path: crx_path(appid, &self.sha256),
                sha256: self.sha256.parse().ok()?,
                size: self.size,
            },
        );

        for patch in &self.patches {
            release.patches.push(Patch {
                format: PatchFormat::Puff,
                from: patch.from.parse().ok()?,
                file: File {
                    path: patch_path(appid, &self.sha256, &patch.from),
                    sha256: patch.sha256.parse().ok()?,
                    size: patch.size,
                },
            });
        }

        Some(release)
    }

    fn has_patch_from(&self, from: &str) -> bool {
        self.patches.iter().any(|p| p.from == from) || self.unpatchable.iter().any(|u| u == from)
    }
}

/// Keeps the newest `KEEP` releases, and older ones that were the newest
/// within `KEEP_FOR`.
fn retain(releases: &mut Vec<Built>, now: u64) {
    let recent = releases
        .iter()
        .take_while(|b| now.saturating_sub(b.built) < KEEP_FOR.as_secs())
        .count();
    releases.truncate((recent + 1).clamp(KEEP, MAX_KEEP));
}

fn internal(appid: &AppId) -> AppResponse {
    let mut answer = AppResponse::new(appid.clone(), AppStatus::Ok);
    answer.updatecheck = Some(UpdateCheckResponse::new(Outcome::Error(
        UpdateCheckError::Internal,
    )));
    answer
}

fn contents(file: &SpecFile, download: &[u8]) -> Result<Vec<u8>, BoxError> {
    if sha2::Sha256::digest(download).as_slice() != file.sha256 {
        return Err(format!("{}: hash mismatch", file.url).into());
    }

    let Some((size, sha256)) = file.zstd else {
        return Ok(download.to_vec());
    };

    if size > MAX_FILE {
        return Err(format!("{}: too large", file.url).into());
    }

    let data = zstd::bulk::decompress(download, size as usize)?;

    if data.len() as u64 != size || sha2::Sha256::digest(&data).as_slice() != sha256 {
        return Err(format!("{}: decompressed contents mismatch", file.url).into());
    }

    Ok(data)
}

fn manifest_version(json: &[u8]) -> Option<Version> {
    let manifest: serde_json::Value = serde_json::from_slice(json).ok()?;
    manifest.get("version")?.as_str()?.parse().ok()
}

/// Stores files that deflate barely shrinks, like the crlset, since deflate
/// makes their patches much larger.
fn compression(data: &[u8]) -> zip::CompressionMethod {
    let deflated = std::io::copy(
        &mut flate2::read::DeflateEncoder::new(data, flate2::Compression::default()),
        &mut std::io::sink(),
    );

    match deflated {
        Ok(size) if (size as f64) < data.len() as f64 * STORE_RATIO => {
            zip::CompressionMethod::Deflated
        }
        _ => zip::CompressionMethod::Stored,
    }
}

fn crx(
    spec: &Spec,
    files: Vec<(String, Vec<u8>)>,
    signer: &dyn crx3::Signer,
) -> Result<Vec<u8>, BoxError> {
    let mut entries = files;

    match &spec.manifest {
        Some(manifest) => {
            entries.push(("manifest.json".into(), serde_json::to_vec_pretty(manifest)?))
        }
        None => {
            let version = entries
                .iter()
                .find(|(name, _)| name == "manifest.json")
                .and_then(|(_, json)| manifest_version(json));

            if version.as_ref() != Some(&spec.version) {
                return Err(format!(
                    "{}: manifest.json isn't version {}",
                    spec.label, spec.version
                )
                .into());
            }
        }
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);

    for (name, data) in entries {
        zip.start_file(name, options.compression_method(compression(&data)))?;
        zip.write_all(&data)?;
    }

    let archive = zip.finish()?.into_inner();
    Ok(crx3::Builder::new().signer(signer).build(&archive)?)
}

/// Checks a crx that was signed elsewhere: by `key`, as the app, and with
/// the version its spec says.
fn signed(
    spec: &Spec,
    files: Vec<(String, Vec<u8>)>,
    key: crx3::KeyHash,
) -> Result<Vec<u8>, BoxError> {
    let [(_, crx)]: [_; 1] = files
        .try_into()
        .map_err(|_| format!("{}: expected one crx", spec.label))?;
    let verified = crx3::verify(&crx, &crx3::Policy::new().required_keys(&[key]))?;

    if verified.id != spec.appid.as_str() {
        return Err(format!("{}: crx is {}, not {}", spec.label, verified.id, spec.appid).into());
    }

    let mut zip = zip::ZipArchive::new(Cursor::new(crx3::split(&crx)?.archive))?;
    let mut json = Vec::new();
    zip.by_name("manifest.json")?.read_to_end(&mut json)?;

    if manifest_version(&json).as_ref() != Some(&spec.version) {
        return Err(format!(
            "{}: manifest.json isn't version {}",
            spec.label, spec.version
        )
        .into());
    }

    Ok(crx)
}

async fn write(path: &Path, bytes: &[u8]) -> Result<(), BoxError> {
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    tokio::fs::write(&partial, bytes).await?;
    tokio::fs::rename(&partial, path).await?;
    Ok(())
}

pub struct Builds {
    http: reqwest::Client,
    config: BuildConfig,
    keys: Arc<Keys>,
    catalogs: RwLock<HashMap<&'static str, Arc<HashMap<AppId, Spec>>>>,
    states: Mutex<HashMap<AppId, State>>,
    jobs: Mutex<HashMap<AppId, watch::Receiver<bool>>>,
    failed: Mutex<HashMap<AppId, (Version, Instant)>>,
    work: Semaphore,
}

impl Builds {
    pub fn new(http: reqwest::Client, config: BuildConfig, keys: Arc<Keys>) -> Self {
        let states = Self::load(&config.dir);
        Builds {
            http,
            config,
            keys,
            catalogs: RwLock::default(),
            states: Mutex::new(states),
            jobs: Mutex::default(),
            failed: Mutex::default(),
            work: Semaphore::new(PARALLEL_WORK),
        }
    }

    fn load(dir: &Path) -> HashMap<AppId, State> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return HashMap::new();
        };

        entries
            .flatten()
            .filter_map(|entry| {
                let appid = AppId::new(entry.file_name().to_str()?)?;
                let json = std::fs::read(entry.path().join("state.json")).ok()?;
                Some((appid, serde_json::from_slice(&json).ok()?))
            })
            .collect()
    }

    pub fn set_catalog(&self, provider: &'static str, specs: Vec<Spec>) {
        let specs = specs.into_iter().map(|s| (s.appid.clone(), s)).collect();

        if let Ok(mut catalogs) = self.catalogs.write() {
            catalogs.insert(provider, Arc::new(specs));
        }
    }

    fn spec(&self, appid: &AppId) -> Option<Spec> {
        let catalogs = self.catalogs.read().ok()?;
        catalogs.values().find_map(|c| c.get(appid).cloned())
    }

    fn state(&self, appid: &AppId) -> State {
        self.states
            .lock()
            .ok()
            .and_then(|s| s.get(appid).cloned())
            .unwrap_or_default()
    }

    async fn save(&self, appid: &AppId, state: State) -> Result<(), BoxError> {
        let dir = self.config.dir.join(appid.as_str());
        tokio::fs::create_dir_all(&dir).await?;
        write(&dir.join("state.json"), &serde_json::to_vec(&state)?).await?;

        if let Ok(mut states) = self.states.lock() {
            states.insert(appid.clone(), state);
        }

        Ok(())
    }

    async fn download(&self, file: &SpecFile) -> Result<Vec<u8>, BoxError> {
        if file.size.is_some_and(|size| size > MAX_DOWNLOAD) {
            return Err(format!("{}: too large", file.url).into());
        }

        let mut response = self
            .http
            .get(&file.url)
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        let mut bytes = Vec::new();

        while let Some(chunk) = response.chunk().await? {
            bytes.extend_from_slice(&chunk);

            if bytes.len() as u64 > file.size.unwrap_or(MAX_DOWNLOAD) {
                return Err(format!("{}: larger than expected", file.url).into());
            }
        }

        if file.size.is_some_and(|size| bytes.len() as u64 != size) {
            return Err(format!("{}: shorter than expected", file.url).into());
        }

        Ok(bytes)
    }

    async fn build(&self, spec: &Spec) -> Result<(), BoxError> {
        let _work = self.work.acquire().await?;
        let mut downloads = Vec::new();

        for file in &spec.files {
            downloads.push((file.clone(), self.download(file).await?));
        }

        let keys = self.keys.clone();
        let task_spec = spec.clone();
        let crx = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, BoxError> {
            let files = downloads
                .iter()
                .map(|(file, bytes)| Ok((file.name.clone(), contents(file, bytes)?)))
                .collect::<Result<Vec<_>, BoxError>>()?;

            match task_spec.signed_by {
                Some(key) => signed(&task_spec, files, key),
                None => crx(&task_spec, files, &keys.signer(&task_spec.label)?),
            }
        })
        .await??;

        let sha256 = hex(&sha2::Sha256::digest(&crx));
        let dir = self.config.dir.join(spec.appid.as_str());
        tokio::fs::create_dir_all(&dir).await?;
        write(&dir.join(format!("{sha256}.crx3")), &crx).await?;

        let mut state = self.state(&spec.appid);
        state.releases.insert(
            0,
            Built {
                version: spec.version.to_string(),
                sha256,
                size: crx.len() as u64,
                built: now(),
                patches: Vec::new(),
                unpatchable: Vec::new(),
            },
        );
        retain(&mut state.releases, now());

        for older in state.releases.iter_mut().skip(PATCHED) {
            older.patches.clear();
            older.unpatchable.clear();
        }

        self.save(&spec.appid, state.clone()).await?;
        prune(&dir, &state).await;
        eprintln!(
            "built {} {} ({} bytes)",
            spec.label,
            spec.version,
            crx.len()
        );
        Ok(())
    }

    async fn diff(
        &self,
        appid: &AppId,
        puffin: &Path,
        from: &str,
        to: &str,
    ) -> Result<Option<BuiltPatch>, BoxError> {
        let dir = self.config.dir.join(appid.as_str());
        let old = tokio::fs::read(dir.join(format!("{from}.crx3"))).await?;
        let new = tokio::fs::read(dir.join(format!("{to}.crx3"))).await?;
        let full = new.len();
        let differ = Differ::puffin(puffin).timeout(DIFF_TIMEOUT);
        let patch = tokio::task::spawn_blocking(move || differ.diff(&old, &new)).await??;

        if patch.len() as f64 > full as f64 * MAX_PATCH_RATIO {
            return Ok(None);
        }

        tokio::fs::create_dir_all(dir.join(to)).await?;
        write(&dir.join(to).join(format!("{from}.puff")), &patch).await?;
        Ok(Some(BuiltPatch {
            from: from.into(),
            sha256: hex(&sha2::Sha256::digest(&patch)),
            size: patch.len() as u64,
        }))
    }

    async fn patch(&self, spec: &Spec, puffin: &Path, from: &str) -> Result<(), BoxError> {
        let _work = self.work.acquire().await?;
        let mut state = self.state(&spec.appid);
        let Some(to) = state.releases.first().map(|b| b.sha256.clone()) else {
            return Ok(());
        };
        let made = self.diff(&spec.appid, puffin, from, &to).await;
        let Some(newest) = state.releases.first_mut() else {
            return Ok(());
        };

        // a failed diff isn't retried, or every check from that cache would rerun it
        match made {
            Ok(Some(patch)) => newest.patches.push(patch),
            Ok(None) => newest.unpatchable.push(from.into()),
            Err(e) => {
                eprintln!("patching {} from {from}: {e}", spec.label);
                newest.unpatchable.push(from.into());
            }
        }

        self.save(&spec.appid, state).await
    }

    fn needs_build(&self, spec: &Spec) -> bool {
        let built = self
            .state(&spec.appid)
            .releases
            .first()
            .and_then(|b| b.version.parse::<Version>().ok());

        if built.is_some_and(|v| v >= spec.version) {
            return false;
        }

        let failed = self
            .failed
            .lock()
            .ok()
            .and_then(|f| f.get(&spec.appid).cloned());
        !failed.is_some_and(|(version, at)| version == spec.version && at.elapsed() < BUILD_RETRY)
    }

    fn patch_source(&self, appid: &AppId, cached: &[String]) -> Option<String> {
        self.config.puffin.as_ref()?;
        let state = self.state(appid);
        let (newest, older) = state.releases.split_first()?;
        cached
            .iter()
            .find(|c| older.iter().any(|b| b.sha256 == **c) && !newest.has_patch_from(c))
            .cloned()
    }

    async fn prepare(&self, spec: &Spec, cached: &[String]) -> Result<(), BoxError> {
        if self.needs_build(spec)
            && let Err(e) = self.build(spec).await
        {
            if let Ok(mut failed) = self.failed.lock() {
                failed.insert(spec.appid.clone(), (spec.version.clone(), Instant::now()));
            }

            return Err(format!("building {}: {e}", spec.label).into());
        }

        if let (Some(puffin), Some(from)) =
            (&self.config.puffin, self.patch_source(&spec.appid, cached))
        {
            self.patch(spec, puffin, &from).await?;
        }

        Ok(())
    }

    /// Runs `prepare` in the background, once per app at a time; the
    /// receiver turns true when it's done.
    fn start(self: &Arc<Self>, spec: Spec, cached: Vec<String>) -> watch::Receiver<bool> {
        let Ok(mut jobs) = self.jobs.lock() else {
            return watch::channel(true).1;
        };

        if let Some(running) = jobs.get(&spec.appid) {
            return running.clone();
        }

        let (done, receiver) = watch::channel(false);
        jobs.insert(spec.appid.clone(), receiver.clone());
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(e) = this.prepare(&spec, &cached).await {
                eprintln!("{e}");
            }

            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.remove(&spec.appid);
            }

            let _ = done.send(true);
        });
        receiver
    }

    async fn answer(
        self: &Arc<Self>,
        check: &Check<'_>,
        app: &App,
        deadline: Instant,
    ) -> AppResponse {
        let spec = self.spec(&app.appid);
        let known = spec.is_some();
        let wanted = spec.filter(|spec| {
            app.updatecheck.as_ref().is_some_and(|c| !c.updatedisabled)
                && app.version.as_ref().is_none_or(|v| *v < spec.version)
        });
        let wants = wanted.is_some();

        if let Some(spec) = wanted {
            let cached: Vec<String> =
                if check.protocol == Protocol::V4 && check.client.accepts("puff") {
                    app.cached.iter().map(Sha256::to_string).collect()
                } else {
                    Vec::new()
                };

            // anything that isn't done by the deadline is offered on a later check
            if self.needs_build(&spec) || self.patch_source(&spec.appid, &cached).is_some() {
                let mut done = self.start(spec, cached);
                let _ = tokio::time::timeout_at(deadline, done.wait_for(|done| *done)).await;
            }
        }

        let releases: Vec<Release> = self
            .state(&app.appid)
            .releases
            .iter()
            .filter_map(|b| b.release(&app.appid))
            .collect();

        // saved releases keep answering while their provider can't be fetched
        if !known && releases.is_empty() {
            return AppResponse::new(app.appid.clone(), AppStatus::UnknownApplication);
        }

        if wants && releases.is_empty() {
            return internal(&app.appid);
        }

        omaha_server::index::answer(
            &releases,
            check.protocol,
            check.client,
            app,
            std::slice::from_ref(&self.config.base),
        )
    }
}

/// Removes crxs that `state` no longer lists, and patches to releases older
/// than the `PATCHED` newest.
async fn prune(dir: &Path, state: &State) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let kept = match name.strip_suffix(".crx3") {
            Some(sha256) => state.releases.iter().any(|b| b.sha256 == sha256),
            None => {
                name == "state.json"
                    || state
                        .releases
                        .iter()
                        .take(PATCHED)
                        .any(|b| b.sha256 == name)
            }
        };

        if !kept {
            let path = entry.path();
            let _ = match entry.file_type().await {
                Ok(t) if t.is_dir() => tokio::fs::remove_dir_all(path).await,
                _ => tokio::fs::remove_file(path).await,
            };
        }
    }
}

pub struct Shared(pub Arc<Builds>);

impl Source for Shared {
    fn check<'a>(&'a self, check: Check<'a>) -> BoxFuture<'a, Vec<AppResponse>> {
        Box::pin(async move {
            let deadline = Instant::now() + WAIT;
            let mut answers = Vec::with_capacity(check.apps.len());

            for app in check.apps {
                answers.push(self.0.answer(&check, app, deadline).await);
            }

            answers
        })
    }

    fn labels_app(&self, appid: &AppId) -> bool {
        self.0.spec(appid).is_some() || !self.0.state(appid).releases.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_releases_from_saved_state() {
        let built = Built {
            version: "29903472".into(),
            sha256: "ab".repeat(32),
            size: 7,
            built: 0,
            patches: vec![BuiltPatch {
                from: "cd".repeat(32),
                sha256: "ef".repeat(32),
                size: 3,
            }],
            unpatchable: Vec::new(),
        };
        let appid = AppId::new("hfnkpimlhhgieaddgfemjhofmfblmnib").unwrap();
        let release = built.release(&appid).unwrap();
        assert_eq!(
            release.crx.path,
            format!("{appid}/{}.crx3", "ab".repeat(32))
        );
        assert_eq!(release.patches[0].from, Sha256::from_bytes([0xcd; 32]));
        assert_eq!(
            release.patches[0].file.path,
            format!("{appid}/{}/{}.puff", "ab".repeat(32), "cd".repeat(32))
        );
    }

    #[test]
    fn reads_state_saved_before_build_times() {
        let json = format!(
            r#"{{"releases":[{{"version":"29928054","sha256":"{}","size":7}}]}}"#,
            "ab".repeat(32)
        );
        let state: State = serde_json::from_str(&json).unwrap();
        assert_eq!(state.releases[0].built, 0);
    }

    fn release(version: u64, built: u64) -> Built {
        Built {
            version: version.to_string(),
            sha256: format!("{version:064}"),
            size: 7,
            built,
            patches: Vec::new(),
            unpatchable: Vec::new(),
        }
    }

    fn versions(releases: &[Built]) -> Vec<&str> {
        releases.iter().map(|b| b.version.as_str()).collect()
    }

    #[test]
    fn keeps_releases_that_were_the_newest_within_a_week() {
        const HOUR: u64 = 60 * 60;
        let now = 100 * 24 * HOUR;

        // one every 12 hours: the newest, and 14 that were the newest in the last week
        let mut releases: Vec<Built> = (0..40)
            .map(|i| release(100 - i, now - i * 12 * HOUR))
            .collect();
        retain(&mut releases, now);
        assert_eq!(releases.len(), 15);
        assert_eq!(releases[14].version, "86");

        // one an hour: capped
        let mut releases: Vec<Built> = (0..40).map(|i| release(100 - i, now - i * HOUR)).collect();
        retain(&mut releases, now);
        assert_eq!(releases.len(), MAX_KEEP);

        // nothing new for a month: still the newest few
        let mut releases: Vec<Built> = (0..10)
            .map(|i| release(100 - i, now - (30 + i) * 24 * HOUR))
            .collect();
        retain(&mut releases, now);
        assert_eq!(versions(&releases), ["100", "99", "98", "97"]);

        // saved before build times were: as many as before
        let mut releases: Vec<Built> = (0..10).map(|i| release(100 - i, 0)).collect();
        releases.insert(0, release(101, now));
        retain(&mut releases, now);
        assert_eq!(versions(&releases), ["101", "100", "99", "98"]);
    }

    /// Bytes that deflate can't shrink, like a crlset's hashes and serials.
    fn incompressible(len: usize) -> Vec<u8> {
        (0u64..)
            .flat_map(|i| sha2::Sha256::digest(i.to_le_bytes()))
            .take(len)
            .collect()
    }

    #[test]
    fn stores_files_that_deflate_barely_shrinks() {
        assert_eq!(
            compression(&incompressible(1 << 16)),
            zip::CompressionMethod::Stored
        );
        assert_eq!(
            compression(&b"{\n  \"version\": \"1\"\n}\n".repeat(100)),
            zip::CompressionMethod::Deflated
        );
        assert_eq!(compression(b""), zip::CompressionMethod::Stored);

        // a tenth of the file is text: deflate saves about 10%, too little
        let mut mostly = incompressible(1 << 16);
        mostly.extend(b"a".repeat(1 << 13));
        assert_eq!(compression(&mostly), zip::CompressionMethod::Stored);
    }

    #[test]
    fn packs_a_crlset_with_its_serials_stored() {
        let keys = Keys::new(b"test");
        let spec = Spec {
            appid: keys.appid("crlset").unwrap(),
            label: "crlset".into(),
            version: "29928387".parse().unwrap(),
            manifest: None,
            files: Vec::new(),
            signed_by: None,
        };
        let crl_set = incompressible(1 << 20);
        let manifest = br#"{
  "manifest_version": 2,
  "name": "crl-set-29928387.data",
  "version": "29928387"
}
"#
        .to_vec();
        let files = vec![
            ("crl-set".to_owned(), crl_set.clone()),
            ("manifest.json".to_owned(), manifest.clone()),
        ];
        let crx = crx(&spec, files, &keys.signer("crlset").unwrap()).unwrap();

        let verified = crx3::verify(&crx, &crx3::Policy::default()).unwrap();
        assert_eq!(verified.id, spec.appid.as_str());
        let archive = crx3::split(&crx).unwrap().archive;
        let mut zip = zip::ZipArchive::new(Cursor::new(archive)).unwrap();

        // the manifest is too small for deflate to save much either
        for (name, data) in [("crl-set", &crl_set), ("manifest.json", &manifest)] {
            let mut entry = zip.by_name(name).unwrap();
            assert_eq!(
                entry.compression(),
                zip::CompressionMethod::Stored,
                "{name}"
            );
            let mut read = Vec::new();
            entry.read_to_end(&mut read).unwrap();
            assert_eq!(&read, data, "{name}");
        }

        assert!(crx.len() > crl_set.len(), "the serials aren't deflated");
    }
}
