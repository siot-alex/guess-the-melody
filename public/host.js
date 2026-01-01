const socket = io();

const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const roundLabel = document.getElementById('roundLabel');
const roundStatus = document.getElementById('roundStatus');
const startRoundBtn = document.getElementById('startRoundBtn');
const endRoundBtn = document.getElementById('endRoundBtn');
const resetGameBtn = document.getElementById('resetGameBtn');
const answerTimeInput = document.getElementById('answerTime');
const lockoutTimeInput = document.getElementById('lockoutTime');
const answerTeam = document.getElementById('answerTeam');
const answerTimer = document.getElementById('answerTimer');
const answerBadge = document.getElementById('answerBadge');
const markAll = document.getElementById('markAll');
const markArtist = document.getElementById('markArtist');
const markTitle = document.getElementById('markTitle');
const markIncorrect = document.getElementById('markIncorrect');
const artistAnswer = document.getElementById('artistAnswer');
const titleAnswer = document.getElementById('titleAnswer');
const teamsList = document.getElementById('teamsList');
const buzzLog = document.getElementById('buzzLog');
const playerLink = document.getElementById('playerLink');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const playerQr = document.getElementById('playerQr');

let latestState = null;
let serverOffset = 0;
let audioContext = null;
let cachedLink = '';

function syncClock(state) {
  serverOffset = state.serverTime - Date.now();
}

function setConnection(online) {
  connDot.classList.toggle('off', !online);
  connText.textContent = online ? 'online' : 'offline';
}

function getServerNow() {
  return Date.now() + serverOffset;
}

function formatSeconds(ms) {
  const value = Math.max(0, ms) / 1000;
  return value.toFixed(value < 10 ? 1 : 0);
}

function ensureAudioContext() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    audioContext = new AudioCtor();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}

function playBeep() {
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const duration = 1.2;
  const sustain = Math.max(0.1, duration - 0.2);
  const osc = audioContext.createOscillator();
  const osc2 = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  osc.type = 'sawtooth';
  osc2.type = 'sawtooth';
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.25);
  osc2.frequency.setValueAtTime(330, now);
  osc2.frequency.exponentialRampToValueAtTime(165, now + 0.25);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(900, now);
  filter.frequency.exponentialRampToValueAtTime(600, now + 0.3);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.6, now + 0.03);
  gain.gain.setValueAtTime(0.5, now + sustain);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gain).connect(audioContext.destination);
  osc.start(now);
  osc2.start(now);
  osc.stop(now + duration + 0.02);
  osc2.stop(now + duration + 0.02);
}

function renderTeams(state) {
  teamsList.innerHTML = '';
  if (!state.teams.length) {
    const empty = document.createElement('div');
    empty.textContent = 'Пока нет команд.';
    empty.className = 'mono';
    teamsList.appendChild(empty);
    return;
  }

  const serverNow = getServerNow();
  const sorted = [...state.teams].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, 'ru');
  });

  sorted.forEach((team) => {
    const item = document.createElement('div');
    item.className = 'list-item';

    const left = document.createElement('div');
    const artistPoints = team.artistPoints || 0;
    const titlePoints = team.titlePoints || 0;
    const fullCount = team.fullCount || 0;
    const correctCount = team.correctCount || 0;
    const totalCorrectMs = Number.isFinite(team.totalCorrectMs) ? team.totalCorrectMs : 0;
    const minLabel =
      correctCount && team.minCorrectMs !== null ? `${formatSeconds(team.minCorrectMs)}с` : '—';
    const avgLabel = correctCount ? `${formatSeconds(totalCorrectMs / correctCount)}с` : '—';
    const misses = team.misses || 0;

    left.innerHTML = `<strong>${team.name}</strong>
      <div class="mono">Очки: ${team.score} (исп: ${artistPoints}, назв: ${titlePoints})</div>
      <div class="mono">Полные: ${fullCount} · Мин: ${minLabel} · Ср: ${avgLabel} · Промахи: ${misses}</div>`;

    const right = document.createElement('div');
    right.className = 'row';
    const badge = document.createElement('span');
    badge.className = 'badge';

    let status = 'Готовы';
    if (!team.connected) {
      status = 'Offline';
      badge.classList.add('warn');
    } else if (state.currentAnsweringTeamId === team.id) {
      status = 'Отвечают';
      badge.classList.add('good');
    } else if (team.lockoutUntil > serverNow) {
      status = `Блок ${formatSeconds(team.lockoutUntil - serverNow)}с`;
      badge.classList.add('warn');
    } else {
      badge.classList.add('good');
    }

    badge.textContent = status;
    right.appendChild(badge);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ghost btn-mini';
    deleteBtn.textContent = 'Удалить';
    deleteBtn.addEventListener('click', () => {
      const ok = window.confirm(`Удалить команду "${team.name}"?`);
      if (!ok) return;
      socket.emit('delete_team', { teamId: team.id });
    });
    right.appendChild(deleteBtn);
    item.appendChild(left);
    item.appendChild(right);
    teamsList.appendChild(item);
  });
}

