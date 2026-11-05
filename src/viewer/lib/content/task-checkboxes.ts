// Task-checkbox wiring over the already-rendered content DOM (not the markdown source).
// wireTaskCheckboxes is called by DocRenderer.show (doc-renderer.ts) after it sets contentEl.innerHTML.
//
// The checkbox path is positional: the Nth rendered box maps to the Nth source marker via
// toggleNthTaskMarker (task-markers.ts). A toggle advances local state optimistically (no re-render)
// and PUTs in the background with the text it started from: a doc that changed meanwhile comes back
// as a 409 and is reloaded instead of overwritten. The writes go one at a time, each from the text
// the previous one left, so two quick ticks never race each other to the server. The in-flight write
// is tracked via sse.trackTaskWrite so the disk-derived rollup waits for it, and sse.muteSelfSave
// mutes the SSE reload our own commit triggers.

import { contentEl } from '../core/dom-refs';
import { sse } from '../core/sse-coord';
import { Dialogs } from '../modals/dialogs';
import { toggleNthTaskMarker } from './task-markers';
import { putDoc, rememberContent } from './content-tree';
import { canEdit, docRenderer } from './doc-renderer';

export class TaskCheckboxes {
  // Make the rendered task checkboxes writable; each toggle flips its source marker and commits.
  wireTaskCheckboxes(file: FileNode, fullContent: string): void {
    if (!canEdit(file)) return;

    const boxes = contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

    if (!boxes.length) return;
    let docContent = fullContent;
    let queue: Promise<unknown> = Promise.resolve();
    let reloaded = false; // a conflict reloaded the doc: the toggles still queued are moot

    boxes.forEach((box, index) => {
      box.disabled = false;
      box.style.cursor = 'pointer';
      box.addEventListener('change', () => {
        const desired = box.checked;
        const base = docContent;
        const newContent = toggleNthTaskMarker(base, index, desired);

        if (newContent == null) {
          box.checked = !desired;

          return;
        }

        // Optimistic: advance local state now, PUT in the background, no re-render.
        docContent = newContent;
        rememberContent(file, newContent);
        sse.muteSelfSave(file.path);
        // The task's own text (drop nested sub-tasks) → a "checked:/unchecked:" commit subject.
        const li = box.closest('li');
        let taskText = '';

        if (li) {
          const clone = li.cloneNode(true) as HTMLElement;

          clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
          taskText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        }

        const body: FilePutBody = {
          path: file.path,
          content: newContent,
          base_content: base,
          task: { text: taskText, checked: desired },
        };
        const write = (queue = queue.then(async () => {
          if (reloaded) return;
          try {
            const res = await putDoc(body);

            if (res.ok) {
              file.mtime = res.mtime;
              rememberContent(file, docContent);
            } else {
              reloaded = true;
              await docRenderer.reloadChanged(file, res.current);
            }
          } catch (e) {
            // Undo this tick if nothing came after it; otherwise the next write's base no longer
            // matches the server, which answers 409 and the doc reloads.
            if (docContent === newContent) {
              docContent = base;
              rememberContent(file, base);
              box.checked = !desired;
            }
            Dialogs.notifyError('err', (e as Error).message);
          }
        }));

        // Tracked via sse so the rollup waits for it before reading from disk.
        sse.trackTaskWrite(write);
      });
    });
  }
}

export const taskCheckboxes = new TaskCheckboxes();
