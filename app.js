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

// LocalStorage: only admin session + unlocks (not shared across users)
const STORAGE = {
  SESSION:       'wc2026_session',
  ADMIN_SESSION: 'wc2026_admin',
  ADMIN_UNLOCKS: 'wc2026_unlocks',
  ADMIN_PWD:     'wc2026_admin_pwd',
};

// ── SUPABASE DB OPERATIONS ────────────────────────
async function dbInit() {
  supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
  const [usersRes, predsRes, resultsRes, settingsRes] = await Promise.all([
    supa.from('users').select('*'),
    supa.from('predictions').select('*'),
    supa.from('match_results').select('*'),
    supa.from('app_settings').select('*'),
  ]);
  _users = {};
  (usersRes.data || []).forEach(u => {
    _users[u.username] = {
      color: u.color, role: u.role || 'member', pin: u.pin,
      championPick: u.champion_pick || null, topScorerPick: u.top_scorer_pick || null,
      created: new Date(u.created_at).getTime(),
    };
  });
  _predictions = {};
  (predsRes.data || []).forEach(p => {
    if (!_predictions[p.username]) _predictions[p.username] = {};
    _predictions[p.username][p.match_id] = { home: p.home_score, away: p.away_score };
  });
  _results = {};
  (resultsRes.data || []).forEach(r => { _results[r.match_id] = { home: r.home_score, away: r.away_score }; });
  mergeResultsIntoMatches();
  _champion = null; _topScorer = null;
  (settingsRes.data || []).forEach(s => {
    if (s.key === 'champion')   _champion  = s.value;
    if (s.key === 'top_scorer') _topScorer = s.value;
  });
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
    await supa.from('predictions').delete().eq('username', username).eq('match_id', matchId);
  } else {
    await supa.from('predictions').upsert(
      { username, match_id: matchId, home_score: home, away_score: away, updated_at: new Date().toISOString() },
      { onConflict: 'username,match_id' }
    );
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

function isMatchLocked(m) {
  if (m.homeScore !== null && m.awayScore !== null) return true;
  const unlocks = JSON.parse(localStorage.getItem(STORAGE.ADMIN_UNLOCKS) || '[]');
  if (unlocks.includes(m.id)) return false;
  return Date.now() >= matchUTCDate(m).getTime() - 2 * 3600 * 1000;
}

// ── INIT ──────────────────────────────────────────
async function init() {
  showLoadingOverlay(true);
  await loadData();
  await dbInit();
  showLoadingOverlay(false);
  restoreSession();
  renderSidebarUser();
  setupNav();
  renderHome();
  renderSchedule();
  renderGroups();
  renderLeaderboard();
  renderStats();
  renderPicks();
  renderAdmin();
  startCountdown();
  setupRealtime();
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
    dbSavePrediction(currentUser, matchId, null, null).catch(console.error);
  } else {
    const h = parseInt(home) || 0, a = parseInt(away) || 0;
    _predictions[currentUser][matchId] = { home: h, away: a };
    dbSavePrediction(currentUser, matchId, h, a).catch(console.error);
  }
  renderSidebarUser();
  updateHomePredCount();
}

