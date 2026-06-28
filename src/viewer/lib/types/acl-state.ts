// GET /api/acl response (src/server/routes/acl.py). owner null = a commons doc (no private owner);
// creator is the original author, shown for attribution only. grants is the explicit allow-list;
// can_manage gates the share/revoke UI (false → read-only view).
interface AclGrant {
  principal: string;
  level: 'view' | 'comment' | 'edit';
  expires_at?: number;
}
interface AclState {
  path: string;
  owner: string | null;
  creator: string | null;
  grants: AclGrant[];
  can_manage: boolean;
}
