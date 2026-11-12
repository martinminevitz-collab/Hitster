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

  return { init, login, logout, api, status, connected: () => status.state === "connected" };
})();
