# Production-Grade OMR Detection Stack

This module provides a full React + FastAPI + OpenCV OMR pipeline, with Docker deployment.

## Features
- Robust preprocessing: grayscale, Gaussian blur, CLAHE, edge extraction
- Document detection + perspective alignment (works with mild rotation/tilt)
- Hybrid threshold strategy (Adaptive + Otsu auto-selection)
- Bubble contour filtering (size consistency + circularity + aspect ratio)
- Dynamic mark detection with EMPTY / INVALID / multiple-mark detection
- Optional scoring via answer key (`answer_key_json`)
- JSON output with confidence score and annotated overlay image

## Run with Docker
```bash
cd omr-system
docker compose up --build
```
- Frontend: http://localhost:5173
- Backend: http://localhost:8000

## Local backend run
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## API
`POST /upload-omr`
- multipart form-data:
  - `image`: file (`jpg/png/webp`)
  - `questions`: int (default 50)
  - `options_per_question`: int (default 4)
  - `answer_key_json`: optional JSON string like `{"1":"A","2":"C"}`

Response:
```json
{
  "answers": {"1": "A", "2": "EMPTY", "3": "INVALID"},
  "invalid_questions": [3],
  "empty_questions": [2],
  "multiple_marked_questions": [3],
  "confidence_score": 0.98,
  "warnings": [],
  "processing_time_ms": 800,
  "score": {
    "total_questions": 3,
    "attempted": 2,
    "correct": 1,
    "incorrect": 2,
    "score_percent": 33.33,
    "details": {"1": {"expected": "A", "detected": "A", "correct": true}}
  },
  "debug_overlay_base64": "..."
}
```

## Validation script
```bash
python scripts/validate_omr.py --api http://localhost:8000 --dir test_images
```
