from pydantic import BaseModel, Field


class OMRScoreDetails(BaseModel):
    expected: str
    detected: str
    correct: bool


class OMRScore(BaseModel):
    total_questions: int
    attempted: int
    correct: int
    incorrect: int
    score_percent: float
    details: dict[str, OMRScoreDetails] = Field(default_factory=dict)


class OMRResponse(BaseModel):
    answers: dict[str, str] = Field(default_factory=dict)
    invalid_questions: list[int] = Field(default_factory=list)
    empty_questions: list[int] = Field(default_factory=list)
    multiple_marked_questions: list[int] = Field(default_factory=list)
    confidence_score: float = 0.0
    warnings: list[str] = Field(default_factory=list)
    processing_time_ms: int = 0
    score: OMRScore | None = None
    debug_overlay_base64: str | None = None
