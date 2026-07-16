// ══════════════════════════════════════════════════
//  WC 2026 Score Predictor — Main App
// ══════════════════════════════════════════════════

// ── SUPABASE CONFIG ───────────────────────────────
// Replace these two values with your Supabase project credentials
const SUPA_URL = 'https://uvuitxfoxmpfkvftfaww.supabase.co';
const SUPA_KEY = 'sb_publishable_Eom9ozKXnhJhcLlkuF49Dg_3hv6zXy4';
let supa = null;

// ── STATE ─────────────────────────────────────────
let TEAMS   = {};
let MATCHES = [];
let STATS   = {};
let currentUser = null;

// In-memory cache (source of truth, loaded from Supabase)
let _users       = {};   // { username: { color, role, pin, championPick, topScorerPick, created } }
let _predictions = {};   // { username: { matchId: { home, away } } }
let _results     = {};   // { matchId: { home, away } }
let _champion    = null; // teamId or null
let _topScorer   = null; // player name or null
let _topScorers  = [];   // [{name, team, count}]
let _topAssists  = [];   // [{name, team, count}]
let _chat        = [];   // [{id, username, message, color, created_at}]
let KNOCKOUT     = [];   // knockout match objects
let _drawWinners = [];   // [{name, color, prizeName, prizeImg}] — lucky draw results

// Wheel animation state (local only, no persistence needed)
let _wheelAngle = 0;
let _wheelSpin  = false;

// LocalStorage: only admin session + unlocks (not shared across users)
const STORAGE = {
  SESSION:       'wc2026_session',
  ADMIN_SESSION: 'wc2026_admin',
  ADMIN_UNLOCKS: 'wc2026_unlocks',
  ADMIN_PWD:     'wc2026_admin_pwd',
};

// ── SUPABASE DB OPERATIONS ────────────────────────

// Supabase server caps results at 1000 rows by default — paginate to fetch everything
async function fetchAllRows(table) {
  const PAGE = 1000;
  let all = [], from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select('*').range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function dbInit() {
  supa = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    }
  });
  const [usersData, predsData, resultsData, settingsData] = await Promise.all([
    fetchAllRows('users'),
    fetchAllRows('predictions'),
    fetchAllRows('match_results'),
    fetchAllRows('app_settings'),
  ]);
  _users = {};
  usersData.forEach(u => {
    _users[u.username] = {
      color: u.color, role: u.role || 'member', pin: u.pin,
      championPick: u.champion_pick || null, topScorerPick: u.top_scorer_pick || null,
      created: new Date(u.created_at).getTime(),
    };
  });
  _predictions = {};
  predsData.forEach(p => {
    if (!_predictions[p.username]) _predictions[p.username] = {};
    _predictions[p.username][p.match_id] = { home: p.home_score, away: p.away_score };
  });
  _results = {};
  resultsData.forEach(r => { _results[r.match_id] = { home: r.home_score, away: r.away_score }; });
  mergeResultsIntoMatches();
  _champion = null; _topScorer = null; _topScorers = []; _topAssists = []; KNOCKOUT = [];
  settingsData.forEach(s => {
    if (s.key === 'champion')         _champion  = s.value;
    if (s.key === 'top_scorer')       _topScorer = s.value;
    if (s.key === 'top_scorers_list') { try { _topScorers = JSON.parse(s.value); } catch(e) {} }
    if (s.key === 'top_assists_list') { try { _topAssists = JSON.parse(s.value); } catch(e) {} }
    if (s.key === 'knockout_matches') { try { KNOCKOUT     = JSON.parse(s.value); } catch(e) { console.error('[DB] knockout_matches parse error', e); } }
    if (s.key === 'draw_winners')    { try { _drawWinners = JSON.parse(s.value); } catch(e) {} }
  });
  console.log(`[DB] loaded — users:${usersData.length} predictions:${predsData.length} results:${resultsData.length} knockout:${KNOCKOUT.length} settings keys:[${settingsData.map(s=>s.key).join(',')}]`);
}

function mergeResultsIntoMatches() {
  MATCHES.forEach(m => {
    const r = _results[m.id];
    m.homeScore = r ? r.home : null;
    m.awayScore = r ? r.away : null;
  });
}

async function dbSavePrediction(username, matchId, home, away) {
  if (home === null) {
    const { error } = await supa.from('predictions').delete().eq('username', username).eq('match_id', matchId);
    console.log('[DB] delete pick', matchId, error?.message || 'OK');
    return error ? { ok: false, error } : { ok: true };
  } else {
    const { data, error } = await supa.from('predictions').upsert(
      { username, match_id: matchId, home_score: home, away_score: away },
      { onConflict: 'username,match_id' }
    ).select();
    console.log('[DB] upsert pick', matchId, home, away, '→', error?.message || `saved (${data?.length ?? 0} rows)`);
    return error ? { ok: false, error } : { ok: true };
  }
}

async function dbSaveResult(matchId, home, away) {
  if (home === null) {
    await supa.from('match_results').delete().eq('match_id', matchId);
  } else {
    await supa.from('match_results').upsert({ match_id: matchId, home_score: home, away_score: away }, { onConflict: 'match_id' });
  }
}

async function dbCreateUser(username, role, pin) {
  if (Object.keys(_users).some(u => u.toLowerCase() === username.toLowerCase())) return { error: 'Username already taken.' };
  const color = AVATAR_COLORS[Object.keys(_users).length % AVATAR_COLORS.length];
  const { error } = await supa.from('users').insert({ username, color, role: role || 'member', pin });
  if (error) return { error: error.message };
  _users[username] = { color, role: role || 'member', pin, championPick: null, topScorerPick: null, created: Date.now() };
  return { ok: true };
}

async function dbDeleteUser(username) {
  await supa.from('users').delete().eq('username', username);
  delete _users[username];
  delete _predictions[username];
}

async function dbUpdateUserField(username, field, value) {
  const col = field === 'championPick' ? 'champion_pick' : field === 'topScorerPick' ? 'top_scorer_pick' : field;
  await supa.from('users').update({ [col]: value }).eq('username', username);
  if (_users[username]) _users[username][field] = value;
}

async function dbSetSetting(key, value) {
  await supa.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
  if (key === 'champion')   _champion  = value;
  if (key === 'top_scorer') _topScorer = value;
}

async function dbDeleteSetting(key) {
  await supa.from('app_settings').delete().eq('key', key);
  if (key === 'champion')   _champion  = null;
  if (key === 'top_scorer') _topScorer = null;
}

async function dbSavePlayerStats(type, data) {
  const key = type === 'scorers' ? 'top_scorers_list' : 'top_assists_list';
  await supa.from('app_settings').upsert({ key, value: JSON.stringify(data) }, { onConflict: 'key' });
  if (type === 'scorers') _topScorers = data;
  else _topAssists = data;
  renderStats();
}

async function dbSaveKnockout(matches) {
  KNOCKOUT = matches;
  await supa.from('app_settings').upsert({ key: 'knockout_matches', value: JSON.stringify(matches) }, { onConflict: 'key' });
  renderBracket();
  renderKnockoutSchedule();
  if (currentUser) renderPicksKnockout();
}

async function dbLoadChat() {
  const { data } = await supa.from('chat').select('*').order('created_at', { ascending: true }).limit(150);
  _chat = data || [];
  renderChat();
}

async function dbSendChat(message) {
  if (!currentUser || !message.trim()) return;
  const color = _users[currentUser]?.color || '#888';
  await supa.from('chat').insert({ username: currentUser, message: message.trim(), color });
}

// ── COMPAT SHIM ───────────────────────────────────
// getUsers() returns the same structure as before, but computed from Supabase cache
function getUsers() {
  const out = {};
  for (const [name, u] of Object.entries(_users)) {
    const preds = _predictions[name] || {};
    let pts = 0, exact = 0, winner = 0;
    MATCHES.forEach(m => {
      if (m.homeScore === null || m.awayScore === null) return;
      const p = preds[m.id]; if (!p) return;
      if (p.home === m.homeScore && p.away === m.awayScore) { pts += 3; exact++; }
      else if (Math.sign(p.home - p.away) === Math.sign(m.homeScore - m.awayScore)) { pts += 1; winner++; }
    });
    KNOCKOUT.forEach(m => {
      if (m.homeScore === null || m.awayScore === null) return;
      const p = preds[m.id]; if (!p) return;
      if (p.home === m.homeScore && p.away === m.awayScore) { pts += 3; exact++; }
      else if (Math.sign(p.home - p.away) === Math.sign(m.homeScore - m.awayScore)) { pts += 1; winner++; }
    });
    if (_champion  && u.championPick  === _champion) pts += 4;
    if (_topScorer && u.topScorerPick && u.topScorerPick.toLowerCase() === _topScorer.toLowerCase()) pts += 5;
    out[name] = { ...u, predictions: preds, points: pts, exact, winner };
  }
  return out;
}
function saveUsers() { /* no-op: data lives in Supabase */ }
function updateUserPoints() { /* no-op: computed on the fly in getUsers() */ }

// ── REALTIME ──────────────────────────────────────
function setupRealtime() {
  supa.channel('chat-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat' }, payload => {
      if (!_chat.find(c => c.id === payload.new.id)) {
        _chat.push(payload.new);
        renderChat();
      }
    })
    .subscribe();

  supa.channel('live-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, payload => {
      const p = payload.new || payload.old;
      if (payload.eventType === 'DELETE') {
        if (_predictions[p.username]) delete _predictions[p.username][p.match_id];
      } else {
        if (!_predictions[p.username]) _predictions[p.username] = {};
        _predictions[p.username][p.match_id] = { home: p.home_score, away: p.away_score };
      }
      renderLeaderboard(); renderHome();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_results' }, payload => {
      const r = payload.new || payload.old;
      if (payload.eventType === 'DELETE') { delete _results[r.match_id]; }
      else { _results[r.match_id] = { home: r.home_score, away: r.away_score }; }
      mergeResultsIntoMatches();
      renderGroups(); renderLeaderboard(); renderStats(); renderHome();
      renderScheduleList(document.querySelector('#scheduleFilters .filter-btn.active')?.dataset.group || 'all');
      if (currentUser) renderPicks();
    })
    .subscribe();
}

const AVATAR_COLORS = [
  '#d4001e','#0077c8','#00875a','#7c3aed','#ea580c',
  '#0891b2','#be185d','#65a30d','#b45309','#0f766e',
];

// ── VENUE TIMEZONES (WC 2026, summer DST) ─────────
const VENUE_UTC = {
  'Los Angeles': -7, 'San Francisco': -7, 'Seattle': -7, 'Vancouver': -7,
  'Dallas': -5, 'Kansas City': -5, 'Houston': -5,
  'New York': -4, 'Philadelphia': -4, 'Boston': -4, 'Miami': -4, 'Atlanta': -4, 'Toronto': -4,
  'Mexico City': -6, 'Monterrey': -6, 'Guadalajara': -6,  // Mexico: no DST since 2023
};

function matchUTCDate(m) {
  return new Date(m.utc);
}

function warsawKickoff(m) {
  const utc = matchUTCDate(m);
  return {
    time: utc.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false }),
    date: utc.toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: 'short' }),
  };
}

// Returns "YYYY-MM-DD" in Warsaw timezone — used to group matches by day
function matchWarsawDate(m) {
  return matchUTCDate(m).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
}

// Returns "Weekday, DD Month YYYY" header label in Warsaw timezone
function fmtWarsawDateLong(m) {
  return matchUTCDate(m).toLocaleDateString('en-GB', { timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function isMatchLocked(m) {
  if (m.homeScore !== null && m.awayScore !== null) return true;
  const unlocks = JSON.parse(localStorage.getItem(STORAGE.ADMIN_UNLOCKS) || '[]');
  if (unlocks.includes(m.id)) return false;
  return Date.now() >= matchUTCDate(m).getTime() - 2 * 3600 * 1000;
}

// ── INIT ──────────────────────────────────────────
function safeRun(label, fn) {
  try { fn(); } catch(e) { console.error('[' + label + ']', e); }
}

async function init() {
  showLoadingOverlay(true);
  await loadData();
  await dbInit();
  showLoadingOverlay(false);
  restoreSession();
  renderSidebarUser();
  setupNav();
  safeRun('renderHome',       renderHome);
  safeRun('renderSchedule',   renderSchedule);
  safeRun('renderGroups',     renderGroups);
  safeRun('renderLeaderboard',renderLeaderboard);
  safeRun('renderStats',      renderStats);
  safeRun('renderRewards',    renderRewards);
  safeRun('renderPicks',      renderPicks);
  safeRun('renderAdmin',      renderAdmin);
  safeRun('startCountdown',   startCountdown);
  setupRealtime();
  dbLoadChat();
}

function showLoadingOverlay(show) {
  document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
}

async function loadData() {
  try {
    const [teamsRes, matchesRes, statsRes] = await Promise.all([
      fetch('data/teams.json'),
      fetch('data/matches.json'),
      fetch('data/stats.json'),
    ]);
    const teamsJson   = await teamsRes.json();
    const matchesJson = await matchesRes.json();
    STATS = await statsRes.json();
    MATCHES = matchesJson.groupStage.map(m => ({ ...m, homeScore: null, awayScore: null }));
    for (const [group, teams] of Object.entries(teamsJson.groups)) {
      teams.forEach(t => { TEAMS[t.id] = { ...t, group }; });
    }
  } catch (e) {
    console.error('Data load error:', e);
    if (location.protocol === 'file:') showFileProtocolWarning();
  }
}

function showFileProtocolWarning() {
  document.body.insertAdjacentHTML('afterbegin', `
    <div style="background:#7c0000;color:#fff;padding:10px 20px;font-size:13px;text-align:center;position:sticky;top:0;z-index:999">
      ⚠️ Open via a local server for full functionality.
      Run: <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px">npx serve .</code>
      or use VS Code Live Server extension.
    </div>
  `);
}

// ── NAVIGATION ────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const sec = el.dataset.section;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('section-' + sec).classList.add('active');
    });
  });
}

function goTo(section) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelector(`.nav-item[data-section="${section}"]`).classList.add('active');
  document.getElementById('section-' + section).classList.add('active');
}

// ── USER / AUTH ───────────────────────────────────
function getPredictions(username) {
  return _predictions[username] || {};
}

function savePrediction(matchId, home, away) {
  if (!currentUser) return;
  if (!_predictions[currentUser]) _predictions[currentUser] = {};
  if (home === '' && away === '') {
    delete _predictions[currentUser][matchId];
    dbSavePrediction(currentUser, matchId, null, null).then(res => {
      if (!res.ok) { console.error('Pick delete failed:', res.error); showToast('⚠️ Could not remove pick – check your connection', 'error'); }
    });
  } else {
    const h = parseInt(home) || 0, a = parseInt(away) || 0;
    _predictions[currentUser][matchId] = { home: h, away: a };
    dbSavePrediction(currentUser, matchId, h, a).then(res => {
      if (!res.ok) { console.error('Pick save failed:', res.error); showToast('⚠️ Pick not saved: ' + (res.error?.message || 'unknown error'), 'error'); }
    }).catch(err => { console.error('Pick save exception:', err); showToast('⚠️ Network error – pick not saved', 'error'); });
  }
  renderSidebarUser();
  updateHomePredCount();
}

