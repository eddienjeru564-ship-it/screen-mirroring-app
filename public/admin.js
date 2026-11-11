// admin.js — password-protected list of logged sessions.
// The password is kept only in this tab's memory and sent as a request header.

const $ = (id) => document.getElementById(id);
let password = '';

async function load() {
  const res = await fetch('/api/admin/sessions', { headers: { 'x-admin-password': password } });
  if (res.status === 401) throw new Error('Wrong password.');
  if (res.status === 503) throw new Error('Admin is disabled. Set ADMIN_PASSWORD on the server.');
  if (!res.ok) throw new Error('Could not load sessions.');
  const { sessions } = await res.json();
  render(sessions);
}

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text; // textContent: never inject log data as HTML
  if (className) td.className = className;
  return td;
}

function render(sessions) {
  const tbody = $('rows');
  tbody.replaceChildren();
  $('empty').classList.toggle('hidden', sessions.length > 0);
  for (const s of sessions) {
    const tr = document.createElement('tr');
    const code = s.code ? `${s.code.slice(0, 3)}-${s.code.slice(3)}` : '—';
    tr.append(
      cell(code, 'mono'),
      cell(fmt(s.startTs)),
      cell(s.endTs ? fmt(s.endTs) : 'active'),
      cell(s.durationHuman || '—'),
      cell(`${s.viewerJoins} / ${s.viewerLeaves}`),
      cell(s.endReason || '—'),
      cell([s.quality, s.hasPassword ? 'password' : null].filter(Boolean).join(', ') || '—'),
    );
    tbody.append(tr);
  }
}

async function signIn() {
  password = $('adminPw').value;
  $('loginError').classList.add('hidden');
  try {
    await load();
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
  } catch (err) {
    password = '';
    $('loginError').textContent = err.message;
    $('loginError').classList.remove('hidden');
  }
}

$('loginBtn').addEventListener('click', signIn);
$('adminPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
$('refreshBtn').addEventListener('click', () => load().catch(() => {}));
$('logoutBtn').addEventListener('click', () => {
  password = '';
  $('adminPw').value = '';
  $('dash').classList.add('hidden');
  $('login').classList.remove('hidden');
});
