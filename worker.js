// Intermediario entre las páginas de jsnn15.github.io y la API de NVIDIA.
// La clave vive solo aquí, como secreto NVIDIA_API_KEY. Cada ruta arma su propio prompt y elige su modelo.
// Defensas, en orden: origen, sesión firmada (con verificación de navegador si hay secreto de Turnstile),
// límite por IP y global en Cloudflare, y tope diario en D1.
const ORIGINS = ['https://jsnn15.github.io', 'http://localhost:8770', 'http://127.0.0.1:8770'];
const BASE = 'https://integrate.api.nvidia.com/v1';
const VLM = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const LLM = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const EMB = 'nvidia/nemotron-3.5-embed-1b';
const MAX_IMG = 1_600_000; // largo máximo del dataURL (≈1,2 MB de JPEG)
const SITEKEY = '0x4AAAAAAF8y8wml3KCMuiel'; // público: identifica el widget de Turnstile de estas páginas
const EXIGE_SESION = false; // se activa cuando todas las páginas ya piden sesión
const SESION_MIN = 30;
const TOPE_DIA = 1500; // consultas en vivo por día, sumando todas las máquinas
const RIC_URL = 'https://jsnn15.github.io/normativa/s/ric.json';
const RUTAS = new Set(
  'inspect epp gauge turno embed ric supervisa cita identifica confirma revisa verifica critica reformula responde'
    .split(' ')
    .map((r) => '/' + r)
);
const hits = new Map(); // respaldo en memoria, solo si faltan los límites de Cloudflare (desarrollo local)

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', ...cors(origin)},
  });
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-NV-Sesion',
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

// ---------- sesión firmada ----------
// La llave de firma se deriva del secreto que ya existe: no hay un segundo secreto que cuidar.
const enc = new TextEncoder();
let LLAVE;
const llave = (env) =>
  (LLAVE ??= crypto.subtle
    .digest('SHA-256', enc.encode('nv-sesion-v1|' + env.NVIDIA_API_KEY))
    .then((h) => crypto.subtle.importKey('raw', h, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])));
const firma = async (env, exp, ip) => {
  const f = await crypto.subtle.sign('HMAC', await llave(env), enc.encode(exp + '|' + ip));
  return btoa(String.fromCharCode(...new Uint8Array(f)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
// La sesión es "vencimiento.firma" y vale solo para la IP que la pidió
const sesionNueva = async (env, ip) => {
  const exp = Date.now() + SESION_MIN * 60_000;
  return `${exp}.${await firma(env, exp, ip)}`;
};
const sesionValida = async (env, s, ip) => {
  const [exp, f] = String(s || '').split('.');
  if (!/^\d{13}$/.test(exp) || +exp < Date.now() || !f) return false;
  return f === (await firma(env, exp, ip));
};
// Turnstile comprueba que al otro lado hay un navegador real y no un script
const navegadorReal = async (env, token, ip) => {
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: env.TURNSTILE_SECRET, response: clip(token, 2048), remoteip: ip}),
  });
  const d = await r.json().catch(() => ({}));
  return d.success === true;
};

// ---------- límites ----------
// Devuelve el aviso para la persona, o '' si puede seguir
const frenado = async (env, ip, path) => {
  if (!env.RL_IP) return limited(ip + path, 30) ? 'Demasiadas consultas seguidas. Espera un minuto.' : '';
  if (!(await env.RL_IP.limit({key: ip})).success) return 'Demasiadas consultas seguidas. Espera un minuto.';
  if (!(await env.RL_TODO.limit({key: 'todo'})).success)
    return 'Hay varias personas probando a la vez. Espera un minuto o usa los ejemplos guardados.';
  return '';
};
// Cuenta la consulta del día en D1 (solo fecha y total, ninguna IP). Si D1 falla, no bloquea.
const topeDiario = async (env) => {
  if (!env.DB) return false;
  const dia = new Date().toISOString().slice(0, 10);
  const sumar = () =>
    env.DB.prepare(
      'INSERT INTO uso (dia, n) VALUES (?1, 1) ON CONFLICT(dia) DO UPDATE SET n = n + 1 RETURNING n'
    )
      .bind(dia)
      .first('n');
  try {
    return (await sumar()) > TOPE_DIA;
  } catch {
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS uso (dia TEXT PRIMARY KEY, n INTEGER NOT NULL)').run();
      return (await sumar()) > TOPE_DIA;
    } catch {
      return false;
    }
  }
};

