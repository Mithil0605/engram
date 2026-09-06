'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS_TOKEN = 'engram.deviceToken';
const LS_NAME = 'engram.deviceName';

let token = localStorage.getItem(LS_TOKEN);
let meta = { encrypted: false, locked: false, host: '127.0.0.1', tls: false, version: '0.1.0', devices: 0 };

async function api(method, p, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch (_) { j = {}; }
  if (r.status === 423 && j.error) { showLockBanner(); }
  return { status: r.status, body: j };
}

function showLockBanner() {
  const b = $('#lock-banner');
  if (b) b.style.display = 'block';
  const a = $('#banner-msg');
  if (a) { a.innerHTML = `<div class="banner err"><strong>Locked</strong> The memory store is encrypted. Enter the password above to unlock.</div>`; }
}
function hideBanner() {
  const b = $('#lock-banner');
  if (b) b.style.display = 'none';
  const a = $('#banner-msg');
  if (a) a.innerHTML = '';
}

function renderPills() {
  const p = $('#pills');
  if (!p) return;
  p.innerHTML = [
    `<span class="pill ${meta.locked ? 'amber' : 'green'}"><span class="dot"></span>${meta.locked ? 'locked' : 'encrypted ' + (meta.encrypted ? 'on' : 'off')}</span>`,
    `<span class="pill blue"><span class="dot"></span>${meta.devices} device${meta.devices === 1 ? '' : 's'}</span>`,
    `<span class="pill"><span class="dot"></span>v${esc(meta.version)}</span>`,
  ].join('');
}

async function loadMeta() {
  const r = await api('GET', '/v1/status');
  if (r.status === 200) Object.assign(meta, r.body);
  if (r.status === 423) { meta.locked = true; showLockBanner(); }
  renderPills();
  renderSecurity();
}

