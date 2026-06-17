import json
import logging
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi import Header
from fastapi.middleware.cors import CORSMiddleware

from .omr_processor import OMRConfig, OMRProcessingError, process_omr
from .schemas import OMRResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

app = FastAPI(title="Production OMR Detector", version="1.1.0")

allowed_origins = [origin.strip() for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if origin.strip()]
if not allowed_origins:
    allowed_origins = ["http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/upload-omr", response_model=OMRResponse)
async def upload_omr(
    image: UploadFile = File(...),
    questions: int = Form(50),
    options_per_question: int = Form(4),
    answer_key_json: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
) -> OMRResponse:
    api_token = os.getenv("OMR_API_TOKEN", "").strip()
    if api_token and authorization != f"Bearer {api_token}":
        raise HTTPException(status_code=401, detail="Unauthorized")

    if image.content_type not in {"image/jpeg", "image/png", "image/jpg", "image/webp"}:
        raise HTTPException(status_code=415, detail="Unsupported file type")

    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty image")
    max_upload_bytes = int(os.getenv("MAX_UPLOAD_BYTES", "8000000"))
    if len(content) > max_upload_bytes:
        raise HTTPException(status_code=413, detail="Image is too large")

    answer_key = None
    if answer_key_json:
        try:
            parsed = json.loads(answer_key_json)
            if not isinstance(parsed, dict):
                raise ValueError("answer_key_json must be a JSON object like {\"1\": \"A\"}")
            answer_key = {str(k): str(v).upper().strip() for k, v in parsed.items()}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid answer_key_json: {exc}") from exc

    try:
        result = process_omr(
            content,
            OMRConfig(
                questions=max(1, min(300, questions)),
                options_per_question=max(2, min(6, options_per_question)),
            ),
            answer_key=answer_key,
        )
        return OMRResponse(**result)
    except OMRProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logging.exception("Unexpected OMR processing failure")
        raise HTTPException(status_code=500, detail="Unexpected processing failure") from exc
