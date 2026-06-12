# Extension PoB — module Path of Exile

Importe des builds Path of Building (PoE1/PoE2) dans Atlas : template
« Import Path of Building » dans la modale Nouveau document (fiche stylée
générée depuis le code PoB), bouton « Maj PoB » pour réimporter un code dans
un doc existant, et endpoint serveur `POST /api/pob-tree` (rôle admin) qui
résout les nœuds de l'arbre des passifs en noms.

## Installation

Copier les trois fichiers dans le dossier d'extensions du mind :

```bash
mkdir -p <mind>/.atlas/extensions
cp pob.py pob.js pob.css <mind>/.atlas/extensions/
```

Puis rebuilder le viewer et redémarrer le serveur :

```bash
python3 src/build.py
python3 src/server.py
```

- `pob.py` — chargé au boot par server.py (`register(context)`) : route
  `POST /api/pob-tree`. Les données d'arbre (tree.lua des repos Path of
  Building Community) sont téléchargées à la demande et mises en cache dans
  `<mind>/.atlas/extensions/_tree_cache/` (hors git, hors viewer).
- `pob.js` — inliné dans le viewer au build, injecté aussi dans les pages de
  partage publiques : décodeur PoB (pako 2.1.0 chargé en lazy depuis
  `/vendor/pako.min.js`, vendoré dans `web/vendor/`),
  générateur de fiche markdown, modales et bouton, traductions fr/en
  embarquées.
- `pob.css` — styles `.poe-*` de la fiche (viewer + pages de partage).

## Désinstallation

Supprimer les trois fichiers (et `_tree_cache/`) puis rebuilder : le viewer
revient strictement au moteur nu. Les fiches déjà générées restent des docs
markdown valides, simplement sans styles ni boutons.
