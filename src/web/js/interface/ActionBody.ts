// POST /api/inbox/action body (src/server/routes/docs.py). dest/tags are keep-only; until is
// snooze-only (server 400s on a non-YYYY-MM-DD value). The client sends keep/trash/snooze.
interface ActionBody {
  action: 'keep' | 'trash' | 'snooze' | 'untrash';
  path: string;
  dest?: string;
  tags?: string[];
  until?: string;
}
