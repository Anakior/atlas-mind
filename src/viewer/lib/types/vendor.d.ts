// Vendored browser libraries, present at runtime as globals (web/vendor/*.js inlined
// in the page). MiniSearch is lazy, hence possibly undefined.
declare const marked: any;
declare const DOMPurify: {
  sanitize(s: string, o?: object): string;
  addHook(entry: 'uponSanitizeAttribute', hook: (node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) => void): void;
  addHook(entry: 'afterSanitizeAttributes', hook: (node: Element) => void): void;
};
declare const hljs: any;
declare const MiniSearch: any | undefined;
