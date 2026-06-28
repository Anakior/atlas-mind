// A new-document template registered by an extension via window.Atlas.registerTemplate. The field
// names are part of the public extension contract (examples/extensions/*) — do NOT rename them.
interface TemplateProvider {
  // async → {content, slug?}; a thrown error is shown as-is (its message is already localized).
  generate(): Promise<{ content: string; slug?: string }>;
  label?: string; // select-option label (default: the registered value)
  block?: HTMLElement; // extra form element, shown only while this template is selected
  namePlaceholder?: string; // placeholder of the name field when selected
  defaultDir?: string; // folder pre-filled when the folder field is empty
  successMessage?: string; // status shown after creation (default: docCreated)
  onOpen?(): void; // called on every modal opening (resets the block)
}
