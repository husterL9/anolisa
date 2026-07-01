//! LLM-as-judge API call wrapper.
//!
//! Calls DashScope (OpenAI-compatible) API to get evaluation scores.
//! Uses `ureq` (already in Cargo deps) for synchronous HTTP.

use std::time::Duration;

/// Configuration for the judge LLM.
pub struct JudgeConfig {
    pub api_base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub max_retries: u32,
}

impl Default for JudgeConfig {
    fn default() -> Self {
        Self {
            api_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            api_key: String::new(),
            model: "qwen-max".to_string(),
            temperature: 0.0,
            max_tokens: 1024,
            timeout_ms: 30_000,
            max_retries: 3,
        }
    }
}

/// Response from a judge LLM call.
#[derive(Debug)]
pub struct JudgeResponse {
    /// Full text content from the model.
    pub content: String,
    /// Extracted score (1-5) if parseable.
    pub score: Option<u8>,
    /// Input tokens used.
    pub input_tokens: u32,
    /// Output tokens used.
    pub output_tokens: u32,
}

/// Call the judge LLM with a structured prompt.
///
/// The prompt should contain both system and user message formatted
/// as produced by `rubrics::build_scoring_prompt`.
pub fn call_judge(config: &JudgeConfig, system_prompt: &str, user_prompt: &str) -> Result<JudgeResponse, String> {
    let body = serde_json::json!({
        "model": config.model,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
    });

    let url = format!("{}/chat/completions", config.api_base_url);
    let timeout = Duration::from_millis(config.timeout_ms);

    let mut last_err = String::new();
    for attempt in 0..config.max_retries {
        if attempt > 0 {
            // Exponential backoff: 1s, 2s, 4s...
            std::thread::sleep(Duration::from_millis(1000 * (1 << (attempt - 1))));
        }

        let result = ureq::post(&url)
            .timeout(timeout)
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {}", config.api_key))
            .send_string(&body.to_string());

        match result {
            Ok(resp) => {
                let status = resp.status();
                let resp_body = resp.into_string().unwrap_or_default();

                if status != 200 {
                    last_err = format!("HTTP {}: {}", status, &resp_body[..resp_body.len().min(200)]);
                    continue;
                }

                // Parse OpenAI-compatible response
                let parsed: serde_json::Value = serde_json::from_str(&resp_body)
                    .map_err(|e| format!("JSON parse error: {}", e))?;

                let content = parsed["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();

                let input_tokens = parsed["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32;
                let output_tokens = parsed["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32;

                let score = parse_score_from_text(&content);

                return Ok(JudgeResponse {
                    content,
                    score,
                    input_tokens,
                    output_tokens,
                });
            }
            Err(e) => {
                last_err = format!("request error: {}", e);
            }
        }
    }

    Err(format!(
        "judge call failed after {} retries: {}",
        config.max_retries, last_err
    ))
}

/// Extract "Score: N" from judge response text.
/// Looks for the last occurrence of "Score: " followed by a digit 1-5.
pub fn parse_score_from_text(text: &str) -> Option<u8> {
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Score:") {
            if let Ok(n) = rest.trim().parse::<u8>() {
                if (1..=5).contains(&n) {
                    return Some(n);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_score() {
        assert_eq!(parse_score_from_text("Reasoning...\nScore: 4"), Some(4));
        assert_eq!(parse_score_from_text("Score: 5\nmore text\nScore: 3"), Some(3));
        assert_eq!(parse_score_from_text("Score: 0"), None);
        assert_eq!(parse_score_from_text("Score: 6"), None);
        assert_eq!(parse_score_from_text("no score here"), None);
    }
}
