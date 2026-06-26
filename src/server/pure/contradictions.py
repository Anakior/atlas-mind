"""Contradiction leads: same-subject document pairs that may hide a conflict (pure stdlib).

Two engines, both corpus-independent and provably bounded:
- topical clusters via mutual-relative tf-idf cosine (confidence "review", never asserted);
- three precise deterministic detectors on RAW text (table-row drift, polarity/negation,
  intra-doc status), confidence "high".

The engine asserts nothing: each candidate is a lead to read and judge. Clusters are
flattened server-side to one flat pair row per surviving edge so the wire/viewer contract
({"candidates": [...]}, flat c.a/c.b) and the pairwise verdict cache stay intact. A handful
is correct; dozens was the bug.
"""
import heapq
import math
import re
from collections import Counter, defaultdict

import server as _s  # _html_to_text, _normalize_text, doc_hash, line_hashes, verdict_index, verdict_holds


# --- tokenizer ---
_MIN_TOKEN_LEN = 3            # min length for ASCII tokens (bypassed for non-ASCII)

# --- df / postings bound (sub-quadratic guarantee) ---
_DF_MIN = 2                   # a term in <2 docs can pair nothing
_DF_FRAC = 0.20              # skip ubiquitous low-idf terms: df > 0.20*N is not a subject
_DF_FRAC_FLOOR = 8           # but never below 8 on tiny corpora: cap_frac = max(8, int(0.20*N))
_PER_TERM_CAP = 50          # HARD postings cap: each term emits <= C(50,2)=1225 pairs

# --- per-doc vector memory ceiling ---
_VEC_CAP = 600              # keep the 600 highest-idf terms/doc; bounds vector mem O(docs*600)

# --- candidate-pair memory ceiling ---
_PAIR_CAP = 200_000         # hard ceiling on the candidate-pair set; degrade with truncated=True

# --- cosine / clustering thresholds ---
_COS_FLOOR = 0.08           # absolute cosine floor: drop incidental single-rare-term overlaps
_REL_FLOOR = 0.50           # mutual-relative-cosine edge threshold (the one knob)
_CLUSTER_MAX = 8            # max docs per cluster; oversize -> drop weakest edges

# --- evidence ---
_EVIDENCE_PER_DOC = 2       # max "à vérifier" lines attached per doc per pair

# --- deterministic-detector strictness ---
_DETECTOR_RARE_DF = 3       # polarity/intra-status leads need shared tokens this rare (df<=3),
                            # corpus-independent, so generic same-subject prose never fires


# Bounded FR/EN function words, dropped from tokens so subjects aren't dominated by "le/of/est".
_STOPWORDS = set(
    "le la les l un une de des du au aux et ou ni mais donc car ce cet cette ces son sa ses "
    "leur leurs il elle ils elles on nous vous je tu se y en a dans sur sous par pour avec sans "
    "vers chez entre est sont etre ete suis es ont ai as avons avez que qui quoi dont ou ne pas "
    "plus tres si comme aussi the an of to in on at by for with from as is are be been was were "
    "has have had do does did this that these those it its they we you i and or but not no so if "
    "then than too very".split()
)


_FENCE_RE = re.compile(r"```.*?```|~~~.*?~~~", re.S)    # fenced blocks, DOTALL
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")              # inline code spans
_WORD_RE = re.compile(r"[^\W\d_][\w]*", re.UNICODE)     # leading Unicode LETTER, drops digit/_ runs

# Thousands separators a table cell may use: ASCII space, NBSP, FR narrow NBSP (U+202F, what
# Intl.NumberFormat('fr')/Office emit), thin space. A lone comma is the decimal point.
_THOUSANDS_SP = "    "
_NUM_RE = re.compile(r"-?\d[\d    ]*(?:[.,]\d+)?")  # plain number cell (no units)


# Polarity lexicon. Each entry = (positive phrases, negative phrases). NEGATIVE CHECKED FIRST.
_POLARITY = [
    ({"existe", "exists", "present", "disponible", "available"},
     {"existe pas", "n existe pas", "absent", "indisponible", "unavailable",
      "does not exist", "doesnt exist", "no longer exists", "n est plus"}),
    ({"obligatoire", "requis", "required", "mandatory"},
     {"optionnel", "facultatif", "optional", "non requis", "not required"}),
    ({"supporte", "supported", "pris en charge", "compatible"},
     {"non supporte", "not supported", "unsupported", "pas compatible", "incompatible"}),
    ({"fait", "termine", "done", "complete", "livre", "shipped", "merged"},
     {"a faire", "todo", "to do", "en cours", "in progress", "pas fait", "not done", "pending"}),
    ({"active", "activee", "enabled", "on"},
     {"desactive", "desactivee", "disabled", "off"}),
    ({"garde", "conserve", "keep", "kept", "retained", "autorise", "allowed"},
     {"supprime", "retire", "removed", "dropped", "deprecated", "abandonne",
      "interdit", "forbidden"}),
]


