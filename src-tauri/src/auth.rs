use base64::{engine::general_purpose, Engine as _};

pub fn encrypt(text: &str, _tag: &str) -> Result<String, String> {
    if text.is_empty() { return Ok("".to_string()); }
    
    // 使用简单的便携式加密（Base64 混淆）
    // 在便携版中，由于无法依赖操作系统的 Keyring，我们将数据混淆后存入数据库
    let encoded = general_purpose::STANDARD.encode(text);
    Ok(format!("portable:v1:{}", encoded))
}

pub fn decrypt(id: &str) -> Result<String, String> {
    if id.is_empty() { return Ok("".to_string()); }
    
    // 处理旧的 Electron 格式
    if id.starts_with("enc:v1:") {
        return Ok("__ERR_DECRYPT_VERSION_MISMATCH__".to_string());
    }

    // 处理旧的 Keyring 格式（由于读取失败，直接让用户重填）
    if id.starts_with("keyring:watchtracker:") {
        return Ok("__ERR_DECRYPT_FAILED__".to_string());
    }

    // 处理新的便携式格式
    if id.starts_with("portable:v1:") {
        let b64 = id.trim_start_matches("portable:v1:");
        let decoded_bytes = general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        return String::from_utf8(decoded_bytes).map_err(|e| e.to_string());
    }

    // 默认原样返回（兼容明文）
    Ok(id.to_string())
}