function renderBuzzLog(state) {
  buzzLog.innerHTML = '';
  if (!state.buzzLog.length) {
    const empty = document.createElement('div');
    empty.textContent = 'Нажатий нет.';
    empty.className = 'mono';
    buzzLog.appendChild(empty);
    return;
  }

  state.buzzLog
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const elapsed = state.roundStartAt ? entry.at - state.roundStartAt : null;
      const timeLabel = elapsed !== null ? `+${formatSeconds(elapsed)}с` : '—';
      item.innerHTML = `<strong>${entry.name}</strong><span class="mono">${timeLabel}</span>`;
      buzzLog.appendChild(item);
    });
}

function updateView() {
  if (!latestState) return;
  const state = latestState;
  const linkValue = state.playerUrl || `${window.location.origin}/`;
  if (linkValue !== cachedLink) {
    cachedLink = linkValue;
    playerLink.value = linkValue;
    playerQr.src = `/player-qr.png?v=${encodeURIComponent(linkValue)}`;
  }

  roundLabel.textContent = state.roundNumber ? `Раунд ${state.roundNumber}` : 'Раунд —';
  if (!state.roundActive) {
    const roundFinished = state.roundNumber > 0;
    roundStatus.textContent = roundFinished ? 'Раунд завершен' : 'Ожидание старта';
    startRoundBtn.textContent = state.roundNumber ? 'Новый раунд' : 'Старт раунда';
    endRoundBtn.disabled = true;
  } else {
    roundStatus.textContent = 'Раунд идет';
    startRoundBtn.textContent = 'Перезапустить';
    endRoundBtn.disabled = false;
  }

  if (document.activeElement !== answerTimeInput) {
    answerTimeInput.value = state.settings.answerTimeSec;
  }
  if (document.activeElement !== lockoutTimeInput) {
    lockoutTimeInput.value = state.settings.lockoutTimeSec;
  }

  if (state.currentAnsweringTeamId) {
    const team = state.teams.find((item) => item.id === state.currentAnsweringTeamId);
    answerTeam.textContent = team ? team.name : '—';
    answerBadge.textContent = 'Ответ';
    answerBadge.classList.add('good');
  } else {
    answerTeam.textContent = '—';
    answerBadge.textContent = 'Ожидание';
    answerBadge.classList.remove('good');
  }

  const artistDone = Boolean(state.roundAnswers?.artistTeamId);
  const titleDone = Boolean(state.roundAnswers?.titleTeamId);
  const hasAnswer = Boolean(state.currentAnsweringTeamId);

  markAll.disabled = !hasAnswer || artistDone || titleDone;
  markArtist.disabled = !hasAnswer || artistDone;
  markTitle.disabled = !hasAnswer || titleDone;
  markIncorrect.disabled = !hasAnswer;

  const artistTeam = state.teams.find((item) => item.id === state.roundAnswers?.artistTeamId);
  const titleTeam = state.teams.find((item) => item.id === state.roundAnswers?.titleTeamId);
  artistAnswer.textContent = artistTeam ? artistTeam.name : '—';
  titleAnswer.textContent = titleTeam ? titleTeam.name : '—';

  const serverNow = getServerNow();
  if (state.answerEndsAt) {
    const remaining = state.answerEndsAt - serverNow;
    answerTimer.textContent = remaining > 0 ? `Осталось: ${formatSeconds(remaining)}с` : 'Время вышло';
  } else {
    answerTimer.textContent = 'Таймер: —';
  }

  renderTeams(state);
  renderBuzzLog(state);
}

startRoundBtn.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('start_round');
});

endRoundBtn.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('end_round');
});

resetGameBtn.addEventListener('click', () => {
  ensureAudioContext();
  const ok = window.confirm('Сбросить игру? Команды и очки будут очищены.');
  if (!ok) return;
  socket.emit('reset_game');
});

function saveSettingsFromInputs() {
  const answerTimeSec = Number(answerTimeInput.value);
  const lockoutTimeSec = Number(lockoutTimeInput.value);
  socket.emit('set_settings', { answerTimeSec, lockoutTimeSec });
}

answerTimeInput.addEventListener('blur', saveSettingsFromInputs);
lockoutTimeInput.addEventListener('blur', saveSettingsFromInputs);
answerTimeInput.addEventListener('change', saveSettingsFromInputs);
lockoutTimeInput.addEventListener('change', saveSettingsFromInputs);

markAll.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('mark_result', { result: 'all' });
});

markArtist.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('mark_result', { result: 'artist' });
});

markTitle.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('mark_result', { result: 'title' });
});

markIncorrect.addEventListener('click', () => {
  ensureAudioContext();
  socket.emit('mark_result', { result: 'incorrect' });
});

copyLinkBtn.addEventListener('click', async () => {
  const value = playerLink.value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyLinkBtn.classList.add('copied');
  } catch (err) {
    playerLink.select();
    document.execCommand('copy');
    copyLinkBtn.classList.add('copied');
  }
  setTimeout(() => {
    copyLinkBtn.classList.remove('copied');
  }, 1200);
});

socket.on('connect', () => {
  setConnection(true);
  socket.emit('join_host', (res) => {
    if (res?.state) {
      latestState = res.state;
      syncClock(latestState);
      updateView();
    }
  });
});

socket.on('disconnect', () => {
  setConnection(false);
});

socket.on('state_update', (state) => {
  const prevState = latestState;
  latestState = state;
  syncClock(latestState);
  updateView();
  if (prevState && !prevState.currentAnsweringTeamId && latestState.currentAnsweringTeamId) {
    playBeep();
  }
});

setInterval(updateView, 200);
