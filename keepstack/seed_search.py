"""Generate a reproducible Library search scenario: python -m keepstack.seed_search."""

import io
from uuid import uuid4

from PIL import Image, ImageDraw

from . import ingest
from .db import get_conn, init_db, transaction

COLLECTION = "Harbor campaign"


def seed_search_demo():
    init_db()
    conn = get_conn()
    if conn.execute("SELECT 1 FROM collections WHERE name = ?", (COLLECTION,)).fetchone():
        raise ValueError(f"{COLLECTION!r} already exists. Seed into a fresh demo repository.")

    date = "2026-07-01T00:00:00Z"
    cursor = conn.execute("INSERT INTO collections (uuid, name, created_at) VALUES (?,?,?)",
                          (str(uuid4()), COLLECTION, date))
    collection_id = cursor.lastrowid
    conn.commit()
    both = ("approved", "campaign")
    cases = [(f"Harbor view {number:02}", both, "image", True, "active") for number in range(1, 16)]
    cases.extend([
        ("Harbor internal", (*both, "internal"), "image", True, "active"),
        ("Harbor restricted", (*both, "restricted"), "image", True, "active"),
        ("Harbor draft", ("campaign",), "image", True, "active"),
        ("Harbor short tag", ("approved", "camp"), "image", True, "active"),
        ("Harbor brief", both, "document", True, "active"),
        ("Harbor outside collection", both, "image", False, "active"),
        ("Harbor deleted", both, "image", True, "deleted"),
        ("River estuary", both, "image", True, "active"),
    ])
    assets = {}
    for index, (title, tags, media_type, in_collection, status) in enumerate(cases):
        payload = io.BytesIO()
        if media_type == "image":
            image = Image.new("RGB", (320, 180), (25 + 5 * index, 86 + index, 130))
            draw = ImageDraw.Draw(image)
            draw.ellipse((40 + 4 * index, 20, 88 + 4 * index, 68), fill=(253, 216, 139))
            draw.polygon([(0, 146), (76, 90), (175, 141), (240, 114), (320, 172), (320, 180), (0, 180)],
                         fill=(24, 53, 74))
            draw.text((12, 150), title, fill="white")
            image.save(payload, format="PNG")
            filename = f"search-demo-{index:02}.png"
        else:
            payload.write(title.encode())
            filename = f"search-demo-{index:02}.txt"
        payload.seek(0)
        asset = ingest.ingest_stream(payload, filename, title=title, run_ai=False)
        timestamp = f"2026-07-0{1 + index // 6}T00:00:00Z"
        with transaction() as conn:
            conn.execute("UPDATE assets SET created_at = ?, status = ? WHERE id = ?",
                         (timestamp, status, asset["id"]))
            if in_collection:
                conn.execute("INSERT INTO collection_assets (collection_id, asset_id) VALUES (?,?)",
                             (collection_id, asset["id"]))
            for tag in tags:
                conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag,))
                conn.execute("INSERT INTO asset_tags (asset_id, tag_id, source) SELECT ?, id, 'manual' "
                             "FROM tags WHERE name = ?", (asset["id"], tag))
        ingest.reindex_fts(asset["id"])
        assets[title] = {**asset, "created_at": timestamp}
    return collection_id, assets


if __name__ == "__main__":
    _, generated = seed_search_demo()
    print(f"Generated {len(generated)} records in the {COLLECTION!r} search scenario.")
