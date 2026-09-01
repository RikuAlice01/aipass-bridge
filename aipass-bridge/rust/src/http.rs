//! The HTTP surface, route for route with the JS bridge: an OpenAI-compatible
//! pair for clients, a handful of endpoints for the CLIs, and the /ext channel
//! the Chrome extension lives on.
use crate::bridge::{self, log};
use crate::state::{JobEvent, Part, Shared, MAX_BODY};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use uuid::Uuid;

type Body = BoxBody<Bytes, Infallible>;

fn full(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Response<Body> {
    let bytes: Bytes = body.into();
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("content-length", bytes.len())
        .header("access-control-allow-origin", "*")
        .body(Full::new(bytes).boxed())
        .unwrap()
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    full(status, "application/json", value.to_string())
}

fn oai_error(status: StatusCode, message: &str, kind: &str) -> Response<Body> {
    json_response(
        status,
        json!({ "error": { "message": message, "type": kind } }),
    )
}

/// An SSE response fed from a channel: the extension channel and streaming
/// chat completions both use it.
fn sse_response(rx: mpsc::UnboundedReceiver<String>, private_network: bool) -> Response<Body> {
    let stream =
        UnboundedReceiverStream::new(rx).map(|s| Ok::<_, Infallible>(Frame::data(Bytes::from(s))));
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no")
        .header("access-control-allow-origin", "*");
    if private_network {
        builder = builder.header("access-control-allow-private-network", "true");
    }
    builder.body(StreamBody::new(stream).boxed()).unwrap()
}

async fn read_body(req: Request<Incoming>) -> Result<String, String> {
    let collected = req
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    if collected.len() > MAX_BODY {
        return Err("body too large".into());
    }
    String::from_utf8(collected.to_vec()).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn completion_id() -> String {
    format!(
        "chatcmpl-{}",
        Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(24)
            .collect::<String>()
    )
}

pub async fn route(state: Shared, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let method = req.method().clone();
    let raw_path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let path = raw_path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };

    if method == Method::OPTIONS {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "GET,POST,OPTIONS")
            .header("access-control-allow-headers", "*")
            .header("access-control-allow-private-network", "true")
            .header("access-control-max-age", "86400")
            .body(Full::new(Bytes::new()).boxed())
            .unwrap());
    }

    let response = match (&method, path) {
        (&Method::POST, "/v1/chat/completions") => chat_completions(state, req).await,
        (&Method::GET, "/v1/models") => {
            let force = query.split('&').any(|p| p == "refresh=1");
            let models = bridge::list_models(&state, force).await;
            let data: Vec<Value> = models
                .iter()
                .map(|m| {
                    json!({
                        "id": m.id, "object": "model", "created": 0,
                        "owned_by": m.provider.clone().unwrap_or_else(|| "aipass".into()),
                        "name": m.name, "free_credit": m.free, "thinking": m.thinking,
                    })
                })
                .collect();
            json_response(StatusCode::OK, json!({ "object": "list", "data": data }))
        }
        (&Method::POST, "/conversations/new") => {
            let body = read_body(req).await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&body).unwrap_or(json!({}));
            let model = parsed
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string);
            match bridge::create_conversation(&state, model, message).await {
                Ok(id) => json_response(StatusCode::OK, json!({ "id": id })),
                Err(e) => oai_error(StatusCode::BAD_GATEWAY, &e, "upstream_error"),
            }
        }
        (&Method::GET, "/conversations") => {
            let _ = bridge::load_conversations(&state).await;
            let conv = state.conversations.lock().unwrap();
            let list: Vec<Value> = conv
                .list
                .iter()
                .map(|c| {
                    json!({
                        "id": c.get("id"),
                        "title": c.get("title"),
                        "updatedAt": c.get("updatedAt"),
                    })
                })
                .collect();
            let current = state
                .config
                .pinned_conversation
                .clone()
                .or_else(|| conv.current.clone());
            drop(conv);
            json_response(
                StatusCode::OK,
                json!({ "current": current, "conversations": list }),
            )
        }
        (&Method::POST, "/config") => {
            let body = read_body(req).await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&body).unwrap_or(json!({}));

            if let Some(m) = parsed.get("defaultModel").and_then(Value::as_str) {
                if !m.trim().is_empty() {
                    *state.default_model.lock().unwrap() = m.trim().to_string();
                    log(format!("default model {}", m.trim()));
                }
            }
            match parsed.get("conversation") {
                Some(Value::Null) => {
                    let mut conv = state.conversations.lock().unwrap();
                    conv.current = None;
                    conv.index = 0;
                    conv.list.clear();
                    log("conversation cleared");
                }
                Some(Value::String(id)) => {
                    let mut conv = state.conversations.lock().unwrap();
                    conv.current = Some(id.clone());
                    conv.index = 0;
                    log(format!("conversation {id}"));
                }
                _ => {}
            }
            json_response(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "defaultModel": state.default_model(),
                    "conversation": state.current_conversation(),
                }),
            )
        }
        (&Method::GET, "/ext/events") => ext_events(state),
        (&Method::POST, "/ext/chunk") => ext_post(state, req, "chunk").await,
        (&Method::POST, "/ext/done") => ext_post(state, req, "done").await,
        (&Method::POST, "/ext/error") => ext_post(state, req, "error").await,
        (&Method::POST, "/ext/loader") => ext_post(state, req, "loader").await,
        (&Method::GET, "/status") | (&Method::GET, "/health") => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "extensions": state.client_count(),
                "activeJobs": state.active_jobs(),
                "defaultModel": state.default_model(),
                "conversation": state.current_conversation(),
                "models": state.cached_models(),
            }),
        ),
        _ => oai_error(
            StatusCode::NOT_FOUND,
            &format!("no route for {method} {path}"),
            "not_found",
        ),
    };
    Ok(response)
}