def _phrase_re(phrases):
    """Word-boundary regex for a phrase set, run on accent-folded lines so a short marker like
    'on'/'off'/'fait' never matches inside 'maison'/'effort'/'satisfait'."""
    alt = "|".join(re.escape(p) for p in sorted(phrases))
    return re.compile(r"\b(?:" + alt + r")\b")


_POLARITY_RE = [(_phrase_re(pos), _phrase_re(neg)) for pos, neg in _POLARITY]

# Evidence markers (supersession / staleness). Accent-folded before matching.
_EVIDENCE_MARKERS = [
    "remplace par", "remplacee par", "replaced by", "superseded", "supersede",
    "reporte en", "reporte a", "deferred to", "moved to", "v2", "v3",
    "n est plus", "nest plus", "no longer", "plus utilise", "deprecated", "obsolete",
    "abandonne", "annule", "cancelled", "canceled", "dropped",
    "ancienne version", "old version", "anciennement", "formerly", "previously",
    "a la place", "instead", "au lieu de", "finalement", "en realite",
]

_DONE_MARK = re.compile(r"🚢|✅|✔|\b(livr[ée]e?s?|shipp?ed|done|fait|termin[ée]e?s?|merged|prod)\b", re.I)
_OPEN_MARK = re.compile(r"\b(a\s+trancher|to\s+decide|todo|tbd|a\s+faire|en\s+discussion|"
                        r"en\s+cours|wip|a\s+definir|undecided|pas\s+tranche|open\s+question)\b", re.I)


def _strip_noise(rel, text):
    """Prose for the cosine engine ONLY (verdict cache always hashes RAW). HTML first, so a
    rendered <code> block is also caught by the fence strip; then fenced, then inline spans."""
    s = _s._html_to_text(text) if rel.lower().endswith(".html") else text
    s = _FENCE_RE.sub(" ", s)
    s = _INLINE_CODE_RE.sub(" ", s)
    return s


def _tokenize(text):
    """Unicode content tokens: leading letter, accent-folded + lowercased. The len<3 floor
    applies to ASCII noise only; short Cyrillic / Greek / CJK tokens are kept."""
    out = []
    for m in _WORD_RE.finditer(text):
        tok = _s._normalize_text(m.group(0))
        if tok.isascii() and len(tok) < _MIN_TOKEN_LEN:
            continue
        if tok in _STOPWORDS:
            continue
        out.append(tok)
    return out


# Memoized tf-idf vectors keyed on a content fingerprint: {fp: (vectors, df, N)}. Tokenize + tf-idf
# over the whole corpus is the cost; the fingerprint recomputes only when a doc actually changed.
# Distinct ACL-scrubbed corpora (superuser None vs a per-user ctx) hash to distinct keys, so a few
# entries are kept (not one) to stop multi-viewer alternation from thrashing the slot. NB: the corpus
# read + _strip_noise still run per call; this memoizes only the vectorization, not that I/O.
_VEC_CACHE = {}
_VEC_CACHE_CAP = 4


def _corpus_vectors(clean):
    """tf-idf vectors (sublinear tf, smoothed idf, L2-normalized), capped to _VEC_CAP terms per doc
    keeping the highest-idf (rarest) terms so the subject token is never evicted. Memoized on a
    cheap content fingerprint: identical corpus -> identical result, computed once."""
    fp = hash(tuple(sorted((rel, hash(text)) for rel, _name, text in clean)))
    cached = _VEC_CACHE.get(fp)
    if cached is not None:
        return cached
    tf = {}
    df = Counter()
    for rel, _name, text in clean:
        c = Counter(_tokenize(text))
        tf[rel] = c
        df.update(c.keys())
    N = max(1, len(clean))
    idf = {t: math.log((N + 1) / (df[t] + 1)) + 1.0 for t in df}  # smoothed, always > 0
    vectors = {}
    for rel, c in tf.items():
        v = {t: (1 + math.log(f)) * idf[t] for t, f in c.items()}  # sublinear tf + idf
        if len(v) > _VEC_CAP:
            keep = heapq.nlargest(_VEC_CAP, v.items(), key=lambda kv: kv[1])  # highest-idf = rarest
            v = dict(keep)
        norm = math.sqrt(sum(w * w for w in v.values())) or 1.0
        vectors[rel] = {t: w / norm for t, w in v.items()}
    result = (vectors, df, N)
    if len(_VEC_CACHE) >= _VEC_CACHE_CAP:
        _VEC_CACHE.pop(next(iter(_VEC_CACHE)))  # FIFO evict the oldest (dict preserves insertion order)
    _VEC_CACHE[fp] = result
    return result


