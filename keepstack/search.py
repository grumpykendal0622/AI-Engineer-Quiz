"""Search and discovery.

Three complementary modes over one catalog:

  * keyword  - FTS5 full-text across title, description, tags, metadata
  * filter   - faceted structured filters (media type, tag, status, dates)
  * semantic - embedding cosine ranking ("natural language" / more-like-this)

Facet counts are returned alongside results so the UI can render a live,
drill-down sidebar.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Optional

from . import ai
from .db import get_conn

SORTS = {
    "newest": "a.created_at DESC, a.id DESC",
    "oldest": "a.created_at ASC, a.id ASC",
    "name": "a.title ASC, a.id ASC",
    "largest": "a.size DESC, a.id DESC",
}


def _fts_query(q: str) -> str:
    """Turn user text into a safe FTS5 prefix query."""
    terms = [t for t in "".join(c if c.isalnum() or c.isspace() else " " for c in q).split() if t]
    return " ".join(f'"{t}"*' for t in terms)


def search(
    *,
    q: str = "",
    media_type: Optional[str] = None,
    tag: Optional[str] = None,
    include_tag: Sequence[str] = (),
    exclude_tag: Sequence[str] = (),
    collection_id: Optional[int] = None,
    status: str = "active",
    sort: str = "newest",
    mode: str = "keyword",
    limit: int = 60,
    offset: int = 0,
) -> dict:
    conn = get_conn()

    # Semantic mode ranks the candidate pool by embedding similarity.
    if mode == "semantic" and q.strip() and not (tag or include_tag or exclude_tag or collection_id):
        return _semantic_search(q, media_type, status, limit, offset)

    scope, params = _keyword_scope(q, media_type, tag, include_tag, exclude_tag, collection_id, status)
    order = SORTS.get(sort, SORTS["newest"])
    total = conn.execute(f"SELECT COUNT(*) AS c{scope}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT a.*{scope} ORDER BY {order} LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return {
        "total": total,
        "items": [_card(dict(row)) for row in rows],
        "facets": _facets(status),
        "mode": "keyword",
    }


def _keyword_scope(q, media_type, tag, include_tag, exclude_tag, collection_id, status):
    included = {name.strip().lower() for name in [*include_tag, tag or ""] if name.strip()}
    excluded = {name.strip().lower() for name in exclude_tag if name.strip()}
    where = ["a.status = ?"]
    where_params: list = [status]
    join = ""
    join_params: list = []

    fts = _fts_query(q)
    if fts:
        join += " JOIN asset_fts f ON f.rowid = a.id"
        where.append("asset_fts MATCH ?")
        where_params.append(fts)
    elif q.strip():
        where.append("0")
    if media_type:
        where.append("a.media_type = ?")
        where_params.append(media_type)
    if collection_id is not None:
        join += " JOIN collection_assets ca ON ca.asset_id = a.id AND ca.collection_id = ?"
        join_params.append(collection_id)

    tag_scope = "FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asset_id = a.id"
    if included & excluded:
        where.append("0")
    else:
        if included:
            placeholders = ", ".join("?" for name in included)
            where.append(f"(SELECT COUNT(*) {tag_scope} AND t.name IN ({placeholders})) = ?")
            where_params.extend([*sorted(included), len(included)])
        if excluded:
            placeholders = ", ".join("?" for name in excluded)
            where.append(f"NOT EXISTS (SELECT 1 {tag_scope} AND t.name IN ({placeholders}))")
            where_params.extend(sorted(excluded))
    where_sql = " AND ".join(where)
    return f" FROM assets a{join} WHERE {where_sql}", [*join_params, *where_params]


def _semantic_search(q, media_type, status, limit, offset) -> dict:
    conn = get_conn()
    qvec = ai.embed(q)
    where = ["status = ?", "embedding IS NOT NULL"]
    params: list = [status]
    if media_type:
        where.append("media_type = ?")
        params.append(media_type)
    rows = conn.execute(
        f"SELECT * FROM assets WHERE {' AND '.join(where)}", params
    ).fetchall()
    scored = []
    for r in rows:
        score = ai.cosine(qvec, ai.unpack_embedding(r["embedding"]))
        scored.append((score, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    page = scored[offset:offset + limit]
    items = []
    for score, r in page:
        card = _card(dict(r))
        card["score"] = round(score, 4)
        items.append(card)
    return {"total": len(scored), "items": items, "facets": _facets(status), "mode": "semantic"}


def more_like(asset_id: int, limit: int = 12) -> list[dict]:
    conn = get_conn()
    base = conn.execute("SELECT embedding FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if not base or not base["embedding"]:
        return []
    bvec = ai.unpack_embedding(base["embedding"])
    rows = conn.execute(
        "SELECT * FROM assets WHERE id != ? AND status = 'active' AND embedding IS NOT NULL",
        (asset_id,),
    ).fetchall()
    scored = [(ai.cosine(bvec, ai.unpack_embedding(r["embedding"])), r) for r in rows]
    scored.sort(key=lambda x: x[0], reverse=True)
    out = []
    for score, r in scored[:limit]:
        card = _card(dict(r))
        card["score"] = round(score, 4)
        out.append(card)
    return out


def _facets(status: str) -> dict:
    conn = get_conn()
    media = conn.execute(
        "SELECT media_type, COUNT(*) c FROM assets WHERE status = ? GROUP BY media_type ORDER BY c DESC",
        (status,),
    ).fetchall()
    tags = conn.execute(
        """SELECT t.name, COUNT(*) c FROM tags t
           JOIN asset_tags at ON at.tag_id = t.id
           JOIN assets a ON a.id = at.asset_id AND a.status = ?
           GROUP BY t.name ORDER BY c DESC LIMIT 25""",
        (status,),
    ).fetchall()
    return {
        "media_types": [{"value": r["media_type"], "count": r["c"]} for r in media],
        "tags": [{"value": r["name"], "count": r["c"]} for r in tags],
    }


def _card(a: dict) -> dict:
    """Compact asset representation for grid/list views."""
    return {
        "id": a["id"],
        "uuid": a["uuid"],
        "title": a["title"],
        "filename": a["filename"],
        "media_type": a["media_type"],
        "mime_type": a["mime_type"],
        "ext": a["ext"],
        "size": a["size"],
        "width": a["width"],
        "height": a["height"],
        "alt_text": a["alt_text"],
        "status": a["status"],
        "created_at": a["created_at"],
    }
