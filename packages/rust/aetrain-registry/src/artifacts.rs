use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryBuildLayout {
    pub root: PathBuf,
    pub observations_dir: PathBuf,
    pub canonical_dir: PathBuf,
    pub audit_dir: PathBuf,
}

impl RegistryBuildLayout {
    pub fn under(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            observations_dir: root.join("observations"),
            canonical_dir: root.join("canonical"),
            audit_dir: root.join("audit"),
            root,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.observations_dir)
            .with_context(|| format!("failed to create {}", self.observations_dir.display()))?;
        fs::create_dir_all(&self.canonical_dir)
            .with_context(|| format!("failed to create {}", self.canonical_dir.display()))?;
        fs::create_dir_all(&self.audit_dir)
            .with_context(|| format!("failed to create {}", self.audit_dir.display()))?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryCanonicalArtifacts {
    pub cities_path: PathBuf,
    pub stations_path: PathBuf,
    pub memberships_path: PathBuf,
    pub name_variants_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryAuditArtifacts {
    pub findings_path: PathBuf,
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let raw = serde_json::to_vec_pretty(value).context("failed to serialize json")?;
    fs::write(path, raw).with_context(|| format!("failed to write {}", path.display()))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let raw = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn write_json_lines<T: Serialize>(path: &Path, values: &[T]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let file =
        fs::File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    for value in values {
        serde_json::to_writer(&mut writer, value).context("failed to serialize json line")?;
        writer
            .write_all(b"\n")
            .context("failed to terminate json line")?;
    }
    writer.flush().context("failed to flush jsonl writer")
}

pub fn read_json_lines<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let file =
        fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut values = Vec::new();
    for line in reader.lines() {
        let line = line.context("failed to read jsonl line")?;
        if line.trim().is_empty() {
            continue;
        }
        values
            .push(serde_json::from_str(&line).with_context(|| {
                format!("failed to parse jsonl record from {}", path.display())
            })?);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("aetrain-registry-{label}-{nanos}"))
    }

    #[test]
    fn json_roundtrip_works() {
        let path = temp_path("json").join("value.json");
        write_json(&path, &vec!["paris", "lyon"]).expect("json should write");
        let values: Vec<String> = read_json(&path).expect("json should read");
        assert_eq!(values, vec!["paris".to_string(), "lyon".to_string()]);
    }

    #[test]
    fn jsonl_roundtrip_works() {
        let path = temp_path("jsonl").join("values.jsonl");
        write_json_lines(&path, &[1u32, 2, 3]).expect("jsonl should write");
        let values: Vec<u32> = read_json_lines(&path).expect("jsonl should read");
        assert_eq!(values, vec![1, 2, 3]);
    }
}
