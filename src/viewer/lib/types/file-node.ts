// A file in the viewer tree (and each fileMap entry). The content-relative posix `path`
// is the document's identity. Shaped by the Python build (build/__init__.py); `vis` is
// added by GET /api/tree (absent for commons and the offline build).
interface FileNode {
  name: string;
  type: 'file';
  path: string;
  ext: string;          // lowercased suffix, e.g. ".md"
  mtime: number;        // epoch seconds (git commit date, st_mtime fallback)
  words?: number;       // .md / .html only
  content?: string;     // offline build only
  tags?: string[];      // folder ∪ frontmatter; present only when non-empty
  vis?: 'private' | 'shared' | 'granted';
}