function showToast(msg, type = 'info') {
  const existing = document.getElementById('appToast');
  if (existing) clearTimeout(existing._t);
  const el = existing || document.createElement('div');
  el.id = 'appToast';
  el.className = 'app-toast' + (type === 'error' ? ' app-toast-error' : '');
  el.textContent = msg;
  if (!existing) document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('app-toast-show'));
  el._t = setTimeout(() => {
    el.classList.remove('app-toast-show');
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

function calcLeaderboard() {
  return Object.entries(getUsers())
    .map(([name, u]) => ({ name, points: u.points, exact: u.exact, winner: u.winner, color: u.color }))
    .sort((a, b) => b.points - a.points || b.exact - a.exact || b.winner - a.winner);
}

function loginExisting() {
  const name = document.getElementById('usernameInput').value.trim();
  const pin  = document.getElementById('pinInput').value.trim();
  const err  = document.getElementById('loginError');
  if (!_users[name]) { err.textContent = 'Username not found.'; err.style.display = 'block'; return; }
  if (_users[name].pin && _users[name].pin !== pin) { err.textContent = 'Incorrect PIN.'; err.style.display = 'block'; return; }
  setSession(name);
  closeLoginModal();
}

async function adminCreateUser(username, role, pin) {
  if (!username || username.length < 2) return { error: 'Min. 2 characters.' };
  if (!pin || pin.length < 4) return { error: 'PIN must be at least 4 characters.' };
  return await dbCreateUser(username, role, pin);
}

function setSession(name) {
  currentUser = name;
  localStorage.setItem(STORAGE.SESSION, name);
  renderSidebarUser();
  renderPicks();
  renderLeaderboard();
  updateHomePredCount();
  renderSpecialPicksHome();
}

function restoreSession() {
  const saved = localStorage.getItem(STORAGE.SESSION);
  if (saved && _users[saved]) { currentUser = saved; }
}

function logout() {
  currentUser = null;
  localStorage.removeItem(STORAGE.SESSION);
  renderSidebarUser();
  renderPicks();
  renderLeaderboard();
  updateHomePredCount();
  renderSpecialPicksHome();
  openLoginModal('You\'ve been signed out. Login again below.');
}

function renderSidebarUser() {
  const el = document.getElementById('sidebarUser');
  if (!currentUser) {
    el.innerHTML = `
      <button class="btn-login-sidebar" onclick="openLoginModal()">
        <span class="btn-login-icon">🔑</span>
        <span class="btn-login-text">Login</span>
      </button>`;
    return;
  }
  const users = getUsers();
  const u = users[currentUser];
  const initials = currentUser.slice(0, 2).toUpperCase();
  const role = u.role || 'member';
  const roleTag = role === 'superuser' ? ` · <span style="color:var(--gold);font-size:10px">👑 SU</span>`
    : role === 'admin' ? ` · <span style="color:var(--green);font-size:10px">🔧 Admin</span>` : '';
  el.innerHTML = `
    <div class="user-card-wrap">
      <div class="user-card">
        <div class="user-avatar" style="background:${u.color}">${initials}</div>
        <div class="user-info">
          <div class="user-name">${esc(currentUser)}</div>
          <div class="user-pts">⭐ ${u.points || 0} pts${roleTag}</div>
        </div>
      </div>
      <button class="btn-logout" onclick="logout()" title="Logout">⏻</button>
    </div>`;
}

function showUserMenu() {
  if (!currentUser) openLoginModal();
}

function updateHomePredCount() {
  const el = document.getElementById('homePredCount');
  if (!el) return;
  if (!currentUser) { el.textContent = '0'; return; }
  const preds = getPredictions(currentUser);
  // Count predictions only for matches with both teams known (group + KO)
  let cnt = 0;
  MATCHES.forEach(m => { if (preds[m.id] !== undefined) cnt++; });
  KNOCKOUT.forEach(m => { if (m.home && m.away && preds[m.id] !== undefined) cnt++; });
  el.textContent = cnt;
}

// ── MODAL ─────────────────────────────────────────
function openLoginModal(msg) {
  if (msg) document.getElementById('loginModalMsg').textContent = msg;
  document.getElementById('loginModal').classList.add('open');
  setTimeout(() => document.getElementById('usernameInput').focus(), 100);
}
function closeLoginModal() {
  document.getElementById('loginModal').classList.remove('open');
  document.getElementById('usernameInput').value = '';
  document.getElementById('pinInput').value = '';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginModalMsg').textContent = 'Enter your credentials to join.';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLoginModal();
  if (e.key === 'Enter' && document.getElementById('loginModal').classList.contains('open')) loginExisting();
});
document.getElementById('loginModal').addEventListener('click', e => {
  if (e.target === document.getElementById('loginModal')) closeLoginModal();
});

// ── COUNTDOWN ─────────────────────────────────────
function startCountdown() {
  function tick() {
    const now = Date.now();
    const candidates = [
      ...MATCHES.filter(m => m.homeScore === null && m.awayScore === null)
        .map(m => ({ m, t: new Date(m.utc).getTime(), isKo: false })),
      ...KNOCKOUT.filter(m => m.home && m.away && m.homeScore === null && m.awayScore === null)
        .map(m => ({ m, t: new Date(m.utc).getTime(), isKo: true })),
    ].filter(x => x.t > now).sort((a, b) => a.t - b.t);
    const next = candidates[0];

    const cdEl = document.getElementById('countdown');
    if (!cdEl) return;

    if (!next) {
      cdEl.querySelector('.countdown-label').textContent = 'Tournament complete';
      ['cdDays','cdHours','cdMins','cdSecs'].forEach(id => { document.getElementById(id).textContent = '—'; });
      document.getElementById('countdownMatchTeams').textContent = '🏆 All matches complete';
      document.getElementById('countdownMatchMeta').textContent  = '';
      return;
    }

    const diff = next.t - now;
    const h = TEAMS[next.m.home] || { name: next.m.homeLabel || next.m.home, iso2: null };
    const a = TEAMS[next.m.away] || { name: next.m.awayLabel || next.m.away, iso2: null };
    const wk = warsawKickoff(next.m);
    const phase = next.isKo ? (KO_ROUND_LABELS[next.m.round] || next.m.round) : `Group ${next.m.group}`;

    document.getElementById('cdDays').textContent  = Math.floor(diff / 86400000);
    document.getElementById('cdHours').textContent = Math.floor((diff % 86400000) / 3600000);
    document.getElementById('cdMins').textContent  = Math.floor((diff % 3600000) / 60000);
    document.getElementById('cdSecs').textContent  = Math.floor((diff % 60000) / 1000);

    document.getElementById('countdownLabel').textContent = 'Next match in';
    document.getElementById('countdownMatchTeams').innerHTML =
      `${flag(h.iso2, 18)} ${h.name} vs ${a.name} ${flag(a.iso2, 18)}`;
    document.getElementById('countdownMatchMeta').textContent =
      `${wk.date} · ${wk.time} Warsaw · ${phase}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ── SPECIAL PICKS ─────────────────────────────────
const SPECIAL_LOCK_UTC = new Date('2026-06-11T22:00:00Z'); // 2h before first match
function isSpecialPickLocked() { return Date.now() >= SPECIAL_LOCK_UTC.getTime(); }

async function saveSpecialPick(type, value) {
  if (!currentUser || isSpecialPickLocked()) return;
  if (_users[currentUser]) _users[currentUser][type] = value;
  renderSpecialPicksHome();
  renderSidebarUser();
  await dbUpdateUserField(currentUser, type, value);
}

function renderSpecialPicksHome() {
  const el = document.getElementById('bonusPicks');
  if (!el) return;
  const locked = isSpecialPickLocked();
  const champion  = _champion;
  const topScorer = _topScorer;
  const preds = currentUser ? getPredictions(currentUser) : {};
  const u = currentUser ? (getUsers()[currentUser] || {}) : {};

  const lockBadge = locked
    ? `<span class="admin-badge red" style="font-size:10px">🔒 Locked</span>`
    : `<span class="admin-badge gray" style="font-size:10px">Locks Jun 12 · 00:00 Warsaw</span>`;

  // Champion pick
  const teamOptions = Object.values(TEAMS).sort((a,b) => a.name.localeCompare(b.name));
  const champPick = u.championPick || '';
  let champResult = '';
  if (champion) {
    const t = TEAMS[champion] || { name: champion, iso2: null };
    const hit = champPick === champion;
    champResult = `<div style="margin-top:8px;font-size:12px;color:var(--text3)">Winner: <strong style="color:${hit?'var(--green)':'var(--text2)'}">${flag(t.iso2,16)} ${t.name}</strong>${hit?' <span class="pred-pts exact">+4 pts</span>':''}</div>`;
  }

  // Top scorer pick
  const scorerPick = u.topScorerPick || '';
  let scorerResult = '';
  if (topScorer) {
    const hit = scorerPick.toLowerCase() === topScorer.toLowerCase();
    scorerResult = `<div style="margin-top:8px;font-size:12px;color:var(--text3)">Top scorer: <strong style="color:${hit?'var(--green)':'var(--text2)'}">${esc(topScorer)}</strong>${hit?' <span class="pred-pts exact">+5 pts</span>':''}</div>`;
  }

  el.innerHTML = `
    <div class="special-picks-bar card" style="margin-bottom:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        <div class="card-title" style="margin:0">🏆 Tournament Bonus Picks</div>
        ${lockBadge}
      </div>
      <div class="special-picks-grid">
        <div class="special-pick-item">
          <div class="sp-label">🏆 Tournament Champion <span class="sp-pts">+4 pts</span></div>
          ${!currentUser
            ? `<div class="sp-login" onclick="openLoginModal()">Login to pick</div>`
            : locked
            ? `<div class="sp-locked">${champPick ? `${flag((TEAMS[champPick]||{}).iso2,16)} ${esc((TEAMS[champPick]||{name:champPick}).name)}` : '— no pick —'}</div>`
            : `<select class="sp-select" onchange="saveSpecialPick('championPick',this.value)">
                <option value="">— pick a team —</option>
                ${teamOptions.map(t=>`<option value="${t.id}" ${champPick===t.id?'selected':''}>${t.name}</option>`).join('')}
               </select>`}
          ${champResult}
        </div>
        <div class="special-pick-item">
          <div class="sp-label">⚽ Top Scorer <span class="sp-pts">+5 pts</span></div>
          ${!currentUser
            ? `<div class="sp-login" onclick="openLoginModal()">Login to pick</div>`
            : locked
            ? `<div class="sp-locked">${scorerPick ? esc(scorerPick) : '— no pick —'}</div>`
            : `<div style="display:flex;gap:8px">
                <input class="sp-input" type="text" placeholder="Player name…" value="${esc(scorerPick)}" maxlength="50"
                  id="topScorerInput" onkeydown="if(event.key==='Enter')saveSpecialPick('topScorerPick',this.value.trim())">
                <button class="btn btn-gold btn-sm" onclick="saveSpecialPick('topScorerPick',document.getElementById('topScorerInput').value.trim())">Save</button>
               </div>`}
          ${scorerResult}
        </div>
      </div>
    </div>`;
}

// ── HOME ──────────────────────────────────────────
function renderHome() {
  updateHomePredCount();
  const played = [...MATCHES, ...KNOCKOUT].filter(m => m.homeScore !== null).length;
  const el = document.getElementById('homeMatchesPlayed');
  if (el) el.textContent = played;

  // Upcoming matches (next 5 without results — group + knockout)
  const upcomingGroup = [...MATCHES]
    .filter(m => m.homeScore === null)
    .map(m => ({ ...m, _isKo: false }));
  const upcomingKo = KNOCKOUT
    .filter(m => m.home && m.away && m.homeScore === null)
    .map(m => ({ ...m, _isKo: true }));
  const upcoming = [...upcomingGroup, ...upcomingKo]
    .sort((a, b) => matchUTCDate(a) - matchUTCDate(b))
    .slice(0, 5);
  const upcomingEl = document.getElementById('homeUpcoming');
  if (!upcoming.length) {
    upcomingEl.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">All matches completed.</div>`;
  } else {
    upcomingEl.innerHTML = upcoming.map(m => miniMatchCard(m)).join('');
  }

  // Mini leaderboard
  const lb = calcLeaderboard().slice(0, 5);
  const lbEl = document.getElementById('homeLeaderboard');
  if (!lb.length) {
    lbEl.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">No players yet. <span style="color:var(--blue);cursor:pointer" onclick="openLoginModal()">Be the first!</span></div>`;
  } else {
    lbEl.innerHTML = lb.map((u, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(30,48,88,0.4);${u.name === currentUser ? 'background:rgba(255,215,0,0.04);border-radius:6px;padding:8px;margin:0 -8px;' : ''}">
        <span style="font-weight:900;font-size:16px;width:24px;color:${i===0?'var(--gold)':i===1?'#c0c0c0':i===2?'#cd7f32':'var(--text3)'}">${i+1}</span>
        <div class="user-avatar" style="background:${u.color};width:28px;height:28px;font-size:11px;flex-shrink:0">${u.name.slice(0,2).toUpperCase()}</div>
        <span style="flex:1;font-weight:600;font-size:13px">${esc(u.name)}</span>
        <span style="font-weight:800;color:var(--gold)">${u.points} pts</span>
      </div>
    `).join('');
  }
}

function miniMatchCard(m) {
  const h  = TEAMS[m.home] || { iso2: null, name: m.homeLabel || m.home };
  const a  = TEAMS[m.away] || { iso2: null, name: m.awayLabel || m.away };
  const wk = warsawKickoff(m);
  const badge = m._isKo || m.round
    ? `<span style="background:var(--gold2);color:#000;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px">${KO_ROUND_LABELS[m.round]||m.round||'KO'}</span>`
    : `<span style="background:var(--red);color:#fff;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px">${m.group}</span>`;
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(30,48,88,0.4);font-size:13px">
      ${matchStatusLamp(m)}
      ${badge}
      <span style="display:flex;align-items:center;gap:5px">${flag(h.iso2, 18)} ${h.name}</span>
      <span style="color:var(--text3);font-size:11px">vs</span>
      <span style="display:flex;align-items:center;gap:5px">${a.name} ${flag(a.iso2, 18)}</span>
      <span style="margin-left:auto;color:var(--text3);white-space:nowrap">${wk.date} ${wk.time}</span>
    </div>
  `;
}

// ── SCHEDULE ──────────────────────────────────────
function renderSchedule() {
  // Phase tabs
  const phaseTabs = document.getElementById('schedulePhaseTabs');
  if (phaseTabs) {
    phaseTabs.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        phaseTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const phase = tab.dataset.phase;
        document.getElementById('scheduleGroupPhase').style.display   = phase === 'group'   ? '' : 'none';
        document.getElementById('scheduleKnockoutPhase').style.display = phase === 'knockout' ? '' : 'none';
      });
    });
  }

  // Build group filter buttons
  const filtersEl = document.getElementById('scheduleFilters');
  const groups = [...new Set(MATCHES.map(m => m.group))].sort();
  filtersEl.innerHTML = `<button class="filter-btn active" data-group="all">All</button>` +
    groups.map(g => `<button class="filter-btn" data-group="${g}">Group ${g}</button>`).join('');

  filtersEl.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filtersEl.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderScheduleList(btn.dataset.group);
    });
  });

  renderScheduleList('all');
  renderKnockoutSchedule();
}

