// One /api/todos item — the wire DTO (src/server/pure/queries.py). id is the file-position index,
// reassigned on every write, so it is stable only between reloads. cat is the configured category.
interface Todo {
  id: number;
  text: string;
  done: boolean;
  cat: string;
}
