//! the translation model components, one per language direction, from
//! mozilla's remote settings.

use crate::BoxError;
use crate::keys::Keys;
use crate::provider::{Provider, Spec, SpecFile, get, sha256_hex};
use omaha_protocol::AppId;
use omaha_server::BoxFuture;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

const CHANGESET: &str = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/changeset?_expected=0";
const ATTACHMENTS: &str = "https://firefox-settings-attachments.cdn.mozilla.net/";
const MAX_CHANGESET: usize = 16 << 20;

pub const PACK_FORMAT: u32 = 1;

const DESKTOP_FILTERS: [&str; 3] = [
    "",
    "env.appinfo.OS != 'Android'",
    "env.appinfo.OS != 'Android' || env.channel != 'release'",
];

#[derive(Deserialize)]
struct Changeset {
    changes: Vec<Record>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    file_type: String,
    source_language: String,
    target_language: String,
    version: String,
    architecture: String,
    #[serde(default, rename = "filter_expression")]
    filter_expression: String,
    attachment: Attachment,
    decompressed_hash: String,
    decompressed_size: u64,
    #[serde(rename = "last_modified")]
    last_modified: u64,
}

#[derive(Clone, Deserialize)]
struct Attachment {
    hash: String,
    size: u64,
    location: String,
}

fn is_language(code: &str) -> bool {
    (2..=16).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

type MozillaVersion = (Vec<u32>, u32, u32);

fn mozilla_version(version: &str) -> Option<MozillaVersion> {
    let (number, pre) = match version.find(|c: char| c.is_ascii_alphabetic()) {
        Some(i) => version.split_at(i),
        None => (version, ""),
    };
    let parts = number
        .split('.')
        .map(|p| p.parse().ok())
        .collect::<Option<Vec<u32>>>()?;
    let stage = match pre.chars().next() {
        None => return Some((parts, 2, 0)),
        Some('a') => 0,
        Some('b') => 1,
        Some(_) => return None,
    };
    Some((parts, stage, pre[1..].parse().ok()?))
}

fn file(name: &str, record: &Record, attachments: &str) -> Option<SpecFile> {
    Some(SpecFile {
        name: name.into(),
        url: format!("{attachments}{}", record.attachment.location),
        size: Some(record.attachment.size),
        sha256: sha256_hex(&record.attachment.hash)?,
        zstd: Some((
            record.decompressed_size,
            sha256_hex(&record.decompressed_hash)?,
        )),
    })
}

fn pack(records: &[&Record], attachments: &str, keys: &Keys) -> Option<Spec> {
    let first = records.first()?;
    let find = |kind: &str| -> Option<Option<&Record>> {
        let mut found = records.iter().filter(|r| r.file_type == kind);
        let one = found.next().copied();
        found.next().is_none().then_some(one)
    };
    let vocabs = match (find("vocab")?, find("srcvocab")?, find("trgvocab")?) {
        (Some(vocab), None, None) => vec![("vocab.spm", vocab)],
        (None, Some(src), Some(trg)) => vec![("srcvocab.spm", src), ("trgvocab.spm", trg)],
        _ => return None,
    };
    let mut parts = vec![("model.bin", find("model")??), ("lex.bin", find("lex")??)];
    parts.extend(vocabs);

    let newest = parts.iter().map(|(_, r)| r.last_modified).max()?;
    let files = parts
        .into_iter()
        .map(|(name, record)| file(name, record, attachments))
        .collect::<Option<Vec<_>>>()?;
    let (from, to) = (&first.source_language, &first.target_language);
    let version = format!("{PACK_FORMAT}.{}", newest / 1000);
    let label = format!("translation-{from}-{to}");
    Some(Spec {
        appid: keys.appid(&label).ok()?,
        label,
        manifest: Some(serde_json::json!({
            "manifest_version": 2,
            "name": format!("Translation Model ({from}-{to})"),
            "version": version,
            "translation": { "from": from, "to": to },
        })),
        version: version.parse().ok()?,
        files,
    })
}

fn parse(json: &[u8], attachments: &str, keys: &Keys) -> Result<Vec<Spec>, serde_json::Error> {
    let changeset: Changeset = serde_json::from_slice(json)?;
    let mut releases: HashMap<(&str, &str, &str, &str), Vec<&Record>> = HashMap::new();

    for record in &changeset.changes {
        if !DESKTOP_FILTERS.contains(&record.filter_expression.as_str())
            || !is_language(&record.source_language)
            || !is_language(&record.target_language)
        {
            continue;
        }

        let key = (
            record.source_language.as_str(),
            record.target_language.as_str(),
            record.version.as_str(),
            record.architecture.as_str(),
        );
        releases.entry(key).or_default().push(record);
    }

    let mut best: HashMap<AppId, (MozillaVersion, Spec)> = HashMap::new();

    for ((_, _, version, _), records) in releases {
        let (Some(order), Some(pack)) =
            (mozilla_version(version), pack(&records, attachments, keys))
        else {
            continue;
        };

        let newer = best
            .get(&pack.appid)
            .is_none_or(|(o, p)| (&order, &pack.version) > (o, &p.version));

        if newer {
            best.insert(pack.appid.clone(), (order, pack));
        }
    }

    Ok(best.into_values().map(|(_, pack)| pack).collect())
}

pub struct Bergamot {
    changeset_url: String,
    attachments_url: String,
}

impl Bergamot {
    pub fn new(changeset_url: String, attachments_url: String) -> Self {
        Bergamot {
            changeset_url,
            attachments_url,
        }
    }

    pub fn from_env() -> Option<Self> {
        let changeset = std::env::var("BERGAMOT_CHANGESET").unwrap_or_else(|_| CHANGESET.into());
        let attachments = std::env::var("BERGAMOT_ATTACHMENTS")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| ATTACHMENTS.into());
        (!changeset.is_empty()).then(|| Bergamot::new(changeset, attachments))
    }
}

