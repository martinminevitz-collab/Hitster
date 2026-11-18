/* Usuarios y ranking del Hitster.
   Cada partida terminada se guarda acá (en el dispositivo) y, si hay base online configurada,
   también se sube ahí para que el ranking sea el mismo en la tablet y en la compu.
   Sin conexión no se pierde nada: lo que falta subir queda en cola y se manda la próxima vez. */
const Ranking = (() => {
  // Base online (Firebase Realtime Database). Vacío = solo en este dispositivo.
  const DB_URL = "";
  const LOCAL = "hitster-ranking", PEND = "hitster-ranking-pend";

  const clave = n => String(n).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
  const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k) || "null") || def; } catch (e) { return def; } };
  const escribir = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const datos = () => { const d = leer(LOCAL, {}); d.usuarios = d.usuarios || {}; d.partidas = d.partidas || {}; return d; };
  const idDe = k => k.replace(/[.#$/\[\]]/g, "_"); // las claves de Firebase no admiten esos caracteres
  const porDefecto = n => /^jugador \d+$/.test(clave(n));

  let estado = { sync: DB_URL ? "pendiente" : "local", error: null };
  const avisos = new Set();
  const avisar = () => avisos.forEach(f => { try { f(); } catch (e) {} });

  function registrar(nombres) {
    const d = datos();
    for (const n of nombres) {
      const k = clave(n);
      if (!k || porDefecto(n)) continue;
      const id = idDe(k);
      if (!d.usuarios[id]) d.usuarios[id] = { nombre: n.trim(), alta: new Date().toISOString() };
      encolar("usuarios/" + id, d.usuarios[id]);
    }
    escribir(LOCAL, d);
    sincronizar();
  }

  function guardarPartida(p) {
    const d = datos(), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    d.partidas[id] = p;
    escribir(LOCAL, d);
    encolar("partidas/" + id, p);
    sincronizar();
  }

  function encolar(ruta, valor) { const q = leer(PEND, {}); q[ruta] = valor; escribir(PEND, q); }

  let enCurso = null;
  function sincronizar() {
    if (!DB_URL) return Promise.resolve();
    if (enCurso) return enCurso;
    estado = { sync: "sincronizando", error: null }; avisar();
    enCurso = (async () => {
      try {
        const q = leer(PEND, {});
        const rutas = Object.keys(q);
        if (rutas.length) {
          // un solo PATCH con todo lo que falta subir
          const r = await fetch(`${DB_URL}/hitster.json`, { method: "PATCH", body: JSON.stringify(q) });
          if (!r.ok) throw new Error("La base respondió " + r.status);
          const ahora = leer(PEND, {});
          for (const k of rutas) if (JSON.stringify(ahora[k]) === JSON.stringify(q[k])) delete ahora[k];
          escribir(PEND, ahora);
        }
        const r = await fetch(`${DB_URL}/hitster.json`);
        if (!r.ok) throw new Error("La base respondió " + r.status);
        const remoto = (await r.json()) || {};
        const d = datos();
        Object.assign(d.usuarios, remoto.usuarios || {});
        Object.assign(d.partidas, remoto.partidas || {});
        escribir(LOCAL, d);
        estado = { sync: "ok", error: null };
      } catch (e) {
        estado = { sync: "error", error: "No se pudo conectar con el ranking online. Lo nuevo queda guardado y se sube después." };
      } finally { enCurso = null; avisar(); }
    })();
    return enCurso;
  }

  function usuarios() {
    const d = datos(), vistos = new Map();
    for (const u of Object.values(d.usuarios)) vistos.set(clave(u.nombre), u.nombre);
    for (const p of Object.values(d.partidas)) for (const j of p.jugadores || []) if (!porDefecto(j.nombre) && !vistos.has(clave(j.nombre))) vistos.set(clave(j.nombre), j.nombre);
    return [...vistos.values()].sort((a, b) => a.localeCompare(b, "es"));
  }

  // mazo: null = todas las partidas
  function tabla(mazo) {
    const filas = new Map();
    for (const p of Object.values(datos().partidas)) {
      if (mazo && p.mazo !== mazo) continue;
      for (const j of p.jugadores || []) {
        const k = clave(j.nombre);
        if (porDefecto(j.nombre)) continue; // "Jugador 3" no es nadie: no entra al ranking
        const f = filas.get(k) || { nombre: j.nombre, acertadas: 0, jugadas: 0, ganadas: 0, robos: 0, temas: 0 };
        f.acertadas += j.acertadas || 0; f.jugadas++; f.ganadas += j.gano ? 1 : 0; f.robos += j.robos || 0; f.temas += j.temas || 0;
        filas.set(k, f);
      }
    }
    return [...filas.values()].sort((a, b) => b.acertadas - a.acertadas || b.ganadas - a.ganadas || a.nombre.localeCompare(b.nombre, "es"));
  }

  function mazosJugados() { return [...new Set(Object.values(datos().partidas).map(p => p.mazo))]; }
  function partidas() { return Object.keys(datos().partidas).length; }

  return { registrar, guardarPartida, sincronizar, usuarios, tabla, mazosJugados, partidas, clave,
    online: () => !!DB_URL, estado: () => estado, alCambiar: f => avisos.add(f) };
})();
