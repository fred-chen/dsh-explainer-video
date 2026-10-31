#!/usr/bin/env python3
"""Extract text + images from PDF/PPTX/DOCX for dsh-explainer-video.

Usage: extract_materials.py <file> <asset_dir>
Outputs JSON on stdout. PDF requires PyMuPDF; PPTX prefers python-pptx;
DOCX prefers python-docx; both office formats fall back to stdlib zip+XML.
"""

import json
import os
import sys
import zipfile
import re
import xml.etree.ElementTree as ET

MAX_IMAGES = 20


def safe_name(value, fallback="asset"):
    value = re.sub(r"[^0-9A-Za-z._-]+", "-", str(value or fallback))
    return value[:80] or fallback


def save_asset(asset_dir, name, data, ext, width=0, height=0, locator="", mime=""):
    if len(data) == 0:
        return None
    os.makedirs(asset_dir, exist_ok=True)
    fn = safe_name(name, "asset")
    if ext and not fn.lower().endswith("." + ext.lower()):
        fn = fn + "." + ext.lower()
    path = os.path.join(asset_dir, fn)
    with open(path, "wb") as f:
        f.write(data)
    return {
        "path": os.path.abspath(path),
        "locator": locator,
        "width": int(width or 0),
        "height": int(height or 0),
        "mime": mime or "",
    }


def extract_pdf(path, asset_dir):
    try:
        import pymupdf
    except Exception:
        try:
            import fitz as pymupdf
        except Exception:
            raise RuntimeError("PDF 解析需要 PyMuPDF；本机未安装 pymupdf")
    doc = pymupdf.open(path)
    notes = []
    assets = []
    image_count = 0
    for page_index, page in enumerate(doc, 1):
        text = (page.get_text("text") or "").strip()
        if text:
            notes.append({"locator": f"p.{page_index}", "text": text})
        if image_count >= MAX_IMAGES:
            continue
        try:
            for img in page.get_images(full=True):
                if image_count >= MAX_IMAGES:
                    break
                xref = img[0]
                info = doc.extract_image(xref)
                if not info:
                    continue
                saved = save_asset(
                    asset_dir,
                    f"pdf-p{page_index}-{image_count + 1}",
                    info.get("image", b""),
                    info.get("ext", "png"),
                    info.get("width", 0),
                    info.get("height", 0),
                    f"p.{page_index}",
                    f"image/{info.get('ext', 'png')}",
                )
                if saved:
                    saved["kind"] = "image"
                    assets.append(saved)
                    image_count += 1
        except Exception:
            pass
    title = ""
    if notes:
        title = notes[0]["text"].split("\n")[0][:120]
    return {
        "title": title,
        "pages": len(doc),
        "notes": notes,
        "assets": assets,
        "warnings": [],
    }


def extract_pptx(path, asset_dir):
    notes = []
    assets = []
    slide_count = 0
    warnings = []
    try:
        from pptx import Presentation
        prs = Presentation(path)
        slide_count = len(prs.slides)
        image_count = 0
        for slide_index, slide in enumerate(prs.slides, 1):
            texts = []
            for shape in slide.shapes:
                try:
                    if shape.has_text_frame:
                        text = (shape.text or "").strip()
                        if text:
                            texts.append(text)
                except Exception:
                    pass
            if texts:
                notes.append({"locator": f"slide {slide_index}", "text": "\n".join(texts)})
            try:
                if slide.has_notes_slide:
                    note_text = (slide.notes_slide.notes_text_frame.text or "").strip()
                    if note_text:
                        notes.append({"locator": f"slide {slide_index} notes", "text": note_text})
            except Exception:
                pass
            for shape in slide.shapes:
                if image_count >= MAX_IMAGES:
                    break
                try:
                    if shape.shape_type == 13 and getattr(shape, "image", None) is not None:
                        image = shape.image
                        saved = save_asset(
                            asset_dir,
                            f"pptx-s{slide_index}-{image_count + 1}",
                            image.blob,
                            image.ext,
                            getattr(image, "width", 0),
                            getattr(image, "height", 0),
                            f"slide {slide_index}",
                            f"image/{image.ext}",
                        )
                        if saved:
                            saved["kind"] = "image"
                            assets.append(saved)
                            image_count += 1
                except Exception:
                    pass
    except Exception as exc:
        warnings.append(f"python-pptx 不可用，改用 zip/XML: {exc}")
        try:
            slide_count, notes, assets = pptx_zip_fallback(path, asset_dir)
        except Exception as fallback_exc:
            raise RuntimeError(f"PPTX 解析失败: {exc} / {fallback_exc}")
    title = ""
    if notes:
        title = notes[0]["text"].split("\n")[0][:120]
    return {
        "title": title,
        "pages": slide_count,
        "notes": notes,
        "assets": assets,
        "warnings": warnings,
    }