def _candidate_pairs(vectors, df, N):
    """Enumerate candidate pairs via an inverted index. The sub-quadratic guarantee is the
    absolute _PER_TERM_CAP (each term => <= C(50,2) pairs); _DF_FRAC only skips ubiquitous
    low-idf noise; _PAIR_CAP is the final hard ceiling, never raises. Terms are walked in
    sorted order so the truncated subset is identical across machines."""
    cap_frac = max(_DF_FRAC_FLOOR, int(N * _DF_FRAC))
    postings = defaultdict(list)
    for rel, v in vectors.items():
        for t in v:
            if _DF_MIN <= df[t] <= cap_frac:
                postings[t].append(rel)
    pairset = set()
    truncated = False
    for t, docs in sorted(postings.items()):
        if len(docs) > _PER_TERM_CAP:  # a df=N term reaches here and emits ZERO pairs
            continue
        docs.sort()
        for i, a in enumerate(docs):
            for j in range(i + 1, len(docs)):
                if len(pairset) >= _PAIR_CAP:
                    truncated = True
                    break
                pairset.add((a, docs[j]))
            if truncated:
                break
        if truncated:
            break
    return pairset, truncated


def _score_pairs(pairset, vectors):
    """Exact cosine over each enumerated pair's term intersection, then the mutual-relative
    score sqrt(ra*rb) where ra/rb normalize cosine by each doc's best match."""
    cos = {}
    for (a, b) in pairset:
        va, vb = vectors[a], vectors[b]
        if len(vb) < len(va):
            va, vb = vb, va  # iterate the smaller vector
        dot = sum(w * vb.get(t, 0.0) for t, w in va.items())  # unit vectors -> exact cosine
        if dot >= _COS_FLOOR:
            cos[(a, b)] = dot
    maxp = defaultdict(float)
    for (a, b), c in cos.items():
        if c > maxp[a]:
            maxp[a] = c
        if c > maxp[b]:
            maxp[b] = c
    edges = {}
    for (a, b), c in cos.items():
        ra = c / maxp[a] if maxp[a] else 0.0
        rb = c / maxp[b] if maxp[b] else 0.0
        s = math.sqrt(ra * rb)
        if s >= _REL_FLOOR:
            edges[(a, b)] = s
    return edges


