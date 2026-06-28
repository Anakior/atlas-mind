// PUT /api/file body (src/server/routes/docs.py). task is checkbox-only — it carries the toggled
// task's text + new state so the server writes a "checked:/unchecked:" commit subject; a plain save
// (editor/editor.ts) PUTs path + content alone.
interface FilePutBody {
  path: string;
  content: string;
  task?: { text: string; checked: boolean };
}
