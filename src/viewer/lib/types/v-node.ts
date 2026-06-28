// A virtual node for the Atlas DOM runtime (00b-atlas-dom.ts). `tag` is an element name,
// or the markers '#text' (textContent) and '#raw' (a single-root trusted HTML string).
interface VNode {
  tag: string;
  key?: string | number;
  props: Record<string, any>;
  children: VNode[];
  text?: string; // '#text' content or '#raw' html
  managed?: boolean; // host node: apply props, never reconcile or remove its children
  el?: Node; // the live DOM node, once created
}
