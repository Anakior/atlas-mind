// Task-marker source surgery: flipping a rendered checkbox flips the Nth `[ ]`/`[x]` marker in the
// markdown SOURCE. DOM-free, pure string ops — the render pipeline (Markdown, renderMd) stays in
// 03-markdown.ts. Loads before its sole consumer wireTaskCheckboxes (04b-task-checkboxes), which calls the
// toggleNthTaskMarker wrapper after a checkbox change.
export class TaskMarkers {
  private static readonly TASK_MARK_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
  private static readonly FENCE_RE = /^(?:`{3,}|~{3,})/;
  private static readonly BQ_RE = /^\s*>[ \t]?/;

  // Flipping the Nth rendered checkbox flips the Nth source marker, so the count must mirror marked
  // exactly: skip fenced-code tasks (no checkbox), count blockquoted ones, detect fences only
  // outside blockquotes (a fence nested in a blockquote is not honoured here).
  static toggleNthTaskMarker(content: string, index: number, checked: boolean): string | null {
    const lines = content.split('\n');
    let n = -1;
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const [unquoted, quoted] = TaskMarkers.stripBlockquote(lines[i]);

      if (!quoted && TaskMarkers.FENCE_RE.test(lines[i].trimStart())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (!TaskMarkers.TASK_MARK_RE.test(unquoted)) continue;
      n++;

      if (n === index) {
        const prefix = lines[i].slice(0, lines[i].length - unquoted.length); // keep the `>`

        lines[i] = prefix + unquoted.replace(TaskMarkers.TASK_MARK_RE, '$1' + (checked ? 'x' : ' ') + '$3');

        return lines.join('\n');
      }
    }

    return null;
  }

  private static stripBlockquote(line: string): [string, boolean] {
    let s = line;
    let quoted = false;

    while (TaskMarkers.BQ_RE.test(s)) {
      s = s.replace(TaskMarkers.BQ_RE, '');
      quoted = true;
    }

    return [s, quoted];
  }
}

export function toggleNthTaskMarker(content: string, index: number, checked: boolean): string | null {
  return TaskMarkers.toggleNthTaskMarker(content, index, checked);
}
