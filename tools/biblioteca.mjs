#!/usr/bin/env node
/* Biblioteca de temas del Hitster.
 *
 * Qué hace:
 *  1. Lee cada lista de tools/mazos/*.txt (una por temática) y la junta en songs.json.
 *  2. Para cada tema que todavía no se revisó, busca el track en Spotify y elige la versión
 *     de estudio original (evita vivos, compilados, remixes; si solo hay remaster, lo usa y avisa).
 *  3. Verifica el año con MusicBrainz (first-release-date de la grabación).
 *  4. Escribe songs.json y revision.md con los temas para revisar a mano.
 *
 * Uso:
 *   node tools/biblioteca.mjs            procesa solo los temas nuevos o sin revisar
 *   node tools/biblioteca.mjs --todos    vuelve a procesar todos
 *   node tools/biblioteca.mjs --mazo rock-nacional   solo ese mazo
 *
 * La primera vez abre el navegador para loguearse en Spotify (usa la Redirect URI http://127.0.0.1:8080/,
 * así que el puerto 8080 tiene que estar libre). La sesión queda en tools/.spotify-token.json (no se sube al repo).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAZOS_DIR = path.join(ROOT, "tools", "mazos");
const SONGS = path.join(ROOT, "songs.json");
const REVISION = path.join(ROOT, "revision.md");
const TOKEN_FILE = path.join(ROOT, "tools", ".spotify-token.json");

const CLIENT_ID = "558e39b6b7a24870bcfa5f52e80d27d2";
const REDIRECT = "http://127.0.0.1:8080/";
const MB_UA = "HitsterSongCheck/1.0 (uso personal, no comercial)";

const args = process.argv.slice(2);
const TODOS = args.includes("--todos");
const SOLO_MAZO = args.includes("--mazo") ? args[args.indexOf("--mazo") + 1] : null;
const SIN_BUSCAR = args.includes("--sin-buscar"); // no usa internet: solo recalcula el informe con lo ya guardado

/* Qué motivos siguen pendientes, teniendo en cuenta lo que ya se confirmó a mano en la lista. */
function pendientesDe(t) {
  const o = t.opciones || {};
  return (t.verificacion?.motivos || []).filter(x =>
    x !== "solo_remaster" &&
    !(o.okAnio && (x === "anio_distinto" || x === "no_musicbrainz")) &&
    !(o.okVersion && (x.startsWith("version_dudosa") || x === "disco_posterior")));
}
const estado = t => (pendientesDe(t).length ? "revisar" : "ok");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const base = s => norm(String(s).split(/ - |\(|\[/)[0]);
const sinArticulo = s => s.replace(/^(el|la|los|las) /, "");
const mismoTitulo = (a, b) => { const x = base(a), y = base(b); return x === y || sinArticulo(x) === sinArticulo(y); };
const mismoArtista = (nombres, artista) => { const a = norm(artista); return nombres.some(n => { const m = norm(n); return m === a || m.includes(a) || a.includes(m); }); };
const anio = fecha => (fecha ? parseInt(String(fecha).slice(0, 4), 10) || null : null);

/* ---------------- listas de mazos -> songs.json ---------------- */
function leerMazos() {
  const mazos = [], temas = [];
  for (const f of fs.readdirSync(MAZOS_DIR).filter(f => f.endsWith(".txt")).sort()) {
    const id = f.replace(/\.txt$/, "");
    let nombre = id;
    let n = 0;
    for (const linea of fs.readFileSync(path.join(MAZOS_DIR, f), "utf8").split(/\r?\n/)) {
      const l = linea.trim();
      if (!l) continue;
      if (l.startsWith("#")) { const m = l.match(/^#\s*nombre:\s*(.+)$/i); if (m) nombre = m[1].trim(); continue; }
      const [artista, titulo, a, opc = ""] = l.split("|").map(x => x.trim());
      if (!artista || !titulo) { console.warn(`  Línea ignorada en ${f}: ${l}`); continue; }
      n++;
      // 4ª columna opcional, separada por comas: fuera · ok-año · ok-versión · spotify:ID (o link de Spotify)
      const o = opc.split(",").map(x => x.trim()).filter(Boolean);
      const sp = o.find(x => /^spotify:|open\.spotify\.com\/track\//i.test(x));
      temas.push({ mazo: id, artista, titulo, anio: parseInt(a, 10) || null,
        opciones: { fuera: o.includes("fuera"), okAnio: o.some(x => norm(x) === "ok ano" || norm(x) === "ok anio"), okVersion: o.some(x => norm(x) === "ok version"),
          spotify: sp ? sp.replace(/^spotify:(track:)?/i, "").replace(/^.*\/track\//, "").replace(/\?.*$/, "") : null } });
    }
    mazos.push({ id, nombre, temas: n });
  }
  return { mazos, temas };
}

function combinar(previo, lista) {
  const clave = t => `${t.mazo}|${norm(t.artista)}|${norm(t.titulo)}`;
  const viejos = new Map((previo?.temas || []).map(t => [clave(t), t]));
  const contador = {};
  const temas = lista.temas.map(t => {
    contador[t.mazo] = (contador[t.mazo] || 0) + 1;
    const v = viejos.get(clave(t));
    // si ya existía, se conserva lo verificado (y el año que se haya corregido a mano en songs.json)
    const opciones = t.opciones;
    // si cambió el ID fijado a mano, hay que volver a verificar ese tema
    if (v) return { ...v, artista: t.artista, titulo: t.titulo, anio: t.anio, fuera: opciones.fuera, opciones,
      verificacion: opciones.spotify && v.verificacion?.spotify?.id !== opciones.spotify ? null : v.verificacion }; // el año manda la lista .txt
    return { id: `${t.mazo}-${String(contador[t.mazo]).padStart(3, "0")}`, mazo: t.mazo, artista: t.artista, titulo: t.titulo, anio: t.anio, fuera: opciones.fuera, opciones, spotify: null, duracion_ms: null, verificacion: null };
  });
  // ids únicos aunque se haya reordenado la lista
  const usados = new Set();
  for (const t of temas) { let id = t.id, k = 1; while (usados.has(id)) id = `${t.id}-${++k}`; t.id = id; usados.add(id); }
  return { mazos: lista.mazos.map(({ id, nombre }) => ({ id, nombre })), temas };
}

/* ---------------- Spotify: login PKCE con servidor local ---------------- */
const leerToken = () => { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch { return null; } };
const guardarToken = t => fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));

async function pedirToken(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify token: ${d.error_description || d.error || res.status}`);
  const viejo = leerToken() || {};
  const t = { access: d.access_token, refresh: d.refresh_token || viejo.refresh, expiresAt: Date.now() + (d.expires_in - 60) * 1000 };
  guardarToken(t);
  return t;
}

function loginEnNavegador() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(8).toString("hex");
  const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT, code_challenge_method: "S256", code_challenge: challenge, state
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== "/" || (!u.searchParams.get("code") && !u.searchParams.get("error"))) { res.writeHead(404); res.end(); return; }
      const listo = msg => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<p style="font:18px system-ui;padding:24px">${msg}</p>`); server.close(); };
      if (u.searchParams.get("error") || u.searchParams.get("state") !== state) { listo("No se pudo conectar con Spotify. Volvé a la terminal."); reject(new Error("Login cancelado o inválido")); return; }
      try { const t = await pedirToken({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT, code_verifier: verifier }); listo("Listo, ya podés cerrar esta pestaña y volver a la terminal."); resolve(t); }
      catch (e) { listo("Falló el login. Mirá la terminal."); reject(e); }
    });
    server.on("error", e => reject(e.code === "EADDRINUSE" ? new Error("El puerto 8080 está ocupado (¿quedó abierto el servidor local del juego?). Cerralo y probá de nuevo.") : e));
    server.listen(8080, "127.0.0.1", () => {
      console.log("\nSe abre el navegador para entrar a Spotify. Si no se abre, copiá esta dirección:\n" + url + "\n");
      exec(process.platform === "win32" ? `start "" "${url}"` : `open "${url}"`);
    });
  });
}

async function token() {
  let t = leerToken();
  if (t && t.access && Date.now() < t.expiresAt) return t.access;
  if (t && t.refresh) { try { return (await pedirToken({ grant_type: "refresh_token", refresh_token: t.refresh })).access; } catch (e) { console.log("La sesión guardada venció, hay que loguearse de nuevo."); } }
  return (await loginEnNavegador()).access;
}

async function spotify(ruta) {
  for (let intento = 0; intento < 5; intento++) {
    const res = await fetch("https://api.spotify.com/v1" + ruta, { headers: { Authorization: "Bearer " + await token() } });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      const espera = (parseInt(res.headers.get("retry-after"), 10) || 2) * 1000;
      if ((d.reason || d.error?.reason) === "QUOTA_EXCEEDED" || espera > 120000)
        throw new Error(`Se agotó el cupo diario de Spotify (se libera en ${Math.ceil(espera / 3600000)} h aprox.). Volvé a correr el script después: sigue desde donde quedó.`);
      console.log(`  Spotify pidió esperar ${espera / 1000}s…`); await sleep(espera); continue;
    }
    if (res.status === 401) { const t = leerToken(); if (t) { t.expiresAt = 0; guardarToken(t); } continue; }
    if (!res.ok) throw new Error(`Spotify ${res.status} en ${ruta}`);
    return res.json();
  }
  throw new Error("Spotify no respondió después de varios intentos");
}

