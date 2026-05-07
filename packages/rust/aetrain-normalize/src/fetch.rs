use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow};
use reqwest::{StatusCode, blocking::Client, header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{SourceDefinition, SourceManifest};

const SOURCE_STATE_FILE: &str = "source-state.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SourceStateRegistry {
    pub dataset_id: String,
    pub updated_at: String,
    pub sources: Vec<SourceStateRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceStateRecord {
    pub source_id: String,
    pub url: String,
    pub file_name: String,
    pub local_path: String,
    pub fetched_at: String,
    pub probe_version: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchStatus {
    Downloaded,
    SkippedUpToDate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedSource {
    pub definition: SourceDefinition,
    pub local_path: PathBuf,
    pub fetched_at: String,
    pub probe_version: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub sha256: String,
    pub status: FetchStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
struct RemoteSourceState {
    probe_version: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<u64>,
}

pub fn load_source_state_registry(cache_root: &Path) -> Result<SourceStateRegistry> {
    let path = cache_root.join(SOURCE_STATE_FILE);
    if !path.exists() {
        return Ok(SourceStateRegistry::default());
    }

    let raw =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn fetch_sources(
    manifest: &SourceManifest,
    cache_root: &Path,
    force: bool,
) -> Result<Vec<FetchedSource>> {
    fs::create_dir_all(cache_root)
        .with_context(|| format!("failed to create {}", cache_root.display()))?;

    let mut registry = load_source_state_registry(cache_root)?;
    if registry.dataset_id.is_empty() {
        registry.dataset_id = manifest.dataset_id.clone();
    }

    let client = Client::builder()
        .user_agent("aetrain-pipeline/0.1 (+https://github.com/schiste/aetrain)")
        .build()
        .context("failed to build HTTP client")?;

    let mut fetched_sources = Vec::new();
    for definition in manifest.active_sources() {
        let current = fetch_one(
            &client,
            definition,
            cache_root,
            registry
                .sources
                .iter()
                .find(|state| state.source_id == definition.id),
            force,
        )?;
        upsert_registry_state(&mut registry.sources, current.to_state_record());
        fetched_sources.push(current);
    }

    registry.updated_at = now_utc_rfc3339()?;
    save_registry(cache_root, &registry)?;
    Ok(fetched_sources)
}

impl FetchedSource {
    fn to_state_record(&self) -> SourceStateRecord {
        SourceStateRecord {
            source_id: self.definition.id.clone(),
            url: self.definition.url.clone(),
            file_name: self.definition.resolved_file_name(),
            local_path: self.local_path.display().to_string(),
            fetched_at: self.fetched_at.clone(),
            probe_version: self.probe_version.clone(),
            etag: self.etag.clone(),
            last_modified: self.last_modified.clone(),
            content_length: self.content_length,
            sha256: self.sha256.clone(),
        }
    }
}

fn fetch_one(
    client: &Client,
    definition: &SourceDefinition,
    cache_root: &Path,
    existing_state: Option<&SourceStateRecord>,
    force: bool,
) -> Result<FetchedSource> {
    let local_path = cache_root
        .join("raw")
        .join(&definition.id)
        .join(definition.resolved_file_name());

    let mut remote_state = probe_remote_state(client, &definition.url)?;
    if let Some(probe_url) = &definition.version_probe_url {
        remote_state.probe_version = probe_source_version(client, probe_url)?;
    }
    if !force
        && local_path.exists()
        && existing_state.is_some_and(|state| is_up_to_date(state, &remote_state, definition))
    {
        let state = existing_state.expect("checked above");
        return Ok(FetchedSource {
            definition: definition.clone(),
            local_path,
            fetched_at: state.fetched_at.clone(),
            probe_version: state.probe_version.clone(),
            etag: state.etag.clone(),
            last_modified: state.last_modified.clone(),
            content_length: state.content_length,
            sha256: state.sha256.clone(),
            status: FetchStatus::SkippedUpToDate,
        });
    }

    let response = client
        .get(&definition.url)
        .send()
        .with_context(|| format!("failed to download {}", definition.url))?
        .error_for_status()
        .with_context(|| format!("received error response for {}", definition.url))?;
    let response_headers = response.headers().clone();
    let bytes = response.bytes().context("failed to read response body")?;

    let parent = local_path
        .parent()
        .ok_or_else(|| anyhow!("invalid local cache path {}", local_path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;

    let tmp_path = local_path.with_extension("tmp");
    fs::write(&tmp_path, &bytes)
        .with_context(|| format!("failed to write {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &local_path)
        .with_context(|| format!("failed to move {} into place", local_path.display()))?;

    Ok(FetchedSource {
        definition: definition.clone(),
        local_path,
        fetched_at: now_utc_rfc3339()?,
        probe_version: remote_state.probe_version,
        etag: header_to_string(&response_headers, header::ETAG),
        last_modified: header_to_string(&response_headers, header::LAST_MODIFIED),
        content_length: response_headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok()),
        sha256: sha256_hex(bytes.as_ref()),
        status: FetchStatus::Downloaded,
    })
}

fn probe_remote_state(client: &Client, url: &str) -> Result<RemoteSourceState> {
    let response = client
        .head(url)
        .send()
        .with_context(|| format!("failed to probe {}", url))?;
    if response.status() != StatusCode::OK {
        return Ok(RemoteSourceState::default());
    }

    Ok(RemoteSourceState {
        probe_version: None,
        etag: header_to_string(response.headers(), header::ETAG),
        last_modified: header_to_string(response.headers(), header::LAST_MODIFIED),
        content_length: response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok()),
    })
}

fn is_up_to_date(
    existing: &SourceStateRecord,
    remote: &RemoteSourceState,
    definition: &SourceDefinition,
) -> bool {
    if existing.url != definition.url || existing.file_name != definition.resolved_file_name() {
        return false;
    }

    if let Some(remote_probe_version) = &remote.probe_version {
        return existing.probe_version.as_ref() == Some(remote_probe_version);
    }

    match (&remote.etag, &existing.etag) {
        (Some(remote), Some(existing)) => return remote == existing,
        (Some(_), None) => return false,
        _ => {}
    }

    matches!(
        (&remote.last_modified, &existing.last_modified, remote.content_length, existing.content_length),
        (Some(remote_modified), Some(existing_modified), Some(remote_len), Some(existing_len))
            if remote_modified == existing_modified && remote_len == existing_len
    )
}

fn probe_source_version(client: &Client, url: &str) -> Result<Option<String>> {
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("failed to probe version at {}", url))?
        .error_for_status()
        .with_context(|| format!("received error response from {}", url))?;
    let payload = response
        .text()
        .context("failed to read probe response body")?;
    let payload: Value = serde_json::from_str(&payload).context("failed to parse probe JSON")?;
    let metas = payload.get("metas");
    let metas_default = metas.and_then(|value| value.get("default"));

    Ok(payload
        .get("modified")
        .and_then(Value::as_str)
        .or_else(|| payload.get("data_processed").and_then(Value::as_str))
        .or_else(|| {
            metas
                .and_then(|value| value.get("data_processed"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            metas
                .and_then(|value| value.get("metadata_processed"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            metas_default
                .and_then(|value| value.get("modified"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            metas_default
                .and_then(|value| value.get("data_processed"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            metas_default
                .and_then(|value| value.get("metadata_processed"))
                .and_then(Value::as_str)
        })
        .map(ToString::to_string))
}

fn save_registry(cache_root: &Path, registry: &SourceStateRegistry) -> Result<()> {
    let path = cache_root.join(SOURCE_STATE_FILE);
    let json =
        serde_json::to_string_pretty(registry).context("failed to serialize source state")?;
    fs::write(&path, json).with_context(|| format!("failed to write {}", path.display()))
}

fn upsert_registry_state(states: &mut Vec<SourceStateRecord>, next: SourceStateRecord) {
    if let Some(existing) = states
        .iter_mut()
        .find(|state| state.source_id == next.source_id)
    {
        *existing = next;
    } else {
        states.push(next);
    }
    states.sort_by(|left, right| left.source_id.cmp(&right.source_id));
}

fn header_to_string(headers: &header::HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn now_utc_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("failed to format timestamp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::ServiceClass;

    fn source() -> SourceDefinition {
        SourceDefinition {
            id: "sncf-fr-gtfs".to_string(),
            kind: crate::SourceKind::Gtfs,
            country_code: "FR".to_string(),
            adapter: "sncf_fr".to_string(),
            url: "https://example.invalid/gtfs.zip".to_string(),
            file_name: Some("gtfs.zip".to_string()),
            version_probe_url: None,
            active: true,
            include_service_classes: vec![ServiceClass::Regional],
            notes: None,
        }
    }

    #[test]
    fn remote_etag_takes_precedence_for_update_detection() {
        let existing = SourceStateRecord {
            source_id: "sncf-fr-gtfs".to_string(),
            url: source().url.clone(),
            file_name: "gtfs.zip".to_string(),
            local_path: "data/cache/raw/sncf-fr-gtfs/gtfs.zip".to_string(),
            fetched_at: "2026-05-07T19:00:00Z".to_string(),
            probe_version: None,
            etag: Some("\"abc\"".to_string()),
            last_modified: Some("Wed, 06 May 2026 19:54:09 GMT".to_string()),
            content_length: Some(10),
            sha256: "deadbeef".to_string(),
        };
        let remote = RemoteSourceState {
            probe_version: None,
            etag: Some("\"abc\"".to_string()),
            last_modified: Some("Thu, 07 May 2026 19:54:09 GMT".to_string()),
            content_length: Some(20),
        };

        assert!(is_up_to_date(&existing, &remote, &source()));
    }
}
