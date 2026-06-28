// One checkbox in the tasks rollup (every - [ ] / - [x] across the mind), served by
// GET /_tasks-index.json or inlined as EMBED_TASKS offline. _docIndex is assigned client-side at
// render: the position among its OWN doc's tasks, so a click scrolls to the Nth rendered checkbox.
interface Task {
  path: string;
  text: string;
  done: boolean;
  _docIndex?: number;
}
