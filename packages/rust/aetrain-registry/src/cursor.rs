use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryCursorMode {
    FullSeed,
    Incremental,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RegistrySourceCursorState {
    pub seed_snapshot_id: Option<String>,
    pub recent_changes_cursor: Option<String>,
    pub replication_sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySourceCursor {
    pub source_id: String,
    pub mode: RegistryCursorMode,
    pub last_successful_refresh_at: Option<String>,
    pub state: RegistrySourceCursorState,
}

pub fn load_cursor(path: &Path) -> Result<RegistrySourceCursor> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn save_cursor(path: &Path, cursor: &RegistrySourceCursor) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(cursor).context("failed to serialize cursor")?;
    fs::write(path, raw).with_context(|| format!("failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("aetrain-registry-cursor-{label}-{nanos}.json"))
    }

    #[test]
    fn cursor_roundtrip_works() {
        let path = temp_path("roundtrip");
        let cursor = RegistrySourceCursor {
            source_id: "wikidata-city-seed".to_string(),
            mode: RegistryCursorMode::Incremental,
            last_successful_refresh_at: Some("2026-05-09T12:00:00Z".to_string()),
            state: RegistrySourceCursorState {
                seed_snapshot_id: Some("wikidata-seed-2026-05-09".to_string()),
                recent_changes_cursor: Some("2026-05-09T12:00:00Z".to_string()),
                replication_sequence: None,
            },
        };

        save_cursor(&path, &cursor).expect("cursor should save");
        let loaded = load_cursor(&path).expect("cursor should load");
        assert_eq!(loaded, cursor);
    }
}
