import { sendJSON } from './util.js';

export function createRouter() {
  const routes = [];
  const add = (method, path, handler) =>
    routes.push({ method, parts: path.split('/').filter(Boolean), handler });

  async function handle(req, res, url) {
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    outer: for (const r of routes) {
      if (r.method !== req.method || r.parts.length !== parts.length) continue;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) continue outer;
      }
      await r.handler({ req, res, params, query: url.searchParams });
      return true;
    }
    return false;
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    del: (p, h) => add('DELETE', p, h),
    handle,
  };
}
