(function () {
  "use strict";

  // ---------- Constantes ----------
  const ROWS = 6, COLS = 5, MAX_PLAYERS = 4;
  const HEARTBEAT_MS = 2000, TIMEOUT_MS = 15000;
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const KB = ["qwertyuiop", "asdfghjkl", "⏎zxcvbnm⌫"];
  const RANK = { absent: 1, present: 2, correct: 3 };

  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- Estado ----------
  const me = { id: uid(), name: "" };
  let net = null, code = null, isHost = false, hostId = null;
  let players = [];            // [{id, name, score}] — autoridad: host
  let phase = "home";          // home | lobby | playing | roundover
  let round = 0, word = null, roundPlayers = [];
  let lastResult = null;
  const lastSeen = {};
  let heartbeat = null;

  // Mi tablero
  let guesses = [], evals = [], current = "", done = false, busy = false;
  let keyState = {};
  // Rivales: id -> {rows: [[...]], done, solved}
  let opp = {};

  // ---------- Utilidades UI ----------
  function show(screen) {
    for (const s of ["Home", "Lobby", "Game"]) $("screen" + s).classList.toggle("hidden", s !== screen);
    const inRoom = screen !== "Home";
    $("roomTag").classList.toggle("hidden", !inRoom);
    $("leaveBtn").classList.toggle("hidden", !inRoom);
    if (inRoom) $("roomTag").textContent = code;
  }

  function toast(msg, ms = 1400) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    $("toasts").prepend(el);
    setTimeout(() => el.classList.add("fade"), ms);
    setTimeout(() => el.remove(), ms + 300);
  }

  function tileRow(text, cls) {
    return [...text].map((ch, i) => {
      const c = typeof cls === "function" ? cls(i) : cls;
      return `<span class="tile mini ${c}">${ch}</span>`;
    }).join("");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Lógica Wordle ----------
  function evaluate(guess, answer) {
    const res = Array(COLS).fill("absent");
    const counts = {};
    for (let i = 0; i < COLS; i++) {
      if (guess[i] === answer[i]) res[i] = "correct";
      else counts[answer[i]] = (counts[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < COLS; i++) {
      if (res[i] !== "correct" && counts[guess[i]] > 0) {
        res[i] = "present";
        counts[guess[i]]--;
      }
    }
    return res;
  }

  // ---------- Red ----------
  async function connect(roomCode) {
    code = roomCode;
    net = await Net.joinChannel("room-" + code, onMessage);
    heartbeat = setInterval(tick, HEARTBEAT_MS);
  }

  function send(msg) {
    if (net) net.send({ ...msg, from: me.id });
  }

  function tick() {
    send({ t: "ping" });
    const now = Date.now();
    if (isHost) {
      const gone = players.filter((p) => p.id !== me.id && now - (lastSeen[p.id] || now) > TIMEOUT_MS);
      gone.forEach((p) => removePlayer(p.id, true));
    } else if (hostId && now - (lastSeen[hostId] || now) > TIMEOUT_MS) {
      leave("El host se desconectó");
    }
  }

  function onMessage(msg) {
    if (!msg || msg.from === me.id) return;
    lastSeen[msg.from] = Date.now();

    switch (msg.t) {
      case "hello":
        if (isHost) hostOnHello(msg);
        break;
      case "full":
        if (msg.to === me.id) joinFailed("La sala está llena");
        break;
      case "state":
        if (!isHost) applyState(msg);
        break;
      case "progress":
        if (msg.round !== round) return;
        opp[msg.from] = { rows: msg.rows, done: msg.done, solved: msg.solved };
        renderOpponents();
        if (isHost) hostCheckRound(msg.from, msg.solved);
        break;
      case "end":
        if (!isHost) onRoundEnd(msg);
        break;
      case "bye":
        if (isHost) removePlayer(msg.from, false);
        else if (msg.from === hostId) leave("El host cerró la sala");
        break;
    }
  }

  // ---------- Host ----------
  function hostState() {
    return { t: "state", hostId: me.id, players, phase, round, word, roundPlayers, result: lastResult };
  }

  function broadcastState() {
    send(hostState());
    renderLobby();
    renderScoreboard();
  }

  function hostOnHello(msg) {
    if (!players.find((p) => p.id === msg.from)) {
      if (players.length >= MAX_PLAYERS) return send({ t: "full", to: msg.from });
      players.push({ id: msg.from, name: msg.name, score: 0 });
      toast(`${msg.name} se unió`);
    }
    broadcastState();
  }

  function removePlayer(id, timedOut) {
    const p = players.find((x) => x.id === id);
    if (!p) return;
    players = players.filter((x) => x.id !== id);
    roundPlayers = roundPlayers.filter((x) => x !== id);
    delete opp[id];
    toast(`${p.name} ${timedOut ? "se desconectó" : "salió"}`);
    broadcastState();
    renderOpponents();
    if (phase === "playing") hostCheckRound(null, false);
  }

  function hostStartRound() {
    if (players.length < 2) return toast("Necesitás al menos 2 jugadores");
    round++;
    word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    roundPlayers = players.map((p) => p.id);
    phase = "playing";
    lastResult = null;
    broadcastState();
    beginRound();
  }

  function hostCheckRound(fromId, solved) {
    if (phase !== "playing") return;
    if (solved) return hostEndRound(fromId);
    const myDone = done;
    const allDone = roundPlayers.every((id) => (id === me.id ? myDone : opp[id] && opp[id].done));
    if (allDone) hostEndRound(null);
  }

  function hostEndRound(winnerId) {
    phase = "roundover";
    const w = players.find((p) => p.id === winnerId);
    if (w) w.score++;
    lastResult = { round, winner: winnerId, word };
    const msg = { t: "end", round, winner: winnerId, word, players };
    send(msg);
    send(hostState());
    onRoundEnd(msg);
  }

  // ---------- Cliente ----------
  function applyState(s) {
    hostId = s.hostId;
    players = s.players;
    const inGame = s.players.some((p) => p.id === me.id);
    if (!inGame) return;
    clearTimeout(joinTimer);

    if (s.phase === "playing" && s.round !== round) {
      round = s.round;
      word = s.word;
      roundPlayers = s.roundPlayers;
      phase = "playing";
      if (roundPlayers.includes(me.id)) beginRound();
      else { phase = "lobby"; show("Lobby"); }
    } else if (phase === "home") {
      phase = s.phase === "playing" ? "lobby" : s.phase === "roundover" ? "lobby" : s.phase;
      round = s.round;
      show("Lobby");
    }
    renderLobby();
    renderScoreboard();
    if (s.phase === "playing" && !roundPlayers.includes(me.id)) {
      $("lobbyHint").textContent = "Hay una ronda en curso. Entrás en la próxima.";
    }
  }

  // ---------- Flujo de sala ----------
  let joinTimer = null;

  function getName() {
    if (Auth.enabled) { me.name = Auth.profile ? Auth.profile.username : "Jugador"; return me.name; }
    const n = $("nameInput").value.trim() || "Jugador";
    me.name = n.slice(0, 14);
    try { localStorage.setItem("pinzle-name", me.name); } catch (e) {}
    return me.name;
  }

  async function createRoom() {
    getName();
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    try { await connect(c); } catch (e) { return toast("Error de conexión"); }
    isHost = true;
    hostId = me.id;
    players = [{ id: me.id, name: me.name, score: 0 }];
    phase = "lobby";
    history.replaceState(null, "", "?room=" + c);
    show("Lobby");
    renderLobby();
  }

  async function joinRoom() {
    getName();
    const c = $("codeInput").value.trim().toUpperCase();
    if (c.length !== 4) return toast("El código tiene 4 letras");
    $("joinBtn").disabled = true;
    try { await connect(c); } catch (e) { $("joinBtn").disabled = false; return toast("Error de conexión"); }
    isHost = false;
    send({ t: "hello", name: me.name });
    joinTimer = setTimeout(() => joinFailed("No se encontró la sala"), 4000);
  }

  function joinFailed(msg) {
    clearTimeout(joinTimer);
    toast(msg, 2000);
    teardown();
    $("joinBtn").disabled = false;
  }

  function teardown() {
    clearInterval(heartbeat);
    if (net) { try { net.leave(); } catch (e) {} }
    net = null; code = null; isHost = false; hostId = null;
    players = []; phase = "home"; round = 0; word = null; roundPlayers = []; opp = {};
    lastResult = null;
  }

  function leave(reason) {
    send({ t: "bye" });
    teardown();
    $("modal").classList.add("hidden");
    $("joinBtn").disabled = false;
    history.replaceState(null, "", location.pathname);
    show("Home");
    if (reason) toast(reason, 2200);
  }

  // ---------- Render lobby / marcador ----------
  function renderLobby() {
    if (!code) return;
    $("lobbyCode").innerHTML = tileRow(code, "correct");
    $("playerList").innerHTML = players.map((p) => `
      <li><span>${esc(p.name)}${p.id === me.id ? " (vos)" : ""}</span>
      <span class="tag">${p.id === (isHost ? me.id : hostId) ? "Host" : ""}</span></li>`).join("");
    $("startBtn").classList.toggle("hidden", !isHost);
    $("startBtn").disabled = players.length < 2;
    $("lobbyHint").textContent = isHost
      ? (players.length < 2 ? "Compartí el código o el link. Necesitás al menos 1 rival." : `${players.length} jugadores listos.`)
      : "Esperando a que el host empiece…";
  }

  function renderScoreboard() {
    $("scoreboard").innerHTML = players.map((p) =>
      `<div class="score-chip ${p.id === me.id ? "me" : ""}">${esc(p.name)}<b>${p.score}</b></div>`).join("");
  }

  // ---------- Ronda ----------
  function beginRound() {
    guesses = []; evals = []; current = ""; done = false; busy = false; keyState = {};
    opp = {};
    roundPlayers.forEach((id) => { if (id !== me.id) opp[id] = { rows: [], done: false, solved: false }; });
    $("modal").classList.add("hidden");
    buildBoard();
    buildKeyboard();
    renderOpponents();
    renderScoreboard();
    show("Game");
  }

  function buildBoard() {
    let html = "";
    for (let r = 0; r < ROWS; r++) {
      html += `<div class="row" data-r="${r}">`;
      for (let c = 0; c < COLS; c++) html += `<div class="tile"></div>`;
      html += "</div>";
    }
    $("board").innerHTML = html;
  }

  function rowEl(r) { return $("board").children[r]; }

  function renderCurrent() {
    const tiles = rowEl(guesses.length).children;
    for (let c = 0; c < COLS; c++) {
      const ch = current[c] || "";
      if (tiles[c].textContent !== ch) {
        tiles[c].textContent = ch;
        tiles[c].className = "tile" + (ch ? " filled" : "");
      }
    }
  }

  function buildKeyboard() {
    const back = '<svg viewBox="0 0 24 24"><path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H7.07L2.4 12l4.66-7H22v14zm-11.59-2L14 13.41 17.59 17 19 15.59 15.41 12 19 8.41 17.59 7 14 10.59 10.41 7 9 8.41 12.59 12 9 15.59z"/></svg>';
    $("keyboard").innerHTML = KB.map((row, i) => {
      let keys = [...row].map((k) => {
        if (k === "⏎") return `<button class="key wide" data-k="enter" type="button">Enter</button>`;
        if (k === "⌫") return `<button class="key wide" data-k="back" type="button" aria-label="Borrar">${back}</button>`;
        return `<button class="key" data-k="${k}" type="button">${k}</button>`;
      }).join("");
      if (i === 1) keys = `<div class="key spacer"></div>${keys}<div class="key spacer"></div>`;
      return `<div class="kb-row">${keys}</div>`;
    }).join("");
  }

  function paintKeys() {
    for (const [k, st] of Object.entries(keyState)) {
      const el = $("keyboard").querySelector(`[data-k="${k}"]`);
      if (el) el.className = "key " + st;
    }
  }

  function renderOpponents() {
    const ids = Object.keys(opp);
    $("opponents").innerHTML = ids.map((id) => {
      const p = players.find((x) => x.id === id);
      const o = opp[id];
      let rows = "";
      for (let r = 0; r < ROWS; r++) {
        rows += `<div class="opp-row">`;
        for (let c = 0; c < COLS; c++) rows += `<div class="opp-cell ${(o.rows[r] && o.rows[r][c]) || ""}"></div>`;
        rows += `</div>`;
      }
      const status = o.solved ? "¡La adivinó!" : o.done ? "Sin intentos" : `${o.rows.length}/${ROWS}`;
      return `<div class="opp"><div class="opp-name">${esc(p ? p.name : "Rival")}</div>
        <div class="opp-board">${rows}</div><div class="opp-status">${status}</div></div>`;
    }).join("");
  }

  // ---------- Input ----------
  function press(k) {
    if (phase !== "playing" || done || busy) return;
    if (k === "enter") return submit();
    if (k === "back") { current = current.slice(0, -1); return renderCurrent(); }
    if (/^[a-z]$/.test(k) && current.length < COLS) { current += k; renderCurrent(); }
  }

  function shakeRow(msg) {
    const r = rowEl(guesses.length);
    r.classList.remove("shake");
    void r.offsetWidth;
    r.classList.add("shake");
    toast(msg);
  }

  function submit() {
    if (current.length < COLS) return shakeRow("Faltan letras");
    if (!VALID.has(current)) return shakeRow("No está en la lista");

    const guess = current;
    const res = evaluate(guess, word);
    const solved = res.every((x) => x === "correct");
    const r = guesses.length;
    guesses.push(guess);
    evals.push(res);
    current = "";
    if (solved || guesses.length >= ROWS) done = true;

    // Avisamos al toque (la carrera la decide el orden de llegada al host)
    send({ t: "progress", round, rows: evals, done, solved });
    if (isHost) hostCheckRound(me.id, solved);

    busy = true;
    const tiles = rowEl(r).children;
    res.forEach((st, i) => {
      setTimeout(() => {
        tiles[i].className = "tile flip";
        setTimeout(() => { tiles[i].className = "tile flip-out " + st; }, 250);
      }, i * 280);
    });
    setTimeout(() => {
      res.forEach((st, i) => {
        const k = guess[i];
        if (!keyState[k] || RANK[st] > RANK[keyState[k]]) keyState[k] = st;
      });
      paintKeys();
      busy = false;
      if (solved) {
        [...tiles].forEach((t, i) => setTimeout(() => t.classList.add("bounce"), i * 90));
      } else if (done && phase === "playing") {
        toast("Sin intentos. Esperando al resto…", 2000);
      }
    }, COLS * 280 + 260);
  }

  // ---------- Fin de ronda ----------
  function onRoundEnd(msg) {
    if (msg.round !== round) return;
    phase = "roundover";
    players = msg.players;
    done = true;
    renderScoreboard();

    const won = msg.winner === me.id;
    const winner = players.find((p) => p.id === msg.winner);
    if (roundPlayers.includes(me.id)) Auth.recordRound(won);
    const delay = msg.winner ? 1900 : 1200;

    setTimeout(() => {
      if (phase !== "roundover" || msg.round !== round) return;
      $("modalEyebrow").textContent = `Ronda ${msg.round}`;
      $("modalTitle").textContent = won ? "¡Ganaste!" : winner ? `Ganó ${winner.name}` : "Nadie la adivinó";
      $("modalWord").innerHTML = tileRow(msg.word.toUpperCase(), won ? "correct" : "absent");
      $("modalScores").innerHTML = [...players].sort((a, b) => b.score - a.score)
        .map((p) => `<div><span>${esc(p.name)}${p.id === me.id ? " (vos)" : ""}</span><span>${p.score}</span></div>`).join("");
      $("nextBtn").classList.toggle("hidden", !isHost);
      $("nextBtn").disabled = players.length < 2;
      $("modalHint").textContent = isHost
        ? (players.length < 2 ? "Esperando a que se una otro jugador…" : "")
        : "Esperando a que el host arranque la próxima…";
      $("modal").classList.remove("hidden");
    }, delay);
  }

  // ---------- Eventos ----------
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement && document.activeElement.tagName === "INPUT") {
      if (e.key === "Enter") {
        if (document.activeElement.id === "codeInput") joinRoom();
        else if (document.activeElement.id === "nameInput") ($("codeInput").value.trim() ? joinRoom() : createRoom());
      }
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); press("enter"); }
    else if (e.key === "Backspace") press("back");
    else press(e.key.toLowerCase());
  });

  $("keyboard").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (b) { b.blur(); press(b.dataset.k); }
  });

  $("createBtn").onclick = createRoom;
  $("joinBtn").onclick = joinRoom;
  $("startBtn").onclick = hostStartRound;
  $("nextBtn").onclick = hostStartRound;
  $("leaveBtn").onclick = () => leave();
  $("copyBtn").onclick = async () => {
    const link = location.href.split("?")[0] + "?room=" + code;
    try { await navigator.clipboard.writeText(link); toast("Link copiado"); }
    catch (e) { toast(link, 4000); }
  };
  $("codeInput").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
  });
  window.addEventListener("beforeunload", () => send({ t: "bye" }));

  // ---------- Init ----------
  try { $("nameInput").value = localStorage.getItem("pinzle-name") || ""; } catch (e) {}
  const qRoom = new URLSearchParams(location.search).get("room");
  if (qRoom) { $("codeInput").value = qRoom.toUpperCase().slice(0, 4); $("nameInput").focus(); }
  $("netMode").textContent = Net.mode === "online"
    ? ""
    : "Modo local: abrí otra pestaña para probar. Conectá Supabase en config.js para jugar online.";
  show("Home");

  // ---------- Cuentas ----------
  let authMode = "login";
  function setAuthMode(m) {
    authMode = m;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
    $("authUser").classList.toggle("hidden", m !== "signup");
    $("authPass").autocomplete = m === "signup" ? "new-password" : "current-password";
    $("authBtn").textContent = m === "signup" ? "Crear cuenta" : "Ingresar";
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setAuthMode(t.dataset.mode)));

  $("authBox").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim(), pass = $("authPass").value;
    $("authBtn").disabled = true;
    try {
      if (authMode === "signup") {
        const r = await Auth.signUp($("authUser").value, email, pass);
        if (r.needsConfirm) { toast("Te mandamos un mail para confirmar la cuenta", 3500); setAuthMode("login"); }
      } else {
        await Auth.signIn(email, pass);
      }
    } catch (err) {
      toast(err.message, 2500);
    } finally {
      $("authBtn").disabled = false;
    }
  });

  $("logoutBtn").onclick = () => Auth.signOut();

  function renderAccount(profile) {
    const loggedIn = !Auth.enabled || !!profile;
    $("authBox").classList.toggle("hidden", loggedIn);
    $("playBox").classList.toggle("hidden", !loggedIn);
    $("nameField").classList.toggle("hidden", Auth.enabled);
    $("profileCard").classList.toggle("hidden", !profile);
    if (profile) {
      $("profName").textContent = profile.username;
      const pct = profile.rounds_played ? Math.round((profile.wins / profile.rounds_played) * 100) : 0;
      $("profStats").textContent = `${profile.wins} victorias · ${profile.rounds_played} rondas · ${pct}%`;
      if (phase === "home") me.name = profile.username;
    } else if (Auth.enabled && phase !== "home") {
      leave("Cerraste sesión");
    }
  }
  Auth.init(renderAccount);
})();
