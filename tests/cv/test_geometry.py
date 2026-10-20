"""Document detection, perspective correction, orientation and deskew."""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from conftest import FIXTURES, gf, requires_tesseract
from processing.common import ImageError, InvalidCornersError, decode_image_bytes, load_image
from processing.deskew import deskew, estimate_skew, rotate_image
from processing.document_detection import detect_document
from processing.orientation import detect_orientation, rotate_quarter
from processing.perspective import four_point_transform, order_corners, output_size, validate_corners
from processing.pipeline import run_geometry


# ------------------------------------------------------------------ image loading
def test_load_image_returns_bgr_uint8(letter):
    assert letter.dtype == np.uint8 and letter.ndim == 3 and letter.shape[2] == 3


def test_decode_rejects_empty_and_garbage():
    with pytest.raises(ImageError):
        decode_image_bytes(b"")
    with pytest.raises(ImageError):
        decode_image_bytes(b"this is definitely not an image" * 20)


def test_decode_rejects_wrong_format_even_with_image_extension_content(tmp_path):
    ok, enc = cv2.imencode(".bmp", np.full((64, 64, 3), 200, np.uint8))
    with pytest.raises(ImageError, match="Unsupported"):
        decode_image_bytes(enc.tobytes())


def test_decode_rejects_truncated_jpeg():
    data = (FIXTURES / "letter_photo.jpg").read_bytes()
    with pytest.raises(ImageError):
        decode_image_bytes(data[: len(data) // 3])


def test_decode_rejects_oversized_pixel_count():
    ok, enc = cv2.imencode(".png", np.full((300, 300, 3), 255, np.uint8))
    with pytest.raises(ImageError, match="too large"):
        decode_image_bytes(enc.tobytes(), max_pixels=10_000)


def test_png_alpha_is_composited_on_white():
    rgba = np.zeros((64, 64, 4), np.uint8)
    rgba[:, :, 3] = 0  # fully transparent
    ok, enc = cv2.imencode(".png", rgba)
    out = decode_image_bytes(enc.tobytes())
    assert out.min() == 255


# ------------------------------------------------------------------ corner ordering / validation
def test_order_corners_any_input_order():
    tl, tr, br, bl = (10, 12), (300, 8), (310, 400), (4, 390)
    expected = np.array([tl, tr, br, bl], dtype=np.float32)
    for perm in ([0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]):
        pts = np.array([tl, tr, br, bl], dtype=np.float32)[perm]
        assert np.allclose(order_corners(pts), expected)


@pytest.mark.parametrize(
    "pts",
    [
        [[0, 0], [10, 10]],  # wrong count
        [[0, 0], [100, 0], [100, 100], [float("nan"), 100]],  # NaN
        [[0, 0], [100, 0], [100, 100], [5000, 5000]],  # outside image
        [[10, 10], [10, 10], [200, 200], [10, 200]],  # duplicate points
        [[10, 10], [300, 10], [20, 20], [300, 300]],  # self-intersecting / non convex
        [[10, 10], [14, 10], [14, 14], [10, 14]],  # tiny
    ],
)
def test_invalid_corners_are_rejected(pts):
    with pytest.raises(InvalidCornersError):
        validate_corners(pts, 400, 400)


# ------------------------------------------------------------------ detection
@pytest.mark.parametrize("name", ["letter_photo.jpg", "registration_form_photo.jpg"])
def test_detects_document_boundary_close_to_ground_truth(name, ground_truth):
    img = load_image(FIXTURES / name)
    result = detect_document(img)
    assert result.detected, result.message
    err = np.abs(result.corners - np.array(ground_truth[name], dtype=np.float32)).max()
    assert err < 20, f"max corner error {err}px"
    assert result.confidence > 0.5


def test_clean_scan_falls_back_to_full_frame(letter):
    result = detect_document(letter)
    assert not result.detected
    h, w = letter.shape[:2]
    assert np.allclose(result.corners, gf.np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]))
    assert "manually" in result.message


