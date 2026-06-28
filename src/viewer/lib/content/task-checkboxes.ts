// Task-checkbox wiring over the already-rendered content DOM (not the markdown source).
// wireTaskCheckboxes is called by DocRenderer.show (doc-renderer.ts) and editor.exitEditMode
// (editor/editor.ts) after they set contentEl.innerHTML.
//
// The checkbox path is positional: the Nth rendered box maps to the Nth source marker via
// toggleNthTaskMarker (task-markers.ts). A toggle advances local state optimistically (no re-render),
// PUTs in the background, and rolls everything back on failure; the in-flight write is tracked via
// sse.trackTaskWrite so the disk-derived rollup waits for it, and sse.muteSelfSave mutes the SSE
// reload our own commit triggers.

import { isServerMode, currentFile } from '../core/state';
import { contentEl } from '../core/dom-refs';
import { sse } from '../core/sse-coord';
import { Dialogs } from '../modals/dialogs';
import { toggleNthTaskMarker } from './task-markers';
import { contentCache } from './content-tree';

export class TaskCheckboxes {
  // Make the rendered task checkboxes writable; each toggle flips its source marker and commits.
  wireTaskCheckboxes(file: FileNode, fullContent: string): void {
    // Offline (file://) or read-only shared view: no writing possible.
    if (!isServerMode || window.__viewerMode) return;

    const boxes = contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

    if (!boxes.length) return;
    let docContent = fullContent;

    boxes.forEach((box, index) => {
      box.disabled = false;
      box.style.cursor = 'pointer';
      box.addEventListener('change', () => {
        const desired = box.checked;
        const newContent = toggleNthTaskMarker(docContent, index, desired);

        if (newContent == null) {
          box.checked = !desired;

          return;
        }

        // Optimistic: advance local state now, PUT in the background, no re-render.
        const prev = docContent;

        docContent = newContent;
        contentCache.set(file.path, newContent);

        if (currentFile && currentFile.path === file.path) currentFile.content = newContent;
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
          task: { text: taskText, checked: desired },
        };

        // Tracked via sse so the rollup waits for it before reading from disk.
        const write = fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);

            return res.json();
          })
          .then((data) => {
            if (currentFile && currentFile.path === file.path && data.mtime)
              currentFile.mtime = data.mtime;
          })
          .catch((e) => {
            // Failure: we roll back the optimistic update (state + visual).
            docContent = prev;
            contentCache.set(file.path, prev);

            if (currentFile && currentFile.path === file.path) currentFile.content = prev;
            box.checked = !desired;
            Dialogs.notifyError('err', e.message);
          });

        sse.trackTaskWrite(write);
      });
    });
  }
}

export const taskCheckboxes = new TaskCheckboxes();