// Índice de pliegos RIC, leído una vez por instancia: /ric recibe números de fragmento, no texto
let RIC;
const ric = () =>
  (RIC ??= fetch(RIC_URL)
    .then((r) => {
      if (!r.ok) throw new Error('no se pudo leer el índice de pliegos');
      return r.json();
    })
    .catch((e) => {
      RIC = undefined;
      throw e;
    }));

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
    throw new Error(
      r.status === 429
        ? 'La IA está con mucha demanda. Espera un minuto o usa los ejemplos guardados.'
        : `La IA no respondió (código ${r.status}). Intenta de nuevo.`
    );
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
// Respuesta con esquema JSON estricto: el modelo no puede devolver otra forma. El razonamiento se activa solo si se pide.
const schemaCall = async (env, messages, schema, max_tokens, think = false) => {
  let err;
  // un reintento: la API gratuita a veces responde 500 o corta la salida
  for (let k = 0; k < 2; k++) {
    try {
      const d = await nv(env, '/chat/completions', {
        model: VLM,
        messages,
        max_tokens: k ? Math.round(max_tokens * 1.5) : max_tokens,
        temperature: 0.1,
        stream: false,
        chat_template_kwargs: {enable_thinking: think},
        response_format: {type: 'json_schema', json_schema: {name: 'respuesta', schema, strict: true}},
      });
      return parseJSON(d.choices[0].message.content || '');
    } catch (e) {
      err = e;
    }
  }
  throw err;
};
const visual = (prompt, images) => [
  {
    role: 'user',
    content: [
      {type: 'text', text: prompt},
      ...images.map((u) => ({type: 'image_url', image_url: {url: img(u)}})),
    ],
  },
];
// Constructores de esquema
const S = {
  str: {type: 'string'},
  num: {type: 'number'},
  int: {type: 'integer'},
  bool: {type: 'boolean'},
  en: (values) => ({type: 'string', enum: values}),
  arr: (items, max = 8) => ({type: 'array', items, maxItems: max}),
  obj: (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
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

// Consulta eléctrica: chat con la norma. Reformula la pregunta con el contexto, y responde solo con los extractos.
const REF_SCHEMA = S.obj({
  consulta: S.str,
  ambito: S.en(['normativa_electrica', 'fuera_de_alcance', 'saludo']),
});
const REF_SYS = `Reescribes la última pregunta de una conversación sobre normativa eléctrica chilena (pliegos RIC de la SEC y DS 8/2019) como una consulta de búsqueda autónoma: incluye el tema de las preguntas anteriores si la nueva depende de ellas ("¿y en un baño?", "¿y si es trifásico?"). Usa términos técnicos del reglamento (por ejemplo "protector diferencial", "sección del conductor", "puesta a tierra de protección"). No agregues temas que no se preguntaron y no menciones "RIC", "SEC" ni "DS 8" en la consulta; solo el tema técnico, corto. ambito: normativa_electrica, saludo, o fuera_de_alcance si no trata de instalaciones eléctricas.`;
// el orden importa: el modelo escribe primero los puntos con su cita y recién al final decide si faltó respaldo
const RESP_SCHEMA = S.obj({
  puntos: S.arr(S.obj({n: S.int, textual: S.str, texto: S.str}), 4),
  aviso: S.str,
  sin_respaldo: S.bool,
  sugerencias: S.arr(S.str, 3),
});
const RESP_SYS = `Eres asesor de normativa eléctrica chilena para instaladores y maestros eléctricos. Respondes en español de Chile, directo, como un ingeniero en terreno.
Usa SOLO los extractos numerados [1], [2]… que recibes. Léelos completos: el dato puede estar en medio de un extracto que trata otro tema, o en una tabla.
puntos: de 1 a 4. El primero es la respuesta directa, con el dato concreto (valor, sección, distancia, tipo de protección). Los demás, solo si aportan: excepciones, casos o condiciones. Cada punto es una o dos frases, sin títulos ni negritas, y lleva:
- n: el número del extracto que lo respalda;
- textual: una copia EXACTA de 8 a 40 palabras seguidas de ese extracto que respalda el punto, sin cambiar ni una letra. Si el dato está en una tabla, copia la fila tal como aparece.
aviso: vacío, salvo que la respuesta dependa de un dato que falta (tipo de recinto, potencia, tensión) o que los extractos no alcancen; ahí dilo en una frase.
Si la norma no da un valor único sino una fórmula, una tabla o un criterio, explícalo con su cita: eso es una respuesta. Solo si ningún extracto trata el tema: sin_respaldo=true, puntos vacío, y en aviso di qué pliego revisar. No inventes valores.
sugerencias: 2 o 3 preguntas de seguimiento cortas, como las haría un maestro.`;
// Supervisor v2: identificar → confirmar con acercamiento → revisar contra la lista del equipo → verificar de cerca
const CATS = [
  'medidor_empalme',
  'tablero',
  'sala_electrica',
  'transformador',
  'canalizacion',
  'grupo_electrogeno',
  'bodega_sustancias',
  'cilindros_gas',
  'estanque',
  'correa_transportadora',
  'maquina',
  'area_trabajo',
  'otro',
];
const ENTORNOS = ['vivienda', 'comercio_oficina', 'industria', 'faena_minera', 'via_publica', 'no_claro'];
const ESTADOS = ['cumple', 'no_cumple', 'no_se_ve'];
const ID_PROMPT = `Eres inspector técnico en Chile. Identifica el equipo o instalación PRINCIPAL de la foto, sin suponer nada de antemano.
Categorías:
- medidor_empalme: medidor de energía de la distribuidora y su caja de empalme, individual o en banco de medidores
- tablero: gabinete con protecciones (automáticos, diferenciales, fusibles) que reparte circuitos
- sala_electrica: recinto con varios tableros, celdas o CCM
- transformador, canalizacion (ductos, bandejas, cajas de paso), grupo_electrogeno
- bodega_sustancias: envases de productos químicos o combustibles almacenados
- cilindros_gas, estanque
- correa_transportadora, maquina (partes móviles), area_trabajo (taller, pasillos, zona de operación)
- otro
Un medidor de energía no es un tablero aunque esté dentro de una caja. Si un equipo concreto (correa, máquina, tablero, envases) ocupa una parte importante de la foto, elige su categoría y no area_trabajo. Si dudas entre dos categorías, baja la confianza.
Entrega: categoria; subtipo (corto: individual o concentrado, aéreo o subterráneo, distribución o fuerza, etc.); entorno; descripcion en una frase; evidencia (rasgos visibles que prueban la categoría); alternativas (otras categorías posibles y por qué no); confianza de 0 a 1; caja_clave (zona que mejor muestra el equipo, coordenadas 0 a 1000, x1,y1 arriba a la izquierda). Español de Chile.`;
const ID_SCHEMA = S.obj({
  categoria: S.en(CATS),
  subtipo: S.str,
  entorno: S.en(ENTORNOS),
  descripcion: S.str,
  evidencia: S.arr(S.str),
  alternativas: S.arr(S.obj({categoria: S.en(CATS), por_que_no: S.str})),
  confianza: S.num,
  caja_clave: S.arr(S.num, 4),
});
const CONF_SCHEMA = S.obj({
  rasgos: S.arr(S.obj({i: S.int, visto: S.en(['si', 'no', 'no_claro']), detalle: S.str})),
});
const REV_SCHEMA = S.obj({
  resumen: S.str,
  puntos: S.arr(S.obj({id: S.str, estado: S.en(ESTADOS), observacion: S.str, caja: S.arr(S.num, 4)}), 14),
  otros: S.arr(
    S.obj({
      titulo: S.str,
      observacion: S.str,
      severidad: S.en(['alta', 'media', 'baja']),
      caja: S.arr(S.num, 4),
      busqueda: S.str,
      repite: S.str,
    }),
    5
  ),
});
const VER_SCHEMA = S.obj({estado: S.en(ESTADOS), observacion: S.str});
const CRIT_SCHEMA = S.obj({veredictos: S.arr(S.obj({i: S.int, sostiene: S.bool, motivo: S.str}), 10)});
const revPrompt = (
  b,
  items
) => `Revisas una foto de: ${clip(b.nombre, 60)} (subtipo: ${clip(b.subtipo, 60) || 'no indicado'}; entorno: ${clip(b.entorno, 30) || 'no claro'}).
${
  items.length
    ? `Para cada punto de la lista responde cumple, no_cumple o no_se_ve.
En puntos va exactamente una entrada por cada id de la lista, en el mismo orden, sin ids nuevos.
Reglas: no_cumple solo si la foto muestra el incumplimiento sin lugar a dudas. Si la foto no permite decidir o tienes dudas, no_se_ve: no adivines, y di qué faltaría ver. En observacion di lo que se ve que justifica el estado. caja: zona del punto en coordenadas 0 a 1000, o [] si no aplica.
Lista:
${items.map((x) => `${x.id}: ${x.texto}`).join('\n')}

En otros, hasta 3 condiciones inseguras claras que ningún punto de la lista cubre; no repitas lo que ya marcaste en la lista.`
    : 'No hay lista para este equipo. puntos debe ir vacío: []. Entrega en otros hasta 5 condiciones inseguras claras.'
}
Para cada uno de otros: repite (id del punto de la lista que trata lo mismo, o vacío si ninguno), titulo corto, observacion de lo que se ve, severidad (alta = riesgo grave e inmediato para personas), caja y busqueda (la exigencia que se incumple, redactada como en un reglamento chileno, sin número de artículo).
No identifiques personas ni opines sobre ellas; de una persona solo importa la condición insegura visible. resumen: una o dos frases. Español de Chile.`;
const CRIT_SYS = `Eres revisor de citas normativas chilenas. Para cada par hallazgo–artículo decide si el texto del artículo exige directamente lo que el hallazgo incumple en ESE equipo. sostiene=false si el artículo trata otro tema, es demasiado general, o rige otra instalación o actividad (por ejemplo, un pliego de recarga de vehículos eléctricos para un empalme domiciliario, o un artículo de minas subterráneas para un taller). Ante la duda, false. motivo: una frase.`;
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
    if (path !== '/sesion' && !RUTAS.has(path)) return json({error: 'ruta desconocida'}, 404, origin);
    let b;
    try {
      b = await req.json();
    } catch {
      return json({error: 'cuerpo inválido'}, 400, origin);
    }
    if (path !== '/sesion' && EXIGE_SESION && !(await sesionValida(env, req.headers.get('X-NV-Sesion'), ip)))
      return json({error: 'sesion'}, 401, origin);
    const aviso = await frenado(env, ip, path);
    if (aviso) return json({error: aviso}, 429, origin);
    if (path === '/sesion') {
      if (env.TURNSTILE_SECRET) {
        const sitekey = env.TURNSTILE_SITEKEY || SITEKEY;
        if (!b.t) return json({error: 'verificacion', sitekey}, 401, origin);
        if (!(await navegadorReal(env, b.t, ip))) return json({error: 'verificacion', sitekey}, 401, origin);
      }
      return json({ok: true, s: await sesionNueva(env, ip), min: SESION_MIN}, 200, origin);
    }
    if (await topeDiario(env))
      return json(
        {error: 'Se alcanzó el tope diario de consultas en vivo. Los ejemplos guardados siguen funcionando.'},
        429,
        origin
      );
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
      if (path === '/reformula') {
        const hist = (Array.isArray(b.historial) ? b.historial : [])
          .slice(-3)
          .map((h) => `Pregunta: ${clip(h.q, 300)}\nRespuesta: ${clip(h.a, 300)}`)
          .join('\n');
        const result = await schemaCall(
          env,
          [
            {role: 'system', content: REF_SYS},
            {
              role: 'user',
              content: `${hist ? `Conversación:\n${hist}\n\n` : ''}Última pregunta: ${clip(b.pregunta, 500)}`,
            },
          ],
          REF_SCHEMA,
          300
        );
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/responde') {
        const hist = (Array.isArray(b.historial) ? b.historial : [])
          .slice(-3)
          .map((h) => `Pregunta: ${clip(h.q, 300)}\nRespuesta: ${clip(h.a, 500)}`)
          .join('\n');
        const ext = (Array.isArray(b.extractos) ? b.extractos : [])
          .slice(0, 8)
          .map((x, i) => `[${i + 1}] ${clip(x.ref, 120)}\n${clip(x.texto, 1800)}`)
          .join('\n\n');
        const result = await schemaCall(
          env,
          [
            {role: 'system', content: RESP_SYS},
            {
              role: 'user',
              content: `${hist ? `Conversación previa:\n${hist}\n\n` : ''}Extractos:\n${ext}\n\nPregunta: ${clip(b.pregunta, 600)}`,
            },
          ],
          RESP_SCHEMA,
          1400
        );
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/identifica') {
        const msgs = visual(ID_PROMPT, [b.image]);
        let result = await schemaCall(env, msgs, ID_SCHEMA, 900);
        let razonado = false;
        if (!(result.confianza >= 0.8)) {
          // caso dudoso: segunda pasada con razonamiento
          result = await schemaCall(env, msgs, ID_SCHEMA, 3500, true);
          razonado = true;
        }
        return json({ok: true, model: VLM, ms: Date.now() - t0, razonado, result}, 200, origin);
      }
      if (path === '/confirma') {
        const rasgos = (Array.isArray(b.rasgos) ? b.rasgos : []).slice(0, 6).map((r) => clip(r, 160));
        const p = `Esta imagen es un acercamiento de la zona donde debería verse un equipo de tipo «${clip(b.nombre, 60)}». Para cada rasgo numerado indica si se ve (si, no o no_claro) y un detalle breve. Solo lo que se ve; no completes por intuición.
${rasgos.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
        const result = await schemaCall(env, visual(p, [b.image]), CONF_SCHEMA, 700);
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/revisa') {
        const items = (Array.isArray(b.items) ? b.items : [])
          .slice(0, 14)
          .map((x) => ({id: clip(x.id, 6), texto: clip(x.texto, 220)}));
        const imgs = b.zoom ? [b.image, b.zoom] : [b.image];
        const pr =
          revPrompt(b, items) +
          (b.zoom
            ? '\nLa segunda imagen es un acercamiento del equipo: úsala para los detalles. Las cajas van siempre en coordenadas de la primera imagen.'
            : '');
        const result = await schemaCall(env, visual(pr, imgs), REV_SCHEMA, 3600);
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/verifica') {
        // verificación ciega: no recibe la observación anterior, para no arrastrar el sesgo de la primera mirada
        const p = `Esta imagen es un acercamiento de una zona de: ${clip(b.nombre, 60)}.
Punto a revisar: «${clip(b.texto, 220)}».
Responde estado: cumple, no_cumple o no_se_ve. no_cumple solo si el acercamiento muestra el incumplimiento sin lugar a dudas. No cuentes como incumplimiento algo que el punto no menciona (por ejemplo, suciedad cuando el punto pide integridad). Si no se puede decidir, no_se_ve. observacion: lo que se ve. Español de Chile.`;
        const result = await schemaCall(env, visual(p, [b.image]), VER_SCHEMA, 400);
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
      }
      if (path === '/critica') {
        const pares = (Array.isArray(b.pares) ? b.pares : []).slice(0, 8);
        const txt = pares
          .map(
            (x, i) =>
              `[${i + 1}] Equipo: ${clip(b.equipo, 60)}. Hallazgo: ${clip(x.titulo, 120)}. ${clip(x.observacion, 300)}\nArtículo ${clip(x.ref, 80)}: ${clip(x.texto, 900)}`
          )
          .join('\n\n');
        const result = await schemaCall(
          env,
          [
            {role: 'system', content: CRIT_SYS},
            {role: 'user', content: txt},
          ],
          CRIT_SCHEMA,
          900
        );
        return json({ok: true, model: VLM, ms: Date.now() - t0, result}, 200, origin);
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
        const emb = () =>
          nv(env, '/embeddings', {
            model: EMB,
            input: texts,
            input_type: b.type === 'passage' ? 'passage' : 'query',
            encoding_format: 'float',
            dimensions: [256, 512, 1024].includes(b.dim) ? b.dim : undefined,
          });
        // la API de embeddings falla de vez en cuando: un reintento
        const d = await emb().catch(() => new Promise((r) => setTimeout(r, 800)).then(emb));
        return json(
          {ok: true, model: EMB, ms: Date.now() - t0, vectors: d.data.map((x) => x.embedding)},
          200,
          origin
        );
      }
      if (path === '/ric') {
        // la página manda los números de los fragmentos; el texto lo pone el servidor desde el índice oficial
        const I = await ric();
        const chunks = (Array.isArray(b.ids) ? b.ids : [])
          .filter((i) => Number.isInteger(i) && I.c[i])
          .slice(0, 6)
          .map((i, k) => {
            const c = I.c[i];
            return `[${k + 1}] RIC N°${c[0]} ${I.mat[c[0]]} · sección ${c[1]}${c[2] ? ' · ' + c[2] : ''} · pág. ${c[3]}\n${clip(c[4], 2200)}`;
          })
          .join('\n\n');
        if (!chunks) return json({error: 'faltan los fragmentos de la consulta'}, 400, origin);
        const msgs = [
          {role: 'system', content: RIC_SYS},
          {role: 'user', content: `Extractos:\n${chunks}\n\nPregunta: ${clip(b.question, 500)}`},
        ];
        const {model, out} = await smart(env, msgs, 700, 0.0);
        return json({ok: true, model, ms: Date.now() - t0, answer: out}, 200, origin);
      }
      return json({error: 'ruta sin implementar'}, 404, origin);
    } catch (e) {
      return json({error: String(e.message || e).slice(0, 200)}, 502, origin);
    }
  },
};
