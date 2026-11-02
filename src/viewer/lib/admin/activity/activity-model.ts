// Pure projections over the wire events for the home Activity card: toItem maps a raw /api/activity
// (or offline EMBED_ACTIVITY) event to the ActivityItem the renderers consume, aggregate collapses a
// run of same-doc/same-author/same-type events into one counted entry, and computeDigest rolls the
// last 7 days into the factual ActivityDigest. No DOM, no state, no network — split out of ActivityCard
// so the data layer stands on its own. Exported as a class; the shell imports it for the data lifecycle.
export class ActivityModel {
  // ---- pure projections over the wire events ----
  static toItem(e: ActivityRaw): ActivityItem {
    const author = (e.author || e.email || '').trim();
    const parts = author.split(/\s+/);
    const ts = Date.parse(e.date);

    return {
      who: author,
      first: parts[0] || e.email || '',
      last: parts.slice(1).join(' '),
      email: e.email || '',
      ai: e.ai || null,
      bot: /atlas bot/i.test(author),
      type: e.type,
      title: e.title || (e.paths && e.paths[0]) || '',
      agoMin: isNaN(ts) ? 0 : Math.max(0, Math.round((Date.now() - ts) / 60000)),
      sha: e.short_sha || (e.sha || '').slice(0, 7),
      path: (e.paths && e.paths[0]) || '',
      subject: e.subject || '',
    };
  }

  // Collapse a run of consecutive events on the SAME doc by the same actor + type into one entry
  // with a count: a burst of edits to one doc shouldn't read as N identical lines (CDC §9). Events
  // arrive newest-first, so the kept time is the most recent.
  static aggregate(items: ActivityItem[]): ActivityItem[] {
    const out: ActivityItem[] = [];

    for (const e of items) {
      const last = out[out.length - 1];

      if (last && last.path === e.path && last.who === e.who && last.type === e.type && last.ai === e.ai) {
        last.count = (last.count || 0) + 1;
      } else {
        out.push(Object.assign({ count: 1 }, e));
      }
    }

    return out;
  }

  // 13b: factual digest over the last 7 days (deterministic, derived from the events; the narrative
  // side is the AI via the existing `activity` MCP tool, on demand).
  static computeDigest(items: ActivityItem[]): ActivityDigest {
    const WIN = 7 * 24 * 60; // minutes in 7 days
    const docs = new Set<string>();
    const days = Array.from({ length: 7 }, () => ({ human: 0, ai: 0 })); // oldest first, today last
    const byFolder = new Map<string, number>();
    const midnight = new Date().setHours(0, 0, 0, 0);
    let created = 0;
    let ai = 0;

    for (const i of items) {
      if (i.agoMin > WIN) continue;
      if (i.path) docs.add(i.path);
      if (i.type === 'create') created += 1;
      if (i.ai) ai += 1;

      const back = Math.max(0, Math.ceil((midnight - (Date.now() - i.agoMin * 60000)) / 86400000)); // 0 = today

      if (back < 7) days[6 - back][i.ai ? 'ai' : 'human'] += 1;
      if (i.path.includes('/')) {
        const folder = i.path.split('/')[0];

        byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
      }
    }

    const top = [...byFolder].sort((a, b) => b[1] - a[1])[0];

    return { docs: docs.size, created, ai, days, top: top ? { folder: top[0], n: top[1] } : null };
  }
}