function renderScheduleList(groupFilter) {
  const list  = document.getElementById('scheduleList');
  const preds = currentUser ? getPredictions(currentUser) : {};

  let matches = [...MATCHES].sort((a, b) => matchUTCDate(a) - matchUTCDate(b));
  if (groupFilter !== 'all') matches = matches.filter(m => m.group === groupFilter);

  // Group by Warsaw calendar date
  const byDate = {};
  matches.forEach(m => {
    const d = matchWarsawDate(m);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(m);
  });

  list.innerHTML = Object.entries(byDate).sort().map(([, ms]) => `
    <div class="schedule-day">
      <div class="schedule-day-header"><span class="day-dot"></span>${fmtWarsawDateLong(ms[0])}</div>
      ${ms.map(m => matchCard(m, preds, true)).join('')}
    </div>
  `).join('');

  list.querySelectorAll('.pred-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.match-card');
      const mid  = card.dataset.matchId;
      const hInp = card.querySelector('[data-side="home"]');
      const aInp = card.querySelector('[data-side="away"]');
      savePrediction(mid, hInp.value, aInp.value);
      updatePredBadge(card, mid, hInp.value, aInp.value);
    });
  });
}

function renderKnockoutSchedule() {
  const el = document.getElementById('scheduleKoList');
  if (!el) return;
  if (!KNOCKOUT.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🏆</div><h3>Knockout bracket coming soon</h3></div>`;
    return;
  }
  const preds = currentUser ? getPredictions(currentUser) : {};
  const byRound = {};
  KNOCKOUT.forEach(m => { if (!byRound[m.round]) byRound[m.round] = []; byRound[m.round].push(m); });

  el.innerHTML = KO_ROUND_ORDER.filter(r => byRound[r]).map(r => `
    <div class="schedule-day">
      <div class="schedule-day-header"><span class="day-dot" style="background:var(--gold)"></span>${KO_ROUND_LABELS[r] || r}</div>
      ${byRound[r].sort((a,b)=>new Date(a.utc)-new Date(b.utc)).map(m => {
        if (!m.home || !m.away) return knockoutMatchCard(m, preds);
        const savedGroup = m.group;
        m.group = KO_ROUND_LABELS[m.round] || m.round;
        const html = matchCard(m, preds, true);
        m.group = savedGroup;
        return html;
      }).join('')}
    </div>
  `).join('');

  el.querySelectorAll('.pred-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.match-card');
      const mid  = card.dataset.matchId;
      savePrediction(mid, card.querySelector('[data-side="home"]').value, card.querySelector('[data-side="away"]').value);
      updatePredBadge(card, mid, card.querySelector('[data-side="home"]').value, card.querySelector('[data-side="away"]').value);
    });
  });
}

function matchCard(m, preds, showPredictors = false, forceEditable = false) {
  const h   = TEAMS[m.home] || { iso2: null, name: m.home };
  const a   = TEAMS[m.away] || { iso2: null, name: m.away };
  const p          = preds[m.id];
  const hasResult  = m.homeScore !== null && m.awayScore !== null;
  const matchLocked = isMatchLocked(m) && !forceEditable;

  let scoreHtml;
  if (hasResult) {
    scoreHtml = `<div class="match-score">${m.homeScore} : ${m.awayScore}</div>`;
  } else {
    scoreHtml = `<div class="match-score pending">–</div>`;
  }

  let predHtml = '';
  if (!hasResult && !forceEditable) {
    if (!currentUser) {
      predHtml = `<span style="font-size:12px;color:var(--text3);cursor:pointer" onclick="openLoginModal()">Sign in to predict</span>`;
    } else if (matchLocked) {
      predHtml = p
        ? `<span class="pred-result">Your pick: ${p.home}:${p.away}</span><span class="pred-pts wrong" style="margin-left:4px">🔒</span>`
        : `<span style="font-size:12px;color:var(--text3)">🔒 Locked</span>`;
    } else {
      const hv = p ? p.home : '';
      const av = p ? p.away : '';
      predHtml = `
        <div class="pred-inputs">
          <input class="pred-input" type="number" min="0" max="20" value="${hv}" data-side="home" placeholder="–">
          <span class="pred-sep">:</span>
          <input class="pred-input" type="number" min="0" max="20" value="${av}" data-side="away" placeholder="–">
          ${p ? `<span class="pred-saved" title="Saved">✓</span>` : ''}
        </div>
      `;
    }
  } else if (forceEditable) {
    // Admin edit mode — inputs shown for all matches including locked/completed
    const hv = p ? p.home : '';
    const av = p ? p.away : '';
    predHtml = `
      <div class="pred-inputs">
        <input class="pred-input" type="number" min="0" max="20" value="${hv}" data-side="home" placeholder="–">
        <span class="pred-sep">:</span>
        <input class="pred-input" type="number" min="0" max="20" value="${av}" data-side="away" placeholder="–">
        ${p ? `<span class="pred-saved" title="Saved">✓</span>` : ''}
        <span class="pred-admin-badge">ADMIN</span>
      </div>
    `;
  } else if (p) {
    const pts = calcPredPts(p.home, p.away, m.homeScore, m.awayScore);
    predHtml = `
      <span class="pred-result">You: ${p.home}:${p.away}</span>
      ${pts === 3 ? `<span class="pred-pts exact">+3 pts</span>` : pts === 1 ? `<span class="pred-pts winner">+1 pt</span>` : `<span class="pred-pts wrong">0 pts</span>`}
    `;
  }

  const wk = warsawKickoff(m);
  return `
    <div class="match-card ${hasResult ? 'has-result' : matchLocked ? 'locked' : ''}" data-match-id="${m.id}">
      ${matchStatusLamp(m)}
      <span class="match-group-badge">${m.group}</span>
      <div class="match-teams">
        <div class="match-team">
          ${flag(h.iso2, 30)}
          <span class="team-name">${h.name}</span>
        </div>
        ${scoreHtml}
        <div class="match-team away">
          <span class="team-name">${a.name}</span>
          ${flag(a.iso2, 30)}
        </div>
      </div>
      <div class="match-pred-slot">${predHtml}</div>
      <div class="match-meta">
        <div class="match-meta-date">${wk.time} <span style="font-size:10px;opacity:.7">Warsaw</span></div>
        <div>${wk.date}${m.city ? ' · ' + m.city : ''}</div>
        ${m.venue ? `<div style="font-size:10px;opacity:.6">${m.venue}</div>` : ''}
      </div>
      ${showPredictors ? matchPredictorsHtml(m) : ''}
    </div>
  `;
}

function updatePredBadge(card, mid, hv, av) {
  const savedMark = card.querySelector('.pred-saved');
  if (hv !== '' || av !== '') {
    if (!savedMark) {
      card.querySelector('.pred-inputs').insertAdjacentHTML('beforeend', `<span class="pred-saved" title="Saved">✓</span>`);
    }
  } else if (savedMark) {
    savedMark.remove();
  }
  // update home count
  updateHomePredCount();
  // update picks page if visible
  if (document.getElementById('section-picks').classList.contains('active')) renderPicks();
}

function calcPredPts(ph, pa, rh, ra) {
  if (ph === rh && pa === ra) return 3;
  if (Math.sign(ph - pa) === Math.sign(rh - ra)) return 1;
  return 0;
}

// ── GROUPS ────────────────────────────────────────
function setupGroupsTabs() {
  document.querySelectorAll('#groupsBracketTabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#groupsBracketTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const isStandings = t.dataset.tab === 'standings';
      document.getElementById('standingsView').style.display = isStandings ? '' : 'none';
      document.getElementById('bracketView').style.display   = isStandings ? 'none' : '';
      if (!isStandings) renderBracket();
    });
  });
  // Bracket is default — render it immediately
  renderBracket();
}

function renderGroups() {
  setupGroupsTabs();
  const grid = document.getElementById('groupsGrid');
  const standings = calcGroupStandings();

  grid.innerHTML = Object.entries(standings).map(([grp, teams]) => {
    return `
      <div class="group-card">
        <div class="group-header">
          <span class="group-title">Group ${grp}</span>
          <span class="group-teams-count">4 teams</span>
        </div>
        <table class="group-table">
          <thead>
            <tr>
              <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>
            ${teams.map((t, i) => `
              <tr>
                <td><span class="gt-pos ${i===0?'q1':i===1?'q2':i===2?'q3':''}">${i+1}</span></td>
                <td>
                  <div class="gt-team">
                    ${flag(t.iso2, 22)}
                    <span>${t.name}</span>
                  </div>
                </td>
                <td>${t.played}</td>
                <td>${t.w}</td>
                <td>${t.d}</td>
                <td>${t.l}</td>
                <td>${t.gd >= 0 ? '+' : ''}${t.gd}</td>
                <td class="gt-pts">${t.pts}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }).join('');
}

function calcGroupStandings() {
  const standings = {};
  // Init
  Object.entries(TEAMS).forEach(([id, t]) => {
    if (!standings[t.group]) standings[t.group] = {};
    standings[t.group][id] = { id, name: t.name, flag: t.flag, played:0, w:0, d:0, l:0, gf:0, ga:0, gd:0, pts:0 };
  });

  // Process results
  MATCHES.forEach(m => {
    if (m.homeScore === null || m.awayScore === null) return;
    const h = standings[TEAMS[m.home]?.group]?.[m.home];
    const a = standings[TEAMS[m.away]?.group]?.[m.away];
    if (!h || !a) return;
    h.played++; a.played++;
    h.gf += m.homeScore; h.ga += m.awayScore;
    a.gf += m.awayScore; a.ga += m.homeScore;
    if (m.homeScore > m.awayScore)      { h.w++; h.pts += 3; a.l++; }
    else if (m.homeScore < m.awayScore) { a.w++; a.pts += 3; h.l++; }
    else                                 { h.d++; h.pts++; a.d++; a.pts++; }
  });

  // Compute GD and sort, merge iso2 from TEAMS
  const result = {};
  Object.entries(standings).sort().forEach(([grp, teams]) => {
    result[grp] = Object.values(teams).map(t => ({ ...t, gd: t.gf - t.ga, iso2: TEAMS[t.id]?.iso2 }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  });
  return result;
}

// ── MY PICKS ──────────────────────────────────────
function renderPicks() {
  renderSpecialPicksHome();
  const adminEdit = isAdminLoggedIn() && !!currentUser;
  const el = document.getElementById('picksContent');
  if (!currentUser) {
    el.innerHTML = `
      <div class="picks-login-prompt">
        <div class="big-icon">🔐</div>
        <h3>Sign in to start predicting</h3>
        <p style="color:var(--text2);margin-bottom:20px">Create a username to save your picks and join the leaderboard.</p>
        <button class="btn btn-primary" onclick="openLoginModal()">Create Username</button>
      </div>`;
    return;
  }

  const preds   = getPredictions(currentUser);
  const users   = getUsers();
  const u       = users[currentUser] || {};

  // Compute stats across group + KO
  let earnedPts = 0, exact = 0, winner = 0, predsOnPlayed = 0;
  const allPlayed = [
    ...MATCHES.filter(m => m.homeScore !== null),
    ...KNOCKOUT.filter(m => m.homeScore !== null),
  ];
  allPlayed.forEach(m => {
    const p = preds[m.id]; if (!p) return;
    predsOnPlayed++;
    const pts = calcPredPts(p.home, p.away, m.homeScore, m.awayScore);
    earnedPts += pts;
    if (pts === 3) exact++; else if (pts === 1) winner++;
  });

  const koMade   = KNOCKOUT.filter(m => m.home && m.away && preds[m.id] !== undefined).length;
  const grpMade  = MATCHES.filter(m => preds[m.id] !== undefined).length;
  const totalMade = grpMade + koMade;
  const accuracy  = predsOnPlayed ? Math.round((exact + winner) / predsOnPlayed * 100) : null;
  const exactRate = predsOnPlayed ? Math.round(exact / predsOnPlayed * 100) : null;
  const bonusPts  = ((_champion && u.championPick === _champion) ? 4 : 0) +
                    ((_topScorer && u.topScorerPick && u.topScorerPick.toLowerCase() === _topScorer.toLowerCase()) ? 5 : 0);

  el.innerHTML = `
    ${adminEdit ? `<div class="admin-edit-banner">🔧 <strong>Admin Edit Mode</strong> — editing picks for <strong>${esc(currentUser)}</strong>.</div>` : ''}
    <div class="card user-stats-card" style="margin-bottom:16px">
      <div class="card-title">📊 Your Stats</div>
      <div class="user-stats-grid">
        <div class="us-item"><div class="us-val">${totalMade}</div><div class="us-lbl">Total picks</div></div>
        <div class="us-item"><div class="us-val">${earnedPts + bonusPts}</div><div class="us-lbl">Total pts</div></div>
        <div class="us-item"><div class="us-val" style="color:var(--green)">${accuracy !== null ? accuracy+'%' : '–'}</div><div class="us-lbl">Accuracy</div></div>
        <div class="us-item"><div class="us-val" style="color:var(--gold)">${exactRate !== null ? exactRate+'%' : '–'}</div><div class="us-lbl">Exact rate</div></div>
        <div class="us-item"><div class="us-val">${exact}</div><div class="us-lbl">Exact scores ⭐</div></div>
        <div class="us-item"><div class="us-val">${winner}</div><div class="us-lbl">Correct result ✓</div></div>
        <div class="us-item"><div class="us-val" style="color:var(--gold)">${bonusPts > 0 ? '+'+bonusPts : '–'}</div><div class="us-lbl">Bonus pts 🏆</div></div>
        <div class="us-item"><div class="us-val">${grpMade}<span style="font-size:11px;color:var(--text3)">/${MATCHES.length}</span></div><div class="us-lbl">Group picks</div></div>
      </div>
    </div>
    <div class="tabs" id="picksPhaseTabs">
      <div class="tab" data-phase="group">⚽ Group Phase</div>
      <div class="tab active" data-phase="knockout">🏆 Knockout Phase</div>
    </div>
    <div id="picksGroupPhase" style="display:none">
      <div id="picksGroupedList">Loading…</div>
    </div>
    <div id="picksKoPhase">
      <div id="picksKoList">Loading…</div>
    </div>
  `;

  document.querySelectorAll('#picksPhaseTabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#picksPhaseTabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const phase = tab.dataset.phase;
      document.getElementById('picksGroupPhase').style.display = phase === 'group' ? '' : 'none';
      document.getElementById('picksKoPhase').style.display    = phase === 'knockout' ? '' : 'none';
    });
  });

  renderPicksGrouped(preds, adminEdit);
  renderPicksKnockout(preds, adminEdit);
}

function renderPicksGrouped(preds, forceEditable = false) {
  const el = document.getElementById('picksGroupedList');
  if (!el) return;

  const sorted = [...MATCHES].sort((a, b) => matchUTCDate(a) - matchUTCDate(b));

  // Group by Warsaw calendar date
  const byDate = {};
  sorted.forEach(m => {
    const d = matchWarsawDate(m);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(m);
  });

  el.innerHTML = Object.entries(byDate).sort().map(([, ms]) => `
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">${fmtWarsawDateLong(ms[0])}</div>
      ${ms.map(m => matchCard(m, preds, false, forceEditable)).join('')}
    </div>
  `).join('');

  el.querySelectorAll('.pred-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.match-card');
      const mid  = card.dataset.matchId;
      const hInp = card.querySelector('[data-side="home"]');
      const aInp = card.querySelector('[data-side="away"]');
      savePrediction(mid, hInp.value, aInp.value);
      updatePredBadge(card, mid, hInp.value, aInp.value);
    });
  });
}

function renderPicksKnockout(preds, forceEditable = false) {
  const el = document.getElementById('picksKoList');
  if (!el) return;
  if (!preds) preds = getPredictions(currentUser);

  const now = Date.now();
  const available = KNOCKOUT.filter(m => m.home && m.away);

  if (!available.length) {
    el.innerHTML = `<div class="empty-state" style="padding:40px 20px">
      <div class="empty-state-icon">🏆</div>
      <h3>Knockout picks coming soon</h3>
      <p style="color:var(--text2)">Team slots will unlock as the Round of 32 results are confirmed.</p>
    </div>`;
    return;
  }

  const byRound = {};
  available.forEach(m => {
    if (!byRound[m.round]) byRound[m.round] = [];
    byRound[m.round].push(m);
  });

  const roundOrder = ['R32','R16','QF','SF','Final','SF3'];

  el.innerHTML = roundOrder.filter(r => byRound[r]).map(r => {
    const ms = byRound[r].sort((a,b) => new Date(a.utc) - new Date(b.utc));
    const label = KO_ROUND_LABELS[r] || r;
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title">${label}</div>
        ${ms.map(m => {
          const kickoff    = new Date(m.utc);
          const isLocked   = !forceEditable && now >= kickoff.getTime();
          const p          = preds[m.id];
          const hasScore   = m.homeScore !== null && m.awayScore !== null;
          const pts        = hasScore && p ? calcPredPts(p.home, p.away, m.homeScore, m.awayScore) : null;
          const warsawDate = kickoff.toLocaleString('en-GB',{timeZone:'Europe/Warsaw',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
          const teamH      = TEAMS[m.home] || { name: m.homeLabel || m.home, iso2: null };
          const teamA      = TEAMS[m.away] || { name: m.awayLabel || m.away, iso2: null };
          const flagH      = flag(teamH.iso2, 20);
          const flagA      = flag(teamA.iso2, 20);
          const nameH      = teamH.name;
          const nameA      = teamA.name;

          let badge = '';
          if (hasScore && pts !== null) {
            if (pts === 3) badge = `<span class="pred-badge exact">⭐ +3</span>`;
            else if (pts === 1) badge = `<span class="pred-badge winner">✓ +1</span>`;
            else badge = `<span class="pred-badge miss">✗ 0</span>`;
          } else if (isLocked && !p) {
            badge = `<span class="pred-badge miss">Missed</span>`;
          } else if (!isLocked && p !== undefined) {
            badge = `<span class="pred-badge" style="background:var(--card2);color:var(--text2)">${p.home}–${p.away}</span>`;
          }

          const resultStr = hasScore
            ? `<span style="font-size:11px;color:var(--text2)">${m.homeScore}–${m.awayScore}${m.penWinner ? ' (pen)' : ''}</span>`
            : '';

          return `
            <div class="match-card ko-pick-card" data-match-id="${m.id}" style="padding:12px;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span style="font-size:10px;background:var(--gold);color:#000;border-radius:4px;padding:1px 6px;font-weight:700">${label}</span>
                <span style="font-size:11px;color:var(--text3)">${warsawDate} CEST</span>
                ${resultStr}
                <div style="margin-left:auto">${badge}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                ${flagH}
                <span style="flex:1;font-weight:600;font-size:14px">${esc(nameH)}</span>
                ${isLocked ? `
                  <span style="color:var(--text3);min-width:60px;text-align:center;font-size:15px">${p ? p.home+'–'+p.away : '–'}</span>
                ` : `
                  <input class="pred-input ko-pred" type="number" min="0" max="20" data-side="home" data-match-id="${m.id}"
                    value="${p !== undefined ? p.home : ''}" style="width:36px;text-align:center">
                  <span style="color:var(--text3)">–</span>
                  <input class="pred-input ko-pred" type="number" min="0" max="20" data-side="away" data-match-id="${m.id}"
                    value="${p !== undefined ? p.away : ''}" style="width:36px;text-align:center">
                `}
                <span style="flex:1;font-weight:600;font-size:14px;text-align:right">${esc(nameA)}</span>
                ${flagA}
              </div>
            </div>
          `;
        }).join('')}
      </div>`;
  }).join('');

  el.querySelectorAll('.ko-pred').forEach(inp => {
    inp.addEventListener('change', () => {
      const mid  = inp.dataset.matchId;
      const card = el.querySelector(`[data-match-id="${mid}"]`);
      const hInp = card.querySelector('[data-side="home"]');
      const aInp = card.querySelector('[data-side="away"]');
      if (hInp.value === '' || aInp.value === '') return;
      savePrediction(mid, +hInp.value, +aInp.value);
    });
  });
}

// ── STREAK HELPER ─────────────────────────────────
function calcUserStreak(username) {
  const preds = getPredictions(username);
  // Collect all played matches sorted by UTC date (oldest first)
  const played = [
    ...MATCHES.filter(m => m.homeScore !== null),
    ...KNOCKOUT.filter(m => m.homeScore !== null),
  ].sort((a, b) => new Date(a.utc || a.date) - new Date(b.utc || b.date));

  // Build per-match points for this user (only matches they predicted)
  const matchPts = played
    .filter(m => preds[m.id] !== undefined)
    .map(m => {
      const p = preds[m.id];
      return calcPredPts(p.home, p.away, m.homeScore, m.awayScore);
    });

  if (!matchPts.length) return { fire: false, cold: false };

  // On fire: scored points in each of last 3 predicted matches, OR 6+ pts in last 3
  const last3 = matchPts.slice(-3);
  const last3pts = last3.reduce((s, p) => s + p, 0);
  const fire = last3.length >= 3 && (last3.every(p => p > 0) || last3pts >= 6);

  // Cold: no points in last 2 predicted matches
  const last2 = matchPts.slice(-2);
  const cold = last2.length >= 2 && last2.every(p => p === 0);

  return { fire, cold };
}

// ── LEADERBOARD ───────────────────────────────────
function renderLeaderboard() {
  const el = document.getElementById('leaderboardContent');
  const lb = calcLeaderboard();

  if (!lb.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏅</div>
        <h3>No players yet</h3>
        <p>Be the first to sign up and make your predictions!</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="openLoginModal()">Join Now</button>
      </div>`;
    return;
  }

  const allUsers  = getUsers();
  const prevSnap  = getRankSnapshot();
  const MEDALS    = ['🥇','🥈','🥉'];

  // Compute ranks with full tiebreaker — ex aequo when pts + exact + winner all match
  const ranks = [];
  lb.forEach((u, i) => {
    if (i === 0) { ranks.push(1); return; }
    const p = lb[i - 1];
    ranks.push(u.points === p.points && u.exact === p.exact && u.winner === p.winner ? ranks[i - 1] : i + 1);
  });

  el.innerHTML = `
    <table class="leaderboard-table">
      <thead>
        <tr>
          <th style="width:60px">#</th>
          <th>Player</th>
          <th style="text-align:right">Pts</th>
          <th style="text-align:center">🏆 Champion</th>
          <th style="text-align:center">⚽ Top Scorer</th>
        </tr>
      </thead>
      <tbody>
        ${lb.map((u, i) => {
          const ud       = allUsers[u.name] || {};
          const isMe     = u.name === currentUser;
          const rankNum  = ranks[i];
          const isTop3   = rankNum <= 3;
          const medal    = MEDALS[rankNum - 1] || '';
          const prevRank = prevSnap[u.name];
          const diff     = prevRank ? prevRank - rankNum : 0;
          const arrow    = diff > 0  ? `<span class="rank-up">▲${diff}</span>`
                         : diff < 0  ? `<span class="rank-dn">▼${Math.abs(diff)}</span>`
                         : prevRank  ? `<span class="rank-eq">—</span>` : '';
          const champId  = ud.championPick;
          const champTeam = champId ? (TEAMS[champId] || { name: champId, iso2: null }) : null;
          const champHit  = champId && _champion && champId === _champion;
          const champCell = champTeam
            ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;${champHit?'color:var(--green);font-weight:700':''}">${flag(champTeam.iso2,14)} ${esc(champTeam.name)}${champHit?' ✓':''}</span>`
            : `<span style="color:var(--text3);font-size:11px">—</span>`;
          const scorerPick = ud.topScorerPick || '';
          const scorerHit  = scorerPick && _topScorer && scorerPick.toLowerCase() === _topScorer.toLowerCase();
          const scorerCell = scorerPick
            ? `<span style="font-size:12px;${scorerHit?'color:var(--green);font-weight:700':''}">${esc(scorerPick)}${scorerHit?' ✓':''}</span>`
            : `<span style="color:var(--text3);font-size:11px">—</span>`;
          const streak   = calcUserStreak(u.name);
          const streakBadge = streak.fire ? ' <span title="On fire! Points in last 3 matches">🔥</span>'
                            : streak.cold ? ' <span title="Cold streak – no points in last 2 matches">🥶</span>'
                            : '';
          return `
            <tr class="${isMe ? 'lb-me' : ''}${isTop3 ? ' lb-top3' : ''}">
              <td>
                <div style="display:flex;align-items:center;gap:5px">
                  <span class="lb-rank lb-medal${rankNum - 1}">${medal || rankNum}</span>
                  ${arrow}
                </div>
              </td>
              <td>
                <div class="lb-user">
                  <div class="user-avatar" style="background:${u.color};width:32px;height:32px;font-size:12px">${u.name.slice(0,2).toUpperCase()}</div>
                  <span style="font-weight:${isMe?'800':'600'}">${esc(u.name)}${isMe ? ' <span style="font-size:11px;color:var(--gold)">★ you</span>' : ''}${streakBadge}</span>
                </div>
              </td>
              <td class="lb-pts">${u.points}</td>
              <td style="text-align:center">${champCell}</td>
              <td style="text-align:center">${scorerCell}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px;font-size:12px;color:var(--text3)">
      🟢 Exact = 3 pts &nbsp;·&nbsp; 🔵 Winner/draw = 1 pt &nbsp;·&nbsp; 🏆 Champion = 4 pts &nbsp;·&nbsp; ⚽ Top scorer = 5 pts
    </div>
    <div style="margin-top:6px;font-size:12px;color:var(--text3)">
      🔥 On fire (points in last 3 matches or 6+ pts in last 3) &nbsp;·&nbsp; 🥶 Cold streak (no points in last 2 matches)
    </div>
  `;
}


// ── STATS ─────────────────────────────────────────
function renderStats() {
  // Calculate from match results — group + knockout
  let played = 0, goals = 0;
  [...MATCHES, ...KNOCKOUT].forEach(m => {
    if (m.homeScore === null) return;
    played++;
    goals += m.homeScore + m.awayScore;
  });
  document.getElementById('statsPlayed').textContent = played;
  document.getElementById('statsGoals').textContent  = goals;
  document.getElementById('statsAvg').textContent    = played ? (goals / played).toFixed(2) : '–';

  const scorersEl = document.getElementById('topScorers');
  scorersEl.innerHTML = _topScorers.length
    ? statsTable(_topScorers, '⚽', 'Goals')
    : `<div class="empty-state"><div class="empty-state-icon">⚽</div><h3>No data yet</h3><p>Admin updates this via the Admin panel.</p></div>`;

  const userStatsEl = document.getElementById('userStatsSection');
  if (userStatsEl) renderAllUsersStats(userStatsEl);
}

// ── REWARDS ───────────────────────────────────────
const DRAW_PRIZES = [
  { name: 'Folding rule', img: 'img/rewards/image8.png' },
  { name: 'Folding rule', img: 'img/rewards/image8.png' },
  { name: 'COB Torch',    img: 'img/rewards/image7.png' },
  { name: 'COB Torch',    img: 'img/rewards/image7.png' },
];

async function dbSaveDrawWinners() {
  await supa.from('app_settings').upsert({ key: 'draw_winners', value: JSON.stringify(_drawWinners) }, { onConflict: 'key' });
}

function getDrawEligible() {
  const lb = calcLeaderboard();
  const top5 = new Set(lb.slice(0, 5).map(u => u.name));
  const won  = new Set(_drawWinners.map(w => w.name));
  return Object.entries(_users)
    .filter(([n]) => !top5.has(n) && !won.has(n))
    .map(([n, u]) => ({ name: n, color: u.color || '#4a6fa5' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getDrawRemainingPrizes() {
  const pool = [...DRAW_PRIZES];
  _drawWinners.forEach(w => {
    const idx = pool.findIndex(p => p.name === w.prizeName);
    if (idx >= 0) pool.splice(idx, 1);
  });
  return pool;
}

function drawWheel() {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const players = getDrawEligible();
  const sz = canvas.width;
  const cx = sz / 2, cy = sz / 2;
  const r  = cx - 14;

  ctx.clearRect(0, 0, sz, sz);

  if (!players.length) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1c32'; ctx.fill();
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#7a9cc6'; ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(_drawWinners.length >= DRAW_PRIZES.length ? 'All prizes awarded!' : 'No eligible players', cx, cy);
    drawWheelPointer(ctx, cx, sz);
    return;
  }

  const n     = players.length;
  const slice = (Math.PI * 2) / n;

  // Segment palette — use player color, fallback to a set of contrasting colours
  const FALLBACKS = ['#c0392b','#2980b9','#27ae60','#8e44ad','#e67e22','#16a085','#d35400','#2c3e50'];
  players.forEach((p, i) => {
    const startA = _wheelAngle - Math.PI / 2 + i * slice;
    const endA   = startA + slice;

    // Segment
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startA, endA); ctx.closePath();
    ctx.fillStyle = p.color || FALLBACKS[i % FALLBACKS.length];
    ctx.fill();
    ctx.strokeStyle = '#08111e'; ctx.lineWidth = 2; ctx.stroke();

    // Name label — max 12 chars, radially outward
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startA + slice / 2);
    const fontSize = Math.max(9, Math.min(13, 130 / n));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4;
    const label = p.name.length > 11 ? p.name.slice(0, 11) + '…' : p.name;
    ctx.fillText(label, r - 10, fontSize / 3);
    ctx.restore();
  });

  // Outer ring
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 4; ctx.stroke();

  // Center hub
  ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = '#08111e'; ctx.fill();
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3; ctx.stroke();
  ctx.font = '16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🎰', cx, cy);

  drawWheelPointer(ctx, cx, sz);
}

function drawWheelPointer(ctx, cx, sz) {
  // Gold triangle pointer pinned at top centre
  const tip = 6, base = 14, height = 26;
  ctx.save();
  ctx.translate(cx, tip);
  ctx.beginPath();
  ctx.moveTo(-base / 2, 0);
  ctx.lineTo(base / 2, 0);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
  ctx.fill();
  ctx.strokeStyle = '#08111e'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

function spinWheel() {
  if (_wheelSpin) return;
  const players = getDrawEligible();
  const prizes  = getDrawRemainingPrizes();
  if (!players.length || !prizes.length) return;

  _wheelSpin = true;
  const spinBtn = document.getElementById('spinBtn');
  if (spinBtn) spinBtn.disabled = true;

  // Hide previous announcement
  const ann = document.getElementById('wheelAnnounce');
  if (ann) ann.style.display = 'none';

  const n          = players.length;
  const slice      = (Math.PI * 2) / n;
  const winnerIdx  = Math.floor(Math.random() * n);

  // Target angle so winnerIdx segment centre lands at pointer (top)
  // Segment i centre = _wheelAngle - π/2 + (i + 0.5) * slice  →  must equal -π/2
  // ⟹ _wheelAngle + (i + 0.5) * slice ≡ 0 (mod 2π)
  // ⟹ target = -(winnerIdx + 0.5) * slice  (mod 2π)
  const rawTarget  = -(winnerIdx + 0.5) * slice;
  const normTarget = ((rawTarget % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const normCur    = ((_wheelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let   delta      = normTarget - normCur;
  if (delta <= 0.05) delta += Math.PI * 2;

  const totalSpin  = delta + (5 + Math.floor(Math.random() * 4)) * Math.PI * 2;
  const startAngle = _wheelAngle;
  const startTime  = performance.now();
  const duration   = 4500;

  function animate(now) {
    const t      = Math.min((now - startTime) / duration, 1);
    const eased  = 1 - Math.pow(1 - t, 3);   // cubic ease-out
    _wheelAngle  = startAngle + totalSpin * eased;
    drawWheel();
    if (t < 1) { requestAnimationFrame(animate); return; }

    // Spin done
    _wheelAngle = startAngle + totalSpin;
    drawWheel();
    _wheelSpin  = false;

    const winner = players[winnerIdx];
    const prize  = prizes[Math.floor(Math.random() * prizes.length)];
    _drawWinners = [..._drawWinners, { name: winner.name, color: winner.color, prizeName: prize.name, prizeImg: prize.img }];
    dbSaveDrawWinners();
    updateDrawUI(winner, prize);
  }
  requestAnimationFrame(animate);
}

async function resetDraw() {
  if (!confirm('Reset the lucky draw? All drawn winners will be cleared.')) return;
  _drawWinners = [];
  await dbSaveDrawWinners();
  _wheelAngle  = 0;
  drawWheel();
  updateDrawUI(null, null);
}

function updateDrawUI(latestWinner, latestPrize) {
  // Announcement banner
  const ann = document.getElementById('wheelAnnounce');
  if (ann) {
    if (latestWinner && latestPrize) {
      ann.innerHTML = `<div class="draw-announce">
        <div class="draw-announce-confetti">🎉</div>
        <div class="user-avatar" style="background:${latestWinner.color};width:44px;height:44px;font-size:17px;display:flex;align-items:center;justify-content:center;border-radius:50%;margin:0 auto 6px">${latestWinner.name.slice(0,2).toUpperCase()}</div>
        <div class="draw-announce-name">${esc(latestWinner.name)}</div>
        <div class="draw-announce-prize">wins a <strong>${esc(latestPrize.name)}</strong></div>
        <img src="${latestPrize.img}" class="draw-announce-img" onerror="this.style.opacity='.2'">
      </div>`;
      ann.style.display = 'block';
    } else {
      ann.style.display = 'none';
    }
  }

  // Winners list
  const list = document.getElementById('drawWinnersList');
  if (list) {
    if (!_drawWinners.length) {
      list.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">No winners yet — spin the wheel!</div>`;
    } else {
      list.innerHTML = _drawWinners.map((w, i) => `
        <div class="draw-winner-item">
          <span style="font-size:11px;color:var(--text3);min-width:18px">#${i+1}</span>
          <div class="user-avatar" style="background:${w.color};width:30px;height:30px;font-size:11px;flex-shrink:0">${w.name.slice(0,2).toUpperCase()}</div>
          <span style="font-weight:700;font-size:13px">${esc(w.name)}</span>
          <div class="draw-winner-prize">
            <img src="${w.prizeImg}" onerror="this.style.opacity='.2'">
            <span>${esc(w.prizeName)}</span>
          </div>
        </div>`).join('');
    }
  }

  // Spin button state
  const spinBtn = document.getElementById('spinBtn');
  if (spinBtn) {
    const canSpin = getDrawEligible().length > 0 && getDrawRemainingPrizes().length > 0;
    spinBtn.disabled = !canSpin;
    spinBtn.textContent = canSpin ? '🎰 Spin the Wheel' : '✅ All prizes drawn';
  }
}

function renderRewards() {
  const el = document.getElementById('rewardsContent');
  if (!el) return;

  const lb = calcLeaderboard();

  const leaderboardPrizes = [
    { place: 1, medal: '🥇', label: '1st Place', img: 'img/rewards/image4.png', name: 'High Sierra Curve backpack', desc: 'Eco-friendly recycled backpack' },
    { place: 2, medal: '🥈', label: '2nd Place', img: 'img/rewards/image2.png', name: 'Sports bag',                desc: 'Spacious sports bag' },
    { place: 3, medal: '🥉', label: '3rd Place', img: 'img/rewards/image1.png', name: 'Thermobottle 500ml',        desc: 'Insulated thermos bottle' },
    { place: 4, medal: '4️⃣',  label: '4th Place', img: 'img/rewards/image3.png', name: 'Canvas tote bag',          desc: 'High-quality canvas tote bag' },
    { place: 5, medal: '5️⃣',  label: '5th Place', img: 'img/rewards/image6.png', name: 'COB Torch with magnet',    desc: 'Compact torch with magnetic base' },
  ];

  function winnerHtml(place) {
    const u = lb[place - 1];
    if (!u) return `<div class="rwd-winner rwd-winner-tbd">TBD</div>`;
    const isMe = u.name === currentUser;
    return `<div class="rwd-winner${isMe ? ' rwd-winner-me' : ''}">
      <div class="user-avatar" style="background:${u.color||'#555'};width:26px;height:26px;font-size:10px">${u.name.slice(0,2).toUpperCase()}</div>
      <span>${esc(u.name)}${isMe?' ★':''}</span>
      <span class="rwd-pts">${u.points} pts</span>
    </div>`;
  }

  const prizesLeft = getDrawRemainingPrizes().length;
  const canSpin    = getDrawEligible().length > 0 && prizesLeft > 0;

  el.innerHTML = `
    <div class="rwd-section-label">🏆 Leaderboard Prizes</div>
    <p style="font-size:13px;color:var(--text3);margin:0 0 16px">Awarded to the top 5 players after the Final (July 19).</p>
    <div class="rwd-grid">
      ${leaderboardPrizes.map(p => `
        <div class="rwd-card${p.place<=3?' rwd-card-top':''}">
          <div class="rwd-badge">${p.medal} ${p.label}</div>
          <div class="rwd-img-wrap"><img src="${p.img}" alt="${esc(p.name)}" class="rwd-img" onerror="this.style.opacity='.2'"></div>
          <div class="rwd-name">${esc(p.name)}</div>
          <div class="rwd-desc">${esc(p.desc)}</div>
          <div class="rwd-currently">Currently leading:</div>
          ${winnerHtml(p.place)}
        </div>`).join('')}
    </div>

    <div class="rwd-section-label" style="margin-top:36px">🎰 Lucky Draw</div>
    <p style="font-size:13px;color:var(--text3);margin:0 0 20px">Spin the wheel to pick a random winner from players not in the top 5. Each winner is removed from subsequent spins.</p>

    <div class="draw-layout">
      <div class="draw-wheel-col">
        <div class="draw-canvas-wrap">
          <canvas id="wheelCanvas" width="360" height="360"></canvas>
        </div>
        <div class="draw-btns">
          <button id="spinBtn" class="btn btn-primary" onclick="spinWheel()" ${canSpin?'':'disabled'}>
            ${canSpin ? '🎰 Spin the Wheel' : '✅ All prizes drawn'}
          </button>
          <button class="btn btn-ghost" onclick="resetDraw()">🔄 Reset</button>
        </div>
        <div id="wheelAnnounce" style="display:none"></div>
      </div>

      <div class="draw-winners-col">
        <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">
          🎁 Prizes remaining: ${prizesLeft} / ${DRAW_PRIZES.length}
        </div>
        <div class="draw-prizes-left" style="margin-bottom:16px">
          ${DRAW_PRIZES.map((p, i) => {
            const taken = i < _drawWinners.length;
            return `<div class="draw-prize-chip${taken?' taken':''}">
              <img src="${p.img}" onerror="this.style.opacity='.2'">
              <span>${esc(p.name)}</span>
              ${taken?'<span class="draw-prize-taken">✓</span>':''}
            </div>`;
          }).join('')}
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">🏆 Winners</div>
        <div id="drawWinnersList"></div>
      </div>
    </div>
  `;

  // Draw wheel and populate winners list after DOM is ready
  requestAnimationFrame(() => {
    drawWheel();
    updateDrawUI(null, null);
  });
}

function renderAllUsersStats(el) {
  const lb = calcLeaderboard();
  if (!lb.length) { el.innerHTML = ''; return; }
  const allPlayed = [...MATCHES, ...KNOCKOUT].filter(m => m.homeScore !== null);
  const rows = lb.map((u, i) => {
    const preds = _predictions[u.name] || {};
    let exact = 0, winner = 0, total = 0, earnedPts = 0;
    allPlayed.forEach(m => {
      const p = preds[m.id]; if (!p) return;
      total++;
      const pts = calcPredPts(p.home, p.away, m.homeScore, m.awayScore);
      earnedPts += pts;
      if (pts === 3) exact++;
      else if (pts === 1) winner++;
    });
    const acc    = total ? Math.round((exact+winner)/total*100) : null;
    const ppm    = total ? (earnedPts / total).toFixed(2) : null;
    const rankClass = i===0?'r1':i===1?'r2':i===2?'r3':'';
    return `<tr>
      <td><span class="lb-rank ${rankClass}">${i+1}</span></td>
      <td><div class="lb-user">
        <div class="user-avatar" style="background:${u.color};width:28px;height:28px;font-size:11px">${u.name.slice(0,2).toUpperCase()}</div>
        <strong>${esc(u.name)}</strong>
      </div></td>
      <td class="lb-pts">${u.points}</td>
      <td style="text-align:center;color:var(--green)">${exact}</td>
      <td style="text-align:center;color:var(--gold2)">${winner}</td>
      <td style="text-align:center">${acc !== null ? acc+'%' : '–'}</td>
      <td style="text-align:center;color:var(--gold);font-weight:700">${ppm !== null ? ppm : '–'}</td>
      <td style="text-align:center;color:var(--text3);font-size:12px">${Object.keys(preds).length}</td>
    </tr>`;
  });
  el.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="card-title">🏅 Predictor Rankings</div>
      <table class="leaderboard-table">
        <thead><tr><th>#</th><th>Player</th><th style="text-align:right">Pts</th><th style="text-align:center">⭐ Exact</th><th style="text-align:center">✓ Correct</th><th style="text-align:center">Accuracy</th><th style="text-align:center">Pts/match</th><th style="text-align:center">Picks</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

// ── WHO PREDICTED CORRECTLY ────────────────────────
function matchPredictorsHtml(m) {
  if (m.homeScore === null || m.awayScore === null) return '';
  const exact = [], correct = [], wrong = [];
  for (const [username, upreds] of Object.entries(_predictions)) {
    const p = upreds[m.id]; if (!p) continue;
    const u = _users[username];
    const obj = { username, color: u?.color || '#555' };
    if (p.home === m.homeScore && p.away === m.awayScore) exact.push(obj);
    else if (Math.sign(p.home - p.away) === Math.sign(m.homeScore - m.awayScore)) correct.push(obj);
    else wrong.push(obj);
  }
  if (!exact.length && !correct.length && !wrong.length) return '';
  const avatars = (list, style) => list.map(u =>
    `<div title="${esc(u.username)}: ${(_predictions[u.username]||{})[m.id]?.home ?? '?'}:${(_predictions[u.username]||{})[m.id]?.away ?? '?'}" class="pred-avatar" style="background:${u.color};${style}">${u.username.slice(0,2).toUpperCase()}</div>`
  ).join('');
  return `<div class="match-predictors">
    ${exact.length  ? `<span class="pred-label" style="color:var(--green)">⭐</span>${avatars(exact,  'border:1.5px solid var(--green)')}`  : ''}
    ${correct.length? `<span class="pred-label" style="color:var(--gold2)">✓</span>${avatars(correct, 'border:1.5px solid var(--gold2)')}`  : ''}
    ${wrong.length  ? `<span class="pred-label" style="color:var(--red2)">✗</span>${avatars(wrong,   'border:1.5px solid var(--red2);opacity:.7')}`  : ''}
  </div>`;
}

function statsTable(data, icon, label) {
  return `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="font-size:10px;color:var(--text3);text-transform:uppercase">
          <th style="text-align:left;padding:6px 8px">#</th>
          <th style="text-align:left;padding:6px 8px">Player</th>
          <th style="text-align:left;padding:6px 8px">Team</th>
          <th style="text-align:right;padding:6px 8px">${label}</th>
        </tr>
      </thead>
      <tbody>
        ${data.map((p, i) => {
          const t = TEAMS[p.team] || { iso2: null, name: p.team };
          return `
            <tr style="border-top:1px solid var(--border)">
              <td style="padding:8px;color:var(--text3);font-size:13px">${i+1}</td>
              <td style="padding:8px;font-weight:600">${esc(p.name)}</td>
              <td style="padding:8px;font-size:13px;color:var(--text2)"><span style="display:inline-flex;align-items:center;gap:5px">${flag(t.iso2, 18)} ${t.name}</span></td>
              <td style="padding:8px;text-align:right;font-weight:900;color:var(--gold);font-size:18px">${p.count}${icon}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── UTILS ─────────────────────────────────────────
function flag(iso2, size) {
  if (!iso2) return '<span style="opacity:.4">🏳️</span>';
  const w = size || 32;
  return `<img src="https://flagcdn.com/w40/${iso2}.png" srcset="https://flagcdn.com/w80/${iso2}.png 2x" width="${w}" height="${Math.round(w * 0.67)}" alt="${iso2}" class="flag-img" loading="lazy" onerror="this.style.opacity='.3'">`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ── ADMIN ─────────────────────────────────────────
const ADMIN_DEFAULT_PWD = 'wc2026admin';

function isAdminLoggedIn() {
  return localStorage.getItem(STORAGE.ADMIN_SESSION) === '1';
}
function loginAdmin(pwd) {
  const stored = localStorage.getItem(STORAGE.ADMIN_PWD) || ADMIN_DEFAULT_PWD;
  if (pwd === stored) { localStorage.setItem(STORAGE.ADMIN_SESSION, '1'); renderAdmin(); return true; }
  return false;
}
function logoutAdmin() { localStorage.removeItem(STORAGE.ADMIN_SESSION); renderAdmin(); }

// ── ROLES ─────────────────────────────────────────
function currentUserRole() {
  if (!currentUser) return null;
  return (_users[currentUser]?.role) || 'member';
}

function canAccessAdmin() {
  const role = currentUserRole();
  return isAdminLoggedIn() || role === 'admin' || role === 'superuser';
}

function isSuperuser() {
  return currentUserRole() === 'superuser';
}

async function setUserRole(username, role) {
  await dbUpdateUserField(username, 'role', role);
  renderAdminUsers();
  renderSidebarUser();
}

async function designateSuperuser(username) {
  if (!confirm(`Make "${username}" the Superuser?\nAny existing Superuser will be demoted to Admin.`)) return;
  for (const [name, u] of Object.entries(_users)) {
    if (u.role === 'superuser') await dbUpdateUserField(name, 'role', 'admin');
  }
  await dbUpdateUserField(username, 'role', 'superuser');
  renderAdminUsers();
  renderSidebarUser();
}

function getAdminResults() { return _results; }
function getAdminUnlocks() { return JSON.parse(localStorage.getItem(STORAGE.ADMIN_UNLOCKS) || '[]'); }

async function saveAdminResult(matchId, home, away) {
  snapshotRankings();
  const h = home === '' ? null : parseInt(home);
  const a = away === '' ? null : parseInt(away);
  if (h === null) { delete _results[matchId]; } else { _results[matchId] = { home: h, away: a }; }
  mergeResultsIntoMatches();
  await dbSaveResult(matchId, h, a);
  renderGroups(); renderLeaderboard(); renderStats(); renderHome();
  if (currentUser) renderPicks();
  const activeGroup = document.querySelector('#scheduleFilters .filter-btn.active')?.dataset.group || 'all';
  renderScheduleList(activeGroup);
}

async function clearAdminResult(matchId) { await saveAdminResult(matchId, '', ''); renderAdminMatches(); }

function toggleAdminUnlock(matchId) {
  const unlocks = getAdminUnlocks();
  const idx = unlocks.indexOf(matchId);
  if (idx >= 0) unlocks.splice(idx, 1); else unlocks.push(matchId);
  localStorage.setItem(STORAGE.ADMIN_UNLOCKS, JSON.stringify(unlocks));
  renderAdminMatches();
  const activeGroup = document.querySelector('#scheduleFilters .filter-btn.active')?.dataset.group || 'all';
  renderScheduleList(activeGroup);
  if (currentUser) renderPicks();
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  await dbDeleteUser(username);
  if (currentUser === username) logout();
  renderAdminUsers(); renderLeaderboard(); renderHome();
}

function renderAdmin() {
  const el = document.getElementById('adminContent');
  if (!el) return;
  if (!canAccessAdmin()) {
    el.innerHTML = `
      <div style="max-width:360px">
        <div class="card">
          <div class="card-title">Admin Login</div>
          <p style="font-size:13px;color:var(--text2);margin-bottom:16px">Enter admin password to access the management panel.</p>
          <input class="modal-input" id="adminPwdInput" type="password" placeholder="Password…" style="margin-bottom:12px">
          <div id="adminLoginError" style="color:var(--red2);font-size:13px;margin-bottom:12px;display:none">Incorrect password.</div>
          <button class="btn btn-primary" onclick="submitAdminLogin()">Login</button>
        </div>
      </div>`;
    document.getElementById('adminPwdInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAdminLogin(); });
    return;
  }
  const role = currentUserRole();
  const showAllTabs = role === 'superuser' || isAdminLoggedIn();
  const statusHtml = isAdminLoggedIn()
    ? `<div style="font-size:14px;color:var(--green)">✅ Logged in as Admin</div><button class="btn btn-ghost btn-sm" onclick="logoutAdmin()">Logout</button>`
    : `<div style="font-size:14px;color:var(--gold)">${role === 'superuser' ? '👑 Superuser' : '🔧 Admin'}: <strong>${esc(currentUser)}</strong></div>`;
  const teamOpts2 = Object.values(TEAMS).sort((a,b)=>a.name.localeCompare(b.name));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      ${statusHtml}
    </div>
    <div class="card" style="margin-bottom:16px;padding:12px 16px">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:160px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">🏆 Tournament Champion</div>
          <select class="sp-select" id="qChampSelect" style="width:100%">
            <option value="">— not set —</option>
            ${teamOpts2.map(t=>`<option value="${t.id}" ${_champion===t.id?'selected':''}>${t.name}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:160px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">⚽ Top Scorer</div>
          <input class="sp-input" id="qScorerInput" placeholder="Player name…" value="${esc(_topScorer||'')}" style="width:100%">
        </div>
        <button class="btn btn-gold btn-sm" style="height:38px;white-space:nowrap" onclick="saveQuickResults()">Save Results</button>
      </div>
      ${(_champion||_topScorer) ? `<div style="margin-top:8px;font-size:11px;color:var(--text3)">
        ${_champion ? `Champion: <strong style="color:var(--gold)">${esc((TEAMS[_champion]||{name:_champion}).name)}</strong>` : ''}
        ${_champion && _topScorer ? ' · ' : ''}
        ${_topScorer ? `Top scorer: <strong style="color:var(--gold)">${esc(_topScorer)}</strong>` : ''}
      </div>` : ''}
    </div>
    <div class="tabs" id="adminTabs">
      <div class="tab active" data-tab="matches">Matches &amp; Results</div>
      <div class="tab" data-tab="bracket">Knockout Bracket</div>
      ${showAllTabs ? `<div class="tab" data-tab="users">User Management</div><div class="tab" data-tab="settings">Settings</div>` : ''}
    </div>
    <div id="adminTabContent"></div>`;
  document.querySelectorAll('#adminTabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#adminTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      renderAdminTab(t.dataset.tab);
    });
  });
  renderAdminTab('matches');
}

function submitAdminLogin() {
  const ok = loginAdmin(document.getElementById('adminPwdInput')?.value || '');
  if (!ok) { const e = document.getElementById('adminLoginError'); if (e) e.style.display = 'block'; }
}

// ── RANK SNAPSHOT (for position change arrows) ─────
function snapshotRankings() {
  const lb = calcLeaderboard();
  const snap = {};
  const ranks = [];
  lb.forEach((u, i) => {
    const r = i === 0 ? 1
      : (u.points === lb[i-1].points && u.exact === lb[i-1].exact && u.winner === lb[i-1].winner)
        ? ranks[i-1] : i + 1;
    ranks.push(r);
    snap[u.name] = r;
  });
  localStorage.setItem('wc2026_rank_snap', JSON.stringify(snap));
}
function getRankSnapshot() {
  return JSON.parse(localStorage.getItem('wc2026_rank_snap') || '{}');
}

// ── MATCH STATUS LAMP ─────────────────────────────
function matchStatusLamp(m, title = true) {
  const now     = Date.now();
  const kickoff = new Date(m.utc).getTime();
  const done    = m.homeScore !== null && m.awayScore !== null;
  if (done)                                         return `<span class="slamp slamp-done"  ${title?'title="Finished"'   :''}>●</span>`;
  if (now < kickoff)                                return `<span class="slamp slamp-soon"  ${title?'title="Not started"':''}>●</span>`;
  if (now < kickoff + 2.5 * 3600_000)              return `<span class="slamp slamp-live"  ${title?'title="Possibly live"':''}>●</span>`;
  return                                                   `<span class="slamp slamp-wait"  ${title?'title="Awaiting result"':''}>●</span>`;
}

// ── QUICK RESULTS (admin panel top bar) ───────────
async function saveQuickResults() {
  const champVal  = document.getElementById('qChampSelect')?.value;
  const scorerVal = document.getElementById('qScorerInput')?.value.trim();
  if (champVal !== undefined) {
    if (champVal) await dbSetSetting('champion', champVal);
    else await dbDeleteSetting('champion');
  }
  if (scorerVal !== undefined) {
    if (scorerVal) await dbSetSetting('top_scorer', scorerVal);
    else await dbDeleteSetting('top_scorer');
  }
  renderLeaderboard(); renderHome(); renderAdmin();
}

function renderAdminTab(tab) {
  if (tab === 'matches') renderAdminMatches();
  else if (tab === 'users') renderAdminUsers();
  else if (tab === 'bracket') renderBracketAdminTab();
  else renderAdminSettings();
}

function renderAdminMatches() {
  const el = document.getElementById('adminTabContent');
  if (!el) return;
  const results = getAdminResults();
  const unlocks = getAdminUnlocks();
  const now     = Date.now();
  const sorted = [...MATCHES].sort((a, b) => matchUTCDate(a) - matchUTCDate(b));
  const byDate = {};
  sorted.forEach(m => {
    const d = matchWarsawDate(m);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(m);
  });

  el.innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:var(--text2)">
      All times shown in <strong style="color:var(--gold)">Warsaw (CEST, UTC+2)</strong>.
      Predictions auto-lock <strong>2h before kickoff</strong>. Use 🔓/🔒 to override.
    </div>
    ${Object.entries(byDate).sort().map(([, ms]) => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title">${fmtWarsawDateLong(ms[0])}</div>
        ${ms.map(m => adminMatchRow(m, unlocks, now)).join('')}
      </div>`).join('')}`;

  el.querySelectorAll('.admin-result-form').forEach(form => {
    const mid  = form.dataset.matchId;
    form.querySelector('.save-btn').addEventListener('click', () => {
      saveAdminResult(mid, form.querySelector('[data-side="home"]').value, form.querySelector('[data-side="away"]').value);
      renderAdminMatches();
    });
  });
  el.querySelectorAll('.unlock-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleAdminUnlock(btn.dataset.matchId));
  });
}

function adminMatchRow(m, unlocks, now) {
  const h = TEAMS[m.home] || { iso2: null, name: m.home };
  const a = TEAMS[m.away] || { iso2: null, name: m.away };
  const wk        = warsawKickoff(m);
  const lockUTC   = matchUTCDate(m).getTime() - 2 * 3600 * 1000;
  const autoLocked = now >= lockUTC;
  const adminUnlocked = unlocks.includes(m.id);
  const hasResult = m.homeScore !== null && m.awayScore !== null;

  let lockBadge;
  if (hasResult) {
    lockBadge = `<span class="admin-badge green">✓ Result entered</span>`;
  } else if (autoLocked && !adminUnlocked) {
    lockBadge = `<span class="admin-badge red">🔒 Locked</span>`;
  } else if (adminUnlocked) {
    lockBadge = `<span class="admin-badge gold">🔓 Admin unlocked</span>`;
  } else {
    const ms = lockUTC - now;
    const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000);
    lockBadge = `<span class="admin-badge gray">Locks in ${hh}h ${mm}m</span>`;
  }

  const curH = hasResult ? m.homeScore : '';
  const curA = hasResult ? m.awayScore : '';

  return `
    <div class="admin-match-row">
      <span class="match-group-badge">${m.group}</span>
      <div class="admin-match-teams">
        <span class="admin-team">${flag(h.iso2, 18)} ${h.name}</span>
        <span style="color:var(--text3);font-size:12px">vs</span>
        <span class="admin-team">${a.name} ${flag(a.iso2, 18)}</span>
      </div>
      <div class="admin-match-meta">🕐 ${wk.time} · ${wk.date}</div>
      <div>${lockBadge}</div>
      <div class="admin-result-form pred-inputs" data-match-id="${m.id}">
        <input class="pred-input" type="number" min="0" max="20" value="${curH}" data-side="home" placeholder="–">
        <span class="pred-sep">:</span>
        <input class="pred-input" type="number" min="0" max="20" value="${curA}" data-side="away" placeholder="–">
        <button class="btn btn-gold btn-sm save-btn">Save</button>
        ${hasResult ? `<button class="btn btn-ghost btn-sm" onclick="clearAdminResult('${m.id}')">✕</button>` : ''}
      </div>
      <button class="btn btn-ghost btn-sm unlock-btn" data-match-id="${m.id}">${adminUnlocked ? '🔒 Re-lock' : '🔓 Unlock'}</button>
    </div>`;
}

async function submitAdminCreateUser() {
  const nameEl = document.getElementById('newUserName');
  const roleEl = document.getElementById('newUserRole');
  const pinEl  = document.getElementById('newUserPin');
  const msgEl  = document.getElementById('newUserMsg');
  const result = await adminCreateUser(nameEl.value.trim(), roleEl.value, pinEl.value.trim());
  if (result.error) { msgEl.style.cssText='display:block;color:var(--red2)'; msgEl.textContent=result.error; }
  else { nameEl.value=''; pinEl.value=''; msgEl.style.cssText='display:block;color:var(--green)'; msgEl.textContent='User created!'; renderAdminUsers(); }
}

function renderAdminUsers() {
  const el = document.getElementById('adminTabContent');
  if (!el) return;
  const sorted = Object.entries(getUsers()).sort((a, b) => (b[1].points || 0) - (a[1].points || 0));
  const createForm = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Create New User</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:140px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:5px">Username</div>
          <input class="modal-input" id="newUserName" type="text" placeholder="Username…" maxlength="20" style="margin:0">
        </div>
        <div style="min-width:120px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:5px">PIN (min 4 chars)</div>
          <input class="modal-input" id="newUserPin" type="text" placeholder="e.g. 1234" maxlength="20" style="margin:0">
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:5px">Role</div>
          <select class="sp-select" id="newUserRole" style="height:46px">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="submitAdminCreateUser()" style="height:46px">Create</button>
      </div>
      <div id="newUserMsg" style="font-size:13px;margin-top:8px;display:none"></div>
    </div>`;
  if (!sorted.length) {
    el.innerHTML = createForm + `<div class="empty-state"><div class="empty-state-icon">👥</div><h3>No users yet</h3></div>`;
    return;
  }
  const canManageRoles = isSuperuser() || isAdminLoggedIn();
  el.innerHTML = createForm + `
    <table class="leaderboard-table" style="margin-top:8px">
      <thead><tr><th>#</th><th>Username</th><th>Role</th><th>PIN</th><th>Points</th><th>Exact</th><th>Picks</th><th>Joined</th><th></th></tr></thead>
      <tbody>
        ${sorted.map(([name, u], i) => {
          const picks  = Object.keys(u.predictions || {}).length;
          const joined = u.created ? new Date(u.created).toLocaleDateString('pl-PL', { day:'2-digit', month:'short', year:'numeric' }) : '–';
          const role = u.role || 'member';
          const roleBadge = role === 'superuser'
            ? `<span class="admin-badge gold">👑 Superuser</span>`
            : role === 'admin'
            ? `<span class="admin-badge green">🔧 Admin</span>`
            : `<span class="admin-badge gray">Member</span>`;
          let roleActions = '';
          if (canManageRoles && name !== currentUser) {
            if (role === 'member')         roleActions += `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="setUserRole('${esc(name)}','admin')">Make Admin</button> `;
            else if (role === 'admin')     roleActions += `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="setUserRole('${esc(name)}','member')">Demote</button> `;
            else if (role === 'superuser') roleActions += `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="setUserRole('${esc(name)}','admin')">Demote to Admin</button> `;
            if (role !== 'superuser')      roleActions += `<button class="btn btn-gold btn-sm" style="font-size:11px" onclick="designateSuperuser('${esc(name)}')">👑 Make SU</button> `;
          }
          return `
            <tr>
              <td style="color:var(--text3)">${i+1}</td>
              <td><div class="lb-user"><div class="user-avatar" style="background:${u.color};width:28px;height:28px;font-size:11px">${name.slice(0,2).toUpperCase()}</div><strong>${esc(name)}</strong></div></td>
              <td>${roleBadge}</td>
              <td><code style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:12px;letter-spacing:1px;color:var(--gold)">${esc(u.pin || '—')}</code></td>
              <td style="color:var(--gold);font-weight:800">${u.points || 0}</td>
              <td style="color:var(--green)">${u.exact || 0}</td>
              <td style="color:var(--text2)">${picks}</td>
              <td style="color:var(--text3);font-size:12px">${joined}</td>
              <td style="white-space:nowrap">${roleActions}<button class="btn btn-ghost btn-sm" style="color:var(--red2);border-color:var(--red2)" onclick="deleteUser('${esc(name)}')">Delete</button></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${renderUserBonusPickEdit()}`;
}

function renderUserBonusPickEdit() {
  const users    = Object.keys(_users).sort((a,b) => a.localeCompare(b));
  const teamOpts = Object.values(TEAMS).sort((a,b) => a.name.localeCompare(b.name));
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">✏️ Fix User Bonus Picks</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Override a user's champion or top scorer pick — use when they missed the deadline or misspelled a name.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">User</div>
          <select class="sp-select" id="editPickUser" style="min-width:140px" onchange="loadUserPicksForEdit()">
            <option value="">— select user —</option>
            ${users.map(n => `<option value="${n}">${esc(n)}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:160px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">🏆 Champion Pick</div>
          <select class="sp-select" id="editPickChamp" style="width:100%">
            <option value="">— not set —</option>
            ${teamOpts.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:160px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">⚽ Top Scorer Pick</div>
          <input class="sp-input" id="editPickScorer" placeholder="Player name…" style="width:100%">
        </div>
        <button class="btn btn-gold btn-sm" onclick="saveUserPickEdit()" style="height:38px">Save Picks</button>
      </div>
      <div id="editPickMsg" style="font-size:12px;margin-top:8px;display:none"></div>
    </div>`;
}

function loadUserPicksForEdit() {
  const name = document.getElementById('editPickUser')?.value;
  if (!name || !_users[name]) return;
  const u = _users[name];
  const champEl  = document.getElementById('editPickChamp');
  const scorerEl = document.getElementById('editPickScorer');
  if (champEl)  champEl.value  = u.championPick  || '';
  if (scorerEl) scorerEl.value = u.topScorerPick || '';
  const msg = document.getElementById('editPickMsg');
  if (msg) msg.style.display = 'none';
}

async function saveUserPickEdit() {
  const name   = document.getElementById('editPickUser')?.value;
  const champ  = document.getElementById('editPickChamp')?.value  || null;
  const scorer = (document.getElementById('editPickScorer')?.value || '').trim() || null;
  const msg    = document.getElementById('editPickMsg');
  if (!name) {
    if (msg) { msg.style.cssText = 'display:block;color:var(--red2)'; msg.textContent = 'Select a user first.'; }
    return;
  }
  await dbUpdateUserField(name, 'championPick',  champ);
  await dbUpdateUserField(name, 'topScorerPick', scorer);
  renderLeaderboard();
  if (msg) { msg.style.cssText = 'display:block;color:var(--green)'; msg.textContent = `✓ Picks updated for ${name}.`; }
}

function renderAdminSettings() {
  const el = document.getElementById('adminTabContent');
  if (!el) return;
  const curChamp  = _champion  || '';
  const curScorer = _topScorer || '';
  const teamOptions = Object.values(TEAMS).sort((a,b)=>a.name.localeCompare(b.name));
  el.innerHTML = `
    <div class="grid-2" style="gap:16px;margin-top:8px">
      <div class="card">
        <div class="card-title">🏆 Tournament Champion Result</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Set after the Final. Awards +4 pts to correct picks.</p>
        <select class="sp-select" id="adminChampSelect" style="width:100%;margin-bottom:10px">
          <option value="">— not set —</option>
          ${teamOptions.map(t=>`<option value="${t.id}" ${curChamp===t.id?'selected':''}>${t.name}</option>`).join('')}
        </select>
        <button class="btn btn-gold btn-sm" onclick="setAdminSpecialResult('champion')">Save Champion</button>
        ${curChamp ? `<span style="margin-left:10px;font-size:12px;color:var(--green)">✓ Set: ${esc((TEAMS[curChamp]||{name:curChamp}).name)}</span>` : ''}
      </div>
      <div class="card">
        <div class="card-title">⚽ Top Scorer Result</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Set after tournament ends. Awards +5 pts to correct picks.</p>
        <input class="modal-input" id="adminScorerInput" type="text" placeholder="Player name…" value="${esc(curScorer)}" style="margin-bottom:10px">
        <button class="btn btn-gold btn-sm" onclick="setAdminSpecialResult('scorer')">Save Scorer</button>
        ${curScorer ? `<span style="margin-left:10px;font-size:12px;color:var(--green)">✓ Set: ${esc(curScorer)}</span>` : ''}
      </div>
    </div>
    </div>
    ${renderStatsAdminSection()}
    <div class="card" style="max-width:400px;margin-top:16px">
      <div class="card-title">Change Admin Password</div>
      <input class="modal-input" id="newPwd1" type="password" placeholder="New password…" style="margin-bottom:10px">
      <input class="modal-input" id="newPwd2" type="password" placeholder="Confirm new password…" style="margin-bottom:10px">
      <div id="pwdChangeMsg" style="font-size:13px;margin-bottom:10px;display:none"></div>
      <button class="btn btn-primary btn-sm" onclick="changeAdminPwd()">Update Password</button>
    </div>`;
}

function renderStatsAdminSection() {
  const teamOpts = Object.values(TEAMS).sort((a,b)=>a.name.localeCompare(b.name));
  const teamSelect = `<select class="sp-select" style="flex:1;min-width:120px">
    <option value="">— team —</option>
    ${teamOpts.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}
  </select>`;
  const mkTable = (list, type) => list.length ? list.map((p,i) => {
    const t = TEAMS[p.team] || { iso2: null, name: p.team };
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text3);width:20px;font-size:12px">${i+1}</span>
      <span style="flex:1;font-weight:600">${esc(p.name)}</span>
      <span style="font-size:12px;color:var(--text2)">${flag(t.iso2,14)} ${t.name}</span>
      <span style="color:var(--gold);font-weight:800;width:30px;text-align:right">${p.count}</span>
      <button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--red2)" onclick="removePlayerStat('${type}',${i})">✕</button>
    </div>`;
  }).join('') : `<div style="color:var(--text3);font-size:13px;padding:8px 0">No entries yet.</div>`;

  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">⚽ Top Scorers (live update)</div>
      <div id="adminScorersList">${mkTable(_topScorers,'scorers')}</div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        <input class="sp-input" id="statScorerName" placeholder="Player name…" style="flex:1;min-width:120px">
        <select class="sp-select" id="statScorerTeam" style="min-width:120px">
          <option value="">— team —</option>
          ${teamOpts.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}
        </select>
        <input class="sp-input" id="statScorerCount" type="number" min="1" max="20" placeholder="#" style="width:52px">
        <button class="btn btn-gold btn-sm" onclick="addPlayerStat('scorers')">Add</button>
      </div>
    </div>`;
}

async function addPlayerStat(type) {
  const isScorer = type === 'scorers';
  const name  = document.getElementById(isScorer ? 'statScorerName'  : 'statAssistName').value.trim();
  const team  = document.getElementById(isScorer ? 'statScorerTeam'  : 'statAssistTeam').value;
  const count = parseInt(document.getElementById(isScorer ? 'statScorerCount' : 'statAssistCount').value) || 1;
  if (!name) return;
  const list = isScorer ? [..._topScorers] : [..._topAssists];
  const idx  = list.findIndex(p => p.name.toLowerCase() === name.toLowerCase() && p.team === team);
  if (idx >= 0) list[idx].count = count;
  else list.push({ name, team, count });
  list.sort((a, b) => b.count - a.count);
  await dbSavePlayerStats(type, list);
  renderAdminSettings();
}

async function removePlayerStat(type, index) {
  const list = (type === 'scorers' ? [..._topScorers] : [..._topAssists]);
  list.splice(index, 1);
  await dbSavePlayerStats(type, list);
  renderAdminSettings();
}

// ── CHAT ──────────────────────────────────────────
function renderChat() {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  el.innerHTML = _chat.length ? _chat.map(msg => {
    const initials = msg.username.slice(0,2).toUpperCase();
    const time = new Date(msg.created_at).toLocaleTimeString('pl-PL', { hour:'2-digit', minute:'2-digit' });
    const isMe = msg.username === currentUser;
    return `
      <div class="chat-msg${isMe ? ' chat-msg-me' : ''}">
        <div class="chat-avatar" style="background:${msg.color}">${initials}</div>
        <div class="chat-bubble">
          <span class="chat-user">${esc(msg.username)}</span>
          <span class="chat-text">${esc(msg.message)}</span>
          <span class="chat-time">${time}</span>
        </div>
      </div>`;
  }).join('') : `<div style="color:var(--text3);font-size:13px;text-align:center;padding:20px 0">No messages yet. Say hello! 👋</div>`;
  el.scrollTop = el.scrollHeight;

  const row = document.getElementById('chatInputRow');
  const prompt = document.getElementById('chatLoginPrompt');
  if (row) row.style.display = currentUser ? 'flex' : 'none';
  if (prompt) prompt.style.display = currentUser ? 'none' : 'block';
}

async function sendChat() {
  const inp = document.getElementById('chatInput');
  if (!inp || !inp.value.trim()) return;
  const msg = inp.value.trim();
  inp.value = '';
  await dbSendChat(msg);
}

// ── KNOCKOUT BRACKET ──────────────────────────────
const KO_ROUND_ORDER  = ['R32','R16','QF','SF','SF3','Final'];
const KO_ROUND_LABELS = { R32:'Round of 32', R16:'Round of 16', QF:'Quarter-finals', SF:'Semi-finals', SF3:'Third Place', Final:'Final' };

// Maps internal KO match IDs → Wikipedia match numbers (for auto-advancement via labels)
const KO_WIKI_MAP = {
  'KO_R32_01':73,'KO_R32_02':76,'KO_R32_03':74,'KO_R32_04':75,
  'KO_R32_05':78,'KO_R32_06':77,'KO_R32_07':79,'KO_R32_08':80,
  'KO_R32_09':82,'KO_R32_10':81,'KO_R32_11':84,'KO_R32_12':83,
  'KO_R32_13':85,'KO_R32_14':88,'KO_R32_15':86,'KO_R32_16':87,
  'KO_R16_17':89,'KO_R16_18':90,'KO_R16_19':91,'KO_R16_20':92,
  'KO_R16_21':93,'KO_R16_22':94,'KO_R16_23':95,'KO_R16_24':96,
  'KO_QF_25':97,'KO_QF_26':98,'KO_QF_27':99,'KO_QF_28':100,
  'KO_SF_29':101,'KO_SF_30':102,
};

function renderBracket() {
  const el = document.getElementById('bracketContent');
  if (!el) return;
  if (!KNOCKOUT.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🏆</div><h3>Bracket coming soon</h3><p>Group stage ends June 27. Admin will set up the knockout bracket once all teams are known.</p></div>`;
    return;
  }

  // Build id → match lookup
  const byId = {};
  KNOCKOUT.forEach(m => { byId[m.id] = m; });

  // Inner helper: render a single bracket match card
  function bmcCard(m) {
    if (!m) return `<div class="bmc"><div class="bmc-tbd">?</div></div>`;

    const homeTeam = m.home ? TEAMS[m.home] : null;
    const awayTeam = m.away ? TEAMS[m.away] : null;
    const played   = m.homeScore !== null && m.awayScore !== null;
    const hasPen   = played && m.homeScore === m.awayScore && m.penWinner;
    const homeWin  = played && (m.homeScore > m.awayScore || (hasPen && m.penWinner === m.home));
    const awayWin  = played && (m.awayScore > m.homeScore || (hasPen && m.penWinner === m.away));

    function flagCircle(team, isWinner) {
      const winCls = isWinner ? ' winner' : '';
      if (!team) return `<div class="bmc-flag-c${winCls}"><span class="bmc-tbd">?</span></div>`;
      const iso2 = (team.iso2 || '').toLowerCase();
      return `<div class="bmc-flag-c${winCls}">${flag(iso2, 40)}</div>`;
    }

    const wk = warsawKickoff(m);
    const scoreHtml = played
      ? `<div class="bmc-score-wrap">${m.homeScore}–${m.awayScore}</div>`
      : `<div class="bmc-score-wrap vs">–</div>`;
    const penHtml = hasPen ? `<div class="bmc-pen">pen.</div>` : '';
    const liveCls = (m.status === 'live') ? ' bmc-live' : (played ? ' bmc-done' : '');

    return `<div class="bmc${liveCls}">
  <div class="bmc-flags">
    ${flagCircle(homeTeam, homeWin)}
    ${scoreHtml}
    ${flagCircle(awayTeam, awayWin)}
  </div>
  ${penHtml}
  <div class="bmc-date">${wk.date}<br>${wk.time}</div>
</div>`;
  }

  // Connector helpers
  function straight4() {
    return `<div class="bkt-conn-straight"><div></div><div></div><div></div><div></div></div>`;
  }
  function merge42() {
    return `<div class="bkt-conn-merge"><div class="bkt-cl"></div><div class="bkt-cr"></div><div class="bkt-cl"></div><div class="bkt-cr"></div></div>`;
  }
  function merge21() {
    return `<div class="bkt-conn-merge"><div class="bkt-cl"></div><div class="bkt-cr"></div></div>`;
  }
  function split12() {
    return `<div class="bkt-conn-split"><div class="bkt-sl"></div><div class="bkt-sr"></div></div>`;
  }
  function split24() {
    return `<div class="bkt-conn-split"><div class="bkt-sl"></div><div class="bkt-sr"></div><div class="bkt-sl"></div><div class="bkt-sr"></div></div>`;
  }
  function straight1() {
    return `<div style="display:flex;height:14px;justify-content:center"><div style="width:40%;border-bottom:2px solid var(--border)"></div></div>`;
  }

  el.innerHTML = `
<div class="bkt">
  <!-- HALF A: R32 → Final -->
  <div class="bkt-label">Round of 32</div>
  <div class="bkt-row">
    <div class="bkt-pod">${bmcCard(byId['KO_R32_01'])}${bmcCard(byId['KO_R32_04'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_03'])}${bmcCard(byId['KO_R32_06'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_12'])}${bmcCard(byId['KO_R32_11'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_10'])}${bmcCard(byId['KO_R32_09'])}</div>
  </div>
  ${straight4()}
  <div class="bkt-label">Round of 16</div>
  <div class="bkt-row">
    ${bmcCard(byId['KO_R16_17'])}${bmcCard(byId['KO_R16_18'])}${bmcCard(byId['KO_R16_21'])}${bmcCard(byId['KO_R16_22'])}
  </div>
  ${merge42()}
  <div class="bkt-label">Quarter-finals</div>
  <div class="bkt-row">
    ${bmcCard(byId['KO_QF_25'])}${bmcCard(byId['KO_QF_26'])}
  </div>
  ${merge21()}
  <div class="bkt-label">Semi-finals</div>
  <div class="bkt-row" style="justify-content:center">
    <div style="flex:0.5;max-width:180px">${bmcCard(byId['KO_SF_29'])}</div>
  </div>
  ${straight1()}

  <!-- FINAL -->
  <div class="bkt-label final-label">🏆 Final</div>
  <div class="bkt-row" style="justify-content:center">
    <div style="flex:0.4;max-width:160px">${bmcCard(byId['KO_Final_32'])}</div>
  </div>

  <!-- HALF B: reverse order -->
  ${straight1()}
  <div class="bkt-label">Semi-finals</div>
  <div class="bkt-row" style="justify-content:center">
    <div style="flex:0.5;max-width:180px">${bmcCard(byId['KO_SF_30'])}</div>
  </div>
  ${split12()}
  <div class="bkt-label">Quarter-finals</div>
  <div class="bkt-row">
    ${bmcCard(byId['KO_QF_27'])}${bmcCard(byId['KO_QF_28'])}
  </div>
  ${split24()}
  <div class="bkt-label">Round of 16</div>
  <div class="bkt-row">
    ${bmcCard(byId['KO_R16_19'])}${bmcCard(byId['KO_R16_20'])}${bmcCard(byId['KO_R16_23'])}${bmcCard(byId['KO_R16_24'])}
  </div>
  ${straight4()}
  <div class="bkt-label">Round of 32</div>
  <div class="bkt-row">
    <div class="bkt-pod">${bmcCard(byId['KO_R32_02'])}${bmcCard(byId['KO_R32_05'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_07'])}${bmcCard(byId['KO_R32_08'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_15'])}${bmcCard(byId['KO_R32_14'])}</div>
    <div class="bkt-pod">${bmcCard(byId['KO_R32_13'])}${bmcCard(byId['KO_R32_16'])}</div>
  </div>

  <!-- 3rd place -->
  <div class="bkt-label" style="color:var(--text3);margin-top:8px">🥉 Third place</div>
  <div class="bkt-row" style="justify-content:center">
    <div style="flex:0.4;max-width:160px">${bmcCard(byId['KO_SF3_31'])}</div>
  </div>
</div>
`;
}

function knockoutMatchCard(m, preds) {
  if (!m.home || !m.away) {
    const wk = warsawKickoff(m);
    return `
      <div class="match-card" style="opacity:.65">
        <span class="match-group-badge" style="background:var(--gold2);color:#000;font-size:9px">${KO_ROUND_LABELS[m.round]||m.round}</span>
        <div class="match-teams">
          <div class="match-team"><span class="team-name" style="color:var(--text3)">${esc(m.homeLabel||'TBD')}</span></div>
          <div class="match-score pending">–</div>
          <div class="match-team away"><span class="team-name" style="color:var(--text3)">${esc(m.awayLabel||'TBD')}</span></div>
        </div>
        <div class="match-pred-slot"></div>
        <div class="match-meta">
          <div class="match-meta-date">${wk.time} <span style="font-size:10px;opacity:.7">Warsaw</span></div>
          <div>${wk.date}</div>
        </div>
      </div>`;
  }

  // Build a temporary match object compatible with matchCard
  const saved = { group: m.group };
  m.group = KO_ROUND_LABELS[m.round] || m.round;

  // Inject penalty info into score display if needed
  const hasPen = m.homeScore !== null && m.awayScore !== null && m.homeScore === m.awayScore && m.penWinner;
  if (hasPen) {
    const origHome = m.homeScore, origAway = m.awayScore;
    // Override score display temporarily to show pen
    m._penLabel = m.penWinner === m.home ? '(pen.)' : null;
  }

  const html = matchCard(m, preds);
  m.group = saved.group;
  delete m._penLabel;

  // Inject penalty badge into card
  if (hasPen) {
    const penTeam = TEAMS[m.penWinner] || { name: m.penWinner };
    return html.replace(
      `<div class="match-score">${m.homeScore} : ${m.awayScore}</div>`,
      `<div class="match-score" style="flex-direction:column;gap:2px">${m.homeScore} : ${m.awayScore}<span style="font-size:9px;color:var(--gold);font-weight:700">pen: ${esc(penTeam.name)}</span></div>`
    );
  }
  return html;
}

function renderBracketAdminTab() {
  const el = document.getElementById('adminTabContent');
  if (!el) return;
  const teams = Object.values(TEAMS).sort((a,b)=>a.name.localeCompare(b.name));

  el.innerHTML = `
    <div style="margin-bottom:10px;font-size:12px;color:var(--text3)">
      💡 Enter score → save. If draw after 90+30 min, pick penalty winner. Winners auto-advance to next round.
    </div>
    ${KNOCKOUT.length ? KNOCKOUT.map((m,i) => {
      const wk = warsawKickoff(m);
      const isDraw = m.homeScore !== null && m.awayScore !== null && m.homeScore === m.awayScore;
      const homeTeamName = m.home ? (TEAMS[m.home]?.name || m.home) : m.homeLabel || '?';
      const awayTeamName = m.away ? (TEAMS[m.away]?.name || m.away) : m.awayLabel || '?';
      const penOpts = isDraw && m.home && m.away ? `
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--gold);font-weight:700">🏅 Penalty winner:</span>
          <select class="sp-select" style="min-width:130px" onchange="setKoPenWinner(${i},this.value)">
            <option value="">— not set —</option>
            <option value="${m.home}" ${m.penWinner===m.home?'selected':''}>${esc(homeTeamName)}</option>
            <option value="${m.away}" ${m.penWinner===m.away?'selected':''}>${esc(awayTeamName)}</option>
          </select>
          ${m.penWinner ? `<span class="admin-badge green">✓ ${esc(TEAMS[m.penWinner]?.name||m.penWinner)} wins on pens</span>` : ''}
        </div>` : '';
      const hasResult = m.homeScore !== null && m.awayScore !== null;
      const resultBadge = hasResult
        ? (isDraw && !m.penWinner
            ? `<span class="admin-badge gold">Draw · set pen winner ↓</span>`
            : `<span class="admin-badge green">✓ Result entered</span>`)
        : '';
      return `
        <div class="admin-match-row" style="flex-wrap:wrap;gap:6px">
          <span class="match-group-badge" style="background:var(--gold2);color:#000">${KO_ROUND_LABELS[m.round]||m.round}</span>
          <div class="admin-match-teams">
            <span class="admin-team">${esc(homeTeamName)}</span>
            <span style="color:var(--text3)">vs</span>
            <span class="admin-team">${esc(awayTeamName)}</span>
          </div>
          <div class="admin-match-meta">🕐 ${wk.date} ${wk.time}</div>
          ${resultBadge}
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;width:100%">
            <select class="sp-select" style="min-width:130px" onchange="setKoTeam(${i},'home',this.value)">
              <option value="">— TBD —</option>${teams.map(t=>`<option value="${t.id}" ${m.home===t.id?'selected':''}>${t.name}</option>`).join('')}
            </select>
            <input class="pred-input" type="number" min="0" max="30" placeholder="–" value="${m.homeScore??''}" style="width:44px"
              onchange="setKoScore(${i},'homeScore',this.value)">
            <span class="pred-sep">:</span>
            <input class="pred-input" type="number" min="0" max="30" placeholder="–" value="${m.awayScore??''}" style="width:44px"
              onchange="setKoScore(${i},'awayScore',this.value)">
            <select class="sp-select" style="min-width:130px" onchange="setKoTeam(${i},'away',this.value)">
              <option value="">— TBD —</option>${teams.map(t=>`<option value="${t.id}" ${m.away===t.id?'selected':''}>${t.name}</option>`).join('')}
            </select>
            <button class="btn btn-ghost btn-sm" style="color:var(--red2)" onclick="removeKnockoutMatch(${i})">✕</button>
          </div>
          ${penOpts}
        </div>`;
    }).join('') : `<div style="color:var(--text3);font-size:13px;padding:12px 0">No knockout matches yet.</div>`}`;
}

async function addKnockoutMatch() {
  const round     = document.getElementById('koRound').value;
  const utc       = document.getElementById('koUtc').value.trim();
  const homeLabel = document.getElementById('koHomeLabel').value.trim();
  const awayLabel = document.getElementById('koAwayLabel').value.trim();
  if (!utc) return;
  const id = `KO_${round}_${Date.now()}`;
  const matches = [...KNOCKOUT, { id, round, utc, homeLabel, awayLabel, home: null, away: null, homeScore: null, awayScore: null }];
  await dbSaveKnockout(matches);
  renderBracketAdminTab();
}

// Auto-advance knockout bracket: when match m has a clear winner,
// propagate the winner/loser to the next-round match via label references (e.g. "W73", "L101")
function autoAdvanceKnockout(changedMatch, matches) {
  const wikiNum = KO_WIKI_MAP[changedMatch.id];
  if (!wikiNum) return matches;

  const hs = changedMatch.homeScore, as = changedMatch.awayScore;
  if (hs === null || as === null) return matches;

  let winner = null, loser = null;
  if (hs > as)      { winner = changedMatch.home; loser = changedMatch.away; }
  else if (as > hs) { winner = changedMatch.away; loser = changedMatch.home; }
  else {
    // Draw after 90 min → check penalty winner
    winner = changedMatch.penWinner || null;
    loser  = winner ? (winner === changedMatch.home ? changedMatch.away : changedMatch.home) : null;
  }
  if (!winner) return matches;

  const wLabel = 'W' + wikiNum, lLabel = 'L' + wikiNum;
  return matches.map(m => {
    let updated = { ...m };
    if (m.homeLabel === wLabel && m.home !== winner) updated.home = winner;
    if (m.awayLabel === wLabel && m.away !== winner) updated.away = winner;
    if (m.homeLabel === lLabel && m.home !== loser)  updated.home = loser;
    if (m.awayLabel === lLabel && m.away !== loser)  updated.away = loser;
    return updated;
  });
}

async function setKoTeam(idx, side, teamId) {
  const matches = [...KNOCKOUT];
  matches[idx][side] = teamId || null;
  await dbSaveKnockout(matches);
}

async function setKoScore(idx, side, val) {
  snapshotRankings();
  let matches = [...KNOCKOUT];
  matches[idx] = { ...matches[idx], [side]: val === '' ? null : parseInt(val) };
  matches = autoAdvanceKnockout(matches[idx], matches);
  await dbSaveKnockout(matches);
  renderLeaderboard(); renderHome();
}

async function setKoPenWinner(idx, teamId) {
  snapshotRankings();
  let matches = [...KNOCKOUT];
  matches[idx] = { ...matches[idx], penWinner: teamId || null };
  matches = autoAdvanceKnockout(matches[idx], matches);
  await dbSaveKnockout(matches);
  renderLeaderboard(); renderHome();
}

async function removeKnockoutMatch(idx) {
  if (!confirm('Remove this match?')) return;
  const matches = [...KNOCKOUT];
  matches.splice(idx, 1);
  await dbSaveKnockout(matches);
  renderBracketAdminTab();
}

async function setAdminSpecialResult(type) {
  if (type === 'champion') {
    const val = document.getElementById('adminChampSelect').value;
    if (val) await dbSetSetting('champion', val);
    else await dbDeleteSetting('champion');
  } else {
    const val = document.getElementById('adminScorerInput').value.trim();
    if (val) await dbSetSetting('top_scorer', val);
    else await dbDeleteSetting('top_scorer');
  }
  renderLeaderboard();
  renderHome();
  renderAdminSettings();
}

function changeAdminPwd() {
  const p1 = document.getElementById('newPwd1').value;
  const p2 = document.getElementById('newPwd2').value;
  const msg = document.getElementById('pwdChangeMsg');
  if (!p1 || p1.length < 4) { msg.style.cssText='display:block;color:var(--red2)'; msg.textContent='Min. 4 characters.'; return; }
  if (p1 !== p2)             { msg.style.cssText='display:block;color:var(--red2)'; msg.textContent='Passwords do not match.'; return; }
  localStorage.setItem(STORAGE.ADMIN_PWD, p1);
  msg.style.cssText='display:block;color:var(--green)'; msg.textContent='Password updated!';
  document.getElementById('newPwd1').value = '';
  document.getElementById('newPwd2').value = '';
}

// ── START ─────────────────────────────────────────
init();
