# Extension d'exemple — thème CSS personnalisé

Montre comment **changer le design d'Atlas** sans toucher au moteur, via le
mécanisme d'extensions CSS.

## Comment ça marche

Tout fichier `.css` (et `.js`) déposé dans `<ton-mind>/.atlas/extensions/` est
**inliné dans le viewer au build** (modes online et offline), par ordre
alphabétique, après le CSS du moteur. Une extension peut donc surcharger
n'importe quel style — ici, la couleur d'accent.

## Utilisation

```bash
# depuis ton mind
mkdir -p .atlas/extensions
cp /chemin/vers/atlas/examples/extensions/custom-theme/custom-theme.css .atlas/extensions/
atlas build .          # ou redémarre le serveur : atlas serve .
```

Recharge le viewer : l'accent bleu d'Atlas devient violet. Édite la valeur
`--my-accent` dans `custom-theme.css` pour choisir ta teinte, ou décommente les
autres pistes (fond, police, arrondis).

## Aller plus loin

- Le moteur utilise des classes **Tailwind compilées** (`text-accent`,
  `bg-navy-800`, `text-ink-200`, `subtle-border`…) : inspecte le viewer avec les
  devtools pour repérer la classe à surcharger.
- Pour de la logique (pas juste du style), ajoute un `.js` (inliné pareil) ou un
  `.py` (chargé au boot du serveur, peut exposer des routes). Voir l'exemple
  `pob/` et la section *Extensions* de l'`atlas.toml` scaffoldé.
