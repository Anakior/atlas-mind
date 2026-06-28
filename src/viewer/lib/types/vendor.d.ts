// Vendored browser libraries, present at runtime as globals (web/vendor/*.js inlined
// in the page). MiniSearch is lazy, hence possibly undefined.
declare const marked: any;
declare const DOMPurify: { sanitize(s: string, o?: object): string };
declare const hljs: any;
declare const MiniSearch: any | undefined;
