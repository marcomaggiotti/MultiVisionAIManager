from __future__ import annotations

import io

from PIL import Image, ImageOps, UnidentifiedImageError


class InvalidImageError(ValueError):
    pass


def decode_image(data: bytes, max_pixels: int = 60_000_000) -> Image.Image:
    if not data:
        raise InvalidImageError("empty image")
    try:
        image = Image.open(io.BytesIO(data))
        if image.size[0] * image.size[1] > max_pixels:
            raise InvalidImageError(f"image is {image.size}, above the pixel limit")
        image.load()
        return ImageOps.exif_transpose(image).convert("RGB")
    except InvalidImageError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise InvalidImageError("unsupported or corrupt image") from exc
