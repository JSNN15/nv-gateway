// Intermediario entre las páginas de jsnn15.github.io y la API de NVIDIA.
// La clave vive solo aquí, como secreto NVIDIA_API_KEY. Cada ruta arma su propio prompt:
// no es un proxy abierto, solo hace las tareas fijas de las páginas.
const ORIGINS = ['https://jsnn15.github.io', 'http://localhost:8770', 'http://127.0.0.1:8770'];
const BASE = 'https://integrate.api.nvidia.com/v1';
const VLM = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const LLM = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const EMB = 'nvidia/nemotron-3.5-embed-1b';
const MAX_IMG = 1_600_000; // largo máximo del dataURL (≈1,2 MB de JPEG)
const hits = new Map(); // límite por IP (por instancia; NVIDIA limita además a 40/min)

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', ...cors(origin)},
  });
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const limited = (key, per = 12) => {
  const now = Date.now(),
    w = (hits.get(key) || []).filter((t) => now - t < 60_000);
  w.push(now);
  hits.set(key, w);
  if (hits.size > 5000) hits.clear();
  return w.length > per;
};

async function nv(env, path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.NVIDIA_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`nvidia ${r.status}: ${t.slice(0, 160)}`);
  }
  return r.json();
}
const chat = async (env, model, messages, max_tokens = 900, temperature = 0.2) => {
  const d = await nv(env, '/chat/completions', {
    model,
    messages,
    max_tokens,
    temperature,
    stream: false,
    chat_template_kwargs: {enable_thinking: false},
  });
  return d.choices[0].message.content || '';
};
// Texto: el modelo grande se apega mejor a los datos; si falla o tarda más de 25 s, responde el rápido
const smart = async (env, messages, max_tokens, temperature) => {
  try {
    const out = await Promise.race([
      chat(env, VLM, messages, max_tokens, temperature),
      new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 25000)),
    ]);
    if (out.trim()) return {model: VLM, out};
  } catch {}
  return {model: LLM, out: await chat(env, LLM, messages, max_tokens, temperature)};
};
// Extrae el primer objeto JSON de la respuesta del modelo
const parseJSON = (s) => {
  const a = s.indexOf('{'),
    b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('respuesta sin JSON');
  const t = s.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' '));
  }
};
// Llama al modelo de visión y, si la respuesta no trae un JSON válido, reintenta una vez
const visionJSON = async (env, prompt, image, max_tokens, temperature) => {
  const msgs = [
    {
      role: 'user',
      content: [
        {type: 'text', text: prompt},
        {type: 'image_url', image_url: {url: image}},
      ],
    },
  ];
  try {
    return parseJSON(await chat(env, VLM, msgs, max_tokens, temperature));
  } catch {
    return parseJSON(await chat(env, VLM, msgs, max_tokens, 0.2));
  }
};
const img = (u) => {
  if (typeof u !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(u) || u.length > MAX_IMG)
    throw new Error('imagen inválida o muy grande');
  return u;
};
const clip = (s, n) => String(s || '').slice(0, n);

