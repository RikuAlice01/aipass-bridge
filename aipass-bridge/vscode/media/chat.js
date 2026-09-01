// The chat panel's front end. It owns no logic beyond rendering: every
// decision is made in the extension host and arrives here as a message.
(() => {
  const vscode = acquireVsCodeApi();

  const $ = (sel) => document.querySelector(sel);
  const thread = $('#thread');
  const input = $('#input');
  const send = $('#send');
  const stop = $('#stop');
  const applyBox = $('#autoapply');
  const applyWrap = $('#applywrap');
  const pill = $('#status');
  const modeAgent = $('#mode-agent');
  const modeAsk = $('#mode-ask');
  const model = $('#model');

  let busy = false;
  // Agent reads and edits files; Ask goes straight to the model with no
  // preamble and no tools, which is what a question like "what day is it"
  // actually wants.
  let mode = 'agent';
  let current = null;   // the agent turn being streamed into

  /* ----------------------------------------------------------- rendering */

  const atBottom = () =>
    thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;

  function keepPinned(fn) {
    // Only follow the stream when the reader has not scrolled up to read
    // something earlier; yanking them back would be worse than lagging.
    const pinned = atBottom();
    fn();
    if (pinned) thread.scrollTop = thread.scrollHeight;
  }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function clearEmpty() {
    const empty = thread.querySelector('.empty');
    if (empty) empty.remove();
  }

  function addMessage(who, text) {
    clearEmpty();
    const msg = el('div', `msg ${who}`);
    msg.append(el('div', 'who', who === 'user' ? 'you' : 'aipass'));
    const body = el('div', 'body', text ?? '');
    msg.append(body);
    keepPinned(() => thread.append(msg));
    return body;
  }

  // One collapsible block per turn, so ten reads do not push the answer off
  // the top of the panel.
  function stepsBlock() {
    if (current?.steps) return current.steps;
    const details = el('details', 'steps');
    const summary = el('summary', null, 'working…');
    const lines = el('div', 'lines');
    details.append(summary, lines);
    keepPinned(() => thread.append(details));
    current = { ...(current ?? {}), steps: details, summary, lines, count: 0 };
    return details;
  }

  function addStep(text) {
    stepsBlock();
    current.count++;
    current.summary.textContent = `${current.count} step${current.count === 1 ? '' : 's'}`;
    keepPinned(() => current.lines.append(el('div', 'line', text)));
  }

  function addNotice(text) {
    clearEmpty();
    keepPinned(() => thread.append(el('div', 'notice', text)));
  }

  function addStaged(files) {
    clearEmpty();
    const box = el('div', 'staged');
    box.append(el('h4', null, `${files.length} file${files.length === 1 ? '' : 's'} staged — nothing written yet`));

    for (const file of files) {
      const row = el('div', 'file');
      row.append(el('span', 'path', file.rel));
      const review = el('button', 'ghost', 'Review');
      review.addEventListener('click', () => vscode.postMessage({ type: 'diff', path: file.abs }));
      row.append(review);
      box.append(row);
    }

    const actions = el('div', 'actions');
    const apply = el('button', null, `Apply ${files.length}`);
    const discard = el('button', 'ghost', 'Discard');
    apply.addEventListener('click', () => {
      vscode.postMessage({ type: 'apply' });
      actions.remove();
    });
    discard.addEventListener('click', () => {
      vscode.postMessage({ type: 'discard' });
      actions.remove();
    });
    actions.append(apply, discard);
    box.append(actions);

    keepPinned(() => thread.append(box));
  }

  function setBusy(on) {
    busy = on;
    send.hidden = on;
    stop.hidden = !on;
    input.disabled = on;
    if (!on) current = null;
  }

  /* ------------------------------------------------------------ messages */

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'status':
        pill.className = `pill ${data.ok ? 'up' : 'down'}`;
        pill.innerHTML = '';
        pill.append(el('span', 'dot'), el('span', null, data.text));
        break;

      case 'user':
        addMessage('user', data.text);
        break;

      case 'step':
        addStep(data.text);
        break;

      case 'assistant':
        if (!current?.body) {
          current = { ...(current ?? {}), body: addMessage('agent', '') };
        }
        keepPinned(() => { current.body.textContent += data.text; });
        break;

      case 'staged':
        addStaged(data.files);
        break;

      case 'notice':
        addNotice(data.text);
        break;

      case 'busy':
        setBusy(data.value);
        break;

      case 'models':
        renderModels(data);
        break;

      case 'restore':
        thread.innerHTML = '';
        for (const m of data.messages) {
          if (m.role === 'notice') addNotice(m.text);
          else addMessage(m.role === 'user' ? 'user' : 'agent', m.text);
        }
        // Nothing is streaming into this, so the next answer starts its own
        // message rather than appending to the last restored one.
        current = null;
        thread.scrollTop = thread.scrollHeight;
        break;

      case 'cleared':
        thread.innerHTML = '';
        thread.append(emptyState());
        setBusy(false);
        break;

      default:
        break;
    }
  });

  // Rebuilt only when something actually changed, or reselecting would fight
  // the user with the dropdown open.
  let lastModels = '';
  function renderModels({ list, selected, fallback }) {
    const signature = JSON.stringify([list, selected, fallback]);
    if (signature === lastModels) return;
    lastModels = signature;

    model.innerHTML = '';
    const fallbackName = list.find((m) => m.id === fallback)?.name ?? fallback;
    model.append(new Option(fallbackName ? `default · ${fallbackName}` : 'default', ''));
    for (const m of list) {
      model.append(new Option(m.free ? `${m.name} · free` : m.name, m.id));
    }
    model.value = list.some((m) => m.id === selected) ? selected : '';
  }

  model.addEventListener('change', () => {
    vscode.postMessage({ type: 'model', id: model.value });
  });

  function emptyState() {
    const box = el('div', 'empty');
    box.append(el('b', null, 'Ask about this workspace'));
    box.append(el('div', null, 'It reads the files you name and stages any edit for review before anything is written.'));
    return box;
  }

  /* --------------------------------------------------------------- input */

  function setMode(next) {
    mode = next;
    modeAgent.classList.toggle('on', next === 'agent');
    modeAsk.classList.toggle('on', next === 'ask');
    // Writing to disk is meaningless when nothing reads the disk.
    applyWrap.hidden = next !== 'agent';
    input.placeholder = next === 'agent'
      ? 'Ask about this workspace, or ask for an edit…'
      : 'Ask anything — no files are read';
  }

  modeAgent.addEventListener('click', () => setMode('agent'));
  modeAsk.addEventListener('click', () => setMode('ask'));

  function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    vscode.postMessage({ type: 'ask', text, apply: applyBox.checked, mode });
    input.value = '';
    input.style.height = 'auto';
  }

  send.addEventListener('click', submit);
  stop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('#new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));

  input.addEventListener('keydown', (e) => {
    // Enter sends, shift+Enter breaks the line — what every chat does, and
    // what the muscle memory of anyone opening this panel expects.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  thread.append(emptyState());
  vscode.postMessage({ type: 'ready' });
})();
