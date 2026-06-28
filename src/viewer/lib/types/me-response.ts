// GET /api/me. Discriminated on `authenticated`; the cloud-only fields are present
// together iff cloud === true (routes/auth.py).
interface MeAnonymous {
  authenticated: false;
  cloud: boolean;
}
interface MeAuthenticated {
  authenticated: true;
  email: string;
  role: 'admin' | 'viewer';
  cloud: boolean;
  csrf_token?: string;
  totp_enabled?: boolean;
  name?: string;
  first_name?: string;
  last_name?: string;
}
type MeResponse = MeAnonymous | MeAuthenticated;
