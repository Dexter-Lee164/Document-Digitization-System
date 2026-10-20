"""DSP enhancement stages, presets and parameter validation."""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from processing import enhancement as enh
from processing.common import ParameterError, to_gray
from processing.schema import defaults, load_schema, preset_params, validate_geometry, validate_params


def _noisy_gray(sigma=15, seed=0):
    rng = np.random.default_rng(seed)
    base = np.full((300, 400), 200, np.uint8)
    cv2.putText(base, "Hello", (40, 160), cv2.FONT_HERSHEY_SIMPLEX, 2.0, 30, 3)
    return np.clip(base.astype(np.float32) + rng.normal(0, sigma, base.shape), 0, 255).astype(np.uint8)


def test_grayscale_conversion_weights():
    bgr = np.zeros((10, 10, 3), np.uint8)
    bgr[:, :] = (0, 255, 0)  # pure green
    g = to_gray(bgr)
    assert g.ndim == 2 and abs(int(g[0, 0]) - round(0.587 * 255)) <= 1


def test_gaussian_and_median_reduce_noise():
    noisy = _noisy_gray()
    bg = (slice(200, 290), slice(20, 380))  # text-free area
    for method in ("gaussian", "median", "bilateral"):
        out = enh.denoise(noisy, method, 5)
        assert out[bg].std() < noisy[bg].std() * 0.7, method


def test_median_removes_salt_and_pepper_better_than_gaussian():
    img = np.full((200, 200), 180, np.uint8)
    rng = np.random.default_rng(1)
    mask = rng.random(img.shape)
    img[mask < 0.03] = 0
    img[mask > 0.97] = 255
    med = np.abs(enh.denoise(img, "median", 3).astype(int) - 180).mean()
    gau = np.abs(enh.denoise(img, "gaussian", 3).astype(int) - 180).mean()
    assert med < gau


def test_clahe_increases_contrast_of_low_contrast_image():
    rng = np.random.default_rng(2)
    low = (120 + rng.integers(0, 20, (200, 200))).astype(np.uint8)
    low[60:140, 60:140] += 15
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(4, 4))
    assert clahe.apply(low).std() > low.std() * 1.5


@pytest.mark.parametrize("method", ["otsu", "adaptive_gaussian"])
def test_thresholding_produces_binary_image(method):
    out = enh.threshold(_noisy_gray(5), method, 35, 12)
    assert set(np.unique(out)).issubset({0, 255})
    assert (out == 0).sum() > 0 and (out == 255).sum() > 0


def test_adaptive_threshold_handles_uneven_lighting_better_than_otsu():
    page = np.full((300, 400), 230, np.uint8)
    cv2.putText(page, "Shadow", (30, 160), cv2.FONT_HERSHEY_SIMPLEX, 2.0, 40, 3)
    gradient = np.linspace(0.35, 1.0, 400, dtype=np.float32)[None, :]
    shaded = (page.astype(np.float32) * gradient).astype(np.uint8)
    otsu = enh.threshold(shaded, "otsu", 35, 12)
    adaptive = enh.threshold(shaded, "adaptive_gaussian", 35, 10)
    # Otsu loses the dark side of the page (black), adaptive keeps a white background everywhere.
    left_otsu_white = (otsu[:, :80] == 255).mean()
    left_adapt_white = (adaptive[:, :80] == 255).mean()
    assert left_adapt_white > left_otsu_white + 0.3


def test_shadow_removal_flattens_illumination():
    page = np.full((400, 600), 235, np.uint8)
    cv2.putText(page, "Document", (40, 200), cv2.FONT_HERSHEY_SIMPLEX, 3.0, 40, 4)
    shaded = (page.astype(np.float32) * np.linspace(0.4, 1.0, 600, dtype=np.float32)[None, :]).astype(np.uint8)
    flat = enh.remove_shadows(shaded)
    left, right = shaded[:, :100].mean(), shaded[:, -100:].mean()
    left2, right2 = flat[:, :100].mean(), flat[:, -100:].mean()
    assert abs(left2 - right2) < abs(left - right) * 0.25


