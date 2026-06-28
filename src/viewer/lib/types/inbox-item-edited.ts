// An inbox item carrying the user's in-session edits (destination / tags), replayed across
// reloads via Override. Separate from InboxItem so the wire shape stays pure.
interface InboxItemEdited extends InboxItem {
  _dest?: string;
  _tags?: string[];
}
