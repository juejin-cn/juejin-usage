//! Wrapping key for `credentials.enc` lives under the shared data directory
//! (`~/.ai-usage/agent-router/vault.key`, mode 0600), like Magpie's local JSON
//! secrets. Dev and release builds share that directory, so macOS keychain ACL
//! prompts between signing identities no longer block gateway logins.
//!
//! Existing installs may still have the legacy keychain item
//! `com.juejin.usage.gateway` / `vault-wrapping-key-v1`; the first successful
//! read migrates it onto disk and leaves the encrypted vault readable.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const LEGACY_SERVICE: &str = "com.juejin.usage.gateway";
const LEGACY_ACCOUNT: &str = "vault-wrapping-key-v1";

fn data_dir() -> PathBuf {
    std::env::var_os("TUD_DATA_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".ai-usage")
        })
}

fn vault_key_path() -> PathBuf {
    data_dir().join("agent-router").join("vault.key")
}

fn valid_key(value: &str) -> bool {
    STANDARD.decode(value).ok().is_some_and(|bytes| bytes.len() == 32)
}

fn read_file_key(path: &Path) -> Result<String, ()> {
    let value = fs::read_to_string(path).map_err(|_| ())?;
    let value = value.trim().to_string();
    if !valid_key(&value) {
        return Err(());
    }
    Ok(value)
}

fn write_file_key(path: &Path, value: &str) -> Result<(), ()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| ())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let temp = path.with_extension("key.tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .map_err(|_| ())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(value.as_bytes()).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
    }
    fs::rename(&temp, path).map_err(|_| ())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = File::open(path).and_then(|file| file.set_permissions(fs::Permissions::from_mode(0o600)));
    }
    if read_file_key(path)? != value {
        return Err(());
    }
    Ok(())
}

fn generate_key() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    STANDARD.encode(bytes)
}

fn legacy_keychain_key() -> Result<String, ()> {
    let entry = keyring::Entry::new(LEGACY_SERVICE, LEGACY_ACCOUNT).map_err(|_| ())?;
    let value = entry.get_password().map_err(|_| ())?;
    if !valid_key(&value) {
        return Err(());
    }
    Ok(value)
}

/// Load or create the vault wrapping key without prompting the OS keychain for
/// routine access. Legacy keychain entries are copied once onto disk.
pub fn wrapping_key() -> Result<String, ()> {
    let path = vault_key_path();
    if let Ok(value) = read_file_key(&path) {
        return Ok(value);
    }
    if let Ok(legacy) = legacy_keychain_key() {
        write_file_key(&path, &legacy)?;
        return Ok(legacy);
    }
    // Do not mint a fresh key while an encrypted vault already exists — that
    // would permanently strand saved provider logins.
    if path.with_file_name("credentials.enc").is_file() {
        return Err(());
    }
    let value = generate_key();
    write_file_key(&path, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn file_key_round_trips_without_keychain() {
        let _guard = env_lock().lock().unwrap();
        let root = std::env::temp_dir().join(format!("jusage-vault-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&root);
        std::env::set_var("TUD_DATA_DIR", &root);
        let first = wrapping_key().expect("create");
        let second = wrapping_key().expect("reload");
        assert_eq!(first, second);
        assert!(valid_key(&first));
        assert!(root.join("agent-router").join("vault.key").is_file());
        std::env::remove_var("TUD_DATA_DIR");
        let _ = fs::remove_dir_all(&root);
    }
}
