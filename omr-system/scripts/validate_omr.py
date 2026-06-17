"""Simple validation runner for OMR API using local test images.
Usage: python scripts/validate_omr.py --api http://localhost:8000 --dir test_images
"""

import argparse
from pathlib import Path

import requests


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--dir", default="test_images")
    args = parser.parse_args()

    img_dir = Path(args.dir)
    files = [p for p in img_dir.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]

    if not files:
        print("No test images found.")
        raise SystemExit(0)

    for image_path in files:
        with image_path.open("rb") as f:
            response = requests.post(
                f"{args.api}/upload-omr",
                files={"image": (image_path.name, f, "image/jpeg")},
                data={"questions": 50, "options_per_question": 4},
                timeout=30,
            )
        print(image_path.name, response.status_code)
        print(response.text[:300])
