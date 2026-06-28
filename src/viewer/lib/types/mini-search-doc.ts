// One document fed to MiniSearch in the offline build (file://, no server). id is the path;
// preview is the first 240 chars, stored so a hit can render a snippet without re-fetching.
interface MiniSearchDoc {
  id: string;
  name: string;
  path: string;
  content: string;
  preview: string;
}
