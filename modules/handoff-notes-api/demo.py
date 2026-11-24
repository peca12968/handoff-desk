"""Run the two-editor walkthrough against a running Handoff Notes API."""
import argparse
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(base, method, path, body=None, headers=None):
    fields = {"Content-Type": "text/plain; charset=utf-8"} if body is not None else {}
    req = Request(base + path, method=method, data=body, headers={**fields, **(headers or {})})
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as exc:
        response = exc
    with response:
        return response.status, response.headers, response.read()


def walkthrough(base):
    def expect(method, path, status, body=None, headers=None):
        actual, fields, data = request(base, method, path, body, headers)
        if actual != status:
            raise RuntimeError(f"{method} {path}: expected {status}, received {actual}: {data!r}")
        return fields, data

    initial = "交班紀錄\n".encode()
    alice_line = "早班已核對庫存。\n".encode()
    bob_line = "晚班請確認出貨時間。\n".encode()
    fields, _ = expect("POST", "/notes", 201, initial)
    note = fields["Location"]
    alice, a_text = expect("GET", note, 200)
    bob, b_text = expect("GET", note, 200)
    expect("PUT", note, 204, a_text + alice_line, {"If-Match": alice["ETag"]})
    expect("PUT", note, 412, b_text + bob_line, {"If-Match": bob["ETag"]})
    latest, current = expect("GET", note, 200)
    _, original = expect("GET", f"{note}/revisions/{bob['Handoff-Revision']}", 200)
    if original != initial or current != initial + alice_line:
        raise RuntimeError("Stale edit changed the saved note or its base revision")
    # The demo models a human choosing to keep both independent additions.
    expect("PUT", note, 204, current + bob_line, {"If-Match": latest["ETag"]})
    final, text = expect("GET", note, 200)
    if final["Handoff-Revision"] != "3" or text != initial + alice_line + bob_line:
        raise RuntimeError("Merged note differs from the two editors' changes")
    return {"location": note, "first_save": 204, "stale_save": 412, "merged_save": 204,
            "revision": int(final["Handoff-Revision"]), "text": text.decode()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", nargs="?", default="http://127.0.0.1:5080")
    print(json.dumps(walkthrough(parser.parse_args().base.rstrip("/")), ensure_ascii=False, indent=2))
