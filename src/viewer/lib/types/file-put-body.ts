// PUT /api/file body (src/server/routes/docs.py). task is checkbox-only — it carries the toggled
// task's text + new state so the server writes a "checked:/unchecked:" commit subject. base_content
// is the text the write started from (every whole-doc write sends it: the editor, a tag, a tick), so
// the server answers 409 instead of overwriting a doc that changed meanwhile (an AI edit, another tab).
interface FilePutBody {
  path: string;
  content: string;
  task?: { text: string; checked: boolean };
  base_content?: string;
}
