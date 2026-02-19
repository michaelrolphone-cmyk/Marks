import json
import re
import unittest
from pathlib import Path


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
ENDPOINT_LINE = re.compile(r"^\s*\d+\.\s+(GET|POST|PUT|PATCH|DELETE|WS)\s+([^\s]+)")


def extract_catalog_http_endpoints(catalog_text: str):
    endpoints = set()
    for line in catalog_text.splitlines():
        m = ENDPOINT_LINE.match(line)
        if not m:
            continue
        method, raw_path = m.group(1), m.group(2)
        if method not in HTTP_METHODS:
            continue

        clean_path = raw_path.split("?", 1)[0]
        endpoints.add((method.lower(), clean_path))
    return endpoints


class OpenApiCoverageTests(unittest.TestCase):
    def test_all_catalog_http_endpoints_are_documented(self):
        repo_root = Path(__file__).resolve().parent.parent
        catalog_text = (repo_root / "apis.txt").read_text(encoding="utf-8")
        openapi = json.loads((repo_root / "docs" / "openapi.json").read_text(encoding="utf-8"))

        documented = set()
        for path, operations in openapi.get("paths", {}).items():
            for method in operations.keys():
                if method.lower() in {m.lower() for m in HTTP_METHODS}:
                    documented.add((method.lower(), path))

        expected = extract_catalog_http_endpoints(catalog_text)
        missing = sorted(expected - documented)

        self.assertFalse(missing, f"Undocumented endpoints in docs/openapi.json: {missing}")


if __name__ == "__main__":
    unittest.main()
