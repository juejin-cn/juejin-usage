//! The wrapping key stays in the OS credential store, never in a config file.
use base64::{engine::general_purpose::STANDARD, Engine};

pub fn wrapping_key() -> Result<String, ()> {
    let entry = keyring::Entry::new("com.juejin.usage.gateway", "vault-wrapping-key-v1").map_err(|_| ())?;
    match entry.get_password() {
        Ok(value) => {
            if STANDARD.decode(&value).map_err(|_| ())?.len() != 32 { return Err(()); }
            Ok(value)
        }
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            let value = STANDARD.encode(bytes);
            entry.set_password(&value).map_err(|_| ())?;
            // Verify native storage succeeded before allowing durable credentials.
            if entry.get_password().map_err(|_| ())? != value { return Err(()); }
            Ok(value)
        }
        Err(_) => Err(()),
    }
}
