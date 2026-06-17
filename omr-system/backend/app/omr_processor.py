import base64
import logging
import time
from dataclasses import dataclass

import cv2
import numpy as np

logger = logging.getLogger("omr")


@dataclass
class OMRConfig:
    questions: int = 50
    options_per_question: int = 4
    min_blur_score: float = 80.0
    min_sheet_area_ratio: float = 0.08


class OMRProcessingError(Exception):
    pass


def _order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    d = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def _four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    rect = _order_points(pts)
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_width = int(max(width_a, width_b))
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_height = int(max(height_a, height_b))
    dst = np.array(
        [[0, 0], [max_width - 1, 0], [max_width - 1, max_height - 1], [0, max_height - 1]],
        dtype="float32",
    )
    m = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, m, (max_width, max_height))


def _encode_overlay(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("utf-8")


def _find_sheet_contour(gray: np.ndarray, min_sheet_area_ratio: float) -> np.ndarray | None:
    # contrast normalization before edge extraction improves low-light scans
    normalized = cv2.equalizeHist(gray)
    blur = cv2.GaussianBlur(normalized, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 170)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:15]

    for contour in contours:
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4 and cv2.contourArea(approx) > gray.size * min_sheet_area_ratio:
            return approx.reshape(4, 2).astype("float32")

    if contours:
        rect = cv2.minAreaRect(contours[0])
        box = cv2.boxPoints(rect)
        if cv2.contourArea(box.astype(np.float32)) > gray.size * min_sheet_area_ratio:
            return box.astype("float32")
    return None


def _group_rows(candidates: list[dict], y_tolerance: float) -> list[list[dict]]:
    rows: list[list[dict]] = []
    for item in sorted(candidates, key=lambda x: x["center"][1]):
        if not rows:
            rows.append([item])
            continue
        mean_y = np.mean([it["center"][1] for it in rows[-1]])
        if abs(item["center"][1] - mean_y) <= y_tolerance:
            rows[-1].append(item)
        else:
            rows.append([item])
    return [sorted(row, key=lambda x: x["center"][0]) for row in rows]


