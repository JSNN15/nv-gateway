// Servidor local para probar worker.js. La clave se lee de la variable de entorno NVIDIA_API_KEY.
// Uso: NVIDIA_API_KEY=nvapi-... node dev.mjs
import http from 'node:http';
import worker from './worker.js';
if (!process.env.NVIDIA_API_KEY) {
  console.error('Falta NVIDIA_API_KEY');
  process.exit(1);
}
const env = {NVIDIA_API_KEY: process.env.NVIDIA_API_KEY};
http
  .createServer(async (q, s) => {
    const chunks = [];
    for await (const c of q) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(
      new Request('http://localhost:8787' + q.url, {
        method: q.method,
        headers: q.headers,
        body: q.method === 'GET' || q.method === 'HEAD' || q.method === 'OPTIONS' ? undefined : body,
      }),
      env
    );
    s.writeHead(r.status, Object.fromEntries(r.headers));
    s.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(8787, () => console.log('worker local en :8787'));