impl Provider for Bergamot {
    fn name(&self) -> &'static str {
        "bergamot"
    }

    fn refresh(&self) -> Duration {
        Duration::from_secs(3600)
    }

    fn fetch<'a>(
        &'a self,
        http: &'a reqwest::Client,
        keys: &'a Keys,
    ) -> BoxFuture<'a, Result<Vec<Spec>, BoxError>> {
        Box::pin(async move {
            let json = get(http, &self.changeset_url, MAX_CHANGESET).await?;
            let packs = parse(&json, &self.attachments_url, keys)?;

            if packs.is_empty() {
                return Err("no models in the changeset".into());
            }

            Ok(packs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str, from: &str, to: &str, version: &str, modified: u64) -> serde_json::Value {
        serde_json::json!({
            "fileType": kind,
            "sourceLanguage": from,
            "targetLanguage": to,
            "version": version,
            "architecture": "base-memory",
            "filter_expression": "",
            "attachment": {
                "hash": "11".repeat(32),
                "size": 10,
                "location": format!("main-workspace/translations-models-v2/{kind}.zst"),
            },
            "decompressedHash": "22".repeat(32),
            "decompressedSize": 20,
            "last_modified": modified,
        })
    }

    fn changeset(records: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "changes": records })).unwrap()
    }

    #[test]
    fn orders_mozilla_versions() {
        let order = ["3.0a1", "3.0b2", "3.0", "3.1", "10.0"].map(|v| mozilla_version(v).unwrap());
        assert!(order.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(mozilla_version("3.0rc1"), None);
    }

    #[test]
    fn picks_the_newest_complete_release() {
        let mut records = Vec::new();

        for kind in ["model", "lex", "vocab"] {
            records.push(record(kind, "de", "en", "3.0", 1_735_689_600_000));
            records.push(record(kind, "de", "en", "3.1", 1_791_318_438_000));
        }

        records.push(record("model", "fr", "en", "3.1", 1_791_318_438_000));
        records.push(record("model", "en", "zh", "3.1", 1_791_318_438_000));
        records.push(record("lex", "en", "zh", "3.1", 1_791_318_438_000));
        records.push(record("srcvocab", "en", "zh", "3.1", 1_791_318_439_000));
        records.push(record("trgvocab", "en", "zh", "3.1", 1_791_318_440_000));
        let mut android = record("model", "en", "de", "9.0", 1_791_318_438_000);
        android["filter_expression"] = "env.appinfo.OS == 'Android'".into();
        records.push(android);

        let packs = parse(
            &changeset(records),
            "https://a.example/",
            &Keys::new(b"test"),
        )
        .unwrap();
        assert_eq!(
            packs.len(),
            2,
            "fr-en has no lex or vocab; en-de is android only"
        );

        let find = |from: &str, to: &str| {
            packs
                .iter()
                .find(|p| p.label == format!("translation-{from}-{to}"))
                .unwrap()
        };
        let de = find("de", "en");
        assert_eq!(de.version, "1.1791318438".parse().unwrap());
        let names: Vec<&str> = de.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["model.bin", "lex.bin", "vocab.spm"]);
        assert!(
            de.files[0]
                .url
                .starts_with("https://a.example/main-workspace/")
        );
        assert_eq!(de.manifest.as_ref().unwrap()["translation"]["to"], "en");

        let zh = find("en", "zh");
        assert_eq!(zh.version, "1.1791318440".parse().unwrap());
        assert_eq!(zh.files.len(), 4);
    }
}
