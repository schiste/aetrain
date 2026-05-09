use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use reqwest::{StatusCode, Url, blocking::Client, header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{DirectoryListingStep, SourceDefinition, SourceKind, SourceManifest, SourceResolver};

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
    #[serde(default, alias = "url")]
    pub configured_url: String,
    #[serde(default)]
    pub resolved_url: String,
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
    pub resolved_url: String,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedRemoteSource {
    download_url: String,
    resolver_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct UdataDatasetPayload {
    #[serde(default)]
    resources: Vec<UdataResource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct UdataResource {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    format: Option<String>,
    url: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    last_modified: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct CkanPackagePayload {
    result: CkanPackageResult,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct CkanPackageResult {
    #[serde(default)]
    resources: Vec<CkanResource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct CkanResource {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    format: Option<String>,
    url: String,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    last_modified: Option<String>,
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

pub fn resolve_cached_sources(
    manifest: &SourceManifest,
    cache_root: &Path,
) -> Result<Vec<FetchedSource>> {
    let registry = load_source_state_registry(cache_root)?;
    let mut resolved = Vec::new();

    for definition in manifest.active_sources() {
        let state = registry
            .sources
            .iter()
            .find(|record| record.source_id == definition.id)
            .with_context(|| format!("missing cached source state for {}", definition.id))?;
        let local_path = PathBuf::from(&state.local_path);
        if !local_path.exists() {
            return Err(anyhow!(
                "cached source file for {} is missing at {}",
                definition.id,
                local_path.display()
            ));
        }

        resolved.push(FetchedSource {
            definition: definition.clone(),
            resolved_url: if state.resolved_url.is_empty() {
                state.configured_url.clone()
            } else {
                state.resolved_url.clone()
            },
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

    Ok(resolved)
}

impl FetchedSource {
    fn to_state_record(&self) -> SourceStateRecord {
        SourceStateRecord {
            source_id: self.definition.id.clone(),
            configured_url: self.definition.url.clone(),
            resolved_url: self.resolved_url.clone(),
            file_name: self
                .definition
                .resolved_file_name_for_url(&self.resolved_url),
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
    let resolved = resolve_download_source(client, definition)?;
    let resolved_file_name = definition.resolved_file_name_for_url(&resolved.download_url);
    let local_path = cache_root
        .join("raw")
        .join(&definition.id)
        .join(&resolved_file_name);

    let mut remote_state = probe_remote_state(client, &resolved.download_url)?;
    if let Some(probe_url) = definition.version_probe_url.as_deref() {
        remote_state.probe_version = probe_source_version(client, probe_url)?;
    } else if resolved.resolver_version.is_some() {
        remote_state.probe_version = resolved.resolver_version.clone();
    }
    if !force
        && local_path.exists()
        && existing_state.is_some_and(|state| {
            is_up_to_date(
                state,
                &remote_state,
                definition,
                &resolved.download_url,
                &resolved_file_name,
            )
        })
    {
        let state = existing_state.expect("checked above");
        return Ok(FetchedSource {
            definition: definition.clone(),
            resolved_url: if state.resolved_url.is_empty() {
                resolved.download_url.clone()
            } else {
                state.resolved_url.clone()
            },
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
        .get(&resolved.download_url)
        .send()
        .with_context(|| format!("failed to download {}", resolved.download_url))?
        .error_for_status()
        .with_context(|| format!("received error response for {}", resolved.download_url))?;
    let response_headers = response.headers().clone();
    let bytes = response.bytes().context("failed to read response body")?;
    validate_downloaded_payload(
        definition,
        &resolved.download_url,
        &resolved_file_name,
        &bytes,
    )?;

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
        resolved_url: resolved.download_url,
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
    resolved_url: &str,
    resolved_file_name: &str,
) -> bool {
    if existing.configured_url != definition.url
        || existing.resolved_url != resolved_url
        || existing.file_name != resolved_file_name
    {
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

fn resolve_download_source(
    client: &Client,
    definition: &SourceDefinition,
) -> Result<ResolvedRemoteSource> {
    match definition.resolver.as_ref() {
        Some(SourceResolver::DirectoryListingCascade { index_url, steps }) => {
            resolve_directory_listing_cascade(client, index_url, steps)
        }
        Some(SourceResolver::HtmlLatestMatch {
            page_url,
            href_pattern,
        }) => resolve_html_latest_match(client, page_url, href_pattern),
        Some(SourceResolver::UdataLatestResource {
            dataset_api_url,
            format,
            title_pattern,
            url_pattern,
        }) => resolve_udata_latest_resource(
            client,
            dataset_api_url,
            format.as_deref(),
            title_pattern.as_deref(),
            url_pattern.as_deref(),
        ),
        Some(SourceResolver::CkanLatestResource {
            package_show_url,
            format,
            name_pattern,
            url_pattern,
        }) => resolve_ckan_latest_resource(
            client,
            package_show_url,
            format.as_deref(),
            name_pattern.as_deref(),
            url_pattern.as_deref(),
        ),
        None => Ok(ResolvedRemoteSource {
            download_url: definition.url.clone(),
            resolver_version: None,
        }),
    }
}

fn resolve_directory_listing_cascade(
    client: &Client,
    index_url: &str,
    steps: &[DirectoryListingStep],
) -> Result<ResolvedRemoteSource> {
    if steps.is_empty() {
        bail!("directory listing resolver requires at least one step");
    }

    let mut current_url = Url::parse(index_url)
        .with_context(|| format!("invalid directory listing index URL {index_url}"))?;
    let mut latest_href = None;

    for step in steps {
        let response = client
            .get(current_url.clone())
            .send()
            .with_context(|| format!("failed to fetch directory listing {}", current_url))?
            .error_for_status()
            .with_context(|| format!("received error response for {}", current_url))?;
        let html = response
            .text()
            .context("failed to read directory listing response body")?;
        let (next_url, href) = select_latest_href(&current_url, &html, &step.href_pattern)?;
        current_url = next_url;
        latest_href = Some(href);
    }

    Ok(ResolvedRemoteSource {
        download_url: current_url.to_string(),
        resolver_version: latest_href.or_else(|| Some(current_url.to_string())),
    })
}

fn resolve_html_latest_match(
    client: &Client,
    page_url: &str,
    href_pattern: &str,
) -> Result<ResolvedRemoteSource> {
    let current_url = Url::parse(page_url)
        .with_context(|| format!("invalid HTML resolver page URL {page_url}"))?;
    let response = client
        .get(current_url.clone())
        .send()
        .with_context(|| format!("failed to fetch HTML resolver page {}", current_url))?
        .error_for_status()
        .with_context(|| format!("received error response for {}", current_url))?;
    let html = response
        .text()
        .context("failed to read HTML resolver response body")?;
    let (next_url, href) = select_latest_href(&current_url, &html, href_pattern)?;
    Ok(ResolvedRemoteSource {
        download_url: next_url.to_string(),
        resolver_version: Some(href),
    })
}

fn resolve_udata_latest_resource(
    client: &Client,
    dataset_api_url: &str,
    format: Option<&str>,
    title_pattern: Option<&str>,
    url_pattern: Option<&str>,
) -> Result<ResolvedRemoteSource> {
    let payload = client
        .get(dataset_api_url)
        .send()
        .with_context(|| format!("failed to fetch udata dataset {}", dataset_api_url))?
        .error_for_status()
        .with_context(|| format!("received error response for {}", dataset_api_url))?
        .text()
        .context("failed to read udata dataset response body")?;
    let payload = serde_json::from_str::<UdataDatasetPayload>(&payload)
        .context("failed to parse udata dataset JSON")?;

    let resource = select_udata_resource(&payload.resources, format, title_pattern, url_pattern)?;
    Ok(ResolvedRemoteSource {
        download_url: resource.url.clone(),
        resolver_version: resource
            .last_modified
            .clone()
            .or_else(|| resource.created_at.clone())
            .or_else(|| Some(resource.url.clone())),
    })
}

fn resolve_ckan_latest_resource(
    client: &Client,
    package_show_url: &str,
    format: Option<&str>,
    name_pattern: Option<&str>,
    url_pattern: Option<&str>,
) -> Result<ResolvedRemoteSource> {
    let payload = client
        .get(package_show_url)
        .send()
        .with_context(|| format!("failed to fetch CKAN package {}", package_show_url))?
        .error_for_status()
        .with_context(|| format!("received error response for {}", package_show_url))?
        .text()
        .context("failed to read CKAN package response body")?;
    let payload = serde_json::from_str::<CkanPackagePayload>(&payload)
        .context("failed to parse CKAN package JSON")?;

    let resource =
        select_ckan_resource(&payload.result.resources, format, name_pattern, url_pattern)?;
    Ok(ResolvedRemoteSource {
        download_url: resource.url.clone(),
        resolver_version: resource
            .last_modified
            .clone()
            .or_else(|| resource.created.clone())
            .or_else(|| Some(resource.url.clone())),
    })
}

fn select_latest_href(base_url: &Url, html: &str, href_pattern: &str) -> Result<(Url, String)> {
    let href_regex = Regex::new(r#"href="([^"]+)""#).context("invalid href extraction regex")?;
    let pattern = Regex::new(href_pattern)
        .with_context(|| format!("invalid directory listing href pattern {href_pattern}"))?;

    let mut matches = href_regex
        .captures_iter(html)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_string()))
        .filter(|href| pattern.is_match(href))
        .collect::<Vec<_>>();
    matches.sort();

    let href = matches
        .pop()
        .ok_or_else(|| anyhow!("no matching href found for pattern {href_pattern}"))?;
    let joined = base_url
        .join(&href)
        .with_context(|| format!("failed to resolve href {href} against {base_url}"))?;
    Ok((joined, href))
}

fn select_udata_resource<'a>(
    resources: &'a [UdataResource],
    format: Option<&str>,
    title_pattern: Option<&str>,
    url_pattern: Option<&str>,
) -> Result<&'a UdataResource> {
    let title_regex = compile_optional_regex(title_pattern)?;
    let url_regex = compile_optional_regex(url_pattern)?;

    let mut matches = resources
        .iter()
        .filter(|resource| {
            matches_format(resource.format.as_deref(), format)
                && matches_optional_regex(
                    resource.title.as_deref().unwrap_or_default(),
                    title_regex.as_ref(),
                )
                && matches_optional_regex(resource.url.as_str(), url_regex.as_ref())
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|resource| {
        (
            resource.last_modified.clone(),
            resource.created_at.clone(),
            resource.title.clone(),
            Some(resource.url.clone()),
        )
    });

    matches
        .pop()
        .ok_or_else(|| anyhow!("no matching udata resource found"))
}

fn select_ckan_resource<'a>(
    resources: &'a [CkanResource],
    format: Option<&str>,
    name_pattern: Option<&str>,
    url_pattern: Option<&str>,
) -> Result<&'a CkanResource> {
    let name_regex = compile_optional_regex(name_pattern)?;
    let url_regex = compile_optional_regex(url_pattern)?;

    let mut matches = resources
        .iter()
        .filter(|resource| {
            matches_format(resource.format.as_deref(), format)
                && matches_optional_regex(
                    resource.name.as_deref().unwrap_or_default(),
                    name_regex.as_ref(),
                )
                && matches_optional_regex(resource.url.as_str(), url_regex.as_ref())
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|resource| {
        (
            resource.last_modified.clone(),
            resource.created.clone(),
            resource.name.clone(),
            Some(resource.url.clone()),
        )
    });

    matches
        .pop()
        .ok_or_else(|| anyhow!("no matching CKAN resource found"))
}

fn compile_optional_regex(pattern: Option<&str>) -> Result<Option<Regex>> {
    pattern
        .map(|value| Regex::new(value).with_context(|| format!("invalid regex pattern {value}")))
        .transpose()
}

fn matches_optional_regex(value: &str, regex: Option<&Regex>) -> bool {
    regex.is_none_or(|pattern| pattern.is_match(value))
}

fn matches_format(candidate: Option<&str>, expected: Option<&str>) -> bool {
    expected.is_none_or(|format| candidate.is_some_and(|value| value.eq_ignore_ascii_case(format)))
}

fn validate_downloaded_payload(
    definition: &SourceDefinition,
    resolved_url: &str,
    resolved_file_name: &str,
    bytes: &[u8],
) -> Result<()> {
    let expects_zip = matches!(definition.kind, SourceKind::Gtfs)
        || resolved_file_name.ends_with(".zip")
        || resolved_url.ends_with(".zip");
    if expects_zip && !is_zip_payload(bytes) {
        bail!(
            "downloaded payload for {} from {} is not a ZIP archive",
            definition.id,
            resolved_url
        );
    }

    Ok(())
}

fn is_zip_payload(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
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
            resolver: None,
            role: Some("schedule".to_string()),
            include_service_classes: vec![ServiceClass::Regional],
            notes: None,
        }
    }

    #[test]
    fn remote_etag_takes_precedence_for_update_detection() {
        let existing = SourceStateRecord {
            source_id: "sncf-fr-gtfs".to_string(),
            configured_url: source().url.clone(),
            resolved_url: source().url.clone(),
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

        assert!(is_up_to_date(
            &existing,
            &remote,
            &source(),
            &source().url,
            "gtfs.zip",
        ));
    }

    #[test]
    fn directory_listing_selector_picks_latest_matching_href() {
        let base = Url::parse("https://example.invalid/archive/").expect("base URL should parse");
        let html = r#"
            <html><body>
                <a href="2024/">2024/</a>
                <a href="2025/">2025/</a>
            </body></html>
        "#;

        let (url, href) =
            select_latest_href(&base, html, r"^20\d{2}/$").expect("href should resolve");
        assert_eq!(href, "2025/");
        assert_eq!(url.as_str(), "https://example.invalid/archive/2025/");
    }

    #[test]
    fn selector_can_pick_latest_absolute_zip_href_from_html_page() {
        let base = Url::parse("https://example.invalid/page").expect("base URL should parse");
        let html = r#"
            <html><body>
                <a href="https://cdn.example.invalid/gtfs_20260501.zip">older</a>
                <a href="https://cdn.example.invalid/gtfs_20260508.zip">newer</a>
            </body></html>
        "#;

        let (url, href) = select_latest_href(
            &base,
            html,
            r"^https://cdn\.example\.invalid/gtfs_\d{8}\.zip$",
        )
        .expect("href should resolve");
        assert_eq!(href, "https://cdn.example.invalid/gtfs_20260508.zip");
        assert_eq!(
            url.as_str(),
            "https://cdn.example.invalid/gtfs_20260508.zip"
        );
    }

    #[test]
    fn udata_selector_prefers_latest_matching_zip_resource() {
        let resources = vec![
            UdataResource {
                title: Some("gtfs-20260429-20260712.zip".to_string()),
                format: Some("zip".to_string()),
                url: "https://example.invalid/gtfs-20260429.zip".to_string(),
                created_at: Some("2026-04-30T05:55:34+00:00".to_string()),
                last_modified: Some("2026-04-30T05:55:34+00:00".to_string()),
            },
            UdataResource {
                title: Some("gtfs-20260506-20260712.zip".to_string()),
                format: Some("zip".to_string()),
                url: "https://example.invalid/gtfs-20260506.zip".to_string(),
                created_at: Some("2026-05-07T04:33:13+00:00".to_string()),
                last_modified: Some("2026-05-07T04:33:17+00:00".to_string()),
            },
        ];

        let resource =
            select_udata_resource(&resources, Some("zip"), Some(r"^gtfs-.*\.zip$"), None)
                .expect("resource should resolve");
        assert_eq!(resource.url, "https://example.invalid/gtfs-20260506.zip");
    }

    #[test]
    fn gtfs_zip_validation_rejects_html_payloads() {
        let result = validate_downloaded_payload(
            &source(),
            "https://example.invalid/gtfs.zip",
            "gtfs.zip",
            b"<html>not a zip</html>",
        );

        assert!(result.is_err());
    }
}
