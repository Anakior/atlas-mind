#!/usr/bin/env python3
"""Search quality on a public benchmark: a BEIR dataset (SciFact by default) turned into a mind,
its test queries asked to search_docs over stdio (`atlas mcp`, what an agent gets), scored with
the standard retrieval metrics and set beside the BM25 baseline the BEIR paper published.

No model is called: it measures the ranking alone, in a few minutes, for free. The dataset is
downloaded once into ~/.cache/atlas-evals/beir/.

    python evals/beir.py                       # SciFact, files named after their titles
    python evals/beir.py --dataset nfcorpus --names id

Writes evals/results/<time>-beir-<dataset>.json and prints a summary."""
import argparse
import datetime as dt
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
CACHE = Path.home() / ".cache" / "atlas-evals" / "beir"
URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{}.zip"
# BM25 nDCG@10 in the BEIR paper (Thakur et al., 2021, table 2): the bar a lexical engine meets.
BM25_NDCG10 = {"scifact": 0.665, "nfcorpus": 0.325, "arguana": 0.315, "scidocs": 0.158,
               "fiqa": 0.236}
MAX_HITS = 50  # search_docs' own cap


def dataset(name: str) -> Path:
    folder = CACHE / name
    if not (folder / "corpus.jsonl").is_file():
        print(f"downloading {URL.format(name)}…", file=sys.stderr)
        with urllib.request.urlopen(URL.format(name), timeout=120) as resp:
            archive = zipfile.ZipFile(io.BytesIO(resp.read()))
        CACHE.mkdir(parents=True, exist_ok=True)
        archive.extractall(CACHE)
    return folder


def jsonl(path: Path) -> list:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def qrels(path: Path) -> dict:
    """{query id: {doc id: grade}} from a BEIR qrels .tsv (header line first)."""
    out = {}
    with open(path, encoding="utf-8") as f:
        next(f)
        for line in f:
            qid, did, grade = line.rstrip("\n").split("\t")
            if int(grade) > 0:
                out.setdefault(qid, {})[did] = int(grade)
    return out


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:80] or "untitled"


def make_mind(root: Path, corpus: list, names: str) -> dict:
    """One .md per document, the title as its H1: {file name: doc id}. `names` picks the file
    name: the title's slug, as a person would name a note, or the bare id."""
    content = root / "content"
    content.mkdir(parents=True)
    by_file = {}
    for doc in corpus:
        stem = slug(doc.get("title") or "") if names == "title" else doc["_id"]
        name = f"{stem}.md"
        if name in by_file:
            name = f"{stem}-{doc['_id']}.md"
        by_file[name] = doc["_id"]
        title = (doc.get("title") or "").strip()
        body = f"# {title}\n\n{doc['text']}\n" if title else doc["text"] + "\n"
        (content / name).write_text(body, encoding="utf-8", newline="\n")
    return by_file


class Stdio:
    """`atlas mcp` on the mind, one request at a time."""

    def __init__(self, mind: Path, log):
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "ATLAS_MIND")}
        self.proc = subprocess.Popen([sys.executable, str(SRC / "cli.py"), "mcp", str(mind)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                     env=env)
        self.next_id = 0
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "beir", "version": "0"}})

    def call(self, method: str, params: dict) -> dict:
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}
        self.proc.stdin.write(json.dumps(msg).encode("utf-8") + b"\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("atlas mcp exited: see its log")
        return json.loads(line)["result"]

    def search(self, q: str, limit: int) -> list:
        result = self.call("tools/call", {"name": "search_docs",
                                          "arguments": {"q": q, "limit": limit}})
        payload = result.get("structuredContent") or json.loads(result["content"][0]["text"])
        return [h["path"] for h in payload.get("hits", [])]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=60)


def ndcg(ranked: list, relevant: dict, k: int) -> float:
    dcg = sum(relevant.get(d, 0) / math.log2(i + 2) for i, d in enumerate(ranked[:k]))
    ideal = sorted(relevant.values(), reverse=True)[:k]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def recall(ranked: list, relevant: dict, k: int) -> float:
    return len(set(ranked[:k]) & relevant.keys()) / len(relevant)


def mrr(ranked: list, relevant: dict, k: int) -> float:
    return next((1 / (i + 1) for i, d in enumerate(ranked[:k]) if d in relevant), 0.0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", default="scifact")
    parser.add_argument("--split", default="test")
    parser.add_argument("--names", choices=("title", "id"), default="title",
                        help="file names: the title's slug (as a person would) or the doc id")
    parser.add_argument("--keep", action="store_true", help="keep the scratch mind")
    args = parser.parse_args()

    folder = dataset(args.dataset)
    corpus = jsonl(folder / "corpus.jsonl")
    queries = {q["_id"]: q["text"] for q in jsonl(folder / "queries.jsonl")}
    judged = qrels(folder / "qrels" / f"{args.split}.tsv")

    scratch = Path(tempfile.mkdtemp(prefix="atlas-beir-"))
    mind = scratch / "mind"
    by_file = make_mind(mind, corpus, args.names)
    log = open(scratch / "server.log", "w", encoding="utf-8")
    started = time.time()
    server = Stdio(mind, log)
    rows = []
    try:
        for n, (qid, relevant) in enumerate(judged.items(), 1):
            paths = server.search(queries[qid], MAX_HITS)
            ranked = [by_file.get(Path(p).name) for p in paths]
            rows.append({"id": qid, "ndcg@10": ndcg(ranked, relevant, 10),
                         "recall@10": recall(ranked, relevant, 10),
                         f"recall@{MAX_HITS}": recall(ranked, relevant, MAX_HITS),
                         "mrr@10": mrr(ranked, relevant, 10), "hits": len(paths)})
            if n % 50 == 0:
                print(f"  {n}/{len(judged)} queries", file=sys.stderr, flush=True)
    finally:
        server.close()
        log.close()
        if not args.keep:
            shutil.rmtree(scratch, ignore_errors=True)
    seconds = time.time() - started

    metrics = {m: round(sum(r[m] for r in rows) / len(rows), 4)
               for m in ("ndcg@10", "recall@10", f"recall@{MAX_HITS}", "mrr@10")}
    no_hit = sum(1 for r in rows if not r["hits"])
    baseline = BM25_NDCG10.get(args.dataset)

    results = HERE / "results"
    results.mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = results / f"{stamp}-beir-{args.dataset}.json"
    out.write_text(json.dumps({"dataset": args.dataset, "split": args.split, "names": args.names,
                               "docs": len(corpus), "queries": len(rows), "metrics": metrics,
                               "bm25_ndcg@10": baseline, "seconds": round(seconds),
                               "rows": rows}, indent=1), encoding="utf-8")
    print(f"\n### BEIR {args.dataset} ({args.split}): {len(corpus)} docs, {len(rows)} queries, "
          f"files named by {args.names}, {seconds:.0f}s\n")
    print("| metric | Atlas |" + (" BM25 (BEIR paper) |" if baseline else ""))
    print("|---|---|" + ("---|" if baseline else ""))
    for m, v in metrics.items():
        ref = f" {baseline:.3f} |" if baseline and m == "ndcg@10" else (" |" if baseline else "")
        print(f"| {m} | {v:.3f} |{ref}")
    if no_hit:
        print(f"\n{no_hit} queries got no hit at all.")
    print(f"\n{out.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
