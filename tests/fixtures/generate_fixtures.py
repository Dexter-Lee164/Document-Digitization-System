"""Synthetic test documents for DocuVision (no real student data).

Usage
-----
    python tests/fixtures/generate_fixtures.py            # (re)creates the files in tests/fixtures
    python tests/fixtures/generate_fixtures.py --samples  # additionally copies demo images into frontend/public/assets/samples

The module is also imported by the test-suite to build documents / simulated phone photographs with KNOWN content
and KNOWN ground-truth geometry.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TEMPLATE_PATH = ROOT / "cv-service" / "templates" / "university_registration.json"

PAGE_W, PAGE_H = 1240, 1754  # A4 at 150 DPI

LETTER_TEXT = """SAMPLE UNIVERSITY
Office of the Registrar
12 March 2026

To All Enrolled Students

Subject: Schedule of Final Examinations

Dear Students,

Please be informed that the final examinations for the second semester will begin on Monday, 18 May 2026, and will end on Friday, 29 May 2026. All students are required to bring their identification cards and examination permits to each session.

Students with unsettled accounts must visit the Cashier's Office before 15 May 2026 to obtain a clearance. Examination permits will not be released without this clearance.

For further questions, please contact the Registrar's Office during regular office hours, Monday to Friday, from 8:00 AM to 5:00 PM.

Sincerely,

