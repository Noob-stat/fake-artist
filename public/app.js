(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const CATEGORY_NAMES = ['Animals', 'Food', 'Places', 'Objects', 'Nature', 'Jobs', 'Movies'];
  const REACTIONS = ['😂', '😮', '🔥', '👀', '😭', '🤔', '👏', '💀', '🎉', '🫠', '😅', '🧐'];

  // Only touch innerHTML when it actually changes, so CSS animations don't
  // restart on every incoming stroke update.
  function setHTML(el, html) {
    if (el.__last !== html) { el.__last = html; el.innerHTML = html; }
  }

  const initials = (name) => String(name || '?').trim().slice(0, 2).toUpperCase();
  const avatar = (p) => `<span class="avatar" style="background:${p.color}">${escapeHtml(initials(p.name))}</span>`;

  /* ------------------------------- identity -------------------------------- */
  let myId = sessionStorage.getItem('fa_id');
  if (!myId) {
    myId = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now() + Math.random().toString(36).slice(2));
    sessionStorage.setItem('fa_id', myId);
  }
  let myName = localStorage.getItem('fa_name') || '';

  /* -------------------------------- state ---------------------------------- */
  let ws = null;
  let connected = false;
  let S = null;
  let clockOffset = 0;
  let prevPhase = null;
  let prevRoundNo = -1;
  let prevMyTurn = false;
  let prevLobbyIds = [];

  const screens = {
    home: $('#scr-home'), lobby: $('#scr-lobby'), play: $('#scr-play'),
    vote: $('#scr-vote'), guess: $('#scr-guess'), reveal: $('#scr-reveal'),
  };

  function showScreen(key) {
    for (const k in screens) screens[k].classList.toggle('hidden', k !== key);
    $('#topbar').classList.toggle('hidden', key === 'home');
    const inGame = ['play', 'vote', 'guess', 'reveal'].includes(key);
    $('#reactionBar').classList.toggle('hidden', !inGame);
    document.body.classList.toggle('has-bar', inGame);
    if (key === 'play') requestAnimationFrame(fitCanvas);
  }

  const serverNow = () => Date.now() + clockOffset;

  /* --------------------------------- sound --------------------------------- */
  const Sound = (() => {
    let ctx = null;
    let enabled = localStorage.getItem('fa_sound') !== 'off';
    let volume = Math.max(0, Math.min(1, parseFloat(localStorage.getItem('fa_volume')) || 0.7));

    function ac() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, dur, type = 'sine', gain = 0.06, when = 0) {
      if (!enabled || volume <= 0) return;
      const c = ac(); if (!c) return;
      const t = c.currentTime + when;
      const g = c.createGain();
      const o = c.createOscillator();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.03);
    }
    function noise(dur, gain = 0.05, when = 0) {
      if (!enabled || volume <= 0) return;
      const c = ac(); if (!c) return;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
      const g = c.createGain(); g.gain.value = gain * volume;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(c.currentTime + when);
    }
    return {
      unlock() { ac(); },
      get enabled() { return enabled; },
      get volume() { return volume; },
      setEnabled(v) { enabled = v; localStorage.setItem('fa_sound', v ? 'on' : 'off'); if (v) tone(660, 0.09, 'triangle', 0.06); },
      toggle() { this.setEnabled(!enabled); return enabled; },
      setVolume(v) { volume = Math.max(0, Math.min(1, v)); localStorage.setItem('fa_volume', String(volume)); },
      tick() { tone(1250, 0.045, 'square', 0.045); },
      urgent() { tone(1600, 0.06, 'square', 0.08); },
      pop() { tone(520, 0.09, 'triangle', 0.06); tone(780, 0.09, 'triangle', 0.045, 0.07); },
      yourTurn() { tone(880, 0.12, 'sine', 0.07); tone(1318, 0.16, 'sine', 0.06, 0.1); },
      react() { tone(1050, 0.06, 'triangle', 0.05); tone(1400, 0.07, 'triangle', 0.04, 0.05); },
      join() { tone(600, 0.08, 'sine', 0.05); tone(900, 0.09, 'sine', 0.04, 0.06); },
      leave() { tone(500, 0.09, 'sine', 0.045); tone(340, 0.12, 'sine', 0.04, 0.07); },
      caught() { tone(180, 0.35, 'sawtooth', 0.07); tone(140, 0.4, 'sawtooth', 0.05, 0.08); },
      drumroll(dur = 1.4) {
        let t = 0, gap = 0.11;
        while (t < dur) { noise(0.055, 0.05, t); t += gap; gap *= 0.9; }
      },
      win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.07, i * 0.09)); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.24, 'sawtooth', 0.05, i * 0.13)); },
    };
  })();

  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {} }

  /* ------------------------------ motion pref ------------------------------ */
  let reduceMotion = localStorage.getItem('fa_motion') === 'reduce';
  function applyMotion() { document.body.classList.toggle('reduce-motion', reduceMotion); }

  /* ------------------------------ websocket -------------------------------- */
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function setConnected(v) {
    connected = v;
    $('#statusDot').classList.toggle('off', !v);
    $('#statusDot').title = v ? 'Connected' : 'Reconnecting…';
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      setConnected(true);
      const saved = sessionStorage.getItem('fa_room');
      if (saved && myName) send({ type: 'join', code: saved, name: myName, playerId: myId });
    };
    ws.onclose = () => { setConnected(false); setTimeout(connect, 1200); };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'state': S = msg; clockOffset = (msg.now || Date.now()) - Date.now(); render(); break;
        case 'reaction': showFloater(msg); break;
        case 'joined':
          myId = msg.playerId;
          sessionStorage.setItem('fa_id', myId);
          sessionStorage.setItem('fa_room', msg.code);
          try { history.replaceState(null, '', '?room=' + msg.code); } catch {}
          break;
        case 'error':
          if (S) toast(msg.message || 'Something went wrong.', true);
          else { $('#homeErr').textContent = msg.message || 'Something went wrong.'; sessionStorage.removeItem('fa_room'); }
          break;
        case 'kicked':
          sessionStorage.removeItem('fa_room'); S = null; prevPhase = null; goHome();
          toast(msg.message || 'You were removed.', true); break;
        case 'closed':
          sessionStorage.removeItem('fa_room'); S = null; prevPhase = null; goHome();
          toast(msg.message || 'The host closed the room.', true); break;
        default: break;
      }
    };
  }

  function goHome() { showScreen('home'); $('#homeErr').textContent = ''; }

  /* ------------------------------ settings form ---------------------------- */
  function settingsFormHTML() {
    return `
      <label class="field">
        <span>Category</span>
        <select data-set="category">
          <option value="random">🎲 Random</option>
          ${CATEGORY_NAMES.map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </label>

      <details class="adv" style="margin-bottom:10px">
        <summary>✍️ Custom words (optional)</summary>
        <label class="field">
          <span>Your words — comma or new line separated</span>
          <textarea data-set="customWords" rows="3" placeholder="pizza, your dog, the moon, homework"></textarea>
        </label>
        <label class="field">
          <span>Hint shown to the Fake (optional)</span>
          <input data-set="customHint" maxlength="30" placeholder="e.g. Things in our kitchen" />
        </label>
      </details>

      <div class="two">
        <label class="field"><span>Fakes</span>
          <select data-set="fakes"><option value="1">1 fake</option><option value="2">2 fakes</option></select>
        </label>
        <label class="field"><span>Lines each</span>
          <select data-set="rounds"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
        </label>
        <label class="field"><span>Turn timer</span>
          <select data-set="turnTime">
            <option value="0">Off</option><option value="20">20s</option><option value="30">30s</option>
            <option value="45">45s</option><option value="60">60s</option><option value="90">90s</option>
          </select>
        </label>
      </div>

      <label class="field"><span>Vote timer</span>
        <select data-set="voteTime">
          <option value="0">Off</option><option value="30">30s</option>
          <option value="45">45s</option><option value="60">60s</option>
        </select>
      </label>

      <label class="check"><input type="checkbox" data-set="fakesKnowEachOther" /> Fakes know each other</label>
    `;
  }

  function readSettings(root, out = {}) {
    root.querySelectorAll('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') out[k] = el.checked;
      else if (k === 'customWords') out[k] = el.value;
      else if (['rounds', 'fakes', 'turnTime', 'voteTime'].includes(k)) out[k] = parseInt(el.value, 10);
      else out[k] = el.value;
    });
    return out;
  }

  function applySettings(root, s, force) {
    if (!s) return;
    if (!force && root.contains(document.activeElement)) return;
    root.querySelectorAll('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else if (k === 'customWords') el.value = (s.customWords || []).join('\n');
      else if (s[k] !== undefined && s[k] !== null) el.value = String(s[k]);
    });
  }

  function saveHomeSettings() {
    try { localStorage.setItem('fa_settings', JSON.stringify(readSettings($('#homeSettings')))); } catch {}
  }

  const summaryOf = (s) => {
    if (!s) return '';
    const bits = [`${s.fakes} fake${s.fakes > 1 ? 's' : ''}`];
    bits.push(`${s.rounds} line${s.rounds > 1 ? 's' : ''} each`);
    bits.push(s.turnTime ? `${s.turnTime}s turns` : 'no turn timer');
    bits.push(s.voteTime ? `${s.voteTime}s votes` : 'no vote timer');
    if (s.customWords && s.customWords.length) bits.push(`${s.customWords.length} custom words`);
    else bits.push(s.category === 'random' ? 'random category' : s.category);
    return bits.join(' · ');
  };

  /* -------------------------------- render --------------------------------- */
  function render() {
    if (!S) { goHome(); return; }

    if (S.phase !== prevPhase) {
      if (S.phase === 'drawing') Sound.pop();
      else if (S.phase === 'guess') Sound.drumroll(1.4);
      else if (S.phase === 'voting') Sound.pop();
      else if (S.phase === 'reveal') {
        if (S.outcome === 'fake_caught') { Sound.win(); if (!reduceMotion) burstConfetti(70); }
        else if (S.you.isFake) { Sound.win(); if (!reduceMotion) burstConfetti(60); }
        else Sound.lose();
      }
    }
    if (S.roundNo !== prevRoundNo) { prevRoundNo = S.roundNo; if (S.phase === 'drawing') Sound.join(); }
    prevPhase = S.phase;

    switch (S.phase) {
      case 'lobby': showScreen('lobby'); renderLobby(); break;
      case 'drawing': showScreen('play'); renderPlay(); break;
      case 'voting': showScreen('vote'); renderVote(); break;
      case 'guess': showScreen('guess'); renderGuess(); break;
      case 'reveal': showScreen('reveal'); renderReveal(); break;
      default: goHome();
    }

    const myTurn = S.phase === 'drawing' && S.turnPlayerId === myId;
    if (myTurn && !prevMyTurn) { Sound.yourTurn(); buzz(45); }
    prevMyTurn = myTurn;
  }

  function playerRow(p, extra) {
    return `<li>
      ${avatar(p)}
      <span class="pname">${escapeHtml(p.name)}${p.isHost ? ' <em>host</em>' : ''}</span>
      <span class="muted">${extra || ''}</span>
    </li>`;
  }

  function renderLobby() {
    $('#lobbyCode').textContent = S.code;
    $('#codeChip').textContent = S.code;
    $('#lobbyCount').textContent = `(${S.players.length}/${S.maxPlayers})`;

    const ids = S.players.map((p) => p.id);
    if (prevLobbyIds.length !== ids.length) {
      const joined = ids.filter((id) => !prevLobbyIds.includes(id));
      const left = prevLobbyIds.filter((id) => !ids.includes(id));
      if (joined.length && prevLobbyIds.length) Sound.join();
      if (left.length) Sound.leave();
    }
    prevLobbyIds = ids;

    const iAmHost = S.you.isHost;
    setHTML($('#lobbyPlayers'), S.players.map((p) => {
      const kickBtn = (iAmHost && p.id !== myId)
        ? `<button class="kick" data-kick="${p.id}" title="Remove">✕</button>` : '';
      return `<li>
        ${avatar(p)}
        <span class="pname">${escapeHtml(p.name)}${p.isHost ? ' <em>host</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}</span>
        ${kickBtn}
      </li>`;
    }).join(''));

    const scored = S.players.some((p) => p.score > 0) || S.roundNo > 0;
    $('#lobbyLeaderboard').classList.toggle('hidden', !scored);
    $('#resetBtn').classList.toggle('hidden', !(iAmHost && scored));
    setHTML($('#lobbyScores'), S.players.slice().sort((a, b) => b.score - a.score)
      .map((p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}</span>
        <span class="muted">${p.roundsWon ? p.roundsWon + '★' : ''}</span><b>${p.score}</b></li>`).join(''));

    $('#hostControls').classList.toggle('hidden', !iAmHost);
    if (iAmHost) {
      applySettings($('#lobbySettings'), S.settings, false);
      const warn = (S.settings.fakes > S.maxFakes)
        ? `  ⚠️ 2 fakes needs 4+ players — will use ${S.maxFakes}.` : '';
      $('#settingsSummary').textContent = summaryOf(S.settings) + warn;
    }

    const n = S.connectedCount;
    const enough = n >= S.minPlayers;
    $('#startBtn').disabled = !enough;
    $('#lobbyMsg').textContent = !enough
      ? `Need at least ${S.minPlayers} players — share the code!`
      : (iAmHost ? 'Everyone in? Start when ready.' : 'Waiting for the host to start…');

    $('#lobbyPlayers').querySelectorAll('[data-kick]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = S.players.find((x) => x.id === b.dataset.kick);
        if (p && confirm(`Remove ${p.name} from the room?`)) send({ type: 'kick', playerId: p.id });
      });
    });
  }

  let lastTurnKey = '';
  let lastRoleKey = '';
  let lastRevealKey = '';

  function renderPlay() {
    const isMyTurn = S.turnPlayerId === myId;
    const total = S.order.length * S.totalRounds;
    const idx = S.order.indexOf(S.turnPlayerId);
    const strokeNo = idx >= 0 ? (S.round - 1) * S.order.length + idx + 1 : total;

    const turnKey = `${S.round}:${S.turnPlayerId}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      myStroke = []; sendBuf = []; drawing = false; drewThisTurn = false;
    }

    const banner = $('#roleBanner');
    const roleKey = `${S.roundNo}:${S.you.isFake}:${S.category}:${(S.you.fellowFakes || []).join(',')}`;
    const roleChanged = roleKey !== lastRoleKey;
    lastRoleKey = roleKey;
    if (S.you.isFake) {
      let mates = '';
      if (S.you.fellowFakes && S.you.fellowFakes.length) {
        const names = S.you.fellowFakes.map((id) => {
          const p = S.players.find((x) => x.id === id); return p ? p.name : '?';
        }).join(', ');
        mates = `<br><span class="muted">Fellow fake: ${escapeHtml(names)}</span>`;
      }
      banner.className = 'banner fake' + (roleChanged ? ' animate-pop' : '');
      setHTML(banner, `<b>You are the FAKE 🕵️</b><br>Category: <b>${escapeHtml(S.category)}</b>${mates}<br>
        You don't know the word. Blend in.`);
    } else {
      banner.className = 'banner artist' + (roleChanged ? ' animate-pop' : '');
      setHTML(banner, `<b>Your word: ${escapeHtml(S.word)}</b><br>Category: ${escapeHtml(S.category)}<br>
        Draw one line. Don't give it away.`);
    }

    const turnPlayer = S.players.find((p) => p.id === S.turnPlayerId);
    setHTML($('#turnText'), isMyTurn
      ? '<span style="color:var(--accent)">Your turn — draw one line</span>'
      : (turnPlayer ? `${avatar(turnPlayer)} ${escapeHtml(turnPlayer.name)}'s turn` : ''));

    setHTML($('#progressText'), `Stroke ${strokeNo} / ${total}`);
    $('#doneBtn').classList.toggle('hidden', !isMyTurn);

    setHTML($('#playPlayers'), S.players.slice().sort((a, b) => b.score - a.score)
      .map((p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}</span><b>${p.score}</b></li>`).join(''));

    requestAnimationFrame(() => { fitCanvas(); drawAll(); });
  }

  function renderVote() {
    const voted = S.you.votedFor;
    setHTML($('#voteList'), S.players.map((p) => {
      if (p.id === myId) return '';
      const cls = voted ? (voted === p.id ? 'voted' : 'dim') : '';
      return `<li class="${cls}">
        <button class="voteBtn" data-id="${p.id}" ${voted ? 'disabled' : ''}>
          ${avatar(p)} ${escapeHtml(p.name)}${p.connected ? '' : ' <em>offline</em>'}
        </button></li>`;
    }).join(''));

    $('#voteHint').textContent = `Tap whoever you think is faking it. (${Object.keys(S.votes).length}/${S.connectedCount} votes in)`;
    $('#voteMsg').textContent = voted ? 'Vote locked in. Waiting for everyone…' : '';
    $('#voteList').querySelectorAll('.voteBtn').forEach((btn) => {
      btn.addEventListener('click', () => { Sound.react(); send({ type: 'vote', targetId: btn.dataset.id }); });
    });
  }

  function renderGuess() {
    const iAmCaught = S.you.id === S.caughtFakeId;
    const caught = S.players.find((p) => p.id === S.caughtFakeId);
    $('#guessTitle').textContent = caught ? `${caught.name} was caught!` : 'Caught!';
    $('#guessBox').classList.toggle('hidden', !iAmCaught);
    $('#guessWait').classList.toggle('hidden', iAmCaught);
    if (!iAmCaught) $('#guessWait').textContent = 'The Fake gets one guess at the word…';
    else $('#guessInput').focus();
  }

  function renderReveal() {
    const fakes = (S.fakeIds || []).map((id) => S.players.find((p) => p.id === id)).filter(Boolean);
    const fakeNames = fakes.map((p) => escapeHtml(p.name)).join(' & ') || 'The Fake';
    const label = fakes.length > 1 ? 'Fakes' : 'Fake';

    const banners = {
      fake_caught: `🎉 Artists win! <b>${fakeNames}</b> got caught and missed the guess.`,
      fake_guessed: `🕵️ ${label} win! <b>${fakeNames}</b> was caught… but guessed the word.`,
      fake_escaped: `😈 ${label} escape! <b>${fakeNames}</b> fooled everyone.`,
    };
    const b = $('#revealBanner');
    const revealKey = `${S.roundNo}:${S.outcome}:${(S.fakeIds || []).join(',')}`;
    const revealChanged = revealKey !== lastRevealKey;
    lastRevealKey = revealKey;
    b.className = 'banner ' + (revealChanged ? 'animate-pop ' : '') + (S.outcome === 'fake_caught' ? 'artist' : 'fake');
    setHTML(b, banners[S.outcome] || 'Round over.');

    setHTML($('#wordReveal'), `<span class="muted">The word was</span><br><b>${escapeHtml(S.word || '')}</b>` +
      (S.guessText ? `<br><span class="muted small">${label} guessed: “${escapeHtml(S.guessText)}”</span>` : ''));

    setHTML($('#scoreList'), S.players.slice().sort((a, b2) => b2.score - a.score)
      .map((p) => `<li>${avatar(p)}<span class="pname">${escapeHtml(p.name)}${S.fakeIds.includes(p.id) ? ' 🕵️' : ''}</span>
        <span class="muted">${p.roundsWon ? p.roundsWon + '★' : ''}</span><b>${p.score}</b></li>`).join(''));

    const iAmHost = S.you.isHost;
    $('#hostReveal').classList.toggle('hidden', !iAmHost);
    $('#againWait').classList.toggle('hidden', iAmHost);
  }

  /* -------------------------------- canvas --------------------------------- */
  const canvas = $('#board');
  const ctx = canvas.getContext('2d');
  let CW = 0, CH = 0;
  let myStroke = [], sendBuf = [], drawing = false, drewThisTurn = false, flushTimer = null;

  const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const canDraw = () => S && S.phase === 'drawing' && S.turnPlayerId === myId;

  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    CW = rect.width; CH = rect.height;
    canvas.width = Math.round(CW * dpr);
    canvas.height = Math.round(CH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAll();
  }

  function pathStroke(points, color, lw) {
    if (!points || !points.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw;
    if (points.length === 1) {
      ctx.beginPath(); ctx.arc(points[0].x * CW, points[0].y * CH, lw / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x * CW, points[0].y * CH);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * CW, points[i].y * CH);
    ctx.stroke();
  }

  function drawAll() {
    ctx.clearRect(0, 0, CW, CH);
    const lw = Math.max(2.5, CW * 0.007);
    const strokes = (S && S.strokes) || [];
    for (const st of strokes) {
      if (st.playerId === myId && st.inProgress && myStroke.length) continue;
      pathStroke(st.points, st.color, lw);
    }
    if (myStroke.length) pathStroke(myStroke, (S && S.you.color) || '#000', lw);
  }

  function addPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const pt = { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
    myStroke.push(pt); sendBuf.push(pt); drawAll();
  }

  function flush(final) {
    if (sendBuf.length) { send({ type: 'stroke', points: sendBuf }); sendBuf = []; }
    if (final && flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  }

  function endDraw() { if (!drawing) return; drawing = false; flush(true); drewThisTurn = true; }

  canvas.addEventListener('pointerdown', (e) => {
    Sound.unlock();
    if (!canDraw() || drewThisTurn) return;
    e.preventDefault();
    drawing = true; myStroke = []; sendBuf = [];
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    addPoint(e);
    if (!flushTimer) flushTimer = setInterval(() => flush(false), 40);
  });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); addPoint(e); });
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  window.addEventListener('resize', () => { if (S && S.phase === 'drawing') fitCanvas(); });

  /* --------------------------------- timers -------------------------------- */
  let lastTickSec = -1;
  let lastVoteSec = -1;
  setInterval(() => {
    const el = $('#timerText');
    if (!el) return;
    if (!S || S.phase !== 'drawing' || !S.turnEndsAt) { el.textContent = ''; el.className = 'timer'; lastTickSec = -1; }
    else {
      const remaining = Math.max(0, S.turnEndsAt - serverNow());
      const sec = Math.ceil(remaining / 1000);
      el.textContent = `⏱ ${sec}s`;
      el.className = 'timer' + (remaining <= 3000 ? ' danger' : remaining <= 5000 ? ' warn' : '');
      if (remaining <= 5000) {
        if (sec !== lastTickSec) { lastTickSec = sec; remaining <= 3000 ? Sound.urgent() : Sound.tick(); }
      } else lastTickSec = -1;
    }

    const vt = $('#voteTimerText');
    if (vt) {
      if (!S || S.phase !== 'voting' || !S.voteEndsAt) { vt.textContent = ''; vt.className = 'timer'; lastVoteSec = -1; }
      else {
        const remaining = Math.max(0, S.voteEndsAt - serverNow());
        const sec = Math.ceil(remaining / 1000);
        vt.textContent = `⏱ ${sec}s`;
        vt.className = 'timer' + (remaining <= 5000 ? ' warn' : '');
        if (remaining <= 10000 && sec !== lastVoteSec) { lastVoteSec = sec; Sound.tick(); }
      }
    }
  }, 200);

  /* ------------------------------- reactions ------------------------------- */
  function buildReactionBar() {
    $('#reactionBar').innerHTML = REACTIONS
      .map((e) => `<button data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('');
    $('#reactionBar').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        Sound.unlock();
        send({ type: 'reaction', emoji: b.dataset.emoji });
        buzz(12);
      });
    });
  }

  function showFloater(msg) {
    if (reduceMotion) { Sound.react(); return; }
    const host = $('#floaters');
    const el = document.createElement('div');
    el.className = 'floater';
    el.style.left = (8 + Math.random() * 74) + '%';
    el.innerHTML = `<em>${escapeHtml(msg.emoji)}</em><small style="color:${msg.color}">${escapeHtml(msg.name)}</small>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2900);
    Sound.react();
    if (msg.playerId !== myId) buzz(8);
  }

  /* ------------------------------- confetti -------------------------------- */
  function burstConfetti(n) {
    const host = $('#confetti');
    const colors = ['#6c8cff', '#b06cff', '#f5a524', '#30a46c', '#e5484d', '#12a594'];
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.style.left = Math.random() * 100 + 'vw';
      s.style.background = colors[Math.floor(Math.random() * colors.length)];
      s.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
      s.style.animationDelay = (Math.random() * 0.4) + 's';
      s.style.transform = `rotate(${Math.random() * 360}deg)`;
      host.appendChild(s);
      setTimeout(() => s.remove(), 3400);
    }
  }

  function toast(text, bad) {
    const el = document.createElement('div');
    el.className = 'banner ' + (bad ? 'fake' : 'artist') + ' animate-pop';
    el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:95;max-width:90%;width:max-content;';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  /* ------------------------------ menu modal ------------------------------- */
  function openMenu() {
    $('#menuModal').classList.remove('hidden');
    $('#modalSoundToggle').textContent = Sound.enabled ? 'On' : 'Off';
    $('#volumeSlider').value = Math.round(Sound.volume * 100);
    $('#motionToggle').textContent = reduceMotion ? 'On' : 'Off';
  }
  function closeMenu() { $('#menuModal').classList.add('hidden'); }

  /* --------------------------------- events -------------------------------- */
  function saveName() {
    const n = $('#nameInput').value.trim();
    if (!n) { $('#homeErr').textContent = 'Enter a name first.'; return null; }
    myName = n; localStorage.setItem('fa_name', n); $('#homeErr').textContent = '';
    return n;
  }

  $('#createBtn').addEventListener('click', () => {
    Sound.unlock();
    const n = saveName(); if (!n) return;
    saveHomeSettings();
    send({ type: 'create', name: n, playerId: myId, settings: readSettings($('#homeSettings')) });
  });

  $('#joinBtn').addEventListener('click', () => {
    Sound.unlock();
    const n = saveName(); if (!n) return;
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!code) { $('#homeErr').textContent = 'Enter a room code.'; return; }
    send({ type: 'join', code, name: n, playerId: myId });
  });

  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#createBtn').click(); });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#guessInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#guessBtn').click(); });

  $('#homeSettings').addEventListener('change', saveHomeSettings);
  $('#homeSettings').addEventListener('input', saveHomeSettings);

  $('#soundBtn').addEventListener('click', () => { Sound.unlock(); updateSoundIcon(Sound.toggle()); });
  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuClose').addEventListener('click', closeMenu);
  $('#menuModal').addEventListener('click', (e) => { if (e.target === $('#menuModal')) closeMenu(); });
  $('#homeRules').addEventListener('click', openMenu);

  $('#modalSoundToggle').addEventListener('click', (e) => {
    const on = Sound.toggle(); e.target.textContent = on ? 'On' : 'Off'; updateSoundIcon(on);
  });
  $('#volumeSlider').addEventListener('input', (e) => Sound.setVolume(parseInt(e.target.value, 10) / 100));
  $('#motionToggle').addEventListener('click', (e) => {
    reduceMotion = !reduceMotion;
    localStorage.setItem('fa_motion', reduceMotion ? 'reduce' : 'auto');
    applyMotion();
    e.target.textContent = reduceMotion ? 'On' : 'Off';
  });

  $('#codeChip').addEventListener('click', async () => {
    if (!S) return;
    try { await navigator.clipboard.writeText(S.code); toast('Room code copied'); } catch {}
  });

  $('#leaveBtn').addEventListener('click', () => {
    if (!confirm('Leave the room?')) return;
    send({ type: 'leave' });
    sessionStorage.removeItem('fa_room');
    S = null; prevPhase = null; prevLobbyIds = [];
    goHome();
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${S.code}`;
    const text = `Play Fake Artist with me! Code: ${S.code}\n${url}`;
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(url);
      $('#shareBtn').textContent = 'Link copied!';
      setTimeout(() => { $('#shareBtn').textContent = 'Copy invite link'; }, 1500);
    } catch {}
  });

  let settingsDebounce = null;
  const pushSettings = () => {
    clearTimeout(settingsDebounce);
    settingsDebounce = setTimeout(() => send({ type: 'settings', settings: readSettings($('#lobbySettings')) }), 140);
  };
  $('#lobbySettings').addEventListener('change', pushSettings);
  $('#lobbySettings').addEventListener('input', pushSettings);

  $('#startBtn').addEventListener('click', () => send({ type: 'start', settings: readSettings($('#lobbySettings')) }));
  $('#disbandBtn').addEventListener('click', () => { if (confirm('Close the room for everyone?')) send({ type: 'disband' }); });
  $('#resetBtn').addEventListener('click', () => { if (confirm('Reset all scores?')) send({ type: 'resetScores' }); });
  $('#doneBtn').addEventListener('click', () => send({ type: 'endTurn' }));
  $('#nextBtn').addEventListener('click', () => send({ type: 'nextRound' }));
  $('#toLobbyBtn').addEventListener('click', () => send({ type: 'toLobby' }));
  $('#guessBtn').addEventListener('click', () => { const t = $('#guessInput').value.trim(); if (t) send({ type: 'guess', text: t }); });

  function updateSoundIcon(on) { $('#soundBtn').textContent = on ? '🔊' : '🔇'; }

  /* ------------------------------ PWA + install ---------------------------- */
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#installRow').style.display = 'flex';
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch {}
    deferredInstall = null;
    $('#installRow').style.display = 'none';
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  /* --------------------------------- boot ---------------------------------- */
  $('#homeSettings').innerHTML = settingsFormHTML();
  $('#lobbySettings').innerHTML = settingsFormHTML();
  buildReactionBar();
  applyMotion();
  updateSoundIcon(Sound.enabled);

  const defaults = { category: 'random', rounds: 2, fakes: 1, turnTime: 0, voteTime: 0, fakesKnowEachOther: false, customWords: [], customHint: '' };
  let saved = defaults;
  try {
    const raw = localStorage.getItem('fa_settings');
    if (raw) saved = Object.assign({}, defaults, JSON.parse(raw));
  } catch {}
  applySettings($('#homeSettings'), saved, true);

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#codeInput').value = urlRoom.toUpperCase().trim();
  $('#nameInput').value = myName;

  // unlock audio on the very first interaction (browser autoplay policy)
  const unlock = () => { Sound.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  showScreen('home');
  connect();
})();