def _threshold_variants(normalized: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    blur = cv2.GaussianBlur(normalized, (5, 5), 0)
    adaptive = cv2.adaptiveThreshold(
        blur,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        7,
    )
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    def _clean(img: np.ndarray) -> np.ndarray:
        out = cv2.morphologyEx(img, cv2.MORPH_OPEN, kernel, iterations=1)
        return cv2.morphologyEx(out, cv2.MORPH_CLOSE, kernel, iterations=1)

    return _clean(adaptive), _clean(otsu)


def _extract_bubbles(binary: np.ndarray, expected_questions: int, options_per_question: int) -> list[dict]:
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    bubble_candidates: list[dict] = []

    for c in contours:
        area = cv2.contourArea(c)
        if area < 35 or area > 2800:
            continue
        peri = cv2.arcLength(c, True)
        if peri == 0:
            continue
        circularity = (4 * np.pi * area) / (peri * peri)
        x, y, w, h = cv2.boundingRect(c)
        aspect_ratio = w / float(max(h, 1))
        if 0.65 <= aspect_ratio <= 1.35 and circularity > 0.42:
            bubble_candidates.append(
                {
                    "contour": c,
                    "bbox": (x, y, w, h),
                    "center": (x + w / 2, y + h / 2),
                    "area": area,
                }
            )

    if not bubble_candidates:
        return []

    diameters = np.array([max(item["bbox"][2], item["bbox"][3]) for item in bubble_candidates], dtype=np.float32)
    median_d = float(np.median(diameters))
    filtered: list[dict] = []
    for item in bubble_candidates:
        d = max(item["bbox"][2], item["bbox"][3])
        if 0.55 * median_d <= d <= 1.8 * median_d:
            filtered.append(item)

    # quick sanity filter to prefer expected scale
    required = expected_questions * options_per_question
    if len(filtered) < required * 0.4:
        return []

    return filtered


def _evaluate_threshold(cleaned: np.ndarray, config: OMRConfig) -> tuple[list[list[dict]], list[dict]]:
    bubbles = _extract_bubbles(cleaned, config.questions, config.options_per_question)
    if not bubbles:
        return [], []

    diameters = [max(item["bbox"][2], item["bbox"][3]) for item in bubbles]
    y_tol = max(8.0, float(np.median(diameters) * 0.9))
    rows = _group_rows(bubbles, y_tol)

    rows = [r for r in rows if len(r) >= config.options_per_question]
    rows = rows[: config.questions]
    return rows, bubbles


def _score_answers(answers: dict[str, str], answer_key: dict[str, str] | None) -> dict | None:
    if not answer_key:
        return None

    valid_total = 0
    correct = 0
    details: dict[str, dict] = {}

    for q, expected in answer_key.items():
        detected = answers.get(str(q), "NA")
        is_valid = detected not in {"INVALID", "EMPTY", "NA"}
        if is_valid:
            valid_total += 1
        is_correct = detected == expected
        if is_correct:
            correct += 1
        details[str(q)] = {
            "expected": expected,
            "detected": detected,
            "correct": is_correct,
        }

    total = len(answer_key)
    score_percent = (correct / total * 100.0) if total else 0.0
    return {
        "total_questions": total,
        "attempted": valid_total,
        "correct": correct,
        "incorrect": max(total - correct, 0),
        "score_percent": round(score_percent, 2),
        "details": details,
    }


def process_omr(image_bytes: bytes, config: OMRConfig, answer_key: dict[str, str] | None = None) -> dict:
    started = time.time()
    warnings: list[str] = []

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise OMRProcessingError("Invalid image data")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur_score = cv2.Laplacian(gray, cv2.CV_64F).var()
    if blur_score < config.min_blur_score:
        warnings.append("Image looks blurry; detection confidence may be lower.")

    sheet = _find_sheet_contour(gray, config.min_sheet_area_ratio)
    if sheet is None:
        raise OMRProcessingError("Sheet not detected. Try a clearer image with full page visible.")

    warped = _four_point_transform(image, sheet)
    warped_gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

    clahe = cv2.createCLAHE(clipLimit=2.8, tileGridSize=(8, 8))
    normalized = clahe.apply(warped_gray)
    adaptive_cleaned, otsu_cleaned = _threshold_variants(normalized)

    rows_a, bubbles_a = _evaluate_threshold(adaptive_cleaned, config)
    rows_o, bubbles_o = _evaluate_threshold(otsu_cleaned, config)

    # choose threshold strategy that yields most plausible row detection
    use_adaptive = len(rows_a) >= len(rows_o)
    cleaned = adaptive_cleaned if use_adaptive else otsu_cleaned
    rows = rows_a if use_adaptive else rows_o
    bubbles = bubbles_a if use_adaptive else bubbles_o

    if len(bubbles) < config.questions * config.options_per_question * 0.6:
        raise OMRProcessingError("Bubble detection mismatch. Ensure proper OMR format and full-page scan.")

    if len(rows) < max(3, int(config.questions * 0.8)):
        raise OMRProcessingError("Question row mismatch. Re-capture image with straight alignment.")

    option_labels = [chr(ord("A") + i) for i in range(config.options_per_question)]
    answers: dict[str, str] = {}
    invalid_questions: list[int] = []
    empty_questions: list[int] = []
    multiple_marked_questions: list[int] = []
    confidence_chunks: list[float] = []

    overlay = warped.copy()

    for q_idx, row in enumerate(rows, start=1):
        row = row[: config.options_per_question]
        fill_scores: list[float] = []

        for item in row:
            x, y, w, h = item["bbox"]
            roi = cleaned[y : y + h, x : x + w]
            mask = np.zeros_like(roi)
            cv2.circle(mask, (w // 2, h // 2), int(min(w, h) * 0.34), 255, -1)
            active = cv2.countNonZero(cv2.bitwise_and(roi, mask))
            norm = active / max(1, cv2.countNonZero(mask))
            fill_scores.append(norm)

        fill_np = np.array(fill_scores, dtype=np.float32)
        ranked = np.argsort(fill_np)[::-1]
        best_idx = int(ranked[0])
        best_score = float(fill_np[best_idx])
        second_score = float(fill_np[ranked[1]]) if len(ranked) > 1 else 0.0

        mean_score = float(np.mean(fill_np))
        std_score = float(np.std(fill_np))
        dynamic_threshold = mean_score + max(0.07, std_score * 1.05)

        if best_score < max(dynamic_threshold, 0.16):
            answers[str(q_idx)] = "EMPTY"
            empty_questions.append(q_idx)
            color = (0, 128, 255)
            selected_indices: list[int] = []
        elif best_score - second_score < max(0.03, std_score * 0.55):
            answers[str(q_idx)] = "INVALID"
            invalid_questions.append(q_idx)
            multiple_marked_questions.append(q_idx)
            color = (0, 0, 255)
            selected_indices = [int(ranked[0]), int(ranked[1])] if len(ranked) > 1 else [best_idx]
        else:
            answers[str(q_idx)] = option_labels[best_idx]
            color = (0, 255, 0)
            selected_indices = [best_idx]
            confidence_chunks.append(float(best_score - mean_score))

        for idx, item in enumerate(row):
            x, y, w, h = item["bbox"]
            cx, cy = int(x + (w / 2)), int(y + (h / 2))
            base_radius = int(max(6, min(w, h) * 0.58))
            is_marked = idx in selected_indices
            if is_marked:
                # draw detection marker outside the inner text/label region to avoid overlap
                cv2.circle(overlay, (cx, cy), base_radius + 3, color, 2)

    confidence = 0.0
    if confidence_chunks:
        confidence = float(np.clip(np.mean(confidence_chunks) * 2.3, 0.0, 1.0))

    score = _score_answers(answers, answer_key)
    if score is not None:
        for q, details in score["details"].items():
            if details["detected"] in {"INVALID", "EMPTY"}:
                continue
            if not details["correct"]:
                warnings.append(f"Q{q} marked as {details['detected']} but expected {details['expected']}")

    elapsed_ms = int((time.time() - started) * 1000)
    logger.info(
        "OMR processed in %sms (blur=%.2f, rows=%s, threshold=%s)",
        elapsed_ms,
        blur_score,
        len(rows),
        "adaptive" if use_adaptive else "otsu",
    )

    return {
        "answers": answers,
        "invalid_questions": invalid_questions,
        "empty_questions": empty_questions,
        "multiple_marked_questions": multiple_marked_questions,
        "confidence_score": round(confidence, 4),
        "warnings": sorted(set(warnings)),
        "processing_time_ms": elapsed_ms,
        "score": score,
        "debug_overlay_base64": _encode_overlay(overlay),
    }