def test_detection_does_not_just_take_the_largest_contour():
    """A big dark rectangle (not paper) next to a smaller bright page: the page should win."""
    canvas = np.full((900, 1200, 3), 120, np.uint8)
    cv2.rectangle(canvas, (20, 20), (560, 880), (40, 40, 40), -1)  # large dark slab
    page = np.full((560, 420, 3), 235, np.uint8)
    for i in range(6):
        cv2.putText(page, "TEXT LINE", (30, 80 + i * 70), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20, 20, 20), 2)
    canvas[160:720, 700:1120] = page
    result = detect_document(canvas)
    assert result.detected
    cx = result.corners[:, 0].mean()
    assert 800 < cx < 1020, f"picked the wrong region (centre x={cx})"


# ------------------------------------------------------------------ perspective
def test_perspective_flattens_known_homography(ground_truth, letter, letter_photo):
    corners = np.array(ground_truth["letter_photo.jpg"], dtype=np.float32)
    warped, matrix = four_point_transform(letter_photo, corners)
    assert matrix.shape == (3, 3)
    # Output should resemble the original page: compare after resizing, using normalised correlation.
    # Blur both so the comparison measures LAYOUT alignment (where the text blocks are), not pixel noise or the
    # simulated lighting gradient.
    ref = cv2.cvtColor(cv2.resize(letter, (warped.shape[1], warped.shape[0])), cv2.COLOR_BGR2GRAY).astype(np.float32)
    got = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ref, got = (cv2.GaussianBlur(a, (0, 0), 6) for a in (ref, got))
    ref, got = (a - cv2.GaussianBlur(a, (0, 0), 60) for a in (ref, got))  # remove slow lighting variation
    corr = np.corrcoef(ref.ravel(), got.ravel())[0, 1]
    assert corr > 0.9, f"correlation {corr:.3f}"
    # aspect ratio approximately A4
    assert abs(warped.shape[0] / warped.shape[1] - 1754 / 1240) < 0.05  # camera-model aspect estimate un-stretches the page


@pytest.mark.parametrize("name", ["letter_photo.jpg", "registration_form_photo.jpg"])
def test_camera_model_recovers_true_a4_aspect_ratio(name, ground_truth):
    from processing.perspective import estimate_aspect_ratio, plan_output

    ordered = order_corners(ground_truth[name])
    ratio = estimate_aspect_ratio(ordered, (2000, 2500))
    assert ratio == pytest.approx(210 / 297, rel=0.03)
    plan = plan_output(ordered, (2000, 2500))
    assert plan["method"] == "camera_model"
    # naive longest-edge sizing would have stretched the page by >10%
    naive_w = max(np.linalg.norm(ordered[1] - ordered[0]), np.linalg.norm(ordered[2] - ordered[3]))
    naive_h = max(np.linalg.norm(ordered[3] - ordered[0]), np.linalg.norm(ordered[2] - ordered[1]))
    assert plan["width"] / plan["height"] == pytest.approx(210 / 297, rel=0.03)
    assert plan["width"] >= naive_w - 2 and plan["height"] >= naive_h - 2  # no side shrunk


def test_aspect_estimation_falls_back_for_affine_quads():
    from processing.perspective import estimate_aspect_ratio, plan_output

    parallelogram = np.array([[100, 100], [700, 100], [750, 900], [150, 900]], dtype=np.float32)
    assert estimate_aspect_ratio(parallelogram, (1000, 1000)) is None
    assert plan_output(parallelogram, (1000, 1000))["method"] == "edge_lengths"


def test_output_size_never_shrinks_a_side():
    q = np.array([[0, 0], [300, 20], [320, 400], [10, 380]], dtype=np.float32)
    w, h = output_size(order_corners(q))
    assert w >= 300 and h >= 380


def test_four_point_transform_invalid_corners_raise(letter_photo):
    with pytest.raises(InvalidCornersError):
        four_point_transform(letter_photo, [[0, 0], [1, 1], [2, 2], [3, 3]])


