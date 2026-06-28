// SSE / write-ordering coordination shared across the checkbox, editor, tasks-rollup and live-reload
// paths. Two registries that must agree but belong to no single feature:
//   - selfSaveUntil: per-path mute window — the SSE that follows our own commit must not re-render it.
//   - taskWrites: in-flight checkbox PUTs; the disk-derived rollup awaits these before reading.
// One instance (`sse`), imported by its consumers (content/task-checkboxes.ts et al.).
export class SseCoord {
  private readonly selfSaveUntil: Record<string, number> = {};
  private readonly taskWrites = new Set<Promise<unknown>>();

  // Mute the self-triggered SSE reload for `path` over the next `ms` (the commit echo would re-render it).
  muteSelfSave(path: string, ms = 6000): void {
    this.selfSaveUntil[path] = Date.now() + ms;
  }

  isSelfSaveMuted(path: string): boolean {
    return !!(this.selfSaveUntil[path] && Date.now() < this.selfSaveUntil[path]);
  }

  // Track an in-flight checkbox PUT so drainTaskWrites() can await it; it drops out once settled.
  trackTaskWrite(p: Promise<unknown>): void {
    this.taskWrites.add(p);
    p.finally(() => this.taskWrites.delete(p));
  }

  async drainTaskWrites(): Promise<void> {
    await Promise.allSettled([...this.taskWrites]);
  }
}

export const sse = new SseCoord();
