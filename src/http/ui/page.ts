/**
 * Self-contained test console. No CDN, no external fonts, no third-party script -
 * this page handles the API key and renders a pairing QR, so nothing off-box gets to
 * see either. It is served only to loopback callers; see routes/ui.ts.
 *
 * The JS below deliberately avoids template literals so this file can stay one
 * template literal without escaping every interpolation.
 */
export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>WhatsApp Relay - Test Console</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#181b22; --line:#282d38; --fg:#e6e8ee;
          --dim:#8b93a5; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#2f81f7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  header { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  main { padding:18px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); max-width:1500px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px; }
  section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:0 0 12px; }
  label { display:block; font-size:12px; color:var(--dim); margin:10px 0 4px; }
  input, textarea, button, select { font:inherit; }
  input, textarea, select { width:100%; background:#0c0e13; color:var(--fg); border:1px solid var(--line);
            border-radius:6px; padding:8px 10px; }
  textarea { resize:vertical; min-height:70px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px;
           cursor:pointer; font-weight:600; }
  button.ghost { background:#20242e; color:var(--fg); border:1px solid var(--line); font-weight:400; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:12px; }
  .warn { background:#2b1a1a; border:1px solid #6b2626; color:#ffb4ae; padding:10px 12px;
          border-radius:6px; font-size:12.5px; margin:0 18px; }
  .badge { padding:2px 9px; border-radius:99px; font-size:12px; border:1px solid var(--line); background:#20242e; }
  .b-ok { color:var(--ok); border-color:#1f4a28; background:#12241a; }
  .b-warn { color:var(--warn); border-color:#5a4416; background:#241f12; }
  .b-bad { color:var(--bad); border-color:#5f2120; background:#241414; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:6px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; }
  code { color:#9ecbff; word-break:break-all; }
  pre { background:#0c0e13; border:1px solid var(--line); border-radius:6px; padding:10px;
        overflow:auto; max-height:280px; font-size:12px; margin:0; white-space:pre-wrap; }
  .qrbox { display:flex; flex-direction:column; align-items:center; gap:10px; }
  .qrbox img { width:100%; max-width:300px; background:#fff; border-radius:6px; padding:6px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12.5px; }
  .kv span:nth-child(odd) { color:var(--dim); }
  .paircode { font-size:30px; letter-spacing:.18em; text-align:center; padding:12px;
              background:#0c0e13; border:1px dashed var(--accent); border-radius:8px; }
  .full { grid-column:1/-1; }
  .muted { color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>WhatsApp Relay - Test Console</h1>
  <span id="state" class="badge">-</span>
  <span id="me" class="muted"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="refresh">Refresh status</button>
</header>

<p class="warn"><strong>Anyone who scans this QR or types this pairing code links a device to
the WhatsApp account</strong> and can then read and send messages as it. This page is served to
loopback callers only - reach it through <code>ssh -L 3000:127.0.0.1:3000 user@host</code>.
Never expose it. The API key you paste below is kept in this tab's sessionStorage only.</p>

<main>
  <section>
    <h2>1. API key</h2>
    <label for="key">X-API-Key (32+ chars)</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="openssl rand -hex 32">
    <div class="row">
      <button id="saveKey">Save for this tab</button>
      <button class="ghost" id="clearKey">Clear</button>
      <span id="keyState" class="muted"></span>
    </div>
  </section>

  <section>
    <h2>2. Connection</h2>
    <div class="kv" id="statusKv"></div>
    <div class="row"><span class="muted">Auto-polls /health every 3s.</span></div>
  </section>

  <section>
    <h2>3a. Link by QR</h2>
    <div class="qrbox">
      <img id="qrImg" alt="pairing QR" hidden>
      <div id="qrMsg" class="muted">Press Load QR. Scan from WhatsApp &gt; Linked devices &gt; Link a device.</div>
    </div>
    <div class="row">
      <button id="loadQr">Load QR</button>
      <label style="margin:0"><input type="checkbox" id="autoQr" style="width:auto" checked> auto-refresh 20s</label>
    </div>
  </section>

  <section>
    <h2>3b. Link by pairing code</h2>
    <label for="phone">Phone number of the account being linked (with country code)</label>
    <input id="phone" placeholder="+62 812 3456 789" autocomplete="off">
    <div class="row"><button id="getPair">Request code</button></div>
    <div id="pairOut"></div>
    <p class="muted">On the phone: Linked devices &gt; Link a device &gt;
      <em>Link with phone number instead</em>. Code expires in ~60s. Use one method at a
      time - each request issues a fresh code and supersedes the previous one, so press
      <em>Load QR</em> again before going back to scanning.</p>
  </section>

  <section>
    <h2>4. Send a message</h2>
    <label for="sendJid">Group JID (blank uses DEFAULT_GROUP_JID)</label>
    <input id="sendJid" placeholder="120363000000000000@g.us" autocomplete="off">
    <label for="msg">Message (1-4000 chars)</label>
    <textarea id="msg" placeholder="hello from the relay"></textarea>
    <label for="idem">Idempotency-Key (optional - resend the same key to test replay)</label>
    <input id="idem" placeholder="test-1" autocomplete="off">
    <div class="row"><button id="send">POST /send</button>
      <button class="ghost" id="sendTwice">Send twice (idempotency test)</button></div>
  </section>

  <section>
    <h2>5. Create a group</h2>
    <label for="subject">Subject (1-100)</label>
    <input id="subject" placeholder="Deploy alerts" autocomplete="off">
    <label for="parts">Participants, one per line or comma separated</label>
    <textarea id="parts" placeholder="+62 812 3456 789"></textarea>
    <div class="row"><button id="create">POST /groups</button></div>
    <p class="muted">Check <code>notAdded</code> in the response - a contact whose "who can add me
      to groups" setting excludes you is left out silently. Use the returned inviteLink.</p>
  </section>

  <section class="full">
    <h2>6. Conversations</h2>
    <div class="row" style="margin:0 0 10px">
      <button id="loadChats">GET /chats</button>
      <button class="ghost" id="loadGroups">GET /groups only</button>
      <select id="kind" style="width:auto">
        <option value="all">all</option>
        <option value="dm">dm</option>
        <option value="group">group</option>
        <option value="broadcast">broadcast</option>
        <option value="newsletter">newsletter</option>
      </select>
      <input id="search" placeholder="search name or jid" style="width:220px" autocomplete="off">
      <label style="margin:0"><input type="checkbox" id="autoChats" style="width:auto" checked>
        keep polling until history sync completes</label>
    </div>
    <div id="chatCount" class="muted" style="margin-bottom:8px"></div>
    <table id="chatTable"><thead><tr>
      <th>Kind</th><th>Name</th><th>JID</th><th>Members</th><th>Unread</th><th>Last activity</th><th>Flags</th><th></th>
    </tr></thead><tbody></tbody></table>
  </section>

  <section class="full">
    <h2>7. Response log</h2>
    <div class="row" style="margin:0 0 10px"><button class="ghost" id="clearLog">Clear</button></div>
    <pre id="log">waiting...</pre>
  </section>
</main>

<script>
'use strict';
var KEY_STORE = 'wa_relay_key';
var el = function (id) { return document.getElementById(id); };
var qrUrl = null;
var qrTimer = null;

function getKey() { return sessionStorage.getItem(KEY_STORE) || ''; }

function setKeyState() {
  var k = getKey();
  el('keyState').textContent = k ? 'stored (' + k.length + ' chars)' : 'not set';
  el('key').value = k;
}

function log(label, status, payload) {
  var stamp = new Date().toISOString().slice(11, 23);
  var head = stamp + '  ' + label + (status ? '  -> ' + status : '');
  var body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  var pre = el('log');
  pre.textContent = head + '\\n' + body + '\\n\\n' + (pre.textContent === 'waiting...' ? '' : pre.textContent);
}

function headers(extra) {
  var h = { 'X-API-Key': getKey() };
  if (extra) { for (var p in extra) { h[p] = extra[p]; } }
  return h;
}

async function api(method, path, body, extraHeaders) {
  var init = { method: method, headers: headers(extraHeaders) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  var res, json;
  try {
    res = await fetch(path, init);
  } catch (e) {
    log(method + ' ' + path, 'network error', String(e));
    return { status: 0, body: null };
  }
  var text = await res.text();
  try { json = JSON.parse(text); } catch (e) { json = text; }
  log(method + ' ' + path, res.status, json);
  return { status: res.status, body: json };
}

function badgeClass(state, healthy) {
  if (healthy) { return 'badge b-ok'; }
  if (state === 'needs_relink' || state === 'replaced' || state === 'restricted') { return 'badge b-bad'; }
  return 'badge b-warn';
}

async function pollHealth(verbose) {
  var res;
  try { res = await fetch('/health'); } catch (e) {
    el('state').textContent = 'unreachable';
    el('state').className = 'badge b-bad';
    return null;
  }
  var s = await res.json();
  el('state').textContent = s.state + (s.outgoingBlocked ? ' / send-blocked' : '');
  el('state').className = badgeClass(s.state, s.healthy);
  el('me').textContent = s.me ? s.me.jid : '';
  var rows = [
    ['state', s.state], ['healthy', String(s.healthy)],
    ['reason', s.reason || '-'], ['linked account', s.me ? s.me.jid : '-'],
    ['qr pending', String(s.qrAvailable)], ['reconnects', String(s.reconnects)],
    ['queue depth', String(s.queueDepth)], ['uptime', s.uptimeSeconds + 's'],
    ['connected at', s.connectedAt || '-'], ['last disconnect', s.lastDisconnectAt || '-']
  ];
  if (s.outgoingBlocked) { rows.push(['outgoing', 'BLOCKED by WhatsApp']); }
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    html += '<span>' + rows[i][0] + '</span><span>' + escapeHtml(rows[i][1]) + '</span>';
  }
  el('statusKv').innerHTML = html;
  if (verbose) { log('GET /health', res.status, s); }
  return s;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function loadQr() {
  if (!getKey()) { el('qrMsg').textContent = 'Set the API key first.'; return; }
  var res;
  try {
    res = await fetch('/qr', { headers: headers({ Accept: 'image/png' }) });
  } catch (e) { el('qrMsg').textContent = 'network error: ' + e; return; }

  if (res.status === 200) {
    var blob = await res.blob();
    if (qrUrl) { URL.revokeObjectURL(qrUrl); }
    qrUrl = URL.createObjectURL(blob);
    el('qrImg').src = qrUrl;
    el('qrImg').hidden = false;
    el('qrMsg').textContent = 'Fetched ' + new Date().toLocaleTimeString() +
      '. WhatsApp > Linked devices > Link a device.';
    log('GET /qr', 200, 'image/png ' + blob.size + ' bytes');
  } else {
    var j = await res.json().catch(function () { return {}; });
    el('qrImg').hidden = true;
    el('qrMsg').textContent = (j.error || res.status) + ': ' + (j.message || '');
    log('GET /qr', res.status, j);
  }
}

function scheduleQr() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  if (el('autoQr').checked) { qrTimer = setInterval(loadQr, 20000); }
}

function participantList() {
  return el('parts').value.split(/[\\n,;]+/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function sendBody() {
  var body = { message: el('msg').value };
  var jid = el('sendJid').value.trim();
  if (jid) { body.groupJid = jid; }
  return body;
}

function sendHeaders() {
  var idem = el('idem').value.trim();
  return idem ? { 'Idempotency-Key': idem } : undefined;
}

el('saveKey').onclick = function () {
  sessionStorage.setItem(KEY_STORE, el('key').value.trim());
  setKeyState();
  pollHealth(false);
};
el('clearKey').onclick = function () { sessionStorage.removeItem(KEY_STORE); setKeyState(); };
el('refresh').onclick = function () { pollHealth(true); };
el('loadQr').onclick = loadQr;
el('autoQr').onchange = scheduleQr;

el('getPair').onclick = async function () {
  var out = el('pairOut');
  out.innerHTML = '';
  var r = await api('POST', '/pair', { phoneNumber: el('phone').value.trim() });
  if (r.status === 200) {
    out.innerHTML = '<div class="paircode">' + escapeHtml(r.body.display) + '</div>' +
      '<p class="muted">' + escapeHtml(r.body.instructions) + '</p>';
  } else {
    out.innerHTML = '<p class="muted">' + escapeHtml((r.body && r.body.message) || r.status) + '</p>';
  }
};

el('send').onclick = function () { api('POST', '/send', sendBody(), sendHeaders()); };
el('sendTwice').onclick = async function () {
  var h = sendHeaders();
  if (!h) { log('idempotency test', '', 'Set an Idempotency-Key first, otherwise both sends are independent.'); return; }
  await api('POST', '/send', sendBody(), h);
  await api('POST', '/send', sendBody(), h);
  log('idempotency test', '', 'Expect one WhatsApp message; the second response should carry idempotentReplay:true.');
};

el('create').onclick = function () {
  api('POST', '/groups', { subject: el('subject').value.trim(), participants: participantList() });
};

function renderRows(rows) {
  var tbody = el('chatTable').querySelector('tbody');
  tbody.innerHTML = '';
  rows.forEach(function (c) {
    var flags = [];
    if (c.iAmAdmin) { flags.push('admin'); }
    if (c.announceOnly) { flags.push('announce-only'); }
    if (c.archived) { flags.push('archived'); }
    if (c.pinned) { flags.push('pinned'); }
    if (c.readOnly) { flags.push('read-only'); }
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + c.kind + '</td>' +
      '<td>' + escapeHtml(c.name || '-') + '</td>' +
      '<td><code>' + escapeHtml(c.jid) + '</code></td>' +
      '<td>' + (c.participantCount == null ? '-' : c.participantCount) + '</td>' +
      '<td>' + (c.unreadCount || 0) + '</td>' +
      '<td>' + (c.lastActivity ? c.lastActivity.replace('T', ' ').slice(0, 19) : '-') + '</td>' +
      '<td>' + flags.join(', ') + '</td><td></td>';
    var btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = 'Use';
    btn.onclick = function () {
      el('sendJid').value = c.jid;
      if (navigator.clipboard) { navigator.clipboard.writeText(c.jid); }
      log('selected chat', '', c.jid + ' (copied to clipboard)');
    };
    tr.lastChild.appendChild(btn);
    tbody.appendChild(tr);
  });
}

var chatTimer = null;

async function loadChats(quiet) {
  var qs = [];
  var kind = el('kind').value;
  if (kind !== 'all') { qs.push('kind=' + kind); }
  var s = el('search').value.trim();
  if (s) { qs.push('search=' + encodeURIComponent(s)); }
  var path = '/chats' + (qs.length ? '?' + qs.join('&') : '');

  var res;
  try { res = await fetch(path, { headers: headers() }); } catch (e) { log('GET ' + path, 'network error', String(e)); return; }
  var body = await res.json().catch(function () { return null; });
  if (!quiet) { log('GET ' + path, res.status, body); }

  if (res.status !== 200 || !body) {
    el('chatCount').textContent = 'failed: ' + res.status + ' ' + ((body && body.message) || '');
    return;
  }

  renderRows(body.chats);
  var h = body.historySync;
  el('chatCount').textContent =
    'showing ' + body.count + ' of ' + body.matched + ' matched / ' + body.total + ' total  |  ' +
    'dm ' + body.counts.dm + ', group ' + body.counts.group +
    ', broadcast ' + body.counts.broadcast + ', newsletter ' + body.counts.newsletter +
    '  |  history sync: ' + (h.enabled ? (h.complete ? 'complete' : 'in progress' +
      (h.progress != null ? ' (' + h.progress + '%)' : '') + ', chunks ' + h.chunks) : 'disabled') +
    (h.truncated ? '  |  TRUNCATED at store limit' : '');

  // "Load everything" needs polling: the chat list is pushed to us in chunks, not
  // fetched, so one request only sees what has arrived so far. Groups are already
  // complete on the first call.
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null; }
  if (el('autoChats').checked && h.enabled && !h.complete) {
    chatTimer = setTimeout(function () { loadChats(true); }, 5000);
  }
}

el('loadChats').onclick = function () { loadChats(false); };
el('kind').onchange = function () { loadChats(false); };
el('search').oninput = function () { loadChats(true); };

el('loadGroups').onclick = async function () {
  var r = await api('GET', '/groups');
  if (r.status !== 200) { el('chatCount').textContent = 'failed'; return; }
  el('chatCount').textContent = r.body.count + ' group(s) from the live RPC';
  renderRows(r.body.groups.map(function (g) {
    return { jid: g.jid, kind: 'group', name: g.subject, participantCount: g.participantCount,
             iAmAdmin: g.iAmAdmin, announceOnly: g.announceOnly };
  }));
};

el('clearLog').onclick = function () { el('log').textContent = 'waiting...'; };

setKeyState();
pollHealth(false);
setInterval(function () { pollHealth(false); }, 3000);
scheduleQr();
</script>
</body>
</html>
`;