def pptx_zip_fallback(path, asset_dir):
    notes = []
    assets = []
    slide_count = 0
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        slide_files = sorted(
            [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)],
            key=lambda x: int(re.search(r"slide(\d+)", x).group(1)),
        )
        slide_count = len(slide_files)
        for slide_file in slide_files:
            index = int(re.search(r"slide(\d+)", slide_file).group(1))
            xml = zf.read(slide_file)
            root = ET.fromstring(xml)
            ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            texts = [el.text.strip() for el in root.findall(".//a:t", ns) if el.text and el.text.strip()]
            if texts:
                notes.append({"locator": f"slide {index}", "text": "\n".join(texts)})
        image_count = 0
        for name in names:
            if image_count >= MAX_IMAGES:
                break
            if name.startswith("ppt/media/"):
                data = zf.read(name)
                ext = os.path.splitext(name)[1].lstrip(".")
                saved = save_asset(asset_dir, f"pptx-media-{image_count + 1}", data, ext, 0, 0, "media", f"image/{ext}")
                if saved:
                    saved["kind"] = "image"
                    assets.append(saved)
                    image_count += 1
    return slide_count, notes, assets


def extract_docx(path, asset_dir):
    notes = []
    assets = []
    warnings = []
    try:
        from docx import Document
        doc = Document(path)
        for index, paragraph in enumerate(doc.paragraphs, 1):
            text = (paragraph.text or "").strip()
            if text:
                notes.append({"locator": f"paragraph {index}", "text": text})
        for table_index, table in enumerate(doc.tables, 1):
            rows = []
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells]
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                notes.append({"locator": f"table {table_index}", "text": "\n".join(rows)})
    except Exception as exc:
        warnings.append(f"python-docx 不可用，改用 zip/XML: {exc}")
        try:
            notes = docx_zip_fallback(path)
        except Exception as fallback_exc:
            raise RuntimeError(f"DOCX 解析失败: {exc} / {fallback_exc}")
    try:
        with zipfile.ZipFile(path) as zf:
            image_count = 0
            for name in zf.namelist():
                if image_count >= MAX_IMAGES:
                    break
                if name.startswith("word/media/"):
                    data = zf.read(name)
                    ext = os.path.splitext(name)[1].lstrip(".")
                    saved = save_asset(asset_dir, f"docx-media-{image_count + 1}", data, ext, 0, 0, "media", f"image/{ext}")
                    if saved:
                        saved["kind"] = "image"
                        assets.append(saved)
                        image_count += 1
    except Exception as exc:
        warnings.append(f"DOCX 图片提取失败: {exc}")
    title = ""
    if notes:
        title = notes[0]["text"].split("\n")[0][:120]
    return {
        "title": title,
        "pages": 0,
        "notes": notes,
        "assets": assets,
        "warnings": warnings,
    }


def docx_zip_fallback(path):
    notes = []
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml")
        root = ET.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for paragraph in root.findall(".//w:p", ns):
            texts = [el.text.strip() for el in paragraph.findall(".//w:t", ns) if el.text and el.text.strip()]
            if texts:
                paragraphs.append("".join(texts))
        for index, text in enumerate(paragraphs, 1):
            notes.append({"locator": f"paragraph {index}", "text": text})
    return notes


def main():
    if len(sys.argv) < 3:
        print("usage: extract_materials.py <file> <asset_dir>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    asset_dir = sys.argv[2]
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".pdf":
            result = extract_pdf(path, asset_dir)
        elif ext in (".pptx", ".ppsx"):
            result = extract_pptx(path, asset_dir)
        elif ext in (".docx", ".doc"):
            result = extract_docx(path, asset_dir)
        else:
            raise RuntimeError(f"不支持的文档类型: {ext}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stdout)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