async function refreshResults() {
  const proj = $('#search-project').value.trim() || 'default';
  const q = $('#search-query').value.trim();
  const url = q
    ? `/v1/recall?project=${encodeURIComponent(proj)}&query=${encodeURIComponent(q)}&limit=30`
    : `/v1/list?project=${encodeURIComponent(proj)}&limit=30`;
  const r = await api('GET', url);
  const box = $('#results');
  if (r.status !== 200) { box.innerHTML = `<div class="banner err"><strong>Error ${r.status}</strong>${esc(r.body.error || '')}</div>`; return; }
  const items = r.body.results || [];
  if (!items.length) { box.innerHTML = `<div class="empty">No memories yet for <b>${esc(proj)}</b>.</div>`; return; }
  box.innerHTML = items.map((m) => `
    <div class="memory" data-id="${esc(m.id)}">
      <div>
        <div class="txt">${m.pinned ? '<span class="pin">★ </span>' : ''}${esc(m.text)}</div>
        <div class="meta">
          ${m.score !== undefined ? `<span>score ${m.score.toFixed(2)}</span>` : ''}
          <span>${esc((m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' '))}</span>
          <span>${esc(new Date(m.updatedAt).toLocaleString())}</span>
          <span class="small">${esc(m.id.slice(0, 8))}</span>
        </div>
      </div>
      <div class="ops">
        <button title="forget" data-act="forget">delete</button>
        <button title="pin" data-act="pin">${m.pinned ? 'unpin' : 'pin'}</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.memory').forEach((el) => {
    el.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = el.dataset.id;
        const act = b.dataset.act;
        const proj = $('#search-project').value.trim() || 'default';
        if (act === 'forget') {
          await api('DELETE', '/v1/forget/', { project: proj, id });
        } else {
          await api('PATCH', '/v1/update', { project: proj, id, pinned: b.title === 'unpin' ? false : true });
        }
        refreshResults();
      });
    });
  });
}

async function refreshDevices() {
  const r = await api('GET', '/v1/devices');
  const box = $('#devices');
  if (r.status === 403) { box.innerHTML = `<div class="empty">Nothing here for you device.</div>`; return; }
  const devs = r.body.devices || [];
  if (!devs.length) { box.innerHTML = `<div class="empty">No devices paired yet.</div>`; return; }
  box.innerHTML = devs.map((d) => `
    <div class="device">
      <div>
        <div class="name">${esc(d.name)} ${d.revoked ? '<span class="tag" style="background:rgba(248,113,113,.15);color:#f87171">revoked</span>' : ''}</div>
        <div class="sub">${esc(d.deviceId)} · last seen ${esc(new Date(d.lastSeen).toLocaleString())}</div>
      </div>
      ${d.revoked ? '' : `<div class="actions"><button class="btn danger" data-id="${esc(d.deviceId)}">Revoke</button></div>`}
    </div>`).join('');
  box.querySelectorAll('.device .actions button').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('DELETE', '/v1/revoke/' + encodeURIComponent(b.dataset.id));
      refreshDevices();
    });
  });
}

async function renderSecurity() {
  const box = $('#sec');
  if (!box) return;
  if (meta.locked) {
    box.innerHTML = `<div class="banner amber"><strong>Locked for 5 minutes</strong> after too many failed attempts.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n">${meta.encrypted ? 'ON' : 'OFF'}</div><div class="k">encryption</div></div>
      <div class="stat"><div class="n">${meta.locked ? 'locked' : 'open'}</div><div class="k">store state</div></div>
      <div class="stat"><div class="n">${esc(meta.host)}</div><div class="k">bind host</div></div>
      <div class="stat"><div class="n">${meta.tls ? 'on' : 'off'}</div><div class="k">TLS</div></div>
    </div>
    <div class="row" style="margin-top:14px">
      <input type="password" id="new-pass" placeholder="new store password" autocomplete="new-password" />
      <button class="btn" id="set-pass">Set password / encrypt</button>
    </div>`;
  const b = $('#set-pass');
  if (b) b.addEventListener('click', async () => {
    const p = $('#new-pass').value;
    if (p.length < 8) { alert('password must be at least 8 characters'); return; }
    const r = await api('POST', '/v1/unlock', { password: p });
    if (r.status === 200) { await loadMeta(); }
  });
}

function setupTabs() {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ['mem', 'add', 'devices', 'security'].forEach((t) => {
        const el = $('#tab-' + t);
        if (el) el.style.display = t === b.dataset.tab ? 'block' : 'none';
      });
      if (b.dataset.tab === 'devices') refreshDevices();
      if (b.dataset.tab === 'mem') refreshResults();
    });
  });
}

async function openPair() {
  const r = await api('POST', '/v1/pair/start', {});
  if (r.status !== 200) { alert('pairing unavailable: ' + (r.body.error || r.status)); return; }
  const { code, expiresIn } = r.body;
  const proto = location.protocol === 'https:' ? 'https' : 'http';
  const url = `${proto}://${location.host}/m`;
  $('#pair-url').textContent = url;
  $('#pair-code').textContent = code;
  $('#pair-expiry').textContent = `Expires in ${Math.round(expiresIn / 1000)}s. Enter it on the phone to grant a revocable token.`;
  $('#pair-modal').classList.add('open');
}

function init() {
  setupTabs();
  const lc = $('#lock-btn');
  if (lc) lc.addEventListener('click', async () => {
    const r = await api('POST', '/v1/unlock', { password: $('#lock-pass').value });
    if (r.status === 200) { hideBanner(); await loadMeta(); $('#lock-pass').value = ''; }
    else alert(r.body.error || 'bad password');
  });
  $('#search-btn').addEventListener('click', refreshResults);
  $('#search-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshResults(); });
  $('#add-btn').addEventListener('click', async () => {
    const text = $('#add-text').value.trim();
    if (!text) return;
    const tags = $('#add-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const r = await api('POST', '/v1/remember', {
      project: $('#add-project').value.trim() || 'default',
      text,
      tags,
      pinned: $('#add-pinned').checked,
      source: 'dashboard',
    });
    if (r.status === 200) {
      $('#add-text').value = '';
      const a = $('#banner-msg');
      a.innerHTML = `<div class="banner ok"><strong>Remembered</strong> ${r.body.updated ? 'updated an existing near-duplicate memory.' : 'New memory stored.'}</div>`;
    } else {
      const a = $('#banner-msg');
      a.innerHTML = `<div class="banner err"><strong>Error ${r.status}</strong>${esc(r.body.error || '')}</div>`;
    }
  });
  $('#pair-btn').addEventListener('click', openPair);
  $('#pair-close').addEventListener('click', () => $('#pair-modal').classList.remove('open'));
  $('#pair-modal').addEventListener('click', (e) => { if (e.target.id === 'pair-modal') e.target.classList.remove('open'); });
  loadMeta().then(refreshResults);
}
document.addEventListener('DOMContentLoaded', init);