# ------------------------------------------------------------------ deskew
@pytest.mark.parametrize("angle", [3.0, -5.0, 8.0])
def test_deskew_estimates_known_skews(letter, angle):
    skewed = gf.rotate_page(letter, angle)  # counter-clockwise positive
    est = estimate_skew(skewed)
    assert est.reliable
    assert est.angle == pytest.approx(-angle, abs=0.6)


def test_deskew_reduces_skew(letter):
    skewed = gf.rotate_page(letter, 5.0)
    fixed, res = deskew(skewed)
    after = estimate_skew(fixed)
    assert abs(after.angle) < 0.5


def test_level_page_is_left_alone(letter):
    fixed, res = deskew(letter)
    assert res.angle == 0.0 and fixed is letter


def test_blank_page_skew_is_unreliable():
    blank = np.full((800, 600, 3), 255, np.uint8)
    res = estimate_skew(blank)
    assert not res.reliable and res.angle == 0.0


def test_rotate_image_expands_canvas(letter):
    out = rotate_image(letter, 10)
    assert out.shape[0] > letter.shape[0] and out.shape[1] > letter.shape[1]


# ------------------------------------------------------------------ orientation
def test_rotate_quarter_is_lossless(letter):
    assert np.array_equal(rotate_quarter(rotate_quarter(letter, 90), 270), letter)
    assert np.array_equal(rotate_quarter(letter, 180), cv2.rotate(letter, cv2.ROTATE_180))
    with pytest.raises(ValueError):
        rotate_quarter(letter, 45)


@requires_tesseract
@pytest.mark.parametrize("fixture,expected", [("letter_clean.png", 0), ("letter_rotated_90.png", 270), ("letter_upside_down.png", 180)])
def test_orientation_detection(fixture, expected):
    res = detect_orientation(load_image(FIXTURES / fixture))
    assert res.reliable
    assert res.angle_cw == expected


@requires_tesseract
def test_orientation_fallback_when_osd_fails(monkeypatch):
    from ocr import recognition

    def boom(*a, **k):
        raise recognition.OcrError("OSD failed")

    monkeypatch.setattr(recognition, "osd", boom)
    res = detect_orientation(load_image(FIXTURES / "letter_upside_down.png"))
    assert res.method == "ocr_score" and res.reliable and res.angle_cw == 180


def test_orientation_reports_unavailable_when_tesseract_missing(monkeypatch, letter):
    from ocr import recognition

    def missing(*a, **k):
        raise recognition.OcrUnavailableError("no tesseract")

    monkeypatch.setattr(recognition, "osd", missing)
    res = detect_orientation(letter)
    assert not res.reliable and res.angle_cw == 0 and res.method == "unavailable"


# ------------------------------------------------------------------ complete geometry pipeline
@requires_tesseract
def test_geometry_pipeline_on_photo_with_manual_rotation(letter_photo):
    out, rep = run_geometry(letter_photo)
    assert rep["corners_source"] == "auto" and rep["perspective"]["applied"]
    rotated, rep2 = run_geometry(letter_photo, manual_rotation=90)
    assert rotated.shape[:2] == out.shape[:2][::-1] or abs(rotated.shape[0] - out.shape[1]) < 3


def test_geometry_manual_corners_override_detection(letter_photo):
    h, w = letter_photo.shape[:2]
    corners = [[300, 300], [1500, 300], [1500, 2000], [300, 2000]]
    out, rep = run_geometry(letter_photo, corners=corners, auto_orient=False, auto_deskew=False)
    assert rep["corners_source"] == "manual"
    assert abs(out.shape[1] - 1200) < 5 and abs(out.shape[0] - 1700) < 5


def test_geometry_invalid_manual_corners(letter_photo):
    with pytest.raises(InvalidCornersError):
        run_geometry(letter_photo, corners=[[0, 0], [10, 0], [10, 10]])
