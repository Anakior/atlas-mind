// Security 2FA shell. The cross-file entry point that lets the Settings Security tab (16z-settings.ts)
// and 99-bootstrap.ts (/api/me boot) refresh the security pane. The pane itself (status badge +
// enable/disable/logout-all buttons) is 18-totp-pane.ts; the enrollment modal (QR + secret + recovery
// codes) is 18-totp-modal.ts. totpEnabled is the global 2FA flag owned by 00-data-csrf.ts.
//
// The cross-file refreshSecurityState wrapper was removed in the ES-module pass: callers now invoke
// securityPane.refreshState() directly (imported from ./security-pane).