/* ---------------- elegir la versión de estudio original ---------------- */
const VIVO = /en vivo|\bvivo\b|\blive\b|directo|concierto|\bgira\b|\btour\b|en obras|unplugged|ac[uú]stic|sesi[oó]n|\bdemo\b|karaoke|instrumental|\bmix\b|remix|\bedit\b|versi[oó]n|version/i;
const COMPILADO = /[eé]xitos|grandes|obras cumbres|obras fundamentales|lo mejor|antolog|best of|colecci[oó]n|\bhits\b|esencial|\bcaja\b|box set|tributo|homenaje/i;
const REMASTER = /remaster/i;

function puntaje(t, titulo) {
  const motivos = [];
  let p = 0;
  if (VIVO.test(t.name) || VIVO.test(t.album.name)) { p += 8; motivos.push("vivo/versión"); }
  if (t.album.album_type === "compilation" || COMPILADO.test(t.album.name)) { p += 4; motivos.push("compilado"); }
  if (/feat\.|\bft\.|\(con /i.test(t.name)) { p += 4; motivos.push("con invitado"); }
  const igual = sinArticulo(norm(t.name)) === sinArticulo(norm(titulo)); // "Muchacha (Ojos de Papel)" es el nombre real, no un agregado
  if (!igual && norm(t.name) !== base(t.name) && !REMASTER.test(t.name) && !VIVO.test(t.name)) { p += 3; motivos.push("título con agregado"); }
  if (REMASTER.test(t.name) || REMASTER.test(t.album.name)) { p += 1; motivos.push("remaster"); }
  return { p, motivos };
}

async function buscarEnSpotify(t) {
  const buscar = async (q, offset = 0) => (await spotify("/search?" + new URLSearchParams({ q, type: "track", limit: "10", offset: String(offset) })))?.tracks?.items || [];
  const estricta = `track:${base(t.titulo) === norm(t.titulo) ? t.titulo : t.titulo.split(/ - |\(/)[0].trim()} artist:${t.artista}`;
  // para cuidar el cupo diario: solo pide más páginas si en la primera no hay una versión limpia
  const sirve = x => mismoTitulo(x.name, t.titulo) && mismoArtista(x.artists.map(a => a.name), t.artista);
  let items = await buscar(estricta);
  for (const offset of [10, 20]) {
    if (items.some(x => sirve(x) && puntaje(x, t.titulo).p === 0)) break;
    const mas = await buscar(estricta, offset); items.push(...mas); if (mas.length < 10) break;
  }
  let candidatos = items.filter(sirve);
  if (!candidatos.length) {
    items = [...await buscar(`${t.titulo} ${t.artista}`), ...await buscar(`${t.titulo} ${t.artista}`, 10)];
    candidatos = items.filter(x => mismoTitulo(x.name, t.titulo) && mismoArtista(x.artists.map(a => a.name), t.artista));
  }
  const vistos = new Set();
  candidatos = candidatos.filter(x => !vistos.has(x.id) && vistos.add(x.id)).map(x => ({ x, ...puntaje(x, t.titulo) }));
  candidatos.sort((a, b) => a.p - b.p || String(a.x.album.release_date).localeCompare(String(b.x.album.release_date)));
  return candidatos[0] || null;
}

/* ---------------- MusicBrainz: año de la primera edición ---------------- */
let ultimoMB = 0;
async function mb(ruta) {
  for (let intento = 0; intento < 4; intento++) {
    const espera = 1100 - (Date.now() - ultimoMB); if (espera > 0) await sleep(espera); // máximo 1 pedido por segundo
    ultimoMB = Date.now();
    const res = await fetch("https://musicbrainz.org/ws/2" + ruta, { headers: { "User-Agent": MB_UA, Accept: "application/json" } });
    if (res.status === 503 || res.status === 429) { await sleep(2500); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    return res.json();
  }
  return null;
}
const lucene = s => String(s).replace(/[\\"]/g, " ");
const VIVO_MB = /live|en vivo|vivo|directo|demo|remix|version|versión|acoustic|acústic|instrumental|karaoke|ensayo/i;

async function anioMusicBrainz(t, isrc) {
  const fechas = [];
  if (isrc) {
    const d = await mb(`/isrc/${encodeURIComponent(isrc)}?fmt=json&inc=artist-credits`);
    for (const r of d?.recordings || []) if (r["first-release-date"] && mismoTitulo(r.title, t.titulo)) fechas.push({ fecha: r["first-release-date"], id: r.id, via: "isrc" });
  }
  const q = `recording:"${lucene(t.titulo.split(/ - |\(/)[0].trim())}" AND artist:"${lucene(t.artista)}"`;
  const d = await mb(`/recording?fmt=json&limit=50&query=${encodeURIComponent(q)}`);
  for (const r of d?.recordings || []) {
    if (!r["first-release-date"] || r.video) continue;
    if (!mismoTitulo(r.title, t.titulo)) continue;
    if (!mismoArtista((r["artist-credit"] || []).map(a => a.name || a.artist?.name || ""), t.artista)) continue;
    if (VIVO_MB.test(r.disambiguation || "") || VIVO_MB.test(r.title.replace(base(r.title), ""))) continue;
    fechas.push({ fecha: r["first-release-date"], id: r.id, via: "búsqueda" });
  }
  fechas.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return fechas[0] || null;
}

/* ---------------- proceso de cada tema ---------------- */
async function verificar(t) {
  const v = { fecha: new Date().toISOString().slice(0, 10), estado: "ok", motivos: [] };
  let elegido = null;
  if (t.opciones?.spotify) { // ID fijado a mano: no gasta búsquedas
    const x = await spotify("/tracks/" + encodeURIComponent(t.opciones.spotify));
    elegido = { x, p: 0, motivos: ["elegido a mano"] };
  }
  else try { elegido = await buscarEnSpotify(t); } catch (e) { if (/cupo/.test(e.message)) throw e; v.motivos.push("error al buscar en Spotify: " + e.message); }
  if (elegido) {
    const x = elegido.x;
    v.spotify = { id: x.id, nombre: x.name, artistas: x.artists.map(a => a.name).join(", "), disco: x.album.name, tipo: x.album.album_type, fecha: x.album.release_date, isrc: x.external_ids?.isrc || null };
    t.spotify = x.id; t.duracion_ms = x.duration_ms;
    if (elegido.motivos.includes("remaster") && elegido.p === 1) v.motivos.push("solo_remaster");
    if (elegido.p >= 3) v.motivos.push("version_dudosa: " + elegido.motivos.join(", "));
  } else { t.spotify = null; t.duracion_ms = null; v.motivos.push("no_spotify"); }

  const m = await anioMusicBrainz(t, v.spotify?.isrc).catch(e => { v.motivos.push("error en MusicBrainz: " + e.message); return null; });
  if (m) { v.musicbrainz = { fecha: m.fecha, grabacion: m.id, via: m.via }; v.anio_mb = anio(m.fecha); }
  else if (!v.motivos.some(x => x.startsWith("error en MusicBrainz"))) v.motivos.push("no_musicbrainz");

  if (v.anio_mb && t.anio && v.anio_mb !== t.anio) v.motivos.push(`anio_distinto`);
  const anioDisco = anio(v.spotify?.fecha);
  const esRemaster = REMASTER.test(v.spotify?.nombre || "") || REMASTER.test(v.spotify?.disco || "");
  if (v.anio_mb && anioDisco && anioDisco > v.anio_mb + 1 && !esRemaster && !v.motivos.some(x => x.startsWith("version_dudosa"))) v.motivos.push("disco_posterior");
  t.verificacion = v;
  v.estado = estado(t);
}

/* ---------------- informe ---------------- */
function informe(data) {
  const temas = data.temas;
  const sp = t => t.verificacion?.spotify ? `${t.verificacion.spotify.disco} (${t.verificacion.spotify.fecha})` : "—";
  const fila = t => `| ${t.artista} | ${t.titulo} |`;
  const grupo = (titulo, explicacion, lista, cols, celdas) => lista.length
    ? `\n## ${titulo} (${lista.length})\n\n${explicacion}\n\n| Artista | Tema | ${cols.join(" | ")} |\n|---|---|${cols.map(() => "---").join("|")}|\n${lista.map(t => fila(t) + " " + celdas(t).join(" | ") + " |").join("\n")}\n`
    : "";
  const activos = temas.filter(t => !t.fuera);
  const con = m => activos.filter(t => t.verificacion && pendientesDe(t).some(x => x.startsWith(m)));
  const listos = activos.filter(t => t.verificacion && t.spotify && estado(t) === "ok").length;
  const sinProcesar = activos.filter(t => !t.verificacion);
  const fuera = temas.filter(t => t.fuera);
  return `# Revisión de la biblioteca de temas

Generado el ${new Date().toISOString().slice(0, 10)} por \`node tools/biblioteca.mjs\`.

**${temas.length} temas** en ${data.mazos.length} mazo(s) · **${listos} listos para jugar** · ${activos.filter(t => t.verificacion && estado(t) === "revisar").length} para revisar · ${sinProcesar.length} sin procesar · ${fuera.length} fuera del mazo.

Las correcciones se hacen en \`tools/mazos/*.txt\`: el año en la 3ª columna, y en la 4ª (opcional, separadas por comas) \`fuera\`, \`ok-año\`, \`ok-versión\` o \`spotify:ID\` / link de Spotify para fijar la versión a mano.
` +
    grupo("Todavía sin procesar", "Se procesan la próxima vez que se corra el script.", sinProcesar, ["Año del juego"], t => [t.anio]) +
    grupo("No los encontré en Spotify", "Estos temas no tienen ID y no van a sonar. Puede ser un error en el nombre o que no estén en Spotify.", con("no_spotify"), ["Año del juego"], t => [t.anio]) +
    grupo("El año no coincide", "El año del juego es distinto del primer lanzamiento según MusicBrainz. Decidí cuál queda.", con("anio_distinto"), ["Año del juego", "MusicBrainz", "Disco en Spotify"], t => [t.anio, t.verificacion.musicbrainz.fecha, sp(t)]) +
    grupo("Versión dudosa en Spotify", "No encontré una versión de estudio limpia: lo que quedó parece vivo, compilado, remix o con invitado.", con("version_dudosa"), ["Qué tiene", "Track elegido", "Disco"], t => [t.verificacion.motivos.find(x => x.startsWith("version_dudosa")).replace("version_dudosa: ", ""), t.verificacion.spotify.nombre, sp(t)]) +
    grupo("El disco de Spotify es posterior al original", "El track elegido es de un disco más nuevo que el primer lanzamiento. Puede ser una regrabación o una reedición.", con("disco_posterior"), ["MusicBrainz", "Track elegido", "Disco"], t => [t.verificacion.musicbrainz.fecha, t.verificacion.spotify.nombre, sp(t)]) +
    grupo("No encontré el año en MusicBrainz", "No hay dato para verificar: queda el año del juego.", con("no_musicbrainz"), ["Año del juego", "Disco en Spotify"], t => [t.anio, sp(t)]) +
    grupo("Solo hay remaster (aviso)", "No hay versión sin remasterizar: se usa el remaster del disco original. No hace falta hacer nada.", activos.filter(t => t.verificacion?.motivos.includes("solo_remaster")), ["Track elegido", "Disco"], t => [t.verificacion.spotify.nombre, sp(t)]) +
    grupo("Fuera del mazo", "Marcados con `fuera` en la lista: no salen en el juego. Para volver a sumarlos, pasá un link de Spotify con `spotify:` y sacá `fuera`.", fuera, ["Año del juego", "Qué pasaba"], t => [t.anio, (t.verificacion?.motivos || []).filter(x => x !== "solo_remaster").join(", ").replace(/_/g, " ") || "—"]) +
    temas.filter(t => t.verificacion?.motivos.some(x => x.startsWith("error"))).map(t => `\n- Error con ${t.artista} – ${t.titulo}: ${t.verificacion.motivos.filter(x => x.startsWith("error")).join("; ")}`).join("");
}

/* ---------------- principal ---------------- */
async function main() {
  const previo = fs.existsSync(SONGS) ? JSON.parse(fs.readFileSync(SONGS, "utf8")) : null;
  const data = combinar(previo, leerMazos());
  // si se corrigió un año en la lista, se recalcula sin volver a buscar
  for (const t of data.temas) {
    const v = t.verificacion; if (!v) continue;
    v.motivos = v.motivos.filter(x => x !== "anio_distinto");
    if (v.anio_mb && t.anio && v.anio_mb !== t.anio) v.motivos.push("anio_distinto");
    v.estado = estado(t);
  }
  const pendientes = data.temas.filter(t => !t.fuera && (!SOLO_MAZO || t.mazo === SOLO_MAZO) && (TODOS || !t.verificacion || t.verificacion.motivos.some(x => x.startsWith("error"))));
  if (SIN_BUSCAR) { pendientes.length = 0; console.log("--sin-buscar: solo se regeneran songs.json y revision.md."); }
  console.log(`${data.temas.length} temas en total, ${pendientes.length} para procesar.`);
  const guardar = () => { fs.writeFileSync(SONGS, JSON.stringify(data, null, 2) + "\n"); fs.writeFileSync(REVISION, informe(data)); };
  if (pendientes.length) await token();
  let i = 0;
  for (const t of pendientes) {
    i++;
    process.stdout.write(`[${i}/${pendientes.length}] ${t.artista} – ${t.titulo}… `);
    try { await verificar(t); }
    catch (e) { console.log("\n" + e.message); guardar(); process.exit(1); }
    console.log(t.verificacion.estado === "ok" ? "ok" : "revisar (" + t.verificacion.motivos.join(", ") + ")");
    if (i % 10 === 0) guardar(); // va guardando por si se corta
  }
  guardar();
  const act = data.temas.filter(t => !t.fuera);
  const listos = act.filter(t => t.verificacion && t.spotify && estado(t) === "ok").length;
  const rev = act.filter(t => t.verificacion && estado(t) === "revisar").length;
  console.log(`\nListo. ${listos} listos para jugar, ${rev} para revisar, ${act.filter(t => !t.verificacion).length} sin procesar, ${data.temas.length - act.length} fuera. Mirá revision.md.`);
}
main().catch(e => { console.error("\nError: " + e.message); process.exit(1); });