/* -------------------------------------------------------- extension channel */

fn ext_events(state: Shared) -> Response<Body> {
    let (tx, rx) = mpsc::unbounded_channel();
    let id = state.add_client(tx.clone());
    log(format!(
        "extension connected ({} total)",
        state.client_count()
    ));
    let _ = tx.send(crate::state::sse("ready", &json!({ "clientId": id })));

    // Warm the model list the way the JS bridge does, shortly after a tab
    // attaches rather than on the first request that needs it.
    let warm = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        bridge::list_models(&warm, true).await;
    });

    // Notice the disconnect the moment the response body is dropped. Waiting
    // for a failed ping would leave a dead tab in the pool for up to fifteen
    // seconds, and jobs round-robin onto it in the meantime.
    let watch_state = state.clone();
    let watch_id = id.clone();
    let watch_tx = tx.clone();
    tokio::spawn(async move {
        watch_tx.closed().await;
        watch_state.drop_client(&watch_id);
        log(format!(
            "extension disconnected ({} left)",
            watch_state.client_count()
        ));
    });

    // Keep-alive comments, so nothing in between reaps an idle connection.
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            if tx.send(": ping\n\n".to_string()).is_err() {
                return;
            }
        }
    });

    sse_response(rx, true)
}

async fn ext_post(state: Shared, req: Request<Incoming>, kind: &str) -> Response<Body> {
    let Ok(body) = read_body(req).await else {
        return json_response(StatusCode::BAD_REQUEST, json!({ "ok": false }));
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return json_response(StatusCode::BAD_REQUEST, json!({ "ok": false }));
    };
    let Some(job_id) = parsed.get("jobId").and_then(Value::as_str) else {
        return json_response(
            StatusCode::OK,
            json!({ "ok": false, "reason": "unknown job" }),
        );
    };

    let delivered = match kind {
        "chunk" => {
            let parts = parsed
                .get("parts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut ok = true;
            for raw in parts {
                if let Ok(part) = serde_json::from_value::<Part>(raw) {
                    ok = state.deliver(job_id, JobEvent::Delta(part));
                }
            }
            ok
        }
        "done" => {
            let reason = parsed
                .get("finishReason")
                .and_then(Value::as_str)
                .unwrap_or("stop")
                .to_string();
            state.deliver(job_id, JobEvent::Done(reason))
        }
        "loader" => match parsed.get("raw").and_then(Value::as_str) {
            Some(raw) => state.deliver(job_id, JobEvent::Raw(raw.to_string())),
            None => state.deliver(
                job_id,
                JobEvent::Error(
                    parsed
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("loader fetch failed")
                        .to_string(),
                ),
            ),
        },
        _ => state.deliver(
            job_id,
            JobEvent::Error(
                parsed
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("extension reported an error")
                    .to_string(),
            ),
        ),
    };

    if delivered {
        json_response(StatusCode::OK, json!({ "ok": true }))
    } else {
        json_response(
            StatusCode::OK,
            json!({ "ok": false, "reason": "unknown job" }),
        )
    }
}

/* -------------------------------------------------------- chat completions */

async fn chat_completions(state: Shared, req: Request<Incoming>) -> Response<Body> {
    let Ok(body) = read_body(req).await else {
        return oai_error(
            StatusCode::BAD_REQUEST,
            "body too large",
            "invalid_request_error",
        );
    };
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
        return oai_error(
            StatusCode::BAD_REQUEST,
            "invalid JSON body",
            "invalid_request_error",
        );
    };

    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| state.default_model());
    let model = model.strip_prefix("aipass/").unwrap_or(&model).to_string();

    let text = bridge::last_user_text(payload.get("messages"));
    if text.is_empty() {
        return oai_error(
            StatusCode::BAD_REQUEST,
            "no user message",
            "invalid_request_error",
        );
    }

    let id = completion_id();
    let created = now_secs();
    log(format!("chat -> {model} ({} bytes)", text.len()));

    let streaming = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let visibility = state.config.tool_visibility.clone();
    let mut handle = bridge::start_chat(state.clone(), model.clone(), text.clone());

    if streaming {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let emit = |delta: Value, finish: Value| {
                format!(
                    "data: {}\n\n",
                    json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
                    })
                )
            };
            let _ = tx.send(emit(
                json!({ "role": "assistant", "content": "" }),
                Value::Null,
            ));

            loop {
                match handle.rx.recv().await {
                    Some(JobEvent::Delta(part)) => {
                        let chunk = match part.kind.as_str() {
                            "status" => match bridge::tool_text(&visibility, &part) {
                                None => continue,
                                Some((true, text)) => json!({ "reasoning_content": text }),
                                Some((false, text)) => json!({ "content": text }),
                            },
                            "reasoning" => json!({ "reasoning_content": part.text }),
                            _ => json!({ "content": part.text }),
                        };
                        if tx.send(emit(chunk, Value::Null)).is_err() {
                            handle.abort();
                            return;
                        }
                    }
                    Some(JobEvent::Done(reason)) => {
                        let finish = if reason == "length" { "length" } else { "stop" };
                        let _ = tx.send(emit(json!({}), json!(finish)));
                        let _ = tx.send("data: [DONE]\n\n".to_string());
                        return;
                    }
                    Some(JobEvent::Error(message)) => {
                        let _ = tx.send(format!(
                            "data: {}\n\n",
                            json!({ "error": { "message": message, "type": "upstream_error" } })
                        ));
                        let _ = tx.send("data: [DONE]\n\n".to_string());
                        return;
                    }
                    Some(JobEvent::Raw(_)) => {}
                    None => {
                        let _ = tx.send("data: [DONE]\n\n".to_string());
                        return;
                    }
                }
            }
        });
        return sse_response(rx, false);
    }

    let mut out = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = "stop".to_string();

    loop {
        match handle.rx.recv().await {
            Some(JobEvent::Delta(part)) => match part.kind.as_str() {
                "status" => {
                    if visibility != "off" {
                        reasoning.push_str(&part.text);
                        reasoning.push('\n');
                    }
                }
                "reasoning" => reasoning.push_str(&part.text),
                _ => out.push_str(&part.text),
            },
            Some(JobEvent::Done(reason)) => {
                if reason == "length" {
                    finish_reason = "length".into();
                }
                break;
            }
            Some(JobEvent::Error(message)) => {
                return oai_error(StatusCode::BAD_GATEWAY, &message, "upstream_error");
            }
            Some(JobEvent::Raw(_)) => {}
            None => break,
        }
    }

    let mut message = json!({ "role": "assistant", "content": out });
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    // Estimates: the upstream stream reports no token counts, but some clients
    // refuse a response without a usage block.
    let ceil4 = |n: usize| (n as f64 / 4.0).ceil() as u64;
    json_response(
        StatusCode::OK,
        json!({
            "id": id, "object": "chat.completion", "created": created, "model": model,
            "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }],
            "usage": {
                "prompt_tokens": ceil4(text.len()),
                "completion_tokens": ceil4(out.len()),
                "total_tokens": ceil4(text.len() + out.len()),
            },
        }),
    )
}
