//! The app's `.data` loaders answer in react-router's turbo-stream encoding: a
//! flat pool of values where objects address their own keys and values by
//! index into that pool.
//!
//! The JS bridge decodes it by mutating placeholder objects as it goes, which
//! lets a cycle point back at a half-built parent. That does not translate, so
//! this memoises finished values and yields null when a reference points at
//! something still being built. Loader payloads are DAGs in practice; the
//! guard is there so a cycle cannot hang the decoder.
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub fn decode(text: &str) -> Result<Value, String> {
    let flat: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut done: HashMap<usize, Value> = HashMap::new();
    let mut building: HashSet<usize> = HashSet::new();
    Ok(resolve(&flat, &Value::from(0u64), &mut done, &mut building))
}

fn resolve(
    flat: &[Value],
    node: &Value,
    done: &mut HashMap<usize, Value>,
    building: &mut HashSet<usize>,
) -> Value {
    // Anything that is not a pool index stands for itself.
    let Some(idx) = node.as_i64() else {
        return node.clone();
    };
    // Negative indices are the undefined/null sentinels.
    if idx < 0 {
        return Value::Null;
    }
    let idx = idx as usize;

    if let Some(hit) = done.get(&idx) {
        return hit.clone();
    }
    if building.contains(&idx) {
        return Value::Null; // a cycle; the JS decoder would hand back the parent
    }
    let Some(raw) = flat.get(idx) else {
        return Value::Null;
    };

    building.insert(idx);
    let out = match raw {
        Value::Array(items) => Value::Array(
            items.iter().map(|e| resolve(flat, e, done, building)).collect(),
        ),
        Value::Object(fields) => {
            let mut map = Map::new();
            for (key, value_ref) in fields {
                // Keys are "_<index into the pool>".
                let key_ref = key
                    .get(1..)
                    .and_then(|n| n.parse::<i64>().ok())
                    .map(Value::from)
                    .unwrap_or(Value::Null);
                let name = match resolve(flat, &key_ref, done, building) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                map.insert(name, resolve(flat, value_ref, done, building));
            }
            Value::Object(map)
        }
        other => other.clone(),
    };
    building.remove(&idx);
    done.insert(idx, out.clone());
    out
}

/// Depth-first search for the first string value under `key`, anywhere.
pub fn find_string(node: &Value, key: &str) -> Option<String> {
    match node {
        Value::Array(items) => items.iter().find_map(|v| find_string(v, key)),
        Value::Object(fields) => {
            if let Some(Value::String(s)) = fields.get(key) {
                return Some(s.clone());
            }
            fields.values().find_map(|v| find_string(v, key))
        }
        _ => None,
    }
}

/// Every object carrying both `id` and `updatedAt`, newest first — the shape a
/// conversation has in the list-conversations loader.
pub fn conversations(node: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    collect_conversations(node, &mut out);
    out.sort_by(|a, b| {
        let key = |v: &Value| v.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        key(b).cmp(&key(a))
    });
    out
}

fn collect_conversations(node: &Value, out: &mut Vec<Value>) {
    match node {
        Value::Array(items) => items.iter().for_each(|v| collect_conversations(v, out)),
        Value::Object(fields) => {
            let has = |k: &str| matches!(fields.get(k), Some(Value::String(_)));
            if has("id") && has("updatedAt") {
                out.push(node.clone());
            }
            fields.values().for_each(|v| collect_conversations(v, out));
        }
        _ => {}
    }
}
