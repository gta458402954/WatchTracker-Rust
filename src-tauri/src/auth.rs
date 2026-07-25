use base64::{engine::general_purpose, Engine as _};

pub fn encrypt(text: &str, _tag: &str) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }

    // 便携版使用 Base64 编码以便随 data 目录迁移；这不是强加密。
    let encoded = general_purpose::STANDARD.encode(text);
    Ok(format!("portable:v1:{}", encoded))
}

pub fn decrypt(id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Ok(String::new());
    }

    let encoded = id
        .strip_prefix("portable:v1:")
        .ok_or_else(|| "Unsupported credential format".to_string())?;
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}
