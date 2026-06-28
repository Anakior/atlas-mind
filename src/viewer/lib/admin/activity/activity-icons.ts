// Static registries for the home Activity card: the CDC event types (display label + tint +
// Heroicons-v2 outline path), the per-language verb labels, the AI-family glyphs, the orrery/journal
// caps and the easter-egg lines. Split out of ActivityCard so the icon/data tables sit apart from the
// behaviour; the shell's helper cluster and the view classes (Journal / Orrery / Health) read
// ActivityIcons.* at render time. Top-level (no IIFE) so it is a shared symbol in the concat scope.
export class ActivityIcons {
  // CDC event types -> display label + tint + Heroicons-v2 outline path (clean line
  // icons, matching the rest of the app). Keyed by the type /api/activity returns.
  static readonly TYPES: Record<string, { label: string; color: string; d: string }> = {
    create: { label: 'created', color: '#e8941c', d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z' },
    edit: { label: 'edited', color: '#1d9bd1', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
    move: { label: 'moved', color: '#1d9bd1', d: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5' },
    delete: { label: 'deleted', color: '#868a90', d: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' },
    check: { label: 'checked', color: '#5fd0a6', d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    revert: { label: 'reverted', color: '#e8941c', d: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3' },
    // Mental-node subscriptions: the share/nodes glyph, tinted green (added) / grey (removed).
    node_add: { label: 'added node', color: '#5fd0a6', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
    node_remove: { label: 'removed node', color: '#868a90', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
  };

  // Verb labels by UI language (LANG from 01-i18n.ts). A local map (vs t()) keeps them next to
  // TYPES and avoids colliding with existing STRINGS keys (create/edit…).
  static readonly VERB: Record<'fr' | 'en', Record<string, string>> = {
    fr: { create: 'créé', edit: 'édité', move: 'déplacé', delete: 'supprimé', check: 'coché', revert: 'restauré', node_add: 'ajouté le nœud', node_remove: 'retiré le nœud' },
    en: { create: 'created', edit: 'edited', move: 'moved', delete: 'deleted', check: 'checked', revert: 'reverted', node_add: 'added the node', node_remove: 'removed the node' },
  };

  static readonly AI: Record<string, string> = {
    claude: 'M12 2.6l1.6 5.9 5.9 1.6-5.9 1.6L12 21.4l-1.6-7.7L4.5 12l5.9-1.6L12 2.6Z',
    chatgpt: 'M12 3.2 18.5 7v8L12 18.8 5.5 15V7L12 3.2Z',
    gemini: 'M12 3c.6 4.5 2.4 6.3 6.9 6.9-4.5.6-6.3 2.4-6.9 6.9-.6-4.5-2.4-6.3-6.9-6.9C9.6 9.3 11.4 7.5 12 3Z',
    generic: 'M12 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z',
  };

  static readonly ORRERY_CAP = 18; // aggregated entries (distinct doc-activities), not raw commits
  static readonly JOURNAL_PREVIEW = 8;

  // Easter egg: flick the orrery (one full orbit) + bounce the sun on click; every 5th click, a
  // little supernova line floats up. Pure fun; reduced-motion gets just the line.
  static readonly EGG_LINES: string[] = [
    '✨ tu as trouvé le cœur du mind',
    '🪐 Atlas porte le ciel… et ton bordel',
    '☄️ supernova !',
    '🌟 fais un vœu',
    '🔭 continue d’explorer',
  ];
}
