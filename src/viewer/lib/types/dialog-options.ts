// Option bag for the confirm / alert / prompt dialogs (modals/dialogs.ts). Every field is optional;
// each dialog reads only the subset it needs (e.g. prompt uses placeholder/value, confirm uses
// destructive/cancelLabel). A bare string is also accepted by confirm/alert as a shorthand message.
interface DialogOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  okLabel?: string;
  placeholder?: string;
  value?: string;
  destructive?: boolean;
}