def test_morphology_acts_on_ink_not_background():
    img = np.full((50, 50), 255, np.uint8)
    img[20:30, 20:30] = 0  # 100 px of ink
    thick = enh.morphology(img, "dilate", 3, 1)
    thin = enh.morphology(img, "erode", 3, 1)
    assert (thick == 0).sum() > 100 and (thin == 0).sum() < 100
    speck = img.copy(); speck[5, 5] = 0
    assert enh.morphology(speck, "open", 3, 1)[5, 5] == 255  # opening removes isolated ink specks


def test_sharpening_increases_edge_energy():
    img = cv2.GaussianBlur(_noisy_gray(0), (0, 0), 2.0)
    for method in ("unsharp", "kernel"):
        out = enh.sharpen(img, method, 1.0)
        assert cv2.Laplacian(out, cv2.CV_64F).var() > cv2.Laplacian(img, cv2.CV_64F).var()


def test_resample_upscales_small_images_and_keeps_aspect():
    small = np.full((500, 400), 200, np.uint8)
    out, scale = enh.resample(small, "auto", 2200)
    assert scale > 1 and abs(out.shape[1] / out.shape[0] - 0.8) < 0.01
    same, scale2 = enh.resample(small, "none", 2200)
    assert scale2 == 1.0 and same.shape == small.shape


def test_noise_estimator_tracks_added_noise():
    clean = np.full((300, 300), 200, np.uint8)
    rng = np.random.default_rng(3)
    noisy = np.clip(clean + rng.normal(0, 10, clean.shape), 0, 255).astype(np.uint8)
    assert enh.estimate_noise_sigma(clean) < 1
    assert 7 < enh.estimate_noise_sigma(noisy) < 13