const P_INSPECT = {
  tablero: 'un tablero o gabinete eléctrico',
  correa: 'una correa transportadora y sus polines, tambores y estructura',
  equipo: 'un equipo industrial (motor, bomba, reductor, cañería, válvula o estructura)',
  general: 'una instalación industrial o de faena',
};
const inspectPrompt = (
  kind
) => `Eres un inspector senior de mantenimiento y seguridad en minería e industria. La foto muestra ${P_INSPECT[kind] || P_INSPECT.general}.
Revisa la foto y entrega SOLO un objeto JSON, en español de Chile, con esta forma:
{"resumen": "una o dos frases sobre el estado general",
 "estado": "bueno" | "observaciones" | "critico",
 "hallazgos": [{"titulo": "corto", "detalle": "qué se ve y por qué importa", "severidad": "alta" | "media" | "baja", "accion": "qué hacer, concreto", "caja": [x1, y1, x2, y2]}],
 "no_se_puede_evaluar": "lo que la foto no permite confirmar"}
Reglas: caja en coordenadas normalizadas de 0 a 1000 sobre la imagen (x1,y1 arriba a la izquierda). Máximo 6 hallazgos, ordenados por severidad. Describe solo lo que se ve; si algo es dudoso dilo en el detalle. Si la foto no es de una instalación industrial, devuelve hallazgos vacíos y explícalo en el resumen.`;
// EPP por sector: la lista vive en el servidor; la página solo elige el sector.
const EPP = {
  construccion: {
    n: 'construcción',
    items: [
      ['casco', 'casco de seguridad'],
      ['chaleco', 'chaleco o ropa reflectante'],
      ['calzado', 'calzado de seguridad'],
      ['guantes', 'guantes de trabajo'],
      ['lentes', 'lentes de seguridad'],
      ['arnes', 'arnés con línea de vida (solo si trabaja a más de 1,8 m o en borde abierto)'],
    ],
  },
  mineria: {
    n: 'minería (rajo o subterránea)',
    items: [
      ['casco', 'casco de seguridad (con lámpara en subterránea)'],
      ['chaleco', 'chaleco o ropa reflectante'],
      ['calzado', 'calzado de seguridad'],
      ['lentes', 'lentes de seguridad'],
      ['guantes', 'guantes de trabajo'],
      ['auditiva', 'protección auditiva (si hay equipos ruidosos)'],
      ['respirador', 'respirador (si hay polvo o gases)'],
    ],
  },
  electrico: {
    n: 'trabajos eléctricos',
    items: [
      ['casco', 'casco dieléctrico'],
      ['guantes', 'guantes dieléctricos o de cuero según tarea'],
      ['careta', 'lentes o careta facial contra arco'],
      ['ropa', 'ropa ignífuga de manga larga'],
      ['calzado', 'calzado dieléctrico'],
      ['arnes', 'arnés (solo si trabaja en altura o en poste)'],
    ],
  },
  soldadura: {
    n: 'soldadura y metalmecánica',
    items: [
      ['careta', 'careta de soldar o protector facial'],
      ['lentes', 'lentes de seguridad'],
      ['guantes', 'guantes de cuero'],
      ['ropa', 'ropa ignífuga, coleto o delantal de cuero'],
      ['calzado', 'calzado de seguridad'],
      ['auditiva', 'protección auditiva (si esmerila o corta)'],
    ],
  },
  alimentos: {
    n: 'industria de alimentos',
    items: [
      ['cofia', 'cofia o gorro que cubra el pelo'],
      ['mascarilla', 'mascarilla'],
      ['guantes', 'guantes'],
      ['ropa', 'ropa de trabajo limpia o delantal'],
      ['calzado', 'botas o calzado de seguridad'],
    ],
  },
  agro: {
    n: 'agrícola',
    items: [
      ['guantes', 'guantes'],
      ['respirador', 'respirador o mascarilla (si aplica agroquímicos)'],
      ['lentes', 'lentes (si aplica agroquímicos)'],
      ['ropa', 'ropa de manga larga'],
      ['calzado', 'botas o calzado cerrado'],
      ['sombrero', 'protección solar (sombrero o legionario)'],
    ],
  },
  industrial: {
    n: 'planta industrial general',
    items: [
      ['casco', 'casco de seguridad'],
      ['lentes', 'lentes de seguridad'],
      ['guantes', 'guantes de trabajo'],
      ['calzado', 'calzado de seguridad'],
      ['chaleco', 'chaleco o ropa reflectante'],
      ['auditiva', 'protección auditiva (si hay ruido)'],
    ],
  },
};
const eppPrompt = (sec) => {
  const S = EPP[sec] || EPP.industrial;
  return `Eres un experto en prevención de riesgos laborales en Chile (DS 594, Ley 16.744). Revisas una foto de un trabajo en el sector ${S.n}.
EPP exigido en este sector, con su identificador: ${S.items.map(([k, d]) => `${k} = ${d}`).join('; ')}.
Para cada persona visible (máximo 8, primero las más grandes en la imagen) evalúa cada EPP de la lista. Entrega SOLO un objeto JSON en español de Chile:
{"resumen": "una o dos frases sobre el cumplimiento",
 "nivel": "cumple" | "observaciones" | "critico",
 "personas": [{"n": 1, "caja": [x1, y1, x2, y2], "actividad": "qué está haciendo, corto",
   "epp": {${S.items.map(([k]) => `"${k}": {"estado": "ok" | "falta" | "incorrecto" | "no_visible" | "no_aplica", "nota": "corta"}`).join(', ')}},
   "riesgo": "alto" | "medio" | "bajo", "accion": "qué corregir, concreto"}],
 "condiciones": [{"titulo": "corto", "detalle": "condición insegura visible", "severidad": "alta" | "media" | "baja", "caja": [x1, y1, x2, y2]}],
 "no_se_puede_evaluar": "lo que la foto no permite confirmar"}
Reglas: cajas en coordenadas normalizadas de 0 a 1000 (x1,y1 arriba a la izquierda), la caja de una persona la cubre de pies a cabeza. "no_visible" si esa parte del cuerpo no se ve o la persona está muy lejos para afirmarlo; "no_aplica" SOLO para los EPP que tienen una condición entre paréntesis y esa condición no se da (por ejemplo arnés sin trabajo en altura); los demás EPP siempre se exigen, así que si no se ven puestos es "falta". No adivines: ante la duda usa "no_visible". "incorrecto" es EPP presente pero mal usado (casco sin abrochar en altura, lentes en la frente, chaleco abierto). Riesgo alto si falta un EPP crítico para la tarea que hace. Condiciones: máximo 4, solo lo que se ve (trabajo en altura sin protección colectiva, chispas sin resguardo, orden y aseo). Si no hay personas, personas vacío y explícalo en el resumen.`;
};
const GAUGE_PROMPT = `Eres un instrumentista. La foto muestra un instrumento de aguja (manómetro, termómetro, amperímetro, voltímetro, etc.).
1) Lee la escala principal (si hay dos, la más grande o la exterior con números más grandes).
2) Lista TODOS los números impresos de esa escala, cada uno con la posición del centro del número en la imagen, en coordenadas normalizadas de 0 a 1000 (x a la derecha, y hacia abajo).
3) Estima el valor que marca la aguja.
Entrega SOLO un objeto JSON en español:
{"instrumento": "tipo", "unidad": "texto", "escala_min": número, "escala_max": número,
 "numeros": [{"v": número, "x": 0-1000, "y": 0-1000}],
 "valor_estimado": número o null, "confianza": "alta" | "media" | "baja", "problemas": "reflejos, ángulo, escala doble, etc., o vacío"}
Si no es un instrumento de aguja, numeros vacío y explícalo en problemas.`;
const TURNO_SYS = `Eres el asistente del jefe de turno en la sala de control de una planta de cobre LX-SX-EW (lixiviación en pilas, extracción por solventes y electroobtención). Recibes una foto instantánea del estado de la planta en JSON: alarmas activas con prioridad ISA-18.2, tags fuera de banda, tags clave, lazos PID, motores con novedad (vibración con su zona ISO 10816-3), rectificador, KPI del turno y la bitácora reciente (ahí aparece la falla simulada, si hay una).
Responde en español de Chile, breve y operativo:
1) La respuesta directa en una o dos frases.
2) Evidencia: solo los datos relevantes a la pregunta, citando tags con su valor (por ejemplo "VIT-M-103 = 5,1 mm/s, zona C"). No mezcles alarmas que no tienen relación.
3) Qué hace el operador ahora y qué hace mantenimiento.
Criterios: vibración zona B normal; zona C = operación restringida, programar la intervención en las próximas horas y vigilar la tendencia, sin detener de inmediato salvo que suba rápido; zona D = riesgo de daño, detener en forma controlada. Prioridad urgente o alta = actuar ya. Los cortocircuitos en celdas de EW se corrigen en operación (el operador de nave separa o retira el cátodo con herramienta aislada), no esperan una parada. Usa coma decimal. Usa solo los datos entregados; si algo no está en los datos, dilo. No inventes tags ni valores. Máximo 170 palabras, con viñetas cortas.`;
const RIC_SYS = `Eres un asesor en normativa eléctrica chilena (pliegos técnicos RIC de la SEC). Respondes en español de Chile usando SOLO los extractos entregados, numerados [1], [2], etc.
Primero la respuesta directa en una o dos frases completas (no solo un número), luego los detalles con la cita entre corchetes después de cada afirmación, por ejemplo: "La sección mínima es 2,5 mm² [2]". Cita solo con el número del extracto entre corchetes, nunca con números de sección. Cada afirmación debe llevar su cita [n]; si no puedes citarla, no la escribas. Si el dato preciso que se pregunta no aparece en los extractos, dilo en la primera frase. Si los extractos no alcanzan para responder, dilo claramente y sugiere qué pliego revisar. No inventes números ni artículos. Las tablas vienen extraídas de un PDF y pueden estar desordenadas: si no puedes leer una tabla con certeza, no deduzcas sus valores; di qué tabla del pliego revisar. Máximo 200 palabras. Termina con: "Verifica siempre en el pliego vigente publicado por la SEC."`;

