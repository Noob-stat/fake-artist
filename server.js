'use strict';

/*
 * Fake Artist - realtime party game server.
 * One room code, everyone on their own phone or PC, zero install, zero cost.
 * Node + ws only. Deployable anywhere that runs Node (PORT env respected).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_CUSTOM_WORDS = 80;

/* ------------------------------- game content ------------------------------ */

const CATEGORIES = {
  Animals: ['elephant', 'penguin', 'octopus', 'giraffe', 'hedgehog', 'butterfly', 'kangaroo', 'dolphin', 'squirrel', 'crocodile', 'owl', 'snail', 'shark', 'rabbit', 'camel', 'flamingo', 'turtle', 'bee', 'fox', 'panda'],
  Food: ['pizza', 'sushi', 'taco', 'pancake', 'watermelon', 'spaghetti', 'donut', 'popcorn', 'burger', 'ice cream', 'soup', 'sandwich', 'banana', 'cheese', 'carrot', 'cupcake', 'pasta', 'strawberry', 'coffee', 'fries'],
  Places: ['lighthouse', 'castle', 'volcano', 'beach', 'airport', 'hospital', 'library', 'stadium', 'desert', 'island', 'bridge', 'farm', 'museum', 'zoo', 'campsite', 'subway', 'park', 'hotel', 'mall', 'harbour'],
  Objects: ['umbrella', 'guitar', 'telescope', 'typewriter', 'hourglass', 'anchor', 'backpack', 'camera', 'lantern', 'compass', 'kite', 'robot', 'mirror', 'key', 'clock', 'scissors', 'balloon', 'ladder', 'candle', 'crown'],
  Nature: ['rainbow', 'mountain', 'waterfall', 'cactus', 'lightning', 'tornado', 'sunflower', 'glacier', 'cave', 'river', 'forest', 'cloud', 'mushroom', 'canyon', 'star', 'moon', 'bamboo', 'coral', 'snowflake', 'island'],
  Jobs: ['astronaut', 'firefighter', 'chef', 'doctor', 'pirate', 'wizard', 'detective', 'farmer', 'diver', 'knight', 'clown', 'pilot', 'scientist', 'barber', 'ninja', 'artist', 'judge', 'magician', 'postman', 'viking'],
  Movies: ['titanic', 'jaws', 'avatar', 'inception', 'frozen', 'godzilla', 'rocky', 'grease', 'shrek', 'alien', 'barbie', 'gladiator', 'matrix', 'up', 'cars', 'elf', 'psycho', 'ratatouille'],
};

const COLORS = ['#e5484d', '#0090ff', '#f5a524', '#30a46c', '#8e4ec6', '#e93d82', '#12a594', '#9a6b3f', '#575ad6', '#c8482a'];

/* --------------------------------- helpers --------------------------------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';

function cleanWords(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(/[\n,;]+/);
  const out = [];
  for (let w of arr) {
    w = String(w).replace(/[<>]/g, '').trim().slice(0, 40);
    if (!w) continue;
    const key = normalize(w);
    if (!key || out.some((x) => normalize(x) === key)) continue;
    out.push(w);
    if (out.length >= MAX_CUSTOM_WORDS) break;
  }
  return out;
}

/* ---------------------------------- rooms ---------------------------------- */

function defaultSettings() {
  return {
    category: 'random',
    rounds: 2,
    fakes: 1,
    turnTime: 0,          // seconds per turn; 0 = off
    voteTime: 0,          // seconds to vote; 0 = off (auto-fills missing votes)
    fakesKnowEachOther: false,
    customWords: [],
    customHint: '',
  };
}

const REACTIONS = ['😂', '😮', '🔥', '👀', '😭', '🤔', '👏', '💀', '🎉', '🫠', '😅', '🧐'];
const REACTION_COOLDOWN = 650; // ms per player

const rooms = new Map();

