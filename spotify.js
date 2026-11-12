/* Conexión con Spotify: login Authorization Code + PKCE, todo en el navegador (sin client secret).
   Los tokens se guardan en el localStorage de este navegador para no tener que loguearse cada vez. */
const Spotify = (() => {
  const CLIENT_ID = "558e39b6b7a24870bcfa5f52e80d27d2";
  const SCOPES = "user-read-playback-state user-modify-playback-state";
  // Tienen que coincidir letra por letra con las cargadas en el dashboard de Spotify.
  const REDIRECT_PROD = "https://martinminevitz-collab.github.io/Hitster/";
  const REDIRECT_LOCAL = "http://127.0.0.1:8080/";
  const TOKENS_KEY = "hitster-spotify-tokens";
  const PKCE_KEY = "hitster-spotify-pkce";
  const ACCOUNTS = "https://accounts.spotify.com";
  const API = "https://api.spotify.com/v1";

  const status = { state: "idle", name: null, error: null }; // idle | working | connected | error
  let onChange = () => {};
  let refreshing = null;

  const redirectUri = () => (location.origin === new URL(REDIRECT_LOCAL).origin ? REDIRECT_LOCAL : REDIRECT_PROD);
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const write = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const set = patch => { Object.assign(status, patch); onChange(status); };

  function randomString(n) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => abc[b % abc.length]).join("");
  }
  async function challengeFor(verifier) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function tokenRequest(params) {
    const res = await fetch(ACCOUNTS + "/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error_description || data.error || "HTTP " + res.status); e.code = data.error; throw e; }
    const old = read(TOKENS_KEY) || {};
    const t = {
      access: data.access_token,
      refresh: data.refresh_token || old.refresh, // Spotify a veces manda uno nuevo; si no, sigue valiendo el anterior
      expiresAt: Date.now() + (data.expires_in - 60) * 1000
    };
    write(TOKENS_KEY, t);
    return t;
  }

  async function login() {
    const verifier = randomString(64), stateParam = randomString(16);
    write(PKCE_KEY, { verifier, state: stateParam });
    const q = new URLSearchParams({
      client_id: CLIENT_ID, response_type: "code", redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge_method: "S256", code_challenge: await challengeFor(verifier), state: stateParam
    });
    location.assign(ACCOUNTS + "/authorize?" + q);
  }

  function logout() { write(TOKENS_KEY, null); set({ state: "idle", name: null, error: null }); }

  async function accessToken() {
    const t = read(TOKENS_KEY);
    if (!t || !t.refresh) return null;
    if (t.access && Date.now() < t.expiresAt) return t.access;
    if (!refreshing) refreshing = tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })
      .catch(e => { if (e.code === "invalid_grant") write(TOKENS_KEY, null); throw e; })
      .finally(() => { refreshing = null; });
    return (await refreshing).access;
  }

  /* Llamada a la Web API con el token al día. Devuelve el JSON (o null si la respuesta viene vacía). */
  async function api(path, opts = {}, retried = false) {
    const token = await accessToken();
    if (!token) { set({ state: "idle", name: null }); throw new Error("No hay sesión de Spotify"); }
    const res = await fetch(API + path, { ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (res.status === 401 && !retried) { const t = read(TOKENS_KEY); if (t) { t.expiresAt = 0; write(TOKENS_KEY, t); } return api(path, opts, true); }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) { const e = new Error((data && data.error && data.error.message) || "HTTP " + res.status); e.status = res.status; e.reason = data && (data.reason || (data.error && data.error.reason)); throw e; }
    return data;
  }

  function friendly(e) {
    if (e.status === 403) return "Spotify no deja usar la app con esta cuenta. Revisá que esté cargada en User Management del dashboard y que el dueño de la app tenga Premium.";
    if (e.status === 429) return e.reason === "QUOTA_EXCEEDED" ? "Se agotó el cupo diario de la app en Spotify. Probá más tarde." : "Spotify pidió esperar un poco. Probá en un minuto.";
    if (e.code === "invalid_grant") return "La sesión de Spotify venció. Conectá de nuevo.";
    return "No se pudo hablar con Spotify (" + e.message + ").";
  }

  async function loadProfile() {
    set({ state: "working", error: null });
    try { const me = await api("/me"); set({ state: "connected", name: me.display_name || me.id, error: null }); }
    catch (e) { set({ state: read(TOKENS_KEY) ? "error" : "idle", error: friendly(e) }); }
  }

  /* Al cargar la página: si volvemos del login de Spotify, cambiamos el código por los tokens. */
  async function init(cb) {
    onChange = cb || onChange;
    const url = new URL(location.href), code = url.searchParams.get("code"), err = url.searchParams.get("error");
    if (code || err) {
      const pkce = read(PKCE_KEY), back = url.searchParams.get("state");
      write(PKCE_KEY, null);
      history.replaceState(null, "", url.pathname);
      if (err) { set({ state: "error", error: err === "access_denied" ? "Cancelaste el login de Spotify." : "Spotify devolvió un error: " + err }); return; }
      if (!pkce || pkce.state !== back) { set({ state: "error", error: "El login no coincide con el que se pidió. Probá conectar de nuevo." }); return; }
      set({ state: "working", error: null });
      try { await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pkce.verifier }); }
      catch (e) { set({ state: "error", error: friendly(e) }); return; }
    }
    if (read(TOKENS_KEY)) await loadProfile();
  }

  /* ---------- Spotify Connect: dispositivos y reproducción ---------- */
  const DEVICE_KEY = "hitster-spotify-device";
  const CACHE_KEY = "hitster-spotify-found"; // temas encontrados por la búsqueda provisoria
  const lastDevice = () => read(DEVICE_KEY);
  const rememberDevice = d => write(DEVICE_KEY, d && { id: d.id, name: d.name });

  async function devices() {
    const d = await api("/me/player/devices");
    return (d && d.devices) || [];
  }

  /* Búsqueda provisoria hasta que el punto 4 complete los IDs verificados en songs.json:
     evita remasters, vivos y compilados, y entre lo que queda se queda con el lanzamiento más viejo. */
  const LIVE = /en vivo|\bvivo\b|\blive\b|directo|concierto|\bgira\b|tour|en obras|unplugged|ac[uú]stic|sesi[oó]n|demo|karaoke|instrumental|\bmix\b|\bedit\b/i;
  const COMP = /[eé]xitos|grandes|obras cumbres|obras fundamentales|lo mejor|antolog|best of|colecci[oó]n|\bhits\b|esencial/i;
  const REMASTER = /remaster/i;
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const base = s => norm(s.split(/ - |\(/)[0]); // "Nada Personal - Remasterizado 2007" -> "nada personal"
  async function searchTrack(s) {
    const find = async (q, offset = 0) => { const d = await api("/search?" + new URLSearchParams({ q, type: "track", limit: "10", offset: String(offset) })); return (d && d.tracks && d.tracks.items) || []; };
    const strict = `track:${s.t} artist:${s.a}`;
    let items = [...await find(strict), ...await find(strict, 10)];
    if (!items.length) items = await find(`${s.t} ${s.a}`); // segundo intento, menos estricto
    const want = base(s.t), artist = norm(s.a);
    const pool = items.filter(t => {
      const got = base(t.name);
      const titleOk = got === want || got.replace(/^el |^la |^los |^las /, "") === want.replace(/^el |^la |^los |^las /, "");
      const artistOk = t.artists.some(a => norm(a.name).includes(artist) || artist.includes(norm(a.name)));
      return titleOk && artistOk;
    });
    const score = t => (LIVE.test(t.name) || LIVE.test(t.album.name) ? 8 : 0)
      + (t.album.album_type === "compilation" || COMP.test(t.album.name) ? 4 : 0)
      + (/feat\.|\bft\.|\bcon\b.*\)/i.test(t.name) ? 4 : 0)
      + (norm(t.name) !== base(t.name) && !REMASTER.test(t.name) ? 3 : 0) // algo extra en el título: "(SEP7IMO DIA)", "- Versión 2010"...
      + (REMASTER.test(t.name) || REMASTER.test(t.album.name) ? 1 : 0);
    pool.sort((x, y) => score(x) - score(y) || String(x.album.release_date).localeCompare(String(y.album.release_date)));
    return pool[0] || null;
  }

  async function resolve(s) {
    if (s.spotify) {
      return { uri: "spotify:track:" + s.spotify, dur: s.dur || null, id: s.spotify };
    }
    const cache = read(CACHE_KEY) || {}, key = s.a + " — " + s.t;
    if (cache[key]) return cache[key];
    const t = await searchTrack(s);
    if (!t) { const e = new Error("No encontré el tema en Spotify"); e.notFound = true; throw e; }
    cache[key] = { uri: t.uri, dur: t.duration_ms, id: t.id, name: t.name, album: t.album.name, date: t.album.release_date };
    write(CACHE_KEY, cache);
    return cache[key];
  }

  /* Pone el tema en el dispositivo elegido. mode: "begin" (desde el principio) o "random" (punto al azar). */
  async function play(s, deviceId, mode) {
    const r = await resolve(s);
    let pos = 0;
    if (mode === "random") {
      let dur = r.dur;
      if (!dur) { const t = await api("/tracks/" + r.id); dur = t.duration_ms; }
      const from = 20000, to = Math.max(from, dur - 40000);
      pos = Math.floor(from + Math.random() * (to - from));
    }
    await api("/me/player/play?device_id=" + encodeURIComponent(deviceId), { method: "PUT", body: JSON.stringify({ uris: [r.uri], position_ms: pos }) });
  }

  async function pause(deviceId) {
    try { await api("/me/player/pause?device_id=" + encodeURIComponent(deviceId), { method: "PUT" }); } catch (e) {}
  }

  function playError(e) {
    if (e.notFound) return "No encontré este tema en Spotify.";
    if (e.status === 404) return "No encuentro el dispositivo. Abrí la app de Spotify en la tablet y reintentá.";
    if (e.status === 403) return "Spotify no dejó reproducir (hace falta Premium y que el dispositivo se pueda controlar).";
    return friendly(e);
  }

  return { init, login, logout, api, status, connected: () => status.state === "connected",
    devices, play, pause, playError, lastDevice, rememberDevice, resolve };
})();
