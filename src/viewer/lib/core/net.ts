// App-wide status writer + JSON fetch wrapper. Cross-cutting (the tree, settings, totp, new-file,
// activity, acl and the doc view all call them): exported functions imported across those features
// rather than feature state. The bodies read their refs (the live `todoStatus` binding, fetch) at
// call time.
import { todoStatus } from '../graph/todo-surface';

// Static chrome (the two spans) is built once; setStatus only swaps the colour
// class and the message text via textContent — never innerHTML — so a message
// string can't inject HTML even if a server/doc value ever flows through here.
let statusMsg: HTMLSpanElement | null = null;
let statusHost: HTMLSpanElement | null = null;

export function setStatus(msg: string, kind?: StatusKind): void {
  const colors: Record<StatusKind, string> = { ok: 'text-emerald-400', err: 'text-rose-400', info: 'text-ink-500' };

  if (!statusMsg || !statusHost) {
    statusMsg = document.createElement('span');
    statusHost = document.createElement('span');
    statusHost.className = 'text-ink-600';
  }

  statusMsg.className = colors[kind!] || colors.info;
  statusMsg.textContent = msg;
  statusHost.textContent = location.host;
  todoStatus!.replaceChildren(statusMsg, statusHost);
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