function calcLeaderboard() {
  return Object.entries(getUsers())
    .map(([name, u]) => ({ name, points: u.points, exact: u.exact, winner: u.winner, color: u.color }))
    .sort((a, b) => b.points - a.points || b.exact - a.exact);
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
  el.textContent = Object.keys(preds).length;
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
    const next = MATCHES
      .filter(m => m.homeScore === null && m.awayScore === null)
      .map(m => ({ m, t: new Date(m.utc).getTime() }))
      .filter(x => x.t > now)
      .sort((a, b) => a.t - b.t)[0];

    const cdEl = document.getElementById('countdown');
    if (!cdEl) return;

    if (!next) {
      cdEl.querySelector('.countdown-label').textContent = 'Group stage complete';
      ['cdDays','cdHours','cdMins','cdSecs'].forEach(id => { document.getElementById(id).textContent = '—'; });
      return;
    }

    const diff = next.t - now;
    const h = TEAMS[next.m.home] || { name: next.m.home, iso2: null };
    const a = TEAMS[next.m.away] || { name: next.m.away, iso2: null };
    const wk = warsawKickoff(next.m);

    document.getElementById('cdDays').textContent  = Math.floor(diff / 86400000);
    document.getElementById('cdHours').textContent = Math.floor((diff % 86400000) / 3600000);
    document.getElementById('cdMins').textContent  = Math.floor((diff % 3600000) / 60000);
    document.getElementById('cdSecs').textContent  = Math.floor((diff % 60000) / 1000);

    document.getElementById('countdownLabel').textContent = 'Next match in';
    document.getElementById('countdownMatchTeams').innerHTML =
      `${flag(h.iso2, 18)} ${h.name} vs ${a.name} ${flag(a.iso2, 18)}`;
    document.getElementById('countdownMatchMeta').textContent =
      `${wk.date} · ${wk.time} Warsaw · Group ${next.m.group}`;
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
  const el = document.getElementById('specialPicksHome');
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
  renderSpecialPicksHome();

  // Upcoming matches (next 5 without results)
  const upcoming = MATCHES.filter(m => m.homeScore === null).slice(0, 5);
  const upcomingEl = document.getElementById('homeUpcoming');
  if (!upcoming.length) {
    upcomingEl.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">All group stage matches completed.</div>`;
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
  const h = TEAMS[m.home] || { iso2: null, name: m.home };
  const a = TEAMS[m.away] || { iso2: null, name: m.away };
  const d = fmtDate(m.date);
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(30,48,88,0.4);font-size:13px">
      <span style="background:var(--red);color:#fff;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px">${m.group}</span>
      <span style="display:flex;align-items:center;gap:5px">${flag(h.iso2, 18)} ${h.name}</span>
      <span style="color:var(--text3);font-size:11px">vs</span>
      <span style="display:flex;align-items:center;gap:5px">${a.name} ${flag(a.iso2, 18)}</span>
      <span style="margin-left:auto;color:var(--text3);white-space:nowrap">${d}</span>
    </div>
  `;
}

// ── SCHEDULE ──────────────────────────────────────
function renderSchedule() {
  // Build filter buttons
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
}

function renderScheduleList(groupFilter) {
  const list   = document.getElementById('scheduleList');
  const preds  = currentUser ? getPredictions(currentUser) : {};
  let matches  = MATCHES;
  if (groupFilter !== 'all') matches = matches.filter(m => m.group === groupFilter);

  // Group by date
  const byDate = {};
  matches.forEach(m => {
    if (!byDate[m.date]) byDate[m.date] = [];
    byDate[m.date].push(m);
  });

  list.innerHTML = Object.entries(byDate).sort().map(([date, ms]) => `
    <div class="schedule-day">
      <div class="schedule-day-header"><span class="day-dot"></span>${fmtDateLong(date)}</div>
      ${ms.map(m => matchCard(m, preds)).join('')}
    </div>
  `).join('');

  // Attach prediction input listeners
  list.querySelectorAll('.pred-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const card  = inp.closest('.match-card');
      const mid   = card.dataset.matchId;
      const hInp  = card.querySelector('[data-side="home"]');
      const aInp  = card.querySelector('[data-side="away"]');
      savePrediction(mid, hInp.value, aInp.value);
      updatePredBadge(card, mid, hInp.value, aInp.value);
    });
  });
}

function matchCard(m, preds) {
  const h   = TEAMS[m.home] || { iso2: null, name: m.home };
  const a   = TEAMS[m.away] || { iso2: null, name: m.away };
  const p          = preds[m.id];
  const hasResult  = m.homeScore !== null && m.awayScore !== null;
  const matchLocked = isMatchLocked(m);

  let scoreHtml;
  if (hasResult) {
    scoreHtml = `<div class="match-score">${m.homeScore} : ${m.awayScore}</div>`;
  } else {
    scoreHtml = `<div class="match-score pending">–</div>`;
  }

  let predHtml = '';
  if (!hasResult) {
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
        <div>${wk.date} · ${m.city}</div>
        <div style="font-size:10px;opacity:.6">${m.venue}</div>
      </div>
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
function renderGroups() {
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
  const total   = MATCHES.length;
  const made    = Object.keys(preds).length;
  const played  = MATCHES.filter(m => m.homeScore !== null).length;
  let earnedPts = 0, exact = 0, winner = 0;
  MATCHES.forEach(m => {
    if (m.homeScore === null) return;
    const p = preds[m.id]; if (!p) return;
    const pts = calcPredPts(p.home, p.away, m.homeScore, m.awayScore);
    earnedPts += pts;
    if (pts === 3) exact++;
    else if (pts === 1) winner++;
  });

  const users = getUsers();
  const u = users[currentUser];

  el.innerHTML = `
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-tile"><div class="stat-tile-val">${made}</div><div class="stat-tile-label">Picks made</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${total - made}</div><div class="stat-tile-label">Remaining</div></div>
      <div class="stat-tile"><div class="stat-tile-val" style="color:var(--green)">${earnedPts}</div><div class="stat-tile-label">Points earned</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${exact}</div><div class="stat-tile-label">Exact scores</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div style="font-size:14px;color:var(--text2)">
        <strong style="color:var(--text)">${esc(currentUser)}</strong>'s picks &nbsp;·&nbsp;
        ${made} / ${total} matches predicted &nbsp;·&nbsp;
        ${played} played so far
      </div>
      <div style="margin-top:8px;background:var(--bg3);border-radius:6px;height:6px;overflow:hidden">
        <div style="background:var(--red);height:100%;width:${Math.round(made/total*100)}%;transition:width 0.5s"></div>
      </div>
    </div>
    <div id="picksGroupedList">Loading…</div>
  `;

  renderPicksGrouped(preds);
}

function renderPicksGrouped(preds) {
  const el = document.getElementById('picksGroupedList');
  if (!el) return;

  const byGroup = {};
  MATCHES.forEach(m => {
    if (!byGroup[m.group]) byGroup[m.group] = [];
    byGroup[m.group].push(m);
  });

  el.innerHTML = Object.entries(byGroup).sort().map(([grp, ms]) => `
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Group ${grp}</div>
      ${ms.map(m => matchCard(m, preds)).join('')}
    </div>
  `).join('');

  // Re-attach listeners
  el.querySelectorAll('.pred-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.match-card');
      const mid  = card.dataset.matchId;
      const hInp = card.querySelector('[data-side="home"]');
      const aInp = card.querySelector('[data-side="away"]');
      savePrediction(mid, hInp.value, aInp.value);
      renderPicks();
    });
  });
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

  const allUsers = getUsers();
  el.innerHTML = `
    <table class="leaderboard-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th style="text-align:right">Pts</th>
          <th style="text-align:center">Exact</th>
          <th style="text-align:center">Winner</th>
          <th style="text-align:center">🏆 Champion</th>
          <th style="text-align:center">⚽ Top Scorer</th>
        </tr>
      </thead>
      <tbody>
        ${lb.map((u, i) => {
          const ud = allUsers[u.name] || {};
          const rankClass = i===0?'r1':i===1?'r2':i===2?'r3':'';
          const isMe = u.name === currentUser;
          const champId = ud.championPick;
          const champTeam = champId ? (TEAMS[champId] || { name: champId, iso2: null }) : null;
          const champHit = champId && _champion && champId === _champion;
          const champCell = champTeam
            ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;${champHit?'color:var(--green);font-weight:700':''}">${flag(champTeam.iso2,14)} ${esc(champTeam.name)}${champHit?' ✓':''}</span>`
            : `<span style="color:var(--text3);font-size:11px">—</span>`;
          const scorerPick = ud.topScorerPick || '';
          const scorerHit = scorerPick && _topScorer && scorerPick.toLowerCase() === _topScorer.toLowerCase();
          const scorerCell = scorerPick
            ? `<span style="font-size:12px;${scorerHit?'color:var(--green);font-weight:700':''}">${esc(scorerPick)}${scorerHit?' ✓':''}</span>`
            : `<span style="color:var(--text3);font-size:11px">—</span>`;
          return `
            <tr class="${isMe ? 'lb-me' : ''}">
              <td><span class="lb-rank ${rankClass}">${i+1}</span></td>
              <td>
                <div class="lb-user">
                  <div class="user-avatar" style="background:${u.color};width:32px;height:32px;font-size:12px">${u.name.slice(0,2).toUpperCase()}</div>
                  <span style="font-weight:${isMe?'800':'600'}">${esc(u.name)}${isMe ? ' <span style="font-size:11px;color:var(--gold)">★ you</span>' : ''}</span>
                </div>
              </td>
              <td class="lb-pts">${u.points}</td>
              <td style="text-align:center"><span class="lb-exact">${u.exact} ✓</span></td>
              <td style="text-align:center"><span class="lb-winner">${u.winner} ≈</span></td>
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
  `;
}


// ── STATS ─────────────────────────────────────────
function renderStats() {
  // Calculate from match results
  let played = 0, goals = 0;
  MATCHES.forEach(m => {
    if (m.homeScore === null) return;
    played++;
    goals += m.homeScore + m.awayScore;
  });
  document.getElementById('statsPlayed').textContent = played;
  document.getElementById('statsGoals').textContent  = goals;
  document.getElementById('statsAvg').textContent    = played ? (goals / played).toFixed(2) : '–';

  // Top scorers from stats.json (manually maintained)
  const scorersEl = document.getElementById('topScorers');
  const assistsEl = document.getElementById('topAssists');

  if (STATS.topScorers && STATS.topScorers.length) {
    scorersEl.innerHTML = statsTable(STATS.topScorers, '⚽', 'Goals');
  }
  if (STATS.topAssists && STATS.topAssists.length) {
    assistsEl.innerHTML = statsTable(STATS.topAssists, '🎯', 'Assists');
  }
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
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      ${statusHtml}
    </div>
    <div class="tabs" id="adminTabs">
      <div class="tab active" data-tab="matches">Matches &amp; Results</div>
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

function renderAdminTab(tab) {
  if (tab === 'matches') renderAdminMatches();
  else if (tab === 'users') renderAdminUsers();
  else renderAdminSettings();
}

function renderAdminMatches() {
  const el = document.getElementById('adminTabContent');
  if (!el) return;
  const results = getAdminResults();
  const unlocks = getAdminUnlocks();
  const now     = Date.now();
  const byGroup = {};
  MATCHES.forEach(m => { if (!byGroup[m.group]) byGroup[m.group] = []; byGroup[m.group].push(m); });

  el.innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:var(--text2)">
      All times shown in <strong style="color:var(--gold)">Warsaw (CEST, UTC+2)</strong>.
      Predictions auto-lock <strong>2h before kickoff</strong>. Use 🔓/🔒 to override.
    </div>
    ${Object.entries(byGroup).sort().map(([grp, ms]) => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title">Group ${grp}</div>
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
            if (role === 'member')      roleActions += `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="setUserRole('${esc(name)}','admin')">Make Admin</button> `;
            else if (role === 'admin')  roleActions += `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="setUserRole('${esc(name)}','member')">Demote</button> `;
            if (role !== 'superuser')   roleActions += `<button class="btn btn-gold btn-sm" style="font-size:11px" onclick="designateSuperuser('${esc(name)}')">👑 Make SU</button> `;
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
    </table>`;
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
    <div class="card" style="max-width:400px;margin-top:16px">
      <div class="card-title">Change Admin Password</div>
      <input class="modal-input" id="newPwd1" type="password" placeholder="New password…" style="margin-bottom:10px">
      <input class="modal-input" id="newPwd2" type="password" placeholder="Confirm new password…" style="margin-bottom:10px">
      <div id="pwdChangeMsg" style="font-size:13px;margin-bottom:10px;display:none"></div>
      <button class="btn btn-primary btn-sm" onclick="changeAdminPwd()">Update Password</button>
    </div>`;
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