function createRoom() {
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  const room = {
    code,
    players: new Map(),
    banned: new Set(),
    hostId: null,
    phase: 'lobby',
    settings: defaultSettings(),
    order: [],
    turnIndex: 0,
    round: 1,
    totalRounds: 2,
    roundNo: 0,
    strokes: [],
    votes: {},
    word: null,
    category: null,
    fakeIds: [],
    caughtFakeId: null,
    outcome: null,
    guessText: null,
    turnEndsAt: 0,
    voteEndsAt: 0,
    lastReaction: {},
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function ensureHost(room) {
  const list = [...room.players.values()];
  if (!list.length) { room.hostId = null; return; }
  if (room.hostId && list.some((p) => p.id === room.hostId)) return;
  const fallback = list.find((p) => p.connected) || list[0];
  room.hostId = fallback.id;
  list.forEach((p) => { p.isHost = p.id === room.hostId; });
}

function addPlayer(room, id, rawName) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || pick(COLORS);
  const player = {
    id,
    name: cleanName(rawName),
    color,
    score: 0,
    roundsWon: 0,
    connected: true,
    isHost: room.players.size === 0,
    socket: null,
  };
  room.players.set(id, player);
  if (player.isHost) room.hostId = id;
  ensureHost(room);
  return player;
}

function removePlayer(room, id) {
  room.players.delete(id);
  delete room.votes[id];
  Object.keys(room.votes).forEach((k) => { if (room.votes[k] === id) delete room.votes[k]; });
  room.order = room.order.filter((x) => x !== id);
  if (room.fakeIds) room.fakeIds = room.fakeIds.filter((x) => x !== id);
  ensureHost(room);
}

function tally(room) {
  const t = {};
  for (const target of Object.values(room.votes)) t[target] = (t[target] || 0) + 1;
  return t;
}

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
const connectedCount = (room) => connectedPlayers(room).length;
const maxFakesFor = (n) => Math.max(1, Math.min(2, n - 2));

/* -------------------------------- game flow -------------------------------- */

function resolveWord(room) {
  const s = room.settings;
  if (s.customWords && s.customWords.length) {
    room.word = pick(s.customWords);
    room.category = (s.customHint && s.customHint.trim()) ? s.customHint.trim().slice(0, 30) : 'Custom words';
  } else {
    const names = Object.keys(CATEGORIES);
    room.category = (s.category && s.category !== 'random' && CATEGORIES[s.category]) ? s.category : pick(names);
    room.word = pick(CATEGORIES[room.category]);
  }
}

function armTurn(room) {
  if (room.phase === 'drawing' && room.settings.turnTime > 0) {
    room.turnEndsAt = Date.now() + room.settings.turnTime * 1000;
  } else {
    room.turnEndsAt = 0;
  }
}

function armVote(room) {
  if (room.phase === 'voting' && room.settings.voteTime > 0) {
    room.voteEndsAt = Date.now() + room.settings.voteTime * 1000;
  } else {
    room.voteEndsAt = 0;
  }
}

function startRound(room, opts = {}) {
  const active = connectedPlayers(room);
  if (active.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players.` };
  if (opts.resetScores) room.players.forEach((p) => { p.score = 0; p.roundsWon = 0; });

  const s = room.settings;
  room.totalRounds = Math.min(3, Math.max(1, parseInt(s.rounds, 10) || 2));

  const fakeCount = Math.max(1, Math.min(parseInt(s.fakes, 10) || 1, maxFakesFor(active.length)));
  const shuffled = shuffle(active.map((p) => p.id));
  room.fakeIds = shuffled.slice(0, fakeCount);

  resolveWord(room);

  room.order = shuffle(active.map((p) => p.id));
  room.turnIndex = 0;
  room.round = 1;
  room.roundNo += 1;
  room.strokes = [];
  room.votes = {};
  room.outcome = null;
  room.guessText = null;
  room.caughtFakeId = null;
  room.voteEndsAt = 0;
  room.phase = 'drawing';
  ensureActiveTurn(room);
  armTurn(room);
  return {};
}

function advanceTurn(room, guard = 0) {
  if (guard > 1000) return;
  room.turnIndex++;
  if (room.turnIndex >= room.order.length) {
    room.turnIndex = 0;
    room.round++;
    if (room.round > room.totalRounds) { room.phase = 'voting'; room.turnEndsAt = 0; armVote(room); return; }
  }
  const cur = room.players.get(room.order[room.turnIndex]);
  if (!cur || !cur.connected) advanceTurn(room, guard + 1);
}

function ensureActiveTurn(room) {
  if (room.phase !== 'drawing') return;
  const cur = room.players.get(room.order[room.turnIndex]);
  if (cur && cur.connected) return;
  advanceTurn(room);
}

function finishTurn(room) {
  if (room.phase !== 'drawing') return;
  const last = room.strokes[room.strokes.length - 1];
  if (last && last.inProgress) last.inProgress = false;
  advanceTurn(room);
  ensureActiveTurn(room);
  armTurn(room);
}

function resolveVotes(room) {
  const t = tally(room);
  let top = null, topN = -1, tie = false;
  for (const [id, n] of Object.entries(t)) {
    if (n > topN) { top = id; topN = n; tie = false; }
    else if (n === topN) { tie = true; }
  }
  const caught = !tie && topN > 0 && room.fakeIds.includes(top);
  room.turnEndsAt = 0;
  room.voteEndsAt = 0;
  if (caught) {
    room.caughtFakeId = top;
    room.phase = 'guess';
  } else {
    room.outcome = 'fake_escaped';
    room.fakeIds.forEach((id) => {
      const f = room.players.get(id);
      if (f) { f.score += 2; f.roundsWon += 1; }
    });
    room.phase = 'reveal';
  }
}

function autoVote(room) {
  const connected = connectedPlayers(room);
  for (const p of connected) {
    if (room.votes[p.id]) continue;
    const others = connected.filter((x) => x.id !== p.id);
    if (others.length) room.votes[p.id] = pick(others).id;
  }
}

function submitGuess(room, text) {
  room.guessText = String(text || '').trim().slice(0, 40);
  const fake = room.players.get(room.caughtFakeId);
  if (normalize(room.guessText) === normalize(room.word)) {
    room.outcome = 'fake_guessed';
    if (fake) { fake.score += 2; fake.roundsWon += 1; }
  } else {
    room.outcome = 'fake_caught';
    room.players.forEach((p) => {
      if (!room.fakeIds.includes(p.id)) { p.score += 1; p.roundsWon += 1; }
    });
  }
  room.phase = 'reveal';
}

/* --------------------------------- messages -------------------------------- */

function stateFor(room, viewerId) {
  const you = room.players.get(viewerId);
  const inGame = room.phase !== 'lobby';
  const isFake = inGame && room.fakeIds.includes(viewerId);
  const showWord = inGame && (!isFake || room.phase === 'reveal');
  const revealFakes = room.phase === 'reveal';
  const showCaught = room.phase === 'guess' || room.phase === 'reveal';

  const fellowFakes = (isFake && room.settings.fakesKnowEachOther && !revealFakes)
    ? room.fakeIds.filter((x) => x !== viewerId)
    : [];

  return {
    type: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
      roundsWon: p.roundsWon, connected: p.connected, isHost: p.id === room.hostId,
    })),
    order: room.order,
    turnPlayerId: room.phase === 'drawing' ? (room.order[room.turnIndex] || null) : null,
    turnEndsAt: room.phase === 'drawing' ? room.turnEndsAt : 0,
    voteEndsAt: room.phase === 'voting' ? room.voteEndsAt : 0,
    round: room.round,
    roundNo: room.roundNo,
    totalRounds: room.totalRounds,
    strokes: room.strokes,
    votes: room.votes,
    category: room.category,
    word: showWord ? room.word : null,
    fakeIds: revealFakes ? room.fakeIds : [],
    caughtFakeId: showCaught ? room.caughtFakeId : null,
    outcome: room.outcome,
    guessText: room.guessText,
    tally: tally(room),
    settings: room.settings,
    categories: Object.keys(CATEGORIES),
    you: {
      id: viewerId,
      isFake,
      isHost: !!(you && you.isHost),
      color: you ? you.color : null,
      votedFor: room.votes[viewerId] || null,
      fellowFakes,
    },
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    connectedCount: connectedCount(room),
    maxFakes: maxFakesFor(Math.max(MIN_PLAYERS, connectedCount(room))),
  };
}

function sendJSON(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (p.connected && p.socket) sendJSON(p.socket, stateFor(room, p.id));
  }
}

/* -------------------------------- websockets ------------------------------- */

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = { roomCode: null, playerId: null };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handleMessage(ws, msg); } catch (err) { console.error('message error', err); }
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

function roomOf(ws) {
  const meta = ws.meta || {};
  const room = rooms.get(meta.roomCode);
  if (!room) return null;
  const player = room.players.get(meta.playerId);
  if (!player || player.socket !== ws) return null;
  return room;
}

const isHostOf = (room, ws) => room && room.hostId === ws.meta.playerId;

function sanitizeSettings(patch, room) {
  const s = room.settings;
  if (!patch || typeof patch !== 'object') return;
  if (typeof patch.category === 'string') {
    s.category = (patch.category === 'random' || CATEGORIES[patch.category]) ? patch.category : s.category;
  }
  if (patch.rounds !== undefined) s.rounds = Math.min(3, Math.max(1, parseInt(patch.rounds, 10) || 1));
  if (patch.fakes !== undefined) s.fakes = Math.min(2, Math.max(1, parseInt(patch.fakes, 10) || 1));
  if (patch.turnTime !== undefined) {
    const t = parseInt(patch.turnTime, 10) || 0;
    s.turnTime = [0, 20, 30, 45, 60, 90, 120].includes(t) ? t : (t > 0 ? Math.min(300, t) : 0);
  }
  if (patch.voteTime !== undefined) {
    const t = parseInt(patch.voteTime, 10) || 0;
    s.voteTime = [0, 20, 30, 45, 60].includes(t) ? t : (t > 0 ? Math.min(180, t) : 0);
  }
  if (typeof patch.fakesKnowEachOther === 'boolean') s.fakesKnowEachOther = patch.fakesKnowEachOther;
  if (patch.customWords !== undefined) s.customWords = cleanWords(patch.customWords);
  if (typeof patch.customHint === 'string') s.customHint = patch.customHint.replace(/[<>]/g, '').trim().slice(0, 30);
  // Note: the number of fakes is the host's *desire* (1-2). It is clamped against
  // the real player count only when a round actually starts, so settings can be
  // configured on the create screen before everyone has joined.
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
    case 'join': return onJoin(ws, msg);
    case 'settings': return onSettings(ws, msg);
    case 'start': return onStart(ws, msg);
    case 'stroke': return onStroke(ws, msg);
    case 'endTurn': return onEndTurn(ws);
    case 'vote': return onVote(ws, msg);
    case 'guess': return onGuess(ws, msg);
    case 'reaction': return onReaction(ws, msg);
    case 'nextRound': return onNextRound(ws);
    case 'toLobby': return onToLobby(ws);
    case 'resetScores': return onResetScores(ws);
    case 'kick': return onKick(ws, msg);
    case 'leave': return onLeave(ws);
    case 'disband': return onDisband(ws);
    default: return;
  }
}

function onCreate(ws, msg) {
  const room = createRoom();
  const id = String(msg.playerId || '').slice(0, 64) || makeCode(8);
  sanitizeSettings(msg.settings, room);
  addPlayer(room, id, msg.name);
  ws.meta = { roomCode: room.code, playerId: id };
  room.players.get(id).socket = ws;
  sendJSON(ws, { type: 'joined', playerId: id, code: room.code });
  broadcast(room);
}

function onJoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase().trim());
  if (!room) return sendJSON(ws, { type: 'error', message: 'Room not found. Check the code.' });

  const id = String(msg.playerId || '').slice(0, 64) || makeCode(8);
  if (room.banned.has(id)) return sendJSON(ws, { type: 'error', message: 'You were removed from that room.' });

  const existing = room.players.get(id);
  if (existing) {
    existing.connected = true;
    existing.socket = ws;
    if (msg.name) existing.name = cleanName(msg.name);
  } else {
    if (room.phase !== 'lobby') return sendJSON(ws, { type: 'error', message: 'That game is already in progress.' });
    if (room.players.size >= MAX_PLAYERS) return sendJSON(ws, { type: 'error', message: 'That room is full.' });
    const p = addPlayer(room, id, msg.name);
    p.socket = ws;
  }

  ws.meta = { roomCode: room.code, playerId: id };
  sendJSON(ws, { type: 'joined', playerId: id, code: room.code });
  broadcast(room);
}

function onSettings(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  if (room.phase !== 'lobby') return;
  sanitizeSettings(msg.settings, room);
  broadcast(room);
}

function onStart(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  if (room.phase !== 'lobby' && room.phase !== 'reveal') return;
  if (msg && msg.settings) sanitizeSettings(msg.settings, room);
  // Scores persist across rounds (rematch keeps scores). Host can clear them with "Reset".
  const res = startRound(room, { resetScores: false });
  if (res.error) return sendJSON(ws, { type: 'error', message: res.error });
  broadcast(room);
}

function onStroke(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'drawing') return;
  const pid = ws.meta.playerId;
  if (room.order[room.turnIndex] !== pid) return;

  let cur = room.strokes[room.strokes.length - 1];
  if (!cur || !cur.inProgress || cur.playerId !== pid) {
    cur = { playerId: pid, color: room.players.get(pid).color, points: [], inProgress: true };
    room.strokes.push(cur);
  }
  const pts = Array.isArray(msg.points) ? msg.points.slice(0, 400) : [];
  for (const pt of pts) {
    if (pt && typeof pt.x === 'number' && typeof pt.y === 'number') cur.points.push({ x: clamp01(pt.x), y: clamp01(pt.y) });
  }
  broadcast(room);
}

function onEndTurn(ws) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'drawing') return;
  if (room.order[room.turnIndex] !== ws.meta.playerId) return;
  finishTurn(room);
  broadcast(room);
}

function onVote(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'voting') return;
  const pid = ws.meta.playerId;
  const target = String(msg.targetId || '');
  if (!room.players.has(target) || target === pid) return;
  room.votes[pid] = target;
  if (Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  broadcast(room);
}

function onGuess(ws, msg) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'guess') return;
  if (ws.meta.playerId !== room.caughtFakeId) return;
  submitGuess(room, msg.text);
  broadcast(room);
}

let reactionSeq = 0;

function onReaction(ws, msg) {
  const room = roomOf(ws);
  if (!room) return;
  const pid = ws.meta.playerId;
  const emoji = String(msg.emoji || '');
  if (!REACTIONS.includes(emoji)) return;

  const now = Date.now();
  if (room.lastReaction[pid] && now - room.lastReaction[pid] < REACTION_COOLDOWN) return;
  room.lastReaction[pid] = now;

  const p = room.players.get(pid);
  const payload = {
    type: 'reaction',
    id: 'r' + (++reactionSeq),
    emoji,
    name: p ? p.name : '',
    color: p ? p.color : '#ffffff',
    playerId: pid,
  };
  for (const pl of room.players.values()) {
    if (pl.connected && pl.socket) sendJSON(pl.socket, payload);
  }
}

function onNextRound(ws) {
  const room = roomOf(ws);
  if (!room || room.phase !== 'reveal' || !isHostOf(room, ws)) return;
  const res = startRound(room, { resetScores: false });
  if (res.error) return sendJSON(ws, { type: 'error', message: res.error });
  broadcast(room);
}

function onToLobby(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  room.phase = 'lobby';
  room.strokes = [];
  room.votes = {};
  room.outcome = null;
  room.guessText = null;
  room.fakeIds = [];
  room.caughtFakeId = null;
  room.turnEndsAt = 0;
  room.word = null;
  room.category = null;
  broadcast(room);
}

function onResetScores(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws) || room.phase !== 'lobby') return;
  room.players.forEach((p) => { p.score = 0; p.roundsWon = 0; });
  broadcast(room);
}

function onKick(ws, msg) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  const target = String(msg.playerId || '');
  if (!target || target === room.hostId) return;
  const player = room.players.get(target);
  if (!player) return;
  room.banned.add(target);
  sendJSON(player.socket, { type: 'kicked', message: 'The host removed you from the room.' });
  if (player.socket) { try { player.socket.meta = { roomCode: null, playerId: null }; } catch {} }
  removePlayer(room, target);
  broadcast(room);
}

function onLeave(ws) {
  const room = roomOf(ws);
  if (!room) return;
  const pid = ws.meta.playerId;
  const p = room.players.get(pid);
  if (p) p.connected = false;
  removePlayer(room, pid);
  ws.meta = { roomCode: null, playerId: null };
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  ensureActiveTurn(room);
  if (room.phase === 'voting' && Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  broadcast(room);
}

function onDisband(ws) {
  const room = roomOf(ws);
  if (!room || !isHostOf(room, ws)) return;
  for (const p of room.players.values()) {
    if (p.socket) sendJSON(p.socket, { type: 'closed', message: 'The host closed the room.' });
  }
  rooms.delete(room.code);
}

function handleClose(ws) {
  const meta = ws.meta || {};
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  const player = room.players.get(meta.playerId);
  if (!player || player.socket !== ws) return;

  player.connected = false;
  player.socket = null;

  if (room.phase === 'lobby') {
    removePlayer(room, player.id);
  } else {
    ensureActiveTurn(room);
    armTurn(room);
    if (room.phase === 'voting' && Object.keys(room.votes).length >= connectedCount(room)) resolveVotes(room);
  }
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  broadcast(room);
}

/* ------------------------------ static server ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function handleHttp(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (urlPath === '/') urlPath = '/index.html';

  const rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* -------------------------- timers + room cleanup -------------------------- */

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'drawing' && room.turnEndsAt && now >= room.turnEndsAt) {
      finishTurn(room);
      broadcast(room);
    } else if (room.phase === 'voting' && room.voteEndsAt && now >= room.voteEndsAt) {
      autoVote(room);
      resolveVotes(room);
      broadcast(room);
    }
  }
}, 400);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const alive = [...room.players.values()].some((p) => p.connected);
    if (!alive && now - room.lastActive > 30 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  🎭 Fake Artist running on http://localhost:${PORT}\n`);
});
