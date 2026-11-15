// Validación del orientador: problemas de visitantes con la respuesta esperada (calza, parcial, no existe, aclarar, fuera).
// Dos errores pesan más que el resto: decir que un prototipo calza cuando no existe (vender de más) y tratar
// como "fuera" un problema real (perder el pedido). Uso: node orientador.mjs [salida.json]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const GW = process.env.GATEWAY || 'http://localhost:8787', ORIGEN = process.env.ORIGEN || 'http://localhost:8770';
const casos = JSON.parse(fs.readFileSync(path.join(AQUI, 'orientador.json'), 'utf8'));
const SAL = process.argv[2] || path.join(AQUI, 'orientador.res.json');
const H = {Origin: ORIGEN, 'Content-Type': 'application/json'};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const ses = (await (await fetch(GW + '/sesion', {method: 'POST', headers: H, body: '{}'})).json()).s;
const PROMESA = /\$|\bpesos\b|\bUF\b|garantiz|en \d+ (días|semanas)|te lo (construye|hace)/i;
// SEGUIR=1 retoma una corrida cortada (la cuota de la API de prueba corta las largas)
const filas = process.env.SEGUIR && fs.existsSync(SAL) ? JSON.parse(fs.readFileSync(SAL, 'utf8')).casos : [];
for (const c of casos) {
  if (filas.some((x) => x.m === c.m)) continue;
  let r;
  for (let k = 0; k < 8; k++) {
    r = await (await fetch(GW + '/orienta', {method: 'POST', headers: {...H, 'X-NV-Sesion': ses}, body: JSON.stringify({mensaje: c.m})})).json();
    if (r.result) break;
    await espera(30000);
  }
  if (!r.result) throw new Error('sin respuesta: ' + (r.error || ''));
  const x = r.result;
  const okTipo = c.tipo.includes(x.tipo), okCap = c.capacidad.includes(x.capacidad);
  const real = c.tipo.some((t) => ['calza', 'parcial', 'no_existe'].includes(t));
  filas.push({m: c.m, espera: c.tipo.join('|') + ' ' + c.capacidad.join('|'), tipo: x.tipo, capacidad: x.capacidad, pasa: okTipo && okCap, respuesta: x.respuesta, pregunta: x.pregunta, ficha: x.ficha, ms: r.ms,
    vende_de_mas: x.tipo === 'calza' && !c.tipo.includes('calza'), pierde_pedido: real && !c.tipo.includes('fuera') && x.tipo === 'fuera', promete: PROMESA.test(x.respuesta || '')});
  const f = filas.at(-1);
  console.log(`${f.pasa ? '✓' : '✗'} [${x.tipo}${x.capacidad ? ' ' + x.capacidad : ''}] ${c.m.slice(0, 70)}${f.pasa ? '' : `  (esperado: ${f.espera})`}`);
  fs.writeFileSync(SAL, JSON.stringify({parcial: true, casos: filas}, null, 1));
  await espera(+(process.env.PAUSA || 3500));
}
const ms = filas.map((x) => x.ms).sort((a, b) => a - b);
const R = {casos: filas.length, aciertos: filas.filter((x) => x.pasa).length, vende_de_mas: filas.filter((x) => x.vende_de_mas).length, pierde_pedido: filas.filter((x) => x.pierde_pedido).length, promete: filas.filter((x) => x.promete).length, mediana_s: Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10};
console.log(JSON.stringify(R));
fs.writeFileSync(SAL, JSON.stringify({fecha: new Date().toISOString().slice(0, 10), resumen: R, casos: filas}, null, 1));
