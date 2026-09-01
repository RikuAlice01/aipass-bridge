//! What the bridge actually does: look models up, pick a conversation, and run
//! a chat through a browser tab.
//!
//! Scope is deliberately narrow, and not by choice: the endpoint accepts one
//! user message and no transcript, and the server owns the history. There is
//! nothing to reconstruct on this side.
use crate::models::Model;
use crate::state::{JobEvent, Part, Shared};
use crate::turbo;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const LOADER_MODELS: &str = "/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models";
pub const LOADER_CONVERSATIONS: &str =
    "/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions";

const MODEL_TTL: Duration = Duration::from_secs(60);
const LOADER_TIMEOUT: Duration = Duration::from_secs(20);
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);

pub fn log(msg: impl AsRef<str>) {
    println!("{}", msg.as_ref());
}

/// Read one event stream to its single raw answer. Loader and create jobs
/// reply once rather than streaming.
async fn await_raw(
    mut rx: mpsc::UnboundedReceiver<JobEvent>,
    state: &Shared,
    job_id: &str,
    timeout: Duration,
) -> Result<String, String> {
    let outcome = match tokio::time::timeout(timeout, rx.recv()).await {
        Err(_) => Err("timed out waiting for the extension".to_string()),
        Ok(None) => Err("the extension went away".to_string()),
        Ok(Some(JobEvent::Raw(raw))) => Ok(raw),
        Ok(Some(JobEvent::Error(message))) => Err(message),
        Ok(Some(_)) => Err("unexpected event for a loader job".to_string()),
    };
    state.finish(job_id);
    outcome
}

pub async fn fetch_loader(state: &Shared, url: &str) -> Result<String, String> {
    let (job_id, rx) = state.dispatch(json!({ "kind": "loader", "url": url }))?;
    await_raw(rx, state, &job_id, LOADER_TIMEOUT).await
}

/* ------------------------------------------------------------------ models */

pub async fn list_models(state: &Shared, force: bool) -> Vec<Model> {
    {
        let cache = state.models.lock().unwrap();
        if !force
            && !cache.models.is_empty()
            && cache.at.map(|at| at.elapsed() < MODEL_TTL).unwrap_or(false)
        {
            return cache.models.clone();
        }
    }
    if state.client_count() == 0 {
        return state.cached_models();
    }

    match fetch_loader(state, LOADER_MODELS).await {
        Ok(raw) => match turbo::decode(&raw) {
            Ok(decoded) => {
                let models = crate::models::extract(&decoded, state.config.keep_media);
                if !models.is_empty() {
                    let free: Vec<&str> = models
                        .iter()
                        .filter(|m| m.free)
                        .map(|m| m.id.as_str())
                        .collect();
                    log(format!(
                        "{} models{}",
                        models.len(),
                        if free.is_empty() {
                            String::new()
                        } else {
                            format!(" (free credit: {})", free.join(", "))
                        }
                    ));
                    let mut cache = state.models.lock().unwrap();
                    cache.at = Some(Instant::now());
                    cache.models = models;
                }
            }
            Err(e) => log(format!("model refresh failed: {e}")),
        },
        Err(e) => log(format!("model refresh failed: {e}")),
    }
    state.cached_models()
}

/* ----------------------------------------------------------- conversations */

pub async fn load_conversations(state: &Shared) -> Result<Vec<Value>, String> {
    if state.client_count() == 0 {
        return Err("no extension connected — cannot look up a conversation".into());
    }
    let raw = fetch_loader(state, LOADER_CONVERSATIONS).await?;
    let list = turbo::conversations(&turbo::decode(&raw)?);
    state.conversations.lock().unwrap().list = list.clone();
    Ok(list)
}

/// The chat page creates a conversation by posting its first message to
/// /chat.data; the server derives the id from the first sixteen hex characters
/// of the clientCreateRequestId it is handed.
pub async fn create_conversation(
    state: &Shared,
    model: Option<String>,
    message: Option<String>,
) -> Result<String, String> {
    let model = model.unwrap_or_else(|| state.default_model());
    let message = message.unwrap_or_else(|| "Hello".into());
    let request_id = Uuid::new_v4().to_string();

    let (job_id, rx) = state.dispatch(json!({
        "kind": "create",
        "modelId": model,
        "message": message,
        "requestId": request_id,
    }))?;
    let raw = await_raw(rx, state, &job_id, CREATE_TIMEOUT).await?;

    let id = turbo::find_string(&turbo::decode(&raw)?, "conversationId").ok_or_else(|| {
        format!(
            "could not read a conversation id from the response: {}",
            raw.chars().take(200).collect::<String>()
        )
    })?;

    {
        let mut conv = state.conversations.lock().unwrap();
        conv.current = Some(id.clone());
        conv.index = 0;
        conv.list.clear();
    }
    log(format!("created conversation {id}"));
    Ok(id)
}

