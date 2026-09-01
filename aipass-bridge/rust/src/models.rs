//! list-models carries no field separating chat models from image/video/audio
//! generators, so they are excluded by id. AIPASS_MODEL_FILTER=all keeps them.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub provider: Option<String>,
    pub free: bool,
    pub ready: bool,
    pub thinking: Option<Vec<String>>,
    pub media: bool,
}

const MEDIA_MARKERS: [&str; 5] = ["seedream", "seedance", "veo-", "lyria", "gpt-image"];

fn is_media(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    MEDIA_MARKERS.iter().any(|m| lower.contains(m))
        || lower.ends_with("-image")
        || lower.contains("image-preview")
}

pub fn extract(node: &Value, keep_media: bool) -> Vec<Model> {
    let mut out = Vec::new();
    walk(node, &mut out);
    if keep_media {
        out
    } else {
        out.into_iter().filter(|m| !m.media && m.ready).collect()
    }
}

fn walk(node: &Value, out: &mut Vec<Model>) {
    match node {
        Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
        Value::Object(fields) => {
            let id = fields
                .get("id")
                .or_else(|| fields.get("modelId"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());

            if let Some(id) = id {
                if !out.iter().any(|m| m.id == id) {
                    let text = |k: &str| fields.get(k).and_then(Value::as_str).map(str::to_string);
                    out.push(Model {
                        id: id.to_string(),
                        name: text("displayName")
                            .or_else(|| text("name"))
                            .unwrap_or_else(|| id.to_string()),
                        provider: text("providerName").or_else(|| text("provider")),
                        free: fields.get("isFreeCredit") == Some(&Value::Bool(true)),
                        ready: fields.get("ready") != Some(&Value::Bool(false)),
                        thinking: fields
                            .get("thinkingConfig")
                            .and_then(|c| c.get("supportedLevels"))
                            .and_then(Value::as_array)
                            .map(|levels| {
                                levels
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            }),
                        media: is_media(id),
                    });
                }
            }
            fields.values().for_each(|v| walk(v, out));
        }
        _ => {}
    }
}
