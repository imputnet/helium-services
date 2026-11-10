use crate::mixins::{Pool, mixin_count};
use crate::signed::UrlSigner;
use crate::upstream::Upstream;
use futures_util::future::join_all;
use omaha_protocol::{
    App, AppId, AppResponse, AppStatus, Operation, Outcome, Pipeline, UpdateCheckError,
    UpdateCheckResponse, is_valid_crx_id,
};
use omaha_server::{BoxFuture, Check, Source};
use rand::seq::SliceRandom;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct UpstreamSource {
    upstream: Upstream,
    pool: Pool,
    signer: Option<Arc<UrlSigner>>,
}

const BATCH: usize = 48;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn answer(appid: &AppId, outcome: Outcome) -> AppResponse {
    let mut answer = AppResponse::new(appid.clone(), AppStatus::Ok);
    answer.updatecheck = Some(UpdateCheckResponse::new(outcome));
    answer
}

impl UpstreamSource {
    pub fn new(upstream: Upstream, signer: Option<Arc<UrlSigner>>) -> Self {
        UpstreamSource {
            upstream,
            pool: Pool::default(),
            signer,
        }
    }

    fn rewrite(&self, upstream: &AppResponse) -> AppResponse {
        let appid = &upstream.appid;

        if upstream.status != AppStatus::Ok {
            return AppResponse::new(appid.clone(), upstream.status.clone());
        }

        let Some(check) = &upstream.updatecheck else {
            return answer(appid, Outcome::NoUpdate);
        };

        let Outcome::Update {
            nextversion,
            pipelines,
        } = &check.outcome
        else {
            return answer(appid, Outcome::NoUpdate);
        };

        let Some((pipeline, (urls, sha256, size))) = pipelines
            .iter()
            .find_map(|p| p.full_crx().map(|crx| (p, crx)))
        else {
            return answer(appid, Outcome::Error(UpdateCheckError::Internal));
        };

        let url = urls
            .iter()
            .find(|u| u.starts_with("https://"))
            .or(urls.last());
        let Some(url) = url else {
            return answer(appid, Outcome::Error(UpdateCheckError::Internal));
        };
        let url = match &self.signer {
            Some(signer) => signer.wrap(url, now_ms()),
            None => url.clone(),
        };

        answer(
            appid,
            Outcome::Update {
                nextversion: nextversion.clone(),
                pipelines: vec![Pipeline {
                    id: pipeline.id.clone(),
                    operations: vec![
                        Operation::Download {
                            size,
                            out: *sha256,
                            urls: vec![url],
                        },
                        Operation::Crx3 {
                            input: *sha256,
                            size: None,
                            path: None,
                            arguments: None,
                        },
                    ],
                }],
            },
        )
    }

    async fn ask(&self, apps: &[&App], exclude: &HashSet<&AppId>) -> Vec<AppResponse> {
        let mut all: Vec<App> = apps.iter().map(|&app| app.clone()).collect();
        all.extend(
            self.pool
                .pick(exclude, mixin_count(apps.len()))
                .into_iter()
                .map(|(appid, version)| {
                    let mut app = App::new(appid);
                    app.version = Some(version);
                    app
                }),
        );
        all.shuffle(&mut rand::rng());

        let answers = match self.upstream.check(&all).await {
            Ok(answers) => answers,
            Err(e) => {
                eprintln!("upstream: {e}");
                return Vec::new();
            }
        };

        for upstream in &answers {
            if let Some(UpdateCheckResponse {
                outcome: Outcome::Update { nextversion, .. },
                ..
            }) = &upstream.updatecheck
            {
                self.pool.add(upstream.appid.clone(), nextversion.clone());
            }
        }

        answers
    }
}

impl Source for UpstreamSource {
    fn check<'a>(&'a self, check: Check<'a>) -> BoxFuture<'a, Vec<AppResponse>> {
        Box::pin(async move {
            let valid: Vec<&App> = check
                .apps
                .iter()
                .copied()
                .filter(|app| is_valid_crx_id(app.appid.as_str()))
                .collect();
            let exclude: HashSet<&AppId> = valid.iter().map(|app| &app.appid).collect();
            let batches = valid.chunks(BATCH).map(|batch| self.ask(batch, &exclude));
            let answers: Vec<AppResponse> = join_all(batches).await.into_iter().flatten().collect();

            check
                .apps
                .iter()
                .map(|app| {
                    if !is_valid_crx_id(app.appid.as_str()) {
                        return AppResponse::new(app.appid.clone(), AppStatus::UnknownApplication);
                    }

                    answers.iter().find(|a| a.appid == app.appid).map_or_else(
                        || answer(&app.appid, Outcome::Error(UpdateCheckError::Internal)),
                        |a| self.rewrite(a),
                    )
                })
                .collect()
        })
    }
}