async fn resolve_conversation(state: &Shared) -> Result<String, String> {
    if let Some(pinned) = &state.config.pinned_conversation {
        return Ok(pinned.clone());
    }
    {
        let conv = state.conversations.lock().unwrap();
        if let Some(current) = &conv.current {
            return Ok(current.clone());
        }
    }
    let empty = state.conversations.lock().unwrap().list.is_empty();
    if empty {
        load_conversations(state).await?;
    }

    let mut conv = state.conversations.lock().unwrap();
    let index = conv.index;
    let Some(pick) = conv.list.get(index).cloned() else {
        return Err("no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {\"conversation\":null}".into());
    };
    let id = pick
        .get("id")
        .and_then(Value::as_str)
        .ok_or("conversation without an id")?
        .to_string();
    conv.current = Some(id.clone());
    let title = pick
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("untitled");
    drop(conv);
    log(format!("conversation {id} ({title})"));
    Ok(id)
}

/* --------------------------------------------------------------- chat flow */

pub struct ChatHandle {
    pub rx: mpsc::UnboundedReceiver<JobEvent>,
    current: Arc<Mutex<Option<String>>>,
    state: Shared,
}

impl ChatHandle {
    pub fn abort(&self) {
        if let Some(id) = self.current.lock().unwrap().take() {
            self.state.abort(&id);
        }
    }
}

/// A 404 means the conversation was deleted; a 409 means the server still
/// believes a generation is running there. Neither recovers on its own, so
/// move to the next most recent — but only before any of the answer has been
/// delivered, and never when a conversation was pinned on purpose.
fn rejected(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("conversation not found")
        || m.contains("returned 404")
        || m.contains("returned 409")
        // 403 CHAT_UNAUTHORIZED / "conversation has been deleted" is the same
        // situation as a 404: this one is gone, the next is fine. Matched on
        // the body rather than the status, because a 403 from an edge filter
        // is a different failure that rotating would only hide.
        || m.contains("chat_unauthorized")
        || m.contains("conversation has been deleted")
        || m.contains("conversation is no longer")
}

pub fn start_chat(state: Shared, model: String, text: String) -> ChatHandle {
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let current: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let task_state = state.clone();
    let task_current = current.clone();
    tokio::spawn(async move {
        let mut attempts = 0usize;
        let mut delivered = 0usize;

        loop {
            attempts += 1;
            let conversation = match resolve_conversation(&task_state).await {
                Ok(id) => id,
                Err(e) => {
                    let _ = out_tx.send(JobEvent::Error(e));
                    return;
                }
            };

            let dispatched = task_state.dispatch(json!({
                "kind": "chat",
                "conversationId": conversation,
                "modelId": model,
                "text": text,
            }));
            let (job_id, mut rx) = match dispatched {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = out_tx.send(JobEvent::Error(e));
                    return;
                }
            };
            *task_current.lock().unwrap() = Some(job_id.clone());

            // The idle timeout resets on every event, which is the point: a
            // long web_search delivers nothing for a while and must not be
            // mistaken for a dead tab.
            let failure = loop {
                match tokio::time::timeout(task_state.config.idle_timeout, rx.recv()).await {
                    Err(_) => break Some("timed out waiting for the extension".to_string()),
                    Ok(None) => break Some("the extension went away".to_string()),
                    Ok(Some(JobEvent::Delta(part))) => {
                        delivered += 1;
                        if out_tx.send(JobEvent::Delta(part)).is_err() {
                            task_state.finish(&job_id);
                            return; // the client hung up
                        }
                    }
                    Ok(Some(JobEvent::Done(reason))) => {
                        task_state.finish(&job_id);
                        let _ = out_tx.send(JobEvent::Done(reason));
                        return;
                    }
                    Ok(Some(JobEvent::Error(message))) => break Some(message),
                    Ok(Some(JobEvent::Raw(_))) => {}
                }
            };
            task_state.finish(&job_id);

            let Some(message) = failure else { return };
            let can_rotate = rejected(&message)
                && attempts <= 3
                && delivered == 0
                && task_state.config.pinned_conversation.is_none();

            if !can_rotate {
                let _ = out_tx.send(JobEvent::Error(message));
                return;
            }
            log(format!(
                "conversation {conversation} rejected, trying the next one"
            ));
            let mut conv = task_state.conversations.lock().unwrap();
            conv.index += 1;
            conv.current = None;
        }
    });

    ChatHandle {
        rx: out_rx,
        current,
        state,
    }
}

/// Only the newest user message is sent. The server holds the history, and a
/// messages array containing an assistant turn is rejected upstream with a
/// bare 403 before the model ever sees it.
pub fn last_user_text(messages: Option<&Value>) -> String {
    let Some(Value::Array(list)) = messages else {
        return String::new();
    };
    list.iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|m| match m.get("content") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Array(parts)) => Some(
                parts
                    .iter()
                    .map(|p| {
                        if p.get("type").and_then(Value::as_str) == Some("text") {
                            p.get("text").and_then(Value::as_str).unwrap_or("")
                        } else {
                            ""
                        }
                    })
                    .collect::<String>(),
            ),
            _ => None,
        })
        .next_back()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Where upstream tool activity goes: 'reasoning' puts it in
/// delta.reasoning_content, 'text' inlines it, 'off' drops it.
pub fn tool_text(visibility: &str, part: &Part) -> Option<(bool, String)> {
    match visibility {
        "off" => None,
        "text" => Some((false, format!("\n{}\n", part.text))),
        _ => Some((true, format!("{}\n", part.text))),
    }
}