def _correlated_noise(gray, sigma, scale=2, seed=5):
    """Noise made at 1/scale resolution and stretched up: neighbouring pixels move together, like camera or JPEG grain."""
    rng = np.random.default_rng(seed)
    h, w = gray.shape
    field = rng.normal(0, sigma * scale, (h // scale + 1, w // scale + 1)).astype(np.float32)
    field = cv2.resize(field, (w, h), interpolation=cv2.INTER_LINEAR)
    return np.clip(gray.astype(np.float32) + field, 0, 255).astype(np.uint8)


def test_noise_estimator_sees_correlated_noise_the_laplacian_misses(letter):
    gray = cv2.resize(to_gray(letter), (880, 1245), interpolation=cv2.INTER_AREA)
    noisy = _correlated_noise(gray, 10)
    # The white-noise estimator reads this as nearly clean; the flat-block estimate finds the real noise floor.
    assert enh._white_noise_sigma(noisy) < 2.5
    assert enh._flat_block_sigma(noisy) > 4
    assert enh.estimate_noise_sigma(noisy) > 4
    assert enh.estimate_noise_sigma(gray) < 1  # a clean page stays clean (ink blocks do not count as noise)


def test_automatic_preset_caps_clahe_when_the_page_is_noisy(letter):
    gray = cv2.resize(to_gray(letter), (880, 1245), interpolation=cv2.INTER_AREA)
    faded = (255 - (255 - gray.astype(np.float32)) * 0.55).astype(np.uint8)  # low-contrast page: the rule wants strong CLAHE
    clean_params, _ = enh.resolve_params("automatic", None, faded)
    noisy_params, analysis = enh.resolve_params("automatic", None, _correlated_noise(faded, 8))
    assert clean_params["clahe_clip"] == 3.0 and clean_params["denoise_method"] == "none"
    assert analysis["noise_sigma"] >= 3.5
    assert noisy_params["denoise_method"] == "median" and noisy_params["denoise_kernel"] >= 5
    assert noisy_params["clahe_clip"] <= 1.5  # CLAHE would stretch the noise as much as the ink


# ------------------------------------------------------------------ pipeline & presets
@pytest.mark.parametrize("preset", ["automatic", "document_scan", "black_white", "grayscale", "custom"])
def test_every_preset_runs_and_returns_single_channel(letter_photo, preset):
    gray = to_gray(letter_photo)
    params, analysis = enh.resolve_params(preset, None, gray)
    out, report = enh.enhance(letter_photo, params)
    assert out.ndim == 2 and out.dtype == np.uint8
    assert report["steps"][0]["stage"] == "grayscale"
    assert set(analysis) >= {"noise_sigma", "contrast_std", "illumination_variation", "sharpness_laplacian_var"}


def test_black_white_preset_is_binary_and_grayscale_is_not(letter_photo):
    gray = to_gray(letter_photo)
    bw, _ = enh.enhance(letter_photo, enh.resolve_params("black_white", None, gray)[0])
    gs, _ = enh.enhance(letter_photo, enh.resolve_params("grayscale", None, gray)[0])
    assert set(np.unique(bw)).issubset({0, 255})
    assert len(np.unique(gs)) > 10


def test_automatic_preset_adapts_to_image_characteristics(letter):
    gray = to_gray(letter)
    clean, _ = enh.resolve_params("automatic", None, gray)
    noisy = np.clip(gray.astype(np.float32) + np.random.default_rng(0).normal(0, 18, gray.shape), 0, 255).astype(np.uint8)
    noisy_params, _ = enh.resolve_params("automatic", None, noisy)
    assert clean["denoise_method"] == "none"
    assert noisy_params["denoise_method"] != "none"
    shaded = (gray * np.linspace(0.45, 1.0, gray.shape[1], dtype=np.float32)[None, :]).astype(np.uint8)
    assert enh.resolve_params("automatic", None, shaded)[0]["shadow_removal"] is True


def test_custom_preset_applies_user_parameters(letter):
    gray = to_gray(letter)
    params, _ = enh.resolve_params("custom", {"threshold_method": "otsu", "denoise_method": "gaussian", "denoise_kernel": 5}, gray)
    assert params["threshold_method"] == "otsu" and params["denoise_method"] == "gaussian" and params["denoise_kernel"] == 5
    out, report = enh.enhance(letter, params)
    assert report["output_mode"] == "binary"
    assert {s["stage"] for s in report["steps"]} >= {"denoise", "threshold"}


def test_report_lists_only_applied_stages(letter):
    params = {**defaults(), "shadow_removal": False, "denoise_method": "none", "clahe_clip": 0, "sharpen_method": "none", "threshold_method": "none", "morph_op": "none", "resize_mode": "none"}
    _, report = enh.enhance(letter, params)
    assert [s["stage"] for s in report["steps"]] == ["grayscale", "resample"]


# ------------------------------------------------------------------ schema validation (shared contract)
def test_schema_defaults_validate():
    assert validate_params(defaults())


@pytest.mark.parametrize(
    "bad",
    [
        {"denoise_method": "laser"},
        {"clahe_clip": 99},
        {"clahe_clip": "high"},
        {"adaptive_block": 5},
        {"shadow_removal": "yes"},
        {"does_not_exist": 1},
        {"denoise_kernel": True},
    ],
)
def test_invalid_parameters_are_rejected(bad):
    with pytest.raises(ParameterError):
        validate_params(bad)


def test_even_kernel_is_corrected_to_odd():
    assert validate_params({"denoise_kernel": 4})["denoise_kernel"] == 5


def test_unknown_preset_rejected():
    with pytest.raises(ParameterError):
        preset_params("sepia")


def test_geometry_parameter_validation():
    assert validate_geometry(90, 3.5) == (90, 3.5)
    with pytest.raises(ParameterError):
        validate_geometry(45, 0)
    with pytest.raises(ParameterError):
        validate_geometry(0, 40)


def test_all_presets_in_schema_are_valid():
    schema = load_schema()
    for name in schema["presets"]:
        assert preset_params(name, schema)
