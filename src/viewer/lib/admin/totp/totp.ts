// Security 2FA cluster map. The status pane (badge + enable/disable/logout-all buttons) is
// ./security-pane; the enrollment modal (QR + secret + recovery codes) is ./totp-enroll-modal. The
// Settings Security tab (admin/settings/settings-panel.ts) and boot/bootstrap.ts (/api/me boot) refresh
// the pane via securityPane.refreshState(). totpEnabled is the 2FA flag owned by core/data-csrf.ts.
//
// This module holds no code: the refreshSecurityState wrapper it used to expose was removed in the
// ES-module pass; callers now invoke securityPane.refreshState() directly (from ./security-pane).
