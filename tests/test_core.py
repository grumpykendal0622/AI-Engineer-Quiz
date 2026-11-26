"""Core pipeline tests: storage dedup, ingest, metadata, search, auth, fixity.

These run against a throwaway data directory so they never touch a real
repository. Run with:  python -m pytest -q
"""
import csv
import io
import json
import os
import tempfile
from pathlib import Path

import pytest

os.environ["KEEPSTACK_DATA_DIR"] = tempfile.mkdtemp(prefix="keepstack-test-")
os.environ["KEEPSTACK_AI_ENABLED"] = "false"

from PIL import Image  # noqa: E402

from keepstack import ai, ingest, ocr, search, standards, storage, thumbnails, vision  # noqa: E402
from keepstack.auth import (hash_password, make_token, role_at_least,  # noqa: E402
                         verify_password, verify_token)
from keepstack.db import get_conn, init_db  # noqa: E402


def _img_bytes(color=(90, 130, 240), size=(400, 300)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def _xmp_img_bytes():
    xmp = """<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
    <rdf:Description>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP Harbor Archive</rdf:li></rdf:Alt></dc:title>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">NeedleMuseum catalog caption</rdf:li></rdf:Alt></dc:description>
      <dc:creator><rdf:Seq><rdf:li>Ada Archivist</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag><rdf:li>estuaries</rdf:li><rdf:li>tidal maps</rdf:li></rdf:Bag></dc:subject>
      <dc:publisher>NeedleMuseum Press</dc:publisher>
      <dc:date>2026-07-02</dc:date>
      <dc:rights>Creative Commons Test License</dc:rights>
      <photoshop:Credit>Archive Credit Line</photoshop:Credit>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""
    buf = io.BytesIO()
    Image.new("RGB", (180, 120), (20, 90, 130)).save(buf, format="JPEG", xmp=xmp.encode("utf-8"))
    return buf.getvalue()


def _split_img_bytes():
    buf = io.BytesIO()
    img = Image.new("RGB", (100, 60), (20, 40, 80))
    for x in range(100):
        for y in range(60):
            img.putpixel((x, y), (220, 30, 30) if x < 50 else (30, 180, 80))
    img.save(buf, format="JPEG")
    return buf.getvalue()


def setup_module(_):
    init_db()


def test_password_hashing():
    h = hash_password("s3cret")
    assert verify_password("s3cret", h)
    assert not verify_password("wrong", h)


def test_token_roundtrip():
    tok = make_token(42, "admin")
    payload = verify_token(tok)
    assert payload["sub"] == 42 and payload["role"] == "admin"
    assert verify_token(tok + "x") is None


def test_role_hierarchy():
    assert role_at_least("admin", "viewer")
    assert role_at_least("editor", "contributor")
    assert not role_at_least("viewer", "editor")


def test_ingest_creates_asset_with_dimensions_and_thumb():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes()), "skyline.jpg")
    assert a["media_type"] == "image"
    assert a["width"] == 400 and a["height"] == 300
    assert a["sha256"] and storage.blob_path(a["storage_key"]).exists()
    assert storage.thumb_path(a["thumb_key"]).exists()


def test_content_addressable_dedup():
    data = _img_bytes(color=(10, 200, 120), size=(256, 256))
    first = ingest.ingest_stream(io.BytesIO(data), "dup_a.jpg")
    second = ingest.ingest_stream(io.BytesIO(data), "dup_b.jpg")
    assert second.get("duplicate") is True
    assert first["sha256"] == second["sha256"]


def test_keyword_search_finds_by_title():
    ingest.ingest_stream(io.BytesIO(_img_bytes(color=(200, 50, 90), size=(420, 260))),
                         "unique_harbor_photo.jpg", title="Unique Harbor Photo")
    res = search.search(q="harbor")
    assert res["total"] >= 1
    assert any("harbor" in (i["title"] or "").lower() for i in res["items"])


def test_library_filters_bind_join_values_before_where_values():
    asset = ingest.ingest_stream(io.BytesIO(_img_bytes(color=(65, 130, 170))),
                                 "catalog_card.jpg", title="Waterside catalog card")
    conn = get_conn()
    collection_id = conn.execute(
        "INSERT INTO collections (uuid, name, created_at) VALUES (?,?,?)",
        (asset["uuid"], "Catalog", asset["created_at"]),
    ).lastrowid
    conn.execute("INSERT INTO collection_assets (collection_id, asset_id, added_at) VALUES (?,?,?)",
                 (collection_id, asset["id"], asset["created_at"]))
    tag_id = conn.execute("INSERT INTO tags (name) VALUES (?)", ("catalog-card",)).lastrowid
    conn.execute("INSERT INTO asset_tags (asset_id, tag_id, source) VALUES (?,?,'manual')",
                 (asset["id"], tag_id))
    conn.commit()

    for filters in ({"collection_id": collection_id},
                    {"tag": "CATALOG-CARD"},
                    {"collection_id": collection_id, "tag": "catalog-card", "q": "waterside", "media_type": "image"}):
        result = search.search(**filters)
        assert result["total"] == 1, filters
        assert [item["uuid"] for item in result["items"]] == [asset["uuid"]], filters


@pytest.fixture(scope="module")
def harbor_demo():
    from keepstack.seed_search import seed_search_demo

    return seed_search_demo()


@pytest.fixture
def harbor_filters(harbor_demo):
    collection_id, _ = harbor_demo
    return {"q": "harbor", "collection_id": collection_id, "media_type": "image",
            "include_tag": ["Approved", "campaign", "approved"],
            "exclude_tag": ["internal", "restricted"]}


def test_combined_library_filters(harbor_demo, harbor_filters):
    _, assets = harbor_demo
    expected = {assets[f"Harbor view {number:02}"]["uuid"] for number in range(1, 16)}

    def matches(**changes):
        result = search.search(**{**harbor_filters, **changes})
        assert result["total"] == len(result["items"])
        return {item["uuid"] for item in result["items"]}

    assert matches() == expected
    assert matches(q="  ") == expected | {assets["River estuary"]["uuid"]}
    assert matches(collection_id=None) == expected | {assets["Harbor outside collection"]["uuid"]}
    assert matches(media_type=None) == expected | {assets["Harbor brief"]["uuid"]}
    assert matches(exclude_tag=["internal"]) == expected | {assets["Harbor restricted"]["uuid"]}
    assert matches(include_tag=["approved", "camp"]) == {assets["Harbor short tag"]["uuid"]}
    assert matches(exclude_tag=["APPROVED"]) == set()
    assert matches(q='"*%(') == set()


@pytest.mark.parametrize("direction", ["oldest", "newest"])
def test_keyword_sort_and_stable_pages(harbor_demo, harbor_filters, direction):
    _, assets = harbor_demo
    expected = sorted((assets[f"Harbor view {number:02}"] for number in range(1, 16)),
                      key=lambda asset: (asset["created_at"], asset["id"]), reverse=direction == "newest")
    actual = []
    for offset in range(0, 15, 5):
        page = search.search(**harbor_filters, sort=direction, limit=5, offset=offset)
        assert page["total"] == 15
        actual.extend(item["uuid"] for item in page["items"])
    assert actual == [asset["uuid"] for asset in expected]


@pytest.fixture
def library_client():
    from fastapi.testclient import TestClient
    from keepstack.app import app

    with TestClient(app) as client:
        response = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        assert response.status_code == 200
        client.headers["Authorization"] = "Bearer " + response.json()["token"]
        yield client


def test_library_validates_pagination_and_ft_input(library_client):
    for params in ({"limit": "-1"}, {"limit": "0"}, {"limit": "201"}, {"limit": "bad"},
                   {"offset": "-1"}, {"offset": "bad"}, {"offset": str(2**80)}):
        assert library_client.get("/api/assets", params=params).status_code == 422
    for query in ('"*%(', "«harbor» -'%' (", "中文"):
        assert library_client.get("/api/assets", params={"q": query, "limit": 1}).status_code == 200


CSV_FIELDS = ["uuid", "title", "description", "filename", "media_type", "tags", "created_at"]


def read_export(response):
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
    assert response.content.startswith(b"\xef\xbb\xbf")
    reader = csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"), newline=""))
    assert reader.fieldnames == CSV_FIELDS
    return list(reader)


@pytest.mark.parametrize("direction", ["oldest", "newest"])
def test_csv_matches_all_list_pages(library_client, harbor_filters, direction):
    params = {**harbor_filters, "sort": direction, "limit": 5}
    expected = []
    for offset in (0, 5, 10):
        listing = library_client.get("/api/assets", params={**params, "offset": offset})
        assert listing.status_code == 200
        assert listing.json()["total"] == 15
        expected.extend(item["uuid"] for item in listing.json()["items"])
    export = library_client.get("/api/assets/export.csv", params={**params, "offset": 10})
    assert export.headers["content-disposition"] == 'attachment; filename="keepstack-assets.csv"'
    rows = read_export(export)
    assert [row["uuid"] for row in rows] == expected
    assert all(row["media_type"] == "image" and json.loads(row["tags"]) == ["approved", "campaign"]
               for row in rows)


def test_csv_requires_login_and_keeps_header_for_empty_results(library_client, harbor_filters):
    path = "/api/assets/export.csv"
    assert library_client.get(path, headers={"Authorization": ""}).status_code == 401
    response = library_client.get(path, params={**harbor_filters, "exclude_tag": ["approved"]})
    assert read_export(response) == []


def test_edits_change_query_and_csv(library_client, harbor_demo, harbor_filters):
    _, assets = harbor_demo
    asset = assets["Harbor view 01"]
    uuid = asset["uuid"]
    path = f"/api/assets/{uuid}"
    title = '港口, "图库"\n新标题'
    description = '说明, "备注"\n新内容'

    def assert_uuids(params, expected):
        listing = library_client.get("/api/assets", params=params)
        assert listing.status_code == 200
        assert [item["uuid"] for item in listing.json()["items"]] == expected
        rows = read_export(library_client.get("/api/assets/export.csv", params=params))
        assert [row["uuid"] for row in rows] == expected
        return rows

    try:
        old_marker = "archivebeforeonly"
        assert library_client.patch(path, json={"title": asset["title"] + " " + old_marker}).status_code == 200
        assert_uuids({**harbor_filters, "q": old_marker}, [uuid])
        assert library_client.patch(path, json={"title": title, "description": description}).status_code == 200
        assert_uuids({**harbor_filters, "q": old_marker}, [])
        edited = {**harbor_filters, "q": "港口"}
        row, = assert_uuids(edited, [uuid])
        assert (row["title"], row["description"], row["filename"]) == (title, description, asset["filename"])
        assert_uuids({**edited, "q": "新内容"}, [uuid])
        assert library_client.delete(path + "/tags/approved").status_code == 200
        assert_uuids(edited, [])
        assert library_client.post(path + "/tags", json={"name": "Approved"}).status_code == 200
        assert_uuids(edited, [uuid])
        assert library_client.post(path + "/tags", json={"name": "internal"}).status_code == 200
        assert_uuids(edited, [])
        assert library_client.delete(path + "/tags/internal").status_code == 200
        assert json.loads(assert_uuids(edited, [uuid])[0]["tags"]) == ["approved", "campaign"]
    finally:
        library_client.patch(path, json={"title": asset["title"], "description": asset["description"] or ""})
        library_client.post(path + "/tags", json={"name": "approved"})
        library_client.delete(path + "/tags/internal")


def test_combined_edit_preserves_tag_sources_and_refreshes_search_and_csv(library_client, harbor_demo):
    _, assets = harbor_demo
    asset = assets["Harbor view 02"]
    path = f"/api/assets/{asset['uuid']}"
    original = library_client.get(path).json()
    original_tags = [tag["name"] for tag in original["tags"]]
    original_campaign = next(tag for tag in original["tags"] if tag["name"] == "campaign")
    special = 'team/brand, "中文" #100%'

    try:
        updated = library_client.patch(path, json={
            "title": "Combined edit",
            "description": "Atomic draft detail",
            "tags": ["campaign", " " + special.upper() + " ", special],
        })
        assert updated.status_code == 200
        assert updated.json()["tags"] == [original_campaign, {"name": special, "source": "manual", "confidence": None}]
        query = {"include_tag": special, "q": "atomic draft"}
        listing = library_client.get("/api/assets", params=query).json()
        assert [item["uuid"] for item in listing["items"]] == [asset["uuid"]]
        row, = read_export(library_client.get("/api/assets/export.csv", params=query))
        assert row["title"] == "Combined edit"
        assert json.loads(row["tags"]) == ["campaign", special]

        assert library_client.patch(path, json={"tags": ["campaign"]}).status_code == 200
        assert library_client.get("/api/assets", params=query).json()["total"] == 0
        assert read_export(library_client.get("/api/assets/export.csv", params=query)) == []
        assert library_client.patch(path, json={"tags": []}).json()["tags"] == []
    finally:
        library_client.patch(path, json={"title": asset["title"], "description": asset["description"],
                                         "tags": original_tags})


def test_combined_edit_rejects_invalid_tags_and_rolls_back_on_index_failure(
    library_client, harbor_demo, monkeypatch,
):
    _, assets = harbor_demo
    asset = assets["Harbor view 03"]
    path = f"/api/assets/{asset['uuid']}"
    original = library_client.get(path).json()
    for tags in ("not-a-list", [None], ["  "], ["null\x00byte"]):
        response = library_client.patch(path, json={"title": "Should not persist", "tags": tags})
        assert response.status_code == 422

    reindex_fts = ingest.reindex_fts

    def failing_index(asset_id, conn):
        reindex_fts(asset_id, conn)
        raise RuntimeError("Index interrupted")

    with monkeypatch.context() as scoped:
        scoped.setattr(ingest, "reindex_fts", failing_index)
        with pytest.raises(RuntimeError, match="Index interrupted"):
            library_client.patch(path, json={"title": "Should not persist", "tags": ["rollback-only"]})
    current = library_client.get(path).json()
    assert current["asset"]["title"] == original["asset"]["title"]
    assert current["tags"] == original["tags"]
    assert library_client.get("/api/assets", params={"q": "should not persist"}).json()["total"] == 0


def test_collection_bulk_add_and_delete_keep_originals(library_client, harbor_demo):
    original_collection, assets = harbor_demo
    first = assets["Harbor view 01"]["uuid"]
    second = assets["Harbor view 02"]["uuid"]
    deleted = assets["Harbor deleted"]["uuid"]
    response = library_client.post("/api/collections", json={"name": "Bulk test"})
    assert response.status_code == 200
    collection_id = response.json()["id"]
    endpoint = f"/api/collections/{collection_id}"

    def members():
        return library_client.get("/api/assets", params={"collection_id": collection_id}).json()["items"]

    try:
        assert members() == []
        assert library_client.post("/api/collections", json={"name": "  BULK test "}).status_code == 409
        assert library_client.post(endpoint + "/assets", json={"uuids": [first, deleted]}).status_code == 409
        assert members() == []
        assert library_client.post(endpoint + "/assets", json={"uuids": [first, second, first]}).json()["added"] == 2
        assert library_client.post(endpoint + "/assets", json={"uuids": [first, second]}).json()["added"] == 0
        assert {item["uuid"] for item in members()} == {first, second}
        assert library_client.get(endpoint + "/candidates", params={"limit": 0}).status_code == 422
        candidates = library_client.get(endpoint + "/candidates", params={"limit": 200}).json()
        assert {item["uuid"] for item in candidates["items"] if item["already_added"]} == {first, second}
        assert deleted not in {item["uuid"] for item in candidates["items"]}
        conn = get_conn()
        deleted_id = assets["Harbor deleted"]["id"]
        conn.execute("INSERT INTO collection_assets (collection_id, asset_id) VALUES (?, ?)",
                     (collection_id, deleted_id))
        conn.commit()
        catalog = library_client.get("/api/collections").json()["collections"]
        assert next(item["asset_count"] for item in catalog if item["id"] == collection_id) == 2
        assert library_client.delete(endpoint).status_code == 200
        assert library_client.get(endpoint + "/candidates").status_code == 404
        detail = library_client.get(f"/api/assets/{first}").json()
        assert [item["id"] for item in detail["collections"]] == [original_collection]
        assert library_client.get(f"/api/assets/{second}/file").status_code == 200
    finally:
        library_client.delete(endpoint)


def test_asset_edit_saves_membership_with_tags_and_metadata(library_client, harbor_demo):
    original_collection, assets = harbor_demo
    asset = assets["Harbor view 04"]
    path = f"/api/assets/{asset['uuid']}"
    detail = library_client.get(path).json()
    original_tags = [item["name"] for item in detail["tags"]]
    collection = library_client.post("/api/collections", json={"name": "Combined edit test"}).json()["id"]
    try:
        body = {"title": "Collection membership update", "tags": [*original_tags, "move/marker"],
                "collection_ids": [collection, collection]}
        assert library_client.patch(path, json={**body, "collection_ids": [True]}).status_code == 422
        assert library_client.patch(path, json={**body, "collection_ids": [2**40]}).status_code == 409
        unchanged = library_client.get(path).json()
        assert unchanged["asset"]["title"] == detail["asset"]["title"]
        assert unchanged["collections"] == detail["collections"]
        assert unchanged["tags"] == detail["tags"]
        edited = library_client.patch(path, json=body)
        assert edited.status_code == 200
        assert [item["id"] for item in edited.json()["collections"]] == [collection]
        params = {"q": "collection membership update", "include_tag": "move/marker"}
        assert library_client.get("/api/assets", params={**params, "collection_id": original_collection}).json()["total"] == 0
        row, = read_export(library_client.get("/api/assets/export.csv", params={**params, "collection_id": collection}))
        assert row["uuid"] == asset["uuid"]
        assert library_client.patch(path, json={"collection_ids": []}).json()["collections"] == []
        assert library_client.get("/api/assets", params=params).json()["total"] == 1
    finally:
        library_client.patch(path, json={"title": asset["title"], "tags": original_tags,
                                         "collection_ids": [original_collection]})
        library_client.delete(f"/api/collections/{collection}")


def test_collection_actions_respect_existing_roles(library_client, harbor_demo):
    collection, assets = harbor_demo
    asset = assets["Harbor view 05"]["uuid"]
    edit_path = f"/api/assets/{asset}"
    collection_path = f"/api/collections/{collection}"
    for role in ("viewer", "contributor", "editor"):
        name = "test_collections_" + role
        password = "test-only-password"
        created = library_client.post("/api/users", json={"username": name, "password": password, "role": role})
        assert created.status_code == 200
        login = library_client.post("/api/auth/login", json={"username": name, "password": password})
        assert login.status_code == 200
        headers = {"Authorization": "Bearer " + login.json()["token"]}
        assert library_client.get("/api/collections", headers=headers).status_code == 200
        expected_edit = 403 if role == "viewer" else 200
        assert library_client.get(collection_path + "/candidates", headers=headers).status_code == expected_edit
        assert library_client.patch(edit_path, json={"collection_ids": [collection]}, headers=headers).status_code == expected_edit
        assert library_client.post(collection_path + "/assets", json={"uuids": [asset]}, headers=headers).status_code == expected_edit
        assert library_client.delete("/api/collections/999999", headers=headers).status_code == (404 if role == "editor" else 403)


def test_upload_limits_and_mixed_batch(library_client, monkeypatch):
    from keepstack.config import config

    monkeypatch.setattr(config, "max_upload_mb", 1)
    path = "/api/assets"
    data = {"run_ai": "false"}
    limit = 1024 * 1024
    image = _img_bytes(color=(38, 105, 179), size=(121, 91))
    specs = [
        ("files", ("at-limit.csv", b"A" * limit, "text/csv")),
        ("files", ("over-limit.csv", b"B" * (limit + 1), "text/csv")),
        ("files", ("blank.txt", b"", "text/plain")),
        ("files", ("invalid.png", b"not an image", "image/png")),
        ("files", ("real.jpg", image, "image/jpeg")),
    ]
    result = library_client.post(path, data=data, files=specs)
    assert result.status_code == 200
    assert [failure["status"] for failure in result.json()["failed"]] == [413, 422, 422]
    exact, photo = result.json()["created"]
    assert library_client.get(f"/api/assets/{exact['uuid']}").json()["asset"]["size"] == limit
    renamed = library_client.post(path, data=data, files={"files": ("renamed.jpg", image, "image/jpeg")})
    assert renamed.json()["created"][0]["duplicate"] is True
    assert renamed.json()["created"][0]["uuid"] == photo["uuid"]
    changed = library_client.post(path, data=data, files={"files": ("real.jpg", _img_bytes(color=(38, 100, 179)), "image/jpeg")})
    assert changed.json()["created"][0]["duplicate"] is False
    for _, spec in specs[1:4]:
        single = library_client.post(path, data=data, files={"files": spec})
        assert single.status_code == (413 if spec[0] == "over-limit.csv" else 422)


def test_semantic_search_returns_ranked_results():
    ingest.ingest_stream(io.BytesIO(_img_bytes(color=(40, 150, 90), size=(330, 500))),
                         "mountain_trail.jpg", title="Mountain trail in the alpine forest")
    res = search.search(q="alpine forest trail", mode="semantic")
    assert res["mode"] == "semantic"
    assert res["total"] >= 1
    # scores should be present and sorted descending
    scores = [i.get("score", 0) for i in res["items"]]
    assert scores == sorted(scores, reverse=True)


def test_embedding_similarity_is_symmetric_and_bounded():
    v = ai.embed("a civic poster about public transit")
    assert 0.99 <= ai.cosine(v, v) <= 1.01
    other = ai.embed("a watershed environmental survey diagram")
    assert -1.01 <= ai.cosine(v, other) <= 1.01


def test_fixity_detects_intact_and_corruption():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes(size=(120, 120))), "fixity.jpg")
    assert storage.verify_fixity(a["storage_key"], a["sha256"]) is True
    # corrupt the blob and confirm the check fails
    storage.blob_path(a["storage_key"]).write_bytes(b"tampered")
    assert storage.verify_fixity(a["storage_key"], a["sha256"]) is False


def test_gc_removes_blob_after_asset_delete():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes(color=(5, 20, 250), size=(111, 111))), "gc-delete.jpg")
    path = storage.blob_path(a["storage_key"])
    assert path.exists()

    conn = get_conn()
    conn.execute("UPDATE assets SET status = 'deleted' WHERE id = ?", (a["id"],))
    conn.commit()

    result = storage.collect_orphan_blobs()

    assert result["removed"] >= 1
    assert not path.exists()


def test_gc_keeps_active_asset_versions():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes(color=(250, 20, 5), size=(112, 112))), "gc-version.jpg")
    old_key = a["storage_key"]
    _new_sha, new_key, new_size = storage.store_bytes(b"replacement version", "txt")

    conn = get_conn()
    conn.execute(
        "INSERT INTO asset_versions (asset_id, version_no, sha256, storage_key, size, note, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (a["id"], 1, a["sha256"], old_key, a["size"], "previous current", "2026-07-01T00:00:00Z"),
    )
    conn.execute(
        "UPDATE assets SET storage_key = ?, size = ? WHERE id = ?",
        (new_key, new_size, a["id"]),
    )
    conn.commit()

    result = storage.collect_orphan_blobs()

    assert old_key not in {b["key"] for b in result["blobs"]}
    assert storage.blob_path(old_key).exists()
    assert storage.blob_path(new_key).exists()


def test_dublin_core_mapping():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes(color=(120, 90, 210), size=(360, 360))),
                             "dc_test.jpg", title="DC Test")
    dc = standards.dublin_core(a)
    assert dc["title"] == "DC Test"
    assert dc["type"] == "image"
    assert dc["identifier"] == a["uuid"]


def test_xmp_fields_seed_catalog_and_search():
    a = ingest.ingest_stream(io.BytesIO(_xmp_img_bytes()), "xmp_harbor.jpg")

    assert a["title"] == "XMP Harbor Archive"
    assert a["description"] == "NeedleMuseum catalog caption"
    assert a["dc_creator"] == "Ada Archivist"
    assert a["dc_subject"] == "estuaries, tidal maps"
    assert a["dc_publisher"] == "NeedleMuseum Press"
    assert a["dc_date"] == "2026-07-02"
    assert a["rights_statement"] == "Creative Commons Test License"
    assert a["credit"] == "Archive Credit Line"

    dc = standards.dublin_core(a)
    assert dc["publisher"] == "NeedleMuseum Press"

    meta = get_conn().execute("SELECT xmp_json FROM asset_metadata WHERE asset_id = ?", (a["id"],)).fetchone()
    xmp = json.loads(meta["xmp_json"])
    assert xmp["fields"]["dc:publisher"] == "NeedleMuseum Press"

    res = search.search(q="NeedleMuseum")
    assert any(i["uuid"] == a["uuid"] for i in res["items"])


def test_iiif_info_advertises_level_2():
    info = standards.iiif_info({"uuid": "asset-1", "width": 100, "height": 60})
    assert info["profile"] == "level2"
    assert info["tiles"][0]["width"] == 512


def test_iiif_rendition_crops_and_rotates():
    sha, key, _ = storage.store_bytes(_split_img_bytes(), "jpg")

    data = thumbnails.iiif_rendition(sha, key, "image", "10,20,30,20", "full", "90")
    img = Image.open(io.BytesIO(data))

    assert img.size == (20, 30)


def test_iiif_rendition_supports_percent_region_and_best_fit_size():
    sha, key, _ = storage.store_bytes(_split_img_bytes(), "jpg")

    data = thumbnails.iiif_rendition(sha, key, "image", "pct:0,0,50,100", "!25,25", "0")
    img = Image.open(io.BytesIO(data))

    assert img.size == (21, 25)


def test_oai_identify_is_valid_xml():
    body, status = standards.oai_response({"verb": "Identify"})
    assert status == 200
    assert "<repositoryName>" in body and "OAI-PMH" in body


def test_login_throttle_locks_success_clears_and_expires(monkeypatch):
    from keepstack import auth
    from keepstack.config import config
    monkeypatch.setattr(config, "login_max_attempts", 3)
    monkeypatch.setattr(config, "login_max_attempts_per_ip", 100)  # isolate the pair bucket
    monkeypatch.setattr(config, "login_lockout_seconds", 60)
    auth.reset_login_throttle()
    user, ip = "admin", "203.0.113.9"

    # First two failures do not lock; the third trips it.
    assert auth.note_login_failure(user, ip, now=1000) is False
    assert auth.note_login_failure(user, ip, now=1000) is False
    assert auth.note_login_failure(user, ip, now=1000) is True
    assert auth.login_locked(user, ip, now=1000) > 0
    assert auth.login_locked(user, "198.51.100.4", now=1000) == 0  # a different IP is open

    # A successful login clears an ACTIVE lockout (not just an empty bucket).
    auth.note_login_success(user, ip)
    assert auth.login_locked(user, ip, now=1000) == 0

    # A fresh lockout later expires once the window passes.
    for _ in range(3):
        auth.note_login_failure(user, ip, now=2000)
    assert auth.login_locked(user, ip, now=2000) > 0
    assert auth.login_locked(user, ip, now=2000 + 61) == 0


def test_login_throttle_per_ip_catches_username_spray(monkeypatch):
    from keepstack import auth
    from keepstack.config import config
    monkeypatch.setattr(config, "login_max_attempts", 100)  # pair bucket effectively off
    monkeypatch.setattr(config, "login_max_attempts_per_ip", 4)
    monkeypatch.setattr(config, "login_lockout_seconds", 60)
    auth.reset_login_throttle()
    ip = "203.0.113.50"
    # Every username is distinct, so no pair bucket ever trips, but the per-IP
    # bucket does after four sprayed attempts, locking the whole source IP.
    for i in range(4):
        assert auth.login_locked(f"user{i}", ip, now=500) == 0
        auth.note_login_failure(f"user{i}", ip, now=500)
    assert auth.login_locked("someone-else", ip, now=500) > 0


def test_client_ip_ignores_spoofed_xff(monkeypatch):
    from keepstack.app import client_ip
    from keepstack.config import config

    class _Req:
        def __init__(self, peer, xff=None):
            self.client = type("C", (), {"host": peer})()
            self.headers = {"X-Forwarded-For": xff} if xff else {}

    # No trusted proxies: X-Forwarded-For is ignored, the real peer wins.
    monkeypatch.setattr(config, "trusted_proxies", [])
    assert client_ip(_Req("198.51.100.7", xff="1.2.3.4")) == "198.51.100.7"

    # Behind a trusted proxy: the right-most non-proxy hop is the client.
    monkeypatch.setattr(config, "trusted_proxies", ["10.0.0.0/8"])
    assert client_ip(_Req("10.0.0.9", xff="9.9.9.9, 10.0.0.5")) == "9.9.9.9"
    # An untrusted direct peer still cannot spoof its way past.
    assert client_ip(_Req("203.0.113.1", xff="9.9.9.9")) == "203.0.113.1"


def test_iiif_manifest_shape():
    a = ingest.ingest_stream(io.BytesIO(_img_bytes(size=(300, 200))),
                             "manifest_test.jpg", title="Manifest Test")
    m = standards.iiif_manifest(a)
    assert m["type"] == "Manifest"
    assert m["@context"].endswith("presentation/3/context.json")
    assert m["label"]["none"] == ["Manifest Test"]

    canvas = m["items"][0]
    assert canvas["type"] == "Canvas"
    assert canvas["width"] == 300 and canvas["height"] == 200

    anno = canvas["items"][0]["items"][0]
    assert anno["motivation"] == "painting"
    assert anno["body"]["id"].endswith("/full/max/0/default.jpg")
    service = anno["body"]["service"][0]
    assert service["type"] == "ImageService3"
    assert service["id"].endswith(f"/iiif/3/{a['uuid']}")


@pytest.mark.skipif(not vision.ready(), reason="local vision model not installed")
def test_local_clip_cross_modal_similarity():
    from PIL import ImageDraw, ImageFont
    data_dir = Path(os.environ["KEEPSTACK_DATA_DIR"])

    page = Image.new("RGB", (448, 448), (250, 250, 250))
    draw = ImageDraw.Draw(page)
    try:
        font = ImageFont.truetype("arial.ttf", 28)
    except Exception:
        font = ImageFont.load_default(size=28)
    for i in range(12):
        draw.text((20, 20 + i * 36), "Quarterly report on estuary water quality.", font=font, fill=(20, 20, 20))
    page_path = data_dir / "clip_textpage.png"
    page.save(page_path)
    color_path = data_dir / "clip_colorfield.png"
    Image.new("RGB", (448, 448), (215, 30, 30)).save(color_path)

    tvec = vision.embed_text("a page of printed text")
    pvec = vision.embed_image(page_path)
    cvec = vision.embed_image(color_path)

    assert tvec and pvec and cvec
    assert ai.cosine(tvec, pvec) > ai.cosine(tvec, cvec)


@pytest.mark.skipif(not ocr.available(), reason="tesseract binary not installed")
def test_ocr_makes_image_text_searchable():
    from PIL import ImageDraw, ImageFont
    img = Image.new("RGB", (900, 240), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 96)
    except Exception:
        font = ImageFont.load_default(size=96)
    draw.text((40, 60), "QUILLFEATHER ARCHIVE", font=font, fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    a = ingest.ingest_stream(io.BytesIO(buf.getvalue()), "ocr_sample.png")

    res = search.search(q="quillfeather")
    assert any(i["uuid"] == a["uuid"] for i in res["items"])


def test_version_endpoint_reports_name_and_version():
    from keepstack.app import version
    payload = version()
    assert payload["name"] == "keepstack"
    assert payload["version"]
