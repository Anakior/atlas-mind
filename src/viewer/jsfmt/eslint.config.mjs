// Dev-only ESLint config: a SINGLE concern, breathing room. Prettier handles the
// layout; this adds the blank lines prettier won't (it never inserts any). The
// viewer JS is concatenated into one classic <script>, hence sourceType 'script'.
export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script' },
    rules: {
      'padding-line-between-statements': [
        'error',
        // Blank line after a run of declarations (but not between two of them).
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        // Blank line before every return.
        { blankLine: 'always', prev: '*', next: 'return' },
        // Blank line around blocks and functions (separate logical paragraphs).
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try', 'do', 'function'] },
        { blankLine: 'always', prev: ['block-like', 'function'], next: '*' },
      ],
    },
  },
];