Maria Santos
University Registrar"""

FORM_VALUES = {
    "student_name": "DELA CRUZ, JUAN M.",
    "student_number": "2022-01457",
    "program": "BS COMPUTER ENGINEERING",
    "year_level": "4TH YEAR",
    "section": "CPE-4A",
    "date": "15/09/2026",
    "contact_number": "0917-123-4567",
    "address": "BLK 5 LOT 12 SAMPAGUITA ST. SAN PEDRO CITY LAGUNA 4023",
}

_FONT_CANDIDATES = {
    ("sans", False): ["DejaVuSans.ttf", "arial.ttf", "Arial.ttf", "LiberationSans-Regular.ttf"],
    ("sans", True): ["DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf"],
    ("serif", False): ["DejaVuSerif.ttf", "times.ttf", "Times New Roman.ttf", "LiberationSerif-Regular.ttf"],
    ("serif", True): ["DejaVuSerif-Bold.ttf", "timesbd.ttf", "Times New Roman Bold.ttf", "LiberationSerif-Bold.ttf"],
}


def font(size: int, serif: bool = False, bold: bool = False) -> ImageFont.FreeTypeFont:
    for name in _FONT_CANDIDATES[("serif" if serif else "sans", bold)]:
        for folder in ("", "/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/", "C:/Windows/Fonts/"):
            try:
                return ImageFont.truetype(folder + name, size)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        current = ""
        for word in paragraph.split():
            trial = (current + " " + word).strip()
            if draw.textlength(trial, font=fnt) <= max_width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def render_text_page(text: str = LETTER_TEXT, size: tuple[int, int] = (PAGE_W, PAGE_H), font_size: int = 36, margin: int = 130, line_gap: float = 1.45) -> np.ndarray:
    """Black serif text on a white page. Returns BGR uint8."""
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    fnt = font(font_size, serif=True)
    y = margin
    for line in _wrap(draw, text, fnt, size[0] - 2 * margin):
        draw.text((margin, y), line, fill=(15, 15, 15), font=fnt)
        y += int(font_size * line_gap)
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def load_template() -> dict:
    return json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))


def render_form_page(values: dict[str, str] | None = None, template: dict | None = None, with_values: bool = True) -> np.ndarray:
    """Draw the sample university registration form exactly according to the template geometry."""
    tpl = template or load_template()
    values = FORM_VALUES if values is None else values
    W, H = tpl["canonical_size"]
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    lay = tpl["layout"]
    ink = (15, 15, 15)

    def centered(text, y_frac, fnt):
        d.text((W / 2, y_frac * H), text, fill=ink, font=fnt, anchor="mm")

    centered(lay["institution"]["text"], lay["institution"]["y"], font(40, bold=True))
    centered(tpl["title"], lay["title"]["y"], font(52, bold=True))
    centered(lay["subtitle"]["text"], lay["subtitle"]["y"], font(28))
    d.line([(W * 0.06, lay["rule_y"] * H), (W * 0.94, lay["rule_y"] * H)], fill=ink, width=3)
    d.text((W * 0.08, lay["section_heading"]["y"] * H), lay["section_heading"]["text"], fill=ink, font=font(30, bold=True))

    label_font, value_font = font(30), font(33, bold=True)
    for f in tpl["fields"]:
        lx, ly = f["label_xy"]
        d.text((lx * W, ly * H), f["label"] + ":", fill=ink, font=label_font)
        rx, ry, rw, rh = f["region"]
        x0, y0, x1, y1 = rx * W, ry * H, (rx + rw) * W, (ry + rh) * H
        d.line([(x0, y1), (x1, y1)], fill=(60, 60, 60), width=2)  # underline at the bottom of the value region
        if with_values and values.get(f["key"]):
            text = values[f["key"]]
            if f["type"] == "multiline":
                words, lines, cur = text.split(), [], ""
                for w_ in words:
                    trial = (cur + " " + w_).strip()
                    if d.textlength(trial, font=value_font) <= x1 - x0 - 10:
                        cur = trial
                    else:
                        lines.append(cur)
                        cur = w_
                lines.append(cur)
                for i, line in enumerate(lines[:2]):
                    d.text((x0 + 6, y0 + 4 + i * (rh * H / 2)), line, fill=ink, font=value_font)
                # second underline for the two-line address box
                d.line([(x0, y0 + rh * H / 2 + 2), (x1, y0 + rh * H / 2 + 2)], fill=(60, 60, 60), width=2)
            else:
                d.text((x0 + 6, y1 - 6), text, fill=ink, font=value_font, anchor="ls")

    d.text((W * 0.08, lay["instructions_heading"]["y"] * H), lay["instructions_heading"]["text"], fill=ink, font=font(30, bold=True))
    small = font(27)
    for i, line in enumerate(lay["instructions"]):
        d.text((W * 0.08, (lay["instructions_heading"]["y"] + 0.04 + i * 0.032) * H), line, fill=ink, font=small)

    sy = lay["signature_y"] * H
    d.line([(W * 0.08, sy), (W * 0.45, sy)], fill=ink, width=2)
    d.line([(W * 0.58, sy), (W * 0.92, sy)], fill=ink, width=2)
    d.text((W * 0.265, sy + 10), "Signature over Printed Name", fill=ink, font=font(24), anchor="ma")
    d.text((W * 0.75, sy + 10), "Registrar", fill=ink, font=font(24), anchor="ma")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


# ----------------------------------------------------------------------------- camera simulation
def camera_quad(
    canvas_size: tuple[int, int] = (2000, 2500),
    rx: float = 16.0,
    ry: float = -9.0,
    rz: float = -3.0,
    fill: float = 0.90,
    focal_px: float = 2600.0,
    page_mm: tuple[float, float] = (210.0, 297.0),
) -> list[tuple[float, float]]:
    """Project a physical A4 sheet through a pinhole camera (principal point at the canvas centre).

    The page is rotated by (rx, ry, rz) degrees and moved along the optical axis until its bounding box fills
    ``fill`` of the canvas. The result is a *physically consistent* perspective quad (TL, TR, BR, BL), so tests
    can check that the true page aspect ratio is recovered."""
    cw, ch = canvas_size
    pw, ph = page_mm
    pts = np.array([[-pw / 2, -ph / 2, 0], [pw / 2, -ph / 2, 0], [pw / 2, ph / 2, 0], [-pw / 2, ph / 2, 0]], dtype=np.float64)
    ax, ay, az = np.radians([rx, ry, rz])
    rot_x = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    rot_y = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    rot_z = np.array([[np.cos(az), -np.sin(az), 0], [np.sin(az), np.cos(az), 0], [0, 0, 1]])
    cam = pts @ (rot_z @ rot_y @ rot_x).T

    def project(distance: float) -> np.ndarray:
        z = cam[:, 2] + distance
        return np.stack([focal_px * cam[:, 0] / z + cw / 2, focal_px * cam[:, 1] / z + ch / 2], axis=1)

    lo, hi = 200.0, 5000.0
    for _ in range(60):  # bisection on distance so the bounding box just fits
        mid = (lo + hi) / 2
        q = project(mid)
        span = max((q[:, 0].max() - q[:, 0].min()) / cw, (q[:, 1].max() - q[:, 1].min()) / ch)
        lo, hi = (mid, hi) if span > fill else (lo, mid)
    q = project(hi)
    q[:, 0] += cw / 2 - (q[:, 0].max() + q[:, 0].min()) / 2
    q[:, 1] += ch / 2 - (q[:, 1].max() + q[:, 1].min()) / 2
    return [(float(x), float(y)) for x, y in q]


def simulate_photo(
    page: np.ndarray,
    canvas_size: tuple[int, int] = (2000, 2500),
    quad: list[tuple[float, float]] | None = None,
    background: str = "wood",
    shadow: float = 0.35,
    noise_sigma: float = 4.0,
    blur_sigma: float = 0.8,
    seed: int = 7,
    jpeg_quality: int = 88,
) -> tuple[np.ndarray, np.ndarray]:
    """Place ``page`` on a textured background through a perspective transform, add lighting gradient, noise and blur.

    Returns (photo BGR uint8, ground-truth corners TL,TR,BR,BL in photo pixel coordinates)."""
    rng = np.random.default_rng(seed)
    cw, ch = canvas_size
    if quad is None:
        quad = [(0.13 * cw, 0.09 * ch), (0.90 * cw, 0.06 * ch), (0.95 * cw, 0.93 * ch), (0.08 * cw, 0.96 * ch)]
    dst = np.array(quad, dtype=np.float32)
    h, w = page.shape[:2]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)

    if background == "wood":
        base = np.zeros((ch, cw, 3), np.float32)
        base[:] = (45, 85, 130)  # brownish (BGR)
        grain = rng.normal(0, 1, (ch, 1)).astype(np.float32)
        grain = cv2.GaussianBlur(grain, (1, 0), 0) if False else grain
        base += np.repeat(grain * 14, cw, axis=1)[:, :, None]
        base += rng.normal(0, 5, base.shape).astype(np.float32)
        bg = np.clip(base, 0, 255).astype(np.uint8)
    else:
        bg = np.full((ch, cw, 3), (38, 38, 42), np.uint8)
        bg = np.clip(bg.astype(np.float32) + rng.normal(0, 4, bg.shape), 0, 255).astype(np.uint8)

    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, matrix, (cw, ch), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), matrix, (cw, ch), flags=cv2.INTER_LINEAR)
    mask = cv2.GaussianBlur(mask, (5, 5), 0).astype(np.float32)[:, :, None] / 255.0
    photo = warped.astype(np.float32) * mask + bg.astype(np.float32) * (1 - mask)

    # soft lighting gradient (shadow on one side)
    xs = np.linspace(1.0 - shadow, 1.0, cw, dtype=np.float32)[None, :, None]
    ys = np.linspace(1.0 - shadow / 2, 1.0, ch, dtype=np.float32)[:, None, None]
    photo *= xs * ys

    if blur_sigma > 0:
        photo = cv2.GaussianBlur(photo, (0, 0), blur_sigma)
    if noise_sigma > 0:
        photo += rng.normal(0, noise_sigma, photo.shape).astype(np.float32)
    photo = np.clip(photo, 0, 255).astype(np.uint8)

    ok, enc = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality])
    photo = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return photo, dst


def rotate_page(img: np.ndarray, angle_ccw: float, fill=(255, 255, 255)) -> np.ndarray:
    """Rotate by an arbitrary angle (counter-clockwise positive), expanding the canvas."""
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle_ccw, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=fill)


def write(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower()
    params = [cv2.IMWRITE_JPEG_QUALITY, 90] if ext in (".jpg", ".jpeg") else []
    ok, enc = cv2.imencode(ext, img, params)
    assert ok
    path.write_bytes(enc.tobytes())


def generate_all(out_dir: Path = HERE) -> dict[str, Path]:
    out: dict[str, Path] = {}
    letter = render_text_page()
    form = render_form_page()
    out["letter_clean.png"] = out_dir / "letter_clean.png"
    write(out["letter_clean.png"], letter)
    out["registration_form_clean.png"] = out_dir / "registration_form_clean.png"
    write(out["registration_form_clean.png"], form)

    photo, corners = simulate_photo(letter, quad=camera_quad(rx=16, ry=-9, rz=-3), seed=11)
    write(out_dir / "letter_photo.jpg", photo)
    out["letter_photo.jpg"] = out_dir / "letter_photo.jpg"
    form_photo, form_corners = simulate_photo(form, quad=camera_quad(rx=-12, ry=11, rz=4), background="dark", seed=5)
    write(out_dir / "registration_form_photo.jpg", form_photo)
    out["registration_form_photo.jpg"] = out_dir / "registration_form_photo.jpg"

    write(out_dir / "letter_rotated_90.png", cv2.rotate(letter, cv2.ROTATE_90_CLOCKWISE))
    out["letter_rotated_90.png"] = out_dir / "letter_rotated_90.png"
    write(out_dir / "letter_upside_down.png", cv2.rotate(letter, cv2.ROTATE_180))
    out["letter_upside_down.png"] = out_dir / "letter_upside_down.png"
    write(out_dir / "letter_skew_5deg.png", rotate_page(letter, 5.0))
    out["letter_skew_5deg.png"] = out_dir / "letter_skew_5deg.png"

    (out_dir / "letter_reference.txt").write_text(LETTER_TEXT + "\n", encoding="utf-8")
    (out_dir / "registration_form_reference.json").write_text(json.dumps(FORM_VALUES, indent=2), encoding="utf-8")
    (out_dir / "ground_truth_corners.json").write_text(
        json.dumps({"letter_photo.jpg": corners.tolist(), "registration_form_photo.jpg": form_corners.tolist()}, indent=2),
        encoding="utf-8",
    )
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", action="store_true", help="also copy demo images to frontend/public/assets/samples")
    args = parser.parse_args()
    files = generate_all()
    for name, path in files.items():
        print("wrote", path.relative_to(ROOT))
    if args.samples:
        dest = ROOT / "frontend" / "public" / "assets" / "samples"
        dest.mkdir(parents=True, exist_ok=True)
        for name in ("letter_photo.jpg", "registration_form_photo.jpg", "letter_clean.png", "registration_form_clean.png"):
            shutil.copy(files[name], dest / name)
            print("copied", (dest / name).relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