// Supervisor normativo: la visión describe condiciones; las citas se eligen entre extractos recuperados en el navegador
const SUP = {
  electrico: {
    que: 'una instalación eléctrica: tablero, sala eléctrica, canalización o equipo eléctrico',
    normas: 'los pliegos RIC de la SEC, el DS 594 y el DS 132',
  },
  bodega: {
    que: 'una bodega o zona de almacenamiento de sustancias peligrosas (tambores, estanques, cilindros, productos químicos o combustibles)',
    normas: 'el DS 43 (almacenamiento de sustancias peligrosas) y el DS 594',
  },
  faena: {
    que: 'un área de trabajo de una faena minera, planta o taller: equipos, correas, máquinas, pasillos y accesos',
    normas: 'el DS 132 (seguridad minera) y el DS 594',
  },
};
const supPrompt = (
  t
) => `Eres supervisor de seguridad y salud en el trabajo en Chile. La foto debería mostrar ${SUP[t].que}.
Solo describes condiciones visibles; otra etapa buscará los artículos de ${SUP[t].normas}.
Entrega SOLO un objeto JSON, en español de Chile, con esta forma:
{"resumen": "una o dos frases sobre el estado general",
 "corresponde": true,
 "hallazgos": [{"titulo": "corto", "observacion": "qué se ve, concreto", "severidad": "alta" | "media" | "baja", "caja": [x1, y1, x2, y2], "busqueda": "la exigencia que parece no cumplirse, redactada como la diría un reglamento chileno, sin número de artículo"}],
 "cumple": ["condiciones visibles que sí están bien"],
 "no_evaluable": ["lo que la foto no permite verificar y requiere medición, documento o revisión en terreno"]}
Reglas: máximo 6 hallazgos, 4 en "cumple" y 5 en "no_evaluable". Solo lo observable: no supongas lo que no se ve.
No cites artículos ni números de norma. No identifiques personas ni opines sobre su estado de ánimo; de una persona solo importa la condición insegura visible (EPP, posición respecto de un equipo o de una zona de peligro).
Severidad alta = riesgo grave e inmediato para las personas. Cajas en coordenadas normalizadas de 0 a 1000 sobre la imagen (x1,y1 arriba a la izquierda).
Si la foto no muestra lo pedido: "corresponde": false, "hallazgos": [] y explícalo en el resumen.`;
const CITA_SYS = `Eres asesor en normativa chilena de seguridad y salud en el trabajo. Recibes los hallazgos de una inspección por foto y, para cada uno, extractos de reglamentos recuperados por un buscador, cada uno con un id.
Decide qué extractos exigen directamente lo que el hallazgo incumple. Responde SOLO un objeto JSON:
{"citas": [{"h": número del hallazgo, "ids": ["ids aplicables, máximo 2, el más directo primero"], "exigencia": "qué exige la norma citada, en una frase fiel al extracto", "accion": "acción correctiva concreta", "confianza": "alta" | "media" | "baja"}]}
Reglas: usa solo ids que aparecen en los extractos de ese mismo hallazgo. Si ninguno lo cubre de forma directa: "ids": [], "exigencia": "Ningún extracto recuperado lo exige de forma directa" y confianza baja.
No inventes artículos, números, distancias ni valores que no estén en los extractos. Un artículo general (deber general de seguridad, por ejemplo) solo si no hay uno específico, y con confianza baja. Español de Chile, frases breves.`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const ok = ORIGINS.includes(origin);
    if (req.method === 'OPTIONS')
      return new Response(null, {status: ok ? 204 : 403, headers: ok ? cors(origin) : {}});
    if (req.method !== 'POST')
      return new Response('Intermediario NVIDIA de los demos de jsnn15.github.io: solo acepta POST.', {
        status: 405,
      });
    if (!ok) return json({error: 'origen no permitido'}, 403, ORIGINS[0]);
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    const path = new URL(req.url).pathname;
    if (limited(ip + path, path === '/embed' ? 30 : 12))
      return json({error: 'Demasiadas consultas seguidas. Espera un minuto.'}, 429, origin);
    let b;
    try {
      b = await req.json();
    } catch {
      return json({error: 'cuerpo inválido'}, 400, origin);
    }
    const t0 = Date.now();
    try {
      if (path === '/inspect') {
        const kind = P_INSPECT[b.kind] ? b.kind : 'general';
        const result = await visionJSON(env, inspectPrompt(kind), img(b.image), 1200, 0.1);
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/epp') {
        const sec = EPP[b.sector] ? b.sector : 'industrial';
        const result = await visionJSON(env, eppPrompt(sec), img(b.image), 2200, 0.1);
        return json(
          {ok: true, model: VLM, ms: Date.now() - t0, sector: sec, items: EPP[sec].items, result},
          200,
          origin
        );
      }
      if (path === '/gauge') {
        const result = await visionJSON(env, GAUGE_PROMPT, img(b.image), 900, 0.0);
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/turno') {
        const snap = clip(JSON.stringify(b.snapshot || {}), 14000);
        const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: clip(m.content, 1200),
        }));
        const msgs = [
          {role: 'system', content: TURNO_SYS},
          ...hist,
          {
            role: 'user',
            content: `Estado de la planta ahora:\n${snap}\n\nPregunta del jefe de turno: ${clip(b.question, 600)}`,
          },
        ];
        const {model, out} = await smart(env, msgs, 600, 0.2);
        return json({ok: true, model, ms: Date.now() - t0, answer: out}, 200, origin);
      }
      if (path === '/supervisa') {
        const tipo = SUP[b.tipo] ? b.tipo : 'faena';
        const result = await visionJSON(env, supPrompt(tipo), img(b.image), 1600, 0.1);
        return json({ok: true, model: VLM, ms: Date.now() - t0, tipo, result}, 200, origin);
      }
      if (path === '/cita') {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 6);
        const txt = items
          .map(
            (h, i) =>
              `Hallazgo ${i + 1}: ${clip(h.titulo, 120)}. ${clip(h.observacion, 400)}\n` +
              (Array.isArray(h.cands) ? h.cands : [])
                .slice(0, 5)
                .map((c) => `  [${clip(c.id, 12)}] ${clip(c.ref, 120)}: ${clip(c.texto, 900)}`)
                .join('\n')
          )
          .join('\n\n');
        const msgs = [
          {role: 'system', content: CITA_SYS},
          {role: 'user', content: `Tipo de inspección: ${clip(b.tipo, 20)}\n\n${txt}`},
        ];
        const {model, out} = await smart(env, msgs, 1400, 0.0);
        return json({ok: true, model, ms: Date.now() - t0, result: parseJSON(out)}, 200, origin);
      }
      if (path === '/embed') {
        const texts = (Array.isArray(b.texts) ? b.texts : [b.text]).slice(0, 4).map((t) => clip(t, 1000));
        const d = await nv(env, '/embeddings', {
          model: EMB,
          input: texts,
          input_type: b.type === 'passage' ? 'passage' : 'query',
          encoding_format: 'float',
          dimensions: [256, 512, 1024].includes(b.dim) ? b.dim : undefined,
        });
        return json(
          {ok: true, model: EMB, ms: Date.now() - t0, vectors: d.data.map((x) => x.embedding)},
          200,
          origin
        );
      }
      if (path === '/ric') {
        const chunks = (Array.isArray(b.chunks) ? b.chunks : [])
          .slice(0, 6)
          .map((c, i) => `[${i + 1}] ${clip(c.title, 160)}\n${clip(c.text, 2200)}`)
          .join('\n\n');
        const msgs = [
          {role: 'system', content: RIC_SYS},
          {role: 'user', content: `Extractos:\n${chunks}\n\nPregunta: ${clip(b.question, 500)}`},
        ];
        const {model, out} = await smart(env, msgs, 700, 0.0);
        return json({ok: true, model, ms: Date.now() - t0, answer: out}, 200, origin);
      }
      return json({error: 'ruta desconocida'}, 404, origin);
    } catch (e) {
      return json({error: String(e.message || e).slice(0, 200)}, 502, origin);
    }
  },
};