def _components(nodes, pairs):
    """Connected components (each a sorted node list, the list of components sorted) over `pairs`
    (an iterable of (a, b)), via union-find rooted to the min node so the output is deterministic
    whatever the edge order. Isolated nodes are included."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    comps = defaultdict(list)
    for n in nodes:
        comps[find(n)].append(n)
    return sorted(sorted(g) for g in comps.values())


def _shed_oversize(members, comp_edges):
    """Split one component into sub-clusters of <= _CLUSTER_MAX docs by dropping its weakest
    edges, keeping EVERY surviving sub-cluster (a small one split off by a weak bridge is never
    lost). comp_edges is (score, a, b) sorted weakest-first. Adding the strongest edges first and
    stopping at the first merge that would exceed the cap reproduces drop-weakest exactly (the
    survivors are a suffix of the weakest-first list) in a single union-find pass, instead of
    recomputing the components after every dropped edge. Returns [(members_sorted, kept_edges)]
    per sub-cluster that has at least one edge."""
    parent = {m: m for m in members}
    size = {m: 1 for m in members}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    kept = []
    for edge in reversed(comp_edges):  # strongest first
        _score, a, b = edge
        ra, rb = find(a), find(b)
        if ra != rb:
            if size[ra] + size[rb] > _CLUSTER_MAX:
                break  # this edge, and every weaker one, are the dropped prefix
            root, child = min(ra, rb), max(ra, rb)
            parent[child] = root
            size[root] += size[child]
        kept.append(edge)
    groups = defaultdict(list)
    for m in members:
        groups[find(m)].append(m)
    edges_by_root = defaultdict(list)
    for edge in kept:
        edges_by_root[find(edge[1])].append(edge)
    return [(sorted(groups[root]), edges_by_root[root])
            for root in sorted(groups) if edges_by_root.get(root)]


def _rarest_shared_term(a, b, vectors, df):
    """The shared term with the highest idf (lowest df), tie-break alphabetical."""
    shared = set(vectors[a]) & set(vectors[b])
    if not shared:
        return ""
    return min(shared, key=lambda t: (df[t], t))


def _vectorize_one(text, df, N):
    """tf-idf vector of one text against an existing corpus df/N (the idf the corpus was built with),
    sublinear tf + smoothed idf, capped and L2-normalized like _corpus_vectors. Scores a doc not in
    the corpus (an inbox item) without rebuilding it; a term absent from the corpus gets df 0 -> max
    idf (a novel word is rare). df.get, never df[]."""
    c = Counter(_tokenize(text))
    v = {t: (1 + math.log(f)) * (math.log((N + 1) / (df.get(t, 0) + 1)) + 1.0) for t, f in c.items()}
    if len(v) > _VEC_CAP:
        v = dict(heapq.nlargest(_VEC_CAP, v.items(), key=lambda kv: kv[1]))
    norm = math.sqrt(sum(w * w for w in v.values())) or 1.0
    return {t: w / norm for t, w in v.items()}


def find_doc_neighbors(rel, text, ctx=None, top=5):
    """Same-subject neighbors of ONE doc (typically an inbox item) against the live corpus (which
    already excludes inbox). The item is scored against the corpus, never added to it. Returns
    [{rel, score, subject}] sorted by cosine desc (>= _COS_FLOOR), top-K, ACL-scrubbed per ctx. Used
    to suggest where to file a kept item."""
    from server.pure import queries  # lazy: avoids the import cycle (see find_contradictions)
    clean = [(r, n, _strip_noise(r, t)) for r, n, t in queries._doc_corpus(ctx) if r != rel]
    if not clean:
        return []
    vectors, df, N = _corpus_vectors(clean)
    iv = _vectorize_one(_strip_noise(rel, text), df, N)
    if not iv:
        return []
    cap_frac = max(_DF_FRAC_FLOOR, int(N * _DF_FRAC))
    # Floor is 1, not _DF_MIN: unlike intra-corpus pairing, here the item is a virtual 2nd doc,
    # so a term in a SINGLE corpus doc IS shared (corpus df 1 + the item = 2). Still skip ubiquitous
    # terms above cap_frac (they are not a subject).
    postings = defaultdict(list)
    for r, v in vectors.items():
        for t in v:
            if 1 <= df[t] <= cap_frac:
                postings[t].append(r)
    cand = {r for t in iv if 1 <= df.get(t, 0) <= cap_frac for r in postings.get(t, ())}
    out = []
    for r in cand:
        vb = vectors[r]
        small, big = (iv, vb) if len(iv) <= len(vb) else (vb, iv)
        dot = sum(w * big.get(t, 0.0) for t, w in small.items())  # unit vectors -> exact cosine
        if dot >= _COS_FLOOR:
            shared = set(iv) & set(vb)
            subject = min(shared, key=lambda t: (df.get(t, 0), t)) if shared else ""
            out.append({"rel": r, "score": round(dot, 4), "subject": subject})
    out.sort(key=lambda c: (-c["score"], c["rel"]))
    return out[:top]


def _cluster_candidates(vectors, df, N):
    """Same-subject clusters from the relative-cosine edges: connected components, then each
    oversize component sheds its weakest edges until every sub-cluster is <= _CLUSTER_MAX (all
    surviving sub-clusters kept, never just the largest). One flat row per surviving edge."""
    pairset, truncated = _candidate_pairs(vectors, df, N)
    edges = _score_pairs(pairset, vectors)
    nodes = {n for pair in edges for n in pair}
    subclusters = []  # (members_sorted, surviving_edges) per kept sub-cluster
    for members in _components(nodes, edges):
        comp_edges = sorted((edges[(a, b)], a, b)
                            for i, a in enumerate(members) for b in members[i + 1:]
                            if (a, b) in edges)
        subclusters.extend(_shed_oversize(members, comp_edges))

    subclusters.sort(key=lambda sc: sc[0])
    rows = []
    for cid, (members, comp_edges) in enumerate(subclusters):
        for s, a, b in comp_edges:
            rows.append({
                "a": a, "b": b, "kind": "cluster", "confidence": "review",
                "score": round(s, 4), "cluster_id": cid, "cluster_size": len(members),
                "subject": _rarest_shared_term(a, b, vectors, df),
                **({"truncated": True} if truncated else {}),
            })
    return rows


def _parse_num(cell):
    """Plain number out of a table cell: whitespace = thousands sep, a lone comma = decimal.
    Explicitly NOT the deleted Value tower: no units, no currencies, no bool."""
    m = _NUM_RE.fullmatch(cell.strip())
    if not m:
        return None
    s = m.group(0).translate(str.maketrans("", "", _THOUSANDS_SP))
    if "," in s and "." not in s:
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _parse_tables(text):
    """Markdown tables of a doc: contiguous |-delimited blocks. Each table is
    (header_cells, [(line_no, [cells])]). The |---| separator row is skipped."""
    tables = []
    cur = None  # (header_line, header_cells, rows)
    for i, line in enumerate(text.splitlines(), start=1):
        if line.strip().startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cur is None:
                cur = [cells, []]
                continue
            if all(set(c) <= set("-: ") and c for c in cells):  # |---|:--:| separator
                continue
            cur[1].append((i, cells))
        else:
            if cur is not None:
                tables.append(cur)
            cur = None
    if cur is not None:
        tables.append(cur)
    return [t for t in tables if t[1]]


def _row_index(table):
    """Map normalized first-cell row-key -> (line_no, cells), keeping the first occurrence."""
    out = {}
    for line_no, cells in table[1]:
        if not cells:
            continue
        key = _s._normalize_text(cells[0])
        out.setdefault(key, (line_no, cells))
    return out


def _detect_table_drift(corpus, cluster_pairs):
    """Cross-doc aligned table-row drift, gated on cluster membership (inherits the cluster
    engine's sub-quadratic bound, no all-pairs loop). Two tables with the same normalized
    header set and >=3 shared row-keys whose non-numeric cells all match; emit IFF EXACTLY 1
    numeric divergence (>=2 = a different time series = the documented false-positive trap)."""
    parsed = {rel: _parse_tables(text) for rel, _name, text in corpus}
    rows = []
    for rel_a, rel_b in sorted(cluster_pairs):  # rel_a < rel_b (cluster rows are normalized)
        for ta in parsed.get(rel_a, ()):
            ha = {_s._normalize_text(c) for c in ta[0]}
            for tb in parsed.get(rel_b, ()):
                hb = {_s._normalize_text(c) for c in tb[0]}
                if not ha or ha != hb:
                    continue
                idx_a, idx_b = _row_index(ta), _row_index(tb)
                shared = sorted(set(idx_a) & set(idx_b))
                if len(shared) < 3:
                    continue
                diffs = []
                consistent = True
                for key in shared:
                    la, ca = idx_a[key]
                    lb, cb = idx_b[key]
                    n = min(len(ca), len(cb))
                    for col in range(n):
                        na, nb = _parse_num(ca[col]), _parse_num(cb[col])
                        if na is not None and nb is not None:
                            if na != nb:
                                diffs.append((key, col, la, lb, ca[col], cb[col]))
                        elif _s._normalize_text(ca[col]) != _s._normalize_text(cb[col]):
                            consistent = False
                            break
                    if not consistent:
                        break
                if not consistent or len(diffs) != 1:
                    continue
                key, col, la, lb, va, vb = diffs[0]
                header_cell = ta[0][col] if col < len(ta[0]) else ""
                rows.append({
                    "a": rel_a, "b": rel_b, "kind": "table-drift", "confidence": "high",
                    "score": 1.0, "subject": (header_cell + " " + key).strip(),
                    "a_line": la, "b_line": lb, "a_value": va, "b_value": vb,
                })
    return rows


def _line_tokens(line):
    return set(_tokenize(line))


def _detect_polarity(corpus, df, cluster_pairs):
    """Cross-doc polarity/negation lead on the SAME subject, gated on cluster membership. A line
    in A matches a positive phrase, a line in B the matching negative phrase (or vice-versa),
    sharing >=2 STRICTLY rare tokens (df <= _DETECTOR_RARE_DF) so generic same-cluster prose
    doesn't fire. Word-boundary matched ('on' never fires inside 'maison'), negative first. A
    lead, not an assertion: confidence "review" (à vérifier)."""
    by_rel = {rel: text for rel, _name, text in corpus}
    rows = []

    def sides(text):
        """Per polarity entry index, the (line_no, raw_line, sense) hits in this doc."""
        hits = defaultdict(list)
        for i, line in enumerate(text.splitlines(), start=1):
            nl = _s._normalize_text(line)
            for pi, (pos_re, neg_re) in enumerate(_POLARITY_RE):
                if neg_re.search(nl):       # negative first
                    hits[pi].append((i, line, "neg"))
                elif pos_re.search(nl):
                    hits[pi].append((i, line, "pos"))
        return hits

    cache = {}
    for ra, rb in sorted(cluster_pairs):
        if ra not in by_rel or rb not in by_rel:
            continue
        ha = cache.setdefault(ra, sides(by_rel[ra]))
        hb = cache.setdefault(rb, sides(by_rel[rb]))
        emitted = False
        for pi in sorted(set(ha) & set(hb)):
            for la, la_line, sa in ha[pi]:
                ta = {t for t in _line_tokens(la_line) if t.isalpha() and df.get(t, 0) <= _DETECTOR_RARE_DF}
                for lb, lb_line, sb in hb[pi]:
                    if sa == sb:
                        continue
                    tb = {t for t in _line_tokens(lb_line) if t.isalpha() and df.get(t, 0) <= _DETECTOR_RARE_DF}
                    shared = sorted(ta & tb)
                    if len(shared) < 2:
                        continue
                    rows.append({
                        "a": ra, "b": rb, "kind": "polarity", "confidence": "review",
                        "score": 1.0, "subject": " ".join(shared),
                        "a_line": la, "b_line": lb,
                        "a_value": la_line.strip()[:200], "b_value": lb_line.strip()[:200],
                    })
                    emitted = True
                    break
                if emitted:
                    break
            if emitted:
                break
    return rows


def _detect_intra_status(corpus, df):
    """Within one file: a _DONE_MARK inside a table row co-existing with an _OPEN_MARK on a
    non-table body line, sharing >=1 STRICTLY rare token (df <= _DETECTOR_RARE_DF) so a doc that
    merely mixes done and todo items on common words doesn't fire. A lead, confidence "review"."""
    rows = []
    for rel, _name, text in corpus:
        lines = text.splitlines()
        done = []  # (line_no, tokens, marker)
        open_ = []
        for i, line in enumerate(lines, start=1):
            is_table = bool(re.match(r"^\s*\|", line))
            nl = _s._normalize_text(line)  # status markers accent-folded before matching
            toks = {t for t in _line_tokens(line) if t.isalpha() and df.get(t, 0) <= _DETECTOR_RARE_DF}
            if is_table:
                m = _DONE_MARK.search(nl)
                if m:
                    done.append((i, toks, m.group(0)))
            else:
                m = _OPEN_MARK.search(nl)
                if m:
                    open_.append((i, toks, m.group(0)))
        if not done or not open_:
            continue
        # Invert open-line tokens so each done row finds its first token-sharing open line in
        # O(tokens), never O(done * open) on a long status-heavy doc.
        open_by_token = defaultdict(list)
        for oi, (_ol, ot, _om) in enumerate(open_):
            for t in ot:
                open_by_token[t].append(oi)
        for dl, dt, dm in done:
            cand = set()
            for t in dt:
                cand.update(open_by_token.get(t, ()))
            if not cand:
                continue
            ol, ot, om = open_[min(cand)]  # earliest token-sharing open line
            shared = sorted(dt & ot)
            rows.append({
                "a": rel, "b": rel, "kind": "intra-status", "confidence": "review",
                "score": 1.0, "subject": shared[0],
                "a_line": dl, "b_line": ol, "a_value": dm, "b_value": om,
            })
            break
    return rows


_DETECTOR_RANK = {"table-drift": 0, "polarity": 1, "intra-status": 2}


def _merge(cands):
    """Dedup by frozenset((a,b)): a deterministic detector replaces a cluster row for the same
    pair; among detectors, precedence table-drift > polarity > intra-status."""
    best = {}
    for c in cands:
        key = frozenset((c["a"], c["b"]))
        cur = best.get(key)
        if cur is None:
            best[key] = c
            continue
        cur_det = cur["kind"] != "cluster"
        new_det = c["kind"] != "cluster"
        if new_det and not cur_det:
            best[key] = c
        elif new_det and cur_det:
            if _DETECTOR_RANK[c["kind"]] < _DETECTOR_RANK[cur["kind"]]:
                best[key] = c
        # cluster never replaces an existing row.
    return list(best.values())


def _evidence_lines(text, path):
    """Up to _EVIDENCE_PER_DOC "à vérifier" pointers: lines carrying an _EVIDENCE_MARKERS hit
    (deterministic by line number). Presentation-only: never ranks, filters or sets a verdict."""
    out = []
    for i, line in enumerate(text.splitlines(), start=1):
        nl = _s._normalize_text(line)
        for marker in _EVIDENCE_MARKERS:
            if marker in nl:
                out.append({"path": path, "line": i, "text": line.strip()[:200], "marker": marker})
                break
        if len(out) >= _EVIDENCE_PER_DOC:
            break
    return out


def _attach_evidence(cands, corpus):
    """Attach each pair's per-doc evidence pointers (a, then b; a==b once)."""
    by_rel = {rel: text for rel, _name, text in corpus}
    for c in cands:
        a, b = c["a"], c["b"]
        ev = _evidence_lines(by_rel.get(a, ""), a)
        if b != a:
            ev = ev + _evidence_lines(by_rel.get(b, ""), b)
        if ev:
            c["evidence"] = ev


def _apply_verdicts(cands, corpus, include_dismissed):
    """Pairwise cache gate: drop 'none' (unless include_dismissed), annotate the rest. Keys on
    the RAW doc/line hashes (the existing invariant), never on stripped prose."""
    vindex = _s.verdict_index()
    hashes = {rel: _s.doc_hash(text) for rel, _name, text in corpus}
    lines = {rel: _s.line_hashes(text) for rel, _name, text in corpus}
    out = []
    for c in cands:
        a, b = c["a"], c["b"]
        key = (a, b) if a < b else (b, a)
        verdict = _s.verdict_holds(vindex.get(key), hashes.get(a, ""), hashes.get(b, ""),
                                   lines.get(a, frozenset()), lines.get(b, frozenset()))
        if verdict == "none" and not include_dismissed:
            continue
        c["verdict"] = verdict
        out.append(c)
    return out


_CONF_RANK = {"high": 0, "review": 1}                                       # asserted before leads
_KIND_RANK = {"table-drift": 0, "polarity": 1, "intra-status": 2, "cluster": 3}


def find_contradictions(ctx=None, limit: int = 50, include_dismissed: bool = False,
                        solid_only: bool = False) -> list:
    """Same-subject document pairs that may hide a conflict: topical clusters plus three
    deterministic detectors. Flat, sorted, capped list of candidate rows; verdict cache gated.
    Never raises on overflow (truncated=True). A handful is correct.

    solid_only=True is the human-viewer feed: keep ONLY what is presentable as a real
    contradiction: the precise high-confidence detector (table-row drift) and any pair already
    confirmed 'real'. The cosine clusters and the polarity / intra-status leads are noisy/hard
    to render, so they stay the AI's on-demand substrate (via the MCP `contradictions` tool),
    not a permanent human feed."""
    from server.pure import queries  # lazy: avoids an import cycle at module load
    corpus = sorted(queries._doc_corpus(ctx))  # RAW; sorted so output is identical across machines
    clean = [(rel, name, _strip_noise(rel, text)) for rel, name, text in corpus]  # cosine only
    vectors, df, N = _corpus_vectors(clean)

    cands = _cluster_candidates(vectors, df, N)
    cluster_pairs = {(c["a"], c["b"]) for c in cands}  # detectors are gated on cluster membership
    cands += _detect_table_drift(corpus, cluster_pairs)
    cands += _detect_polarity(corpus, df, cluster_pairs)
    cands += _detect_intra_status(corpus, df)
    cands = _merge(cands)
    _attach_evidence(cands, corpus)
    cands = _apply_verdicts(cands, corpus, include_dismissed)
    if solid_only:
        cands = [c for c in cands if c["confidence"] == "high" or c.get("verdict") == "real"]

    cands.sort(key=lambda c: (_CONF_RANK[c["confidence"]], _KIND_RANK[c["kind"]],
                              -c["score"], c["a"], c["b"]))
    return cands[:limit]
