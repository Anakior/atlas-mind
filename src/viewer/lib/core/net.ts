// App-wide status writer + JSON fetch wrapper. Cross-cutting (the tree, settings, totp, new-file,
// activity, acl and the doc view all call them): exported functions imported across those features
// rather than feature state. The bodies read their refs (the live `todoStatus` binding, fetch) at
// call time.
import { todoStatus } from '../graph/todo-surface';

export function setStatus(msg: string, kind?: StatusKind): void {
  const colors: Record<StatusKind, string> = { ok: 'text-emerald-400', err: 'text-rose-400', info: 'text-ink-500' };

  todoStatus!.innerHTML = `<span class="${colors[kind!] || colors.info}">${msg}</span><span class="text-ink-600">${location.host}</span>`;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const opts: RequestInit = { method, headers };

  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);

  if (!res.ok) throw new Error('HTTP ' + res.status);

  return res.json();
}
