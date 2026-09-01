//! The job hub, and everything the HTTP layer shares.
//!
//! The JS bridge wires jobs together with callbacks; here each job owns a
//! channel. A requester creates a job, hands the sender to the hub, and reads
//! events until Done or Error. The idle timeout falls out of reading with
//! `tokio::time::timeout`, so it resets on every delta exactly as the JS timer
//! did — without a timer to cancel.
use crate::models::Model;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const MAX_BODY: usize = 8 * 1024 * 1024;

/// One piece of an answer as the extension reports it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Part {
    pub kind: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug)]
pub enum JobEvent {
    Delta(Part),
    Done(String),
    Error(String),
    /// A loader or create job answers with one raw body rather than deltas.
    Raw(String),
}

pub struct Job {
    /// Which extension client it went to, so a disconnect can detach it
    /// without failing the job — the upstream fetch lives in the page and
    /// survives the worker being evicted.
    pub client: Option<String>,
    pub tx: mpsc::UnboundedSender<JobEvent>,
}

pub struct ExtClient {
    pub id: String,
    pub tx: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
pub struct ModelCache {
    pub at: Option<Instant>,
    pub models: Vec<Model>,
}

#[derive(Default)]
pub struct Conversations {
    pub current: Option<String>,
    pub list: Vec<Value>,
    pub index: usize,
}

pub struct Config {
    pub host: String,
    pub port: u16,
    pub models_fallback: Vec<String>,
    pub tool_visibility: String,
    pub pinned_conversation: Option<String>,
    pub idle_timeout: Duration,
    pub keep_media: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Config {
            host: env("AIPASS_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: env("AIPASS_PORT").and_then(|v| v.parse().ok()).unwrap_or(8787),
            models_fallback: env("AIPASS_MODELS")
                .unwrap_or_else(|| "gemini-3.1-flash-lite,claude-sonnet-5@default".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            tool_visibility: env("AIPASS_TOOL_VISIBILITY").unwrap_or_else(|| "reasoning".into()),
            pinned_conversation: env("AIPASS_CONVERSATION_ID"),
            idle_timeout: Duration::from_millis(
                env("AIPASS_IDLE_TIMEOUT_MS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(180_000),
            ),
            keep_media: env("AIPASS_MODEL_FILTER").as_deref() == Some("all"),
        }
    }
}

pub struct AppState {
    pub config: Config,
    pub default_model: Mutex<String>,
    pub jobs: Mutex<HashMap<String, Job>>,
    pub clients: Mutex<Vec<ExtClient>>,
    pub models: Mutex<ModelCache>,
    pub conversations: Mutex<Conversations>,
    round_robin: AtomicUsize,
}

pub type Shared = Arc<AppState>;

pub struct ExtClientHandle {
    pub id: String,
    pub tx: mpsc::UnboundedSender<String>,
}

impl AppState {
    pub fn new(config: Config) -> Shared {
        let default_model = std::env::var("AIPASS_MODEL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "gemini-3.1-flash-lite".into());
        Arc::new(AppState {
            config,
            default_model: Mutex::new(default_model),
            jobs: Mutex::new(HashMap::new()),
            clients: Mutex::new(Vec::new()),
            models: Mutex::new(ModelCache::default()),
            conversations: Mutex::new(Conversations::default()),
            round_robin: AtomicUsize::new(0),
        })
    }

    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    pub fn active_jobs(&self) -> usize {
        self.jobs.lock().unwrap().len()
    }

    pub fn default_model(&self) -> String {
        self.default_model.lock().unwrap().clone()
    }

    /// Models as last seen, or the configured fallback when nothing has been
    /// fetched — the popup and /v1/models must answer before a tab attaches.
    pub fn cached_models(&self) -> Vec<Model> {
        let cache = self.models.lock().unwrap();
        if !cache.models.is_empty() {
            return cache.models.clone();
        }
        self.config
            .models_fallback
            .iter()
            .map(|id| Model {
                id: id.clone(),
                name: id.clone(),
                provider: None,
                free: false,
                ready: true,
                thinking: None,
                media: false,
            })
            .collect()
    }

    pub fn current_conversation(&self) -> Option<String> {
        self.config
            .pinned_conversation
            .clone()
            .or_else(|| self.conversations.lock().unwrap().current.clone())
    }

    /// Round-robin, matching the JS bridge: several tabs share the load.
    fn pick_client(&self) -> Option<ExtClientHandle> {
        let clients = self.clients.lock().unwrap();
        if clients.is_empty() {
            return None;
        }
        let n = self.round_robin.fetch_add(1, Ordering::Relaxed) % clients.len();
        let c = &clients[n];
        Some(ExtClientHandle {
            id: c.id.clone(),
            tx: c.tx.clone(),
        })
    }

    /// Create a job, send it to a tab, and hand back both its id and the
    /// receiver the caller reads events from.
    pub fn dispatch(
        &self,
        mut payload: Value,
    ) -> Result<(String, mpsc::UnboundedReceiver<JobEvent>), String> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        payload["jobId"] = json!(id);

        // A tab can be gone before anything noticed, so a failed send retires
        // that client and tries the next rather than failing the request.
        loop {
            let Some(client) = self.pick_client() else {
                return Err(
                    "no extension connected — open a de.aipass.net tab and check the popup".into(),
                );
            };
            // Registered before the send: the reply can arrive first.
            self.jobs.lock().unwrap().insert(
                id.clone(),
                Job {
                    client: Some(client.id.clone()),
                    tx: tx.clone(),
                },
            );
            if client.tx.send(sse("job", &payload)).is_ok() {
                return Ok((id, rx));
            }
            self.jobs.lock().unwrap().remove(&id);
            self.drop_client(&client.id);
        }
    }

    pub fn deliver(&self, job_id: &str, event: JobEvent) -> bool {
        let jobs = self.jobs.lock().unwrap();
        match jobs.get(job_id) {
            Some(job) => job.tx.send(event).is_ok(),
            None => false,
        }
    }

    pub fn finish(&self, job_id: &str) {
        self.jobs.lock().unwrap().remove(job_id);
    }

    /// Ask the tab to stop generating, then drop the job.
    pub fn abort(&self, job_id: &str) {
        let client_id = {
            let jobs = self.jobs.lock().unwrap();
            jobs.get(job_id).and_then(|j| j.client.clone())
        };
        if let Some(cid) = client_id {
            let clients = self.clients.lock().unwrap();
            if let Some(c) = clients.iter().find(|c| c.id == cid) {
                let _ = c.tx.send(sse("abort", &json!({ "jobId": job_id })));
            }
        }
        self.finish(job_id);
    }

    pub fn add_client(&self, tx: mpsc::UnboundedSender<String>) -> String {
        let id = Uuid::new_v4().to_string();
        self.clients
            .lock()
            .unwrap()
            .push(ExtClient { id: id.clone(), tx });
        id
    }

    /// Detach, never fail, any job that was riding this client. Chrome evicts
    /// an idle MV3 worker mid-answer and the page keeps streaming; failing here
    /// would kill a request that is still very much alive.
    pub fn drop_client(&self, id: &str) {
        self.clients.lock().unwrap().retain(|c| c.id != id);
        let mut jobs = self.jobs.lock().unwrap();
        for job in jobs.values_mut() {
            if job.client.as_deref() == Some(id) {
                job.client = None;
            }
        }
    }
}

pub fn sse(event: &str, data: &Value) -> String {
    format!("event: {}\ndata: {}\n\n", event, data)
}
