---
tags: [guide, rendering]
---

# Markdown showcase

A quick tour of how Atlas Mind renders Markdown. If it is valid Markdown, it
shows up here the way you'd expect — and it all stays searchable and linkable.

## Text

Regular paragraphs with **bold**, *italic*, ~~strikethrough~~ and `inline code`.
Links go to [the project](https://github.com/Anakior/atlas-mind) or, internally,
to other notes via [[welcome|the home page]].

## Lists and tasks

- A bullet
- Another, with a nested item
  - nested once
- Back to top level

1. Ordered
2. Lists
3. Too

Task lists track state:

- [x] Build a self-contained offline file
- [x] Embed the search index and backlinks
- [ ] Win the LinkedIn comment section

## Quotes and callouts

> "The best way to predict the future is to invent it." — Alan Kay

## Tables

| Format          | Rendered inline? | Uploaded anywhere? |
|-----------------|:----------------:|:------------------:|
| Markdown        |        yes       |         no         |
| Standalone HTML |        yes       |         no         |
| PDF             |        yes       |         no         |
| Word `.docx`    |   yes (client)   |         no         |

## Code, with highlighting

```python
def build_mind(content_root):
    """Turn a folder of notes into a searchable, linked mind."""
    tree = walk(content_root, embed_content=True)
    backlinks = build_links_index(tree)
    return render_template(tree=tree, embed_backlinks=backlinks)
```

```javascript
// The viewer resolves wikilinks at render time.
const target = resolveWikilink("[[guides/wikilinks-and-backlinks]]");
openDocument(target);
```

## What's next

See how links weave documents together in
[[guides/wikilinks-and-backlinks]], then look at the whole picture in
[[features/the-mind-graph]].
