const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get(['/host', '/host/'], (req, res) => {
  res.redirect('/host.html');
});

const DEFAULT_SETTINGS = {
  answerTimeSec: 5,
  lockoutTimeSec: 10
};

const state = {
  teams: new Map(),
  roundActive: false,
  roundNumber: 0,
  currentAnsweringTeamId: null,
  answerEndsAt: null,
  roundStartAt: null,
  answerTimeSec: DEFAULT_SETTINGS.answerTimeSec,
  lockoutTimeSec: DEFAULT_SETTINGS.lockoutTimeSec,
  lastWinnerTeamId: null,
  buzzLog: [],
  lastResult: null,
  roundAnswers: {
    artistTeamId: null,
    titleTeamId: null,
    artistAt: null,
    titleAt: null,
    fullAwarded: false
  }
};

function now() {
  return Date.now();
}

function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const addresses of Object.values(nets)) {
    if (!addresses) continue;
    for (const addr of addresses) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

function getBaseUrl() {
  const lanAddress = getLanAddress();
  return lanAddress ? `http://${lanAddress}:${PORT}` : `http://localhost:${PORT}`;
}

function getPlayerUrl() {
  return `${getBaseUrl()}/`;
}

let qrCache = { url: '', buffer: null, pending: null };

async function getPlayerQrBuffer() {
  const url = getPlayerUrl();
  if (qrCache.url === url && qrCache.buffer) return qrCache.buffer;
  if (qrCache.url === url && qrCache.pending) return qrCache.pending;
  qrCache.url = url;
  qrCache.pending = QRCode.toBuffer(url, { width: 240, margin: 1 })
    .then((buffer) => {
      qrCache.buffer = buffer;
      qrCache.pending = null;
      return buffer;
    })
    .catch((err) => {
      qrCache.buffer = null;
      qrCache.pending = null;
      throw err;
    });
  return qrCache.pending;
}

app.get('/player-qr.png', async (req, res) => {
  try {
    const buffer = await getPlayerQrBuffer();
    res.type('png').send(buffer);
  } catch (err) {
    res.status(500).end();
  }
});

function getPublicState() {
  return {
    serverTime: now(),
    playerUrl: getPlayerUrl(),
    roundActive: state.roundActive,
    roundNumber: state.roundNumber,
    currentAnsweringTeamId: state.currentAnsweringTeamId,
    answerEndsAt: state.answerEndsAt,
    roundStartAt: state.roundStartAt,
    lastWinnerTeamId: state.lastWinnerTeamId,
    lastResult: state.lastResult,
    roundAnswers: state.roundAnswers,
    settings: {
      answerTimeSec: state.answerTimeSec,
      lockoutTimeSec: state.lockoutTimeSec
    },
    buzzLog: state.buzzLog,
    teams: Array.from(state.teams.values()).map((team) => ({
      id: team.id,
      name: team.name,
      score: team.score,
      artistPoints: team.artistPoints,
      titlePoints: team.titlePoints,
      fullCount: team.fullCount,
      correctCount: team.correctCount,
      minCorrectMs: team.minCorrectMs,
      totalCorrectMs: team.totalCorrectMs,
      misses: team.misses,
      lockoutUntil: team.lockoutUntil,
      connected: team.connected,
      lastBuzzAt: team.lastBuzzAt
    }))
  };
}

function broadcastState() {
  io.emit('state_update', getPublicState());
}

function resetGame() {
  state.teams.clear();
  state.roundActive = false;
  state.roundNumber = 0;
  state.currentAnsweringTeamId = null;
  state.answerEndsAt = null;
  state.roundStartAt = null;
  state.lastWinnerTeamId = null;
  state.buzzLog = [];
  state.lastResult = null;
  state.roundAnswers = {
    artistTeamId: null,
    titleTeamId: null,
    artistAt: null,
    titleAt: null,
    fullAwarded: false
  };
  state.answerTimeSec = DEFAULT_SETTINGS.answerTimeSec;
  state.lockoutTimeSec = DEFAULT_SETTINGS.lockoutTimeSec;
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function isNameTaken(name, excludeId) {
  const target = name.toLowerCase();
  for (const team of state.teams.values()) {
    if (team.id === excludeId) continue;
    if (team.name.toLowerCase() === target) return true;
  }
  return false;
}

function canTeamBuzz(team, timeMs) {
  if (!state.roundActive) return { ok: false, reason: 'round_inactive' };
  if (state.currentAnsweringTeamId) return { ok: false, reason: 'answer_in_progress' };
  if (team.lockoutUntil && team.lockoutUntil > timeMs) return { ok: false, reason: 'locked' };
  return { ok: true };
}

function canAwardResult(result) {
  const artistDone = Boolean(state.roundAnswers.artistTeamId);
  const titleDone = Boolean(state.roundAnswers.titleTeamId);
  if (result === 'all') return !artistDone && !titleDone;
  if (result === 'artist') return !artistDone;
  if (result === 'title') return !titleDone;
  return true;
}

function endRound(teamId) {
  state.roundActive = false;
  state.currentAnsweringTeamId = null;
  state.answerEndsAt = null;
  state.lastWinnerTeamId = teamId || null;
}

function applyResult(result) {
  const teamId = state.currentAnsweringTeamId;
  if (!teamId || !state.teams.has(teamId)) return false;
  if (!canAwardResult(result)) return false;
  const team = state.teams.get(teamId);
  const timestamp = now();
  let points = 0;
  let isCorrect = false;

  if (result === 'all') {
    points = 2;
    team.artistPoints += 1;
    team.titlePoints += 1;
    isCorrect = true;
  } else if (result === 'artist' || result === 'title') {
    points = 1;
    if (result === 'artist') {
      team.artistPoints += 1;
    } else {
      team.titlePoints += 1;
    }
    isCorrect = true;
  } else if (result === 'incorrect') {
    team.misses += 1;
  }

  if (points) {
    team.score += points;
  }

  if (isCorrect && state.roundStartAt) {
    const solveMs = Math.max(0, timestamp - state.roundStartAt);
    team.correctCount += 1;
    team.totalCorrectMs += solveMs;
    team.minCorrectMs =
      team.minCorrectMs === null ? solveMs : Math.min(team.minCorrectMs, solveMs);
  }

  state.lastResult = {
    teamId,
    result,
    points,
    at: timestamp
  };

  if (result === 'all') {
    state.roundAnswers.artistTeamId = teamId;
    state.roundAnswers.titleTeamId = teamId;
    state.roundAnswers.artistAt = timestamp;
    state.roundAnswers.titleAt = timestamp;
  } else if (result === 'artist') {
    state.roundAnswers.artistTeamId = teamId;
    state.roundAnswers.artistAt = timestamp;
  } else if (result === 'title') {
    state.roundAnswers.titleTeamId = teamId;
    state.roundAnswers.titleAt = timestamp;
  }

  const roundComplete = Boolean(state.roundAnswers.artistTeamId && state.roundAnswers.titleTeamId);
  const fullTeamId =
    state.roundAnswers.artistTeamId === state.roundAnswers.titleTeamId
      ? state.roundAnswers.artistTeamId
      : null;
  if (fullTeamId && roundComplete && !state.roundAnswers.fullAwarded) {
    const fullTeam = state.teams.get(fullTeamId);
    const finishAt = Math.max(state.roundAnswers.artistAt || 0, state.roundAnswers.titleAt || 0);
    if (fullTeam && state.roundStartAt && finishAt) {
      const solveMs = Math.max(0, finishAt - state.roundStartAt);
      fullTeam.fullCount += 1;
    } else if (fullTeam) {
      fullTeam.fullCount += 1;
    }
    state.roundAnswers.fullAwarded = true;
  }

  if (result === 'all') {
    endRound(teamId);
  } else if (roundComplete) {
    endRound(teamId);
  } else {
    team.lockoutUntil = now() + state.lockoutTimeSec * 1000;
    state.currentAnsweringTeamId = null;
    state.answerEndsAt = null;
  }

  return true;
}

io.on('connection', (socket) => {
  socket.on('join_host', (ack) => {
    socket.data.role = 'host';
    if (typeof ack === 'function') {
      ack({ ok: true, state: getPublicState() });
    }
    broadcastState();
  });

  socket.on('join_team', (payload, ack) => {
    const name = normalizeName(payload?.name);
    const requestedId = payload?.teamId;

    if (!name && !requestedId) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'name_required' });
      }
      return;
    }

    let team = null;
    if (requestedId && state.teams.has(requestedId)) {
      team = state.teams.get(requestedId);
      if (name && name !== team.name) {
        if (isNameTaken(name, team.id)) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'name_taken' });
          }
          return;
        }
        team.name = name;
      }
    } else {
      if (!name) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'name_required' });
        }
        return;
      }
      if (isNameTaken(name)) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'name_taken' });
        }
        return;
      }
      team = {
        id: crypto.randomUUID(),
        name,
        score: 0,
        artistPoints: 0,
        titlePoints: 0,
        fullCount: 0,
        correctCount: 0,
        minCorrectMs: null,
        totalCorrectMs: 0,
        misses: 0,
        lockoutUntil: 0,
        connected: true,
        socketId: socket.id,
        lastBuzzAt: 0
      };
      state.teams.set(team.id, team);
    }

    team.connected = true;
    team.socketId = socket.id;
    socket.data.role = 'team';
    socket.data.teamId = team.id;

    if (typeof ack === 'function') {
      ack({ ok: true, teamId: team.id, name: team.name, state: getPublicState() });
    }
    broadcastState();
  });

  socket.on('set_settings', (payload) => {
    if (socket.data.role !== 'host') return;
    const answerTimeSec = Number(payload?.answerTimeSec);
    const lockoutTimeSec = Number(payload?.lockoutTimeSec);
    if (Number.isFinite(answerTimeSec) && answerTimeSec > 0 && answerTimeSec < 60) {
      state.answerTimeSec = Math.round(answerTimeSec * 10) / 10;
    }
    if (Number.isFinite(lockoutTimeSec) && lockoutTimeSec >= 0 && lockoutTimeSec < 120) {
      state.lockoutTimeSec = Math.round(lockoutTimeSec * 10) / 10;
    }
    broadcastState();
  });

  socket.on('start_round', () => {
    if (socket.data.role !== 'host') return;
    state.roundActive = true;
    state.roundNumber += 1;
    state.currentAnsweringTeamId = null;
    state.answerEndsAt = null;
    state.roundStartAt = now();
    state.lastWinnerTeamId = null;
    state.buzzLog = [];
    state.lastResult = null;
    state.roundAnswers = {
      artistTeamId: null,
      titleTeamId: null,
      artistAt: null,
      titleAt: null,
      fullAwarded: false
    };
    for (const team of state.teams.values()) {
      team.lockoutUntil = 0;
      team.lastBuzzAt = 0;
    }
    broadcastState();
  });

  socket.on('end_round', () => {
    if (socket.data.role !== 'host') return;
    if (!state.roundActive) return;
    state.roundActive = false;
    state.currentAnsweringTeamId = null;
    state.answerEndsAt = null;
    broadcastState();
  });

  socket.on('reset_game', () => {
    if (socket.data.role !== 'host') return;
    resetGame();
    broadcastState();
  });

  socket.on('delete_team', (payload) => {
    if (socket.data.role !== 'host') return;
    const teamId = payload?.teamId;
    if (!teamId || !state.teams.has(teamId)) return;
    state.teams.delete(teamId);
    state.buzzLog = state.buzzLog.filter((entry) => entry.teamId !== teamId);
    if (state.currentAnsweringTeamId === teamId) {
      state.currentAnsweringTeamId = null;
      state.answerEndsAt = null;
    }
    if (state.lastWinnerTeamId === teamId) {
      state.lastWinnerTeamId = null;
    }
    if (state.lastResult?.teamId === teamId) {
      state.lastResult = null;
    }
    if (state.roundAnswers.artistTeamId === teamId) {
      state.roundAnswers.artistTeamId = null;
      state.roundAnswers.artistAt = null;
    }
    if (state.roundAnswers.titleTeamId === teamId) {
      state.roundAnswers.titleTeamId = null;
      state.roundAnswers.titleAt = null;
    }
    if (!state.roundAnswers.artistTeamId || !state.roundAnswers.titleTeamId) {
      state.roundAnswers.fullAwarded = false;
    }
    broadcastState();
  });

  socket.on('mark_result', (payload) => {
    if (socket.data.role !== 'host') return;
    const result = payload?.result;
    if (!['all', 'artist', 'title', 'incorrect'].includes(result)) return;
    if (!applyResult(result)) return;
    broadcastState();
  });

  socket.on('mark_correct', () => {
    if (socket.data.role !== 'host') return;
    if (!applyResult('all')) return;
    broadcastState();
  });

  socket.on('mark_incorrect', () => {
    if (socket.data.role !== 'host') return;
    if (!applyResult('incorrect')) return;
    broadcastState();
  });

  socket.on('buzz', (ack) => {
    if (socket.data.role !== 'team') return;
    const teamId = socket.data.teamId;
    if (!teamId || !state.teams.has(teamId)) return;
    const team = state.teams.get(teamId);
    const timeMs = now();
    const verdict = canTeamBuzz(team, timeMs);
    if (!verdict.ok) {
      if (typeof ack === 'function') {
        ack({ ok: false, reason: verdict.reason, state: getPublicState() });
      }
      return;
    }

    state.currentAnsweringTeamId = teamId;
    state.answerEndsAt = timeMs + state.answerTimeSec * 1000;
    team.lastBuzzAt = timeMs;
    state.buzzLog.push({
      teamId,
      name: team.name,
      at: timeMs
    });
    if (state.buzzLog.length > 40) {
      state.buzzLog.shift();
    }
    if (typeof ack === 'function') {
      ack({ ok: true, state: getPublicState() });
    }
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'team') {
      const teamId = socket.data.teamId;
      if (teamId && state.teams.has(teamId)) {
        const team = state.teams.get(teamId);
        if (team.socketId === socket.id) {
          team.connected = false;
        }
      }
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Guess the Melody server running on http://localhost:${PORT}`);
  const hostUrl = `${getBaseUrl()}/host.html`;
  try {
    if (process.platform === 'darwin') {
      exec(`open "${hostUrl}"`);
    } else if (process.platform === 'win32') {
      exec(`cmd /c start "" "${hostUrl}"`);
    } else {
      exec(`xdg-open "${hostUrl}"`);
    }
  } catch (err) {
    console.warn('Failed to open browser:', err.message);
  }
});
