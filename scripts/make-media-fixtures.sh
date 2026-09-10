#!/usr/bin/env bash
#
# Regenerate the media fixtures the event-form tests upload.
#
# Committed as a generator rather than as 440K of binaries, because the point of
# these files is what they *prove*, and a checked-in blob cannot tell you why it
# is 2048px or why one clip is deliberately wrong. Run this and read the
# comments; the output is reproducible and gitignored.
#
#   ./scripts/make-media-fixtures.sh
#
# Needs ffmpeg and ImageMagick (`brew install ffmpeg imagemagick`).
set -euo pipefail

OUT="$(cd "$(dirname "$0")" && pwd)/fixtures/media"
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "missing: ffmpeg — brew install ffmpeg" >&2; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "missing: Pillow — pip3 install Pillow" >&2; exit 1; }

# ---------------------------------------------------------------- cover image
#
# 2048 square, the largest the form accepts, in four labelled colour bands.
#
# The bands are the whole point. The organiser's phone-frame preview crops a
# cover differently per surface — Featured keeps 73.7% of the width and 52% of
# the height, Upcoming is 1.923 wide, Nearby is 1.070 — and a flat photo cannot
# show you what was lost. With bands the crop is readable off a screenshot:
# BLUE surviving means the title band survived, RED surviving means nothing was
# cropped at all.
#
#   BLUE   top 10%    where a title sits
#   GREEN  the safe area every surface keeps
#   AMBER  cropped by the wide surfaces
#   RED    cropped by everything
# Pillow rather than ImageMagick: it is already a dependency of the Python
# toolchain on this machine, and one fewer `brew install` between somebody and a
# reproducible fixture.
OUT="$OUT" python3 - <<'PY'
import os
from PIL import Image, ImageDraw

N = 2048
img = Image.new("RGB", (N, N), "#B3261E")          # RED   — cropped by everything
d = ImageDraw.Draw(img)
d.rectangle([102, 102, N - 103, N - 103], "#F2A413")   # AMBER — cropped by the wide surfaces
d.rectangle([270, 270, N - 271, N - 271], "#1E7A3C")   # GREEN — the safe area
d.rectangle([0, 0, N - 1, int(N * 0.10)], "#1A56DB")   # BLUE  — the title band

# A real font size, or the labels render at Pillow's 11px default and are
# invisible on a 2048px canvas — which defeats reading the crop off a
# screenshot, the only reason the labels exist.
def font(size):
    from PIL import ImageFont
    for path in ("/System/Library/Fonts/Helvetica.ttc",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

for text, size, y in (("TITLE BAND", 96, 45), ("SAFE AREA", 120, N // 2 - 70)):
    f = font(size)
    w = d.textlength(text, font=f)
    d.text(((N - w) / 2, y), text, fill="white", font=f)

img.save(os.path.join(os.environ["OUT"], "event-cover-2048.jpg"), quality=90)
PY

# ------------------------------------------------------------------ good clip
#
# 1080 square, 10s, H.264 + AAC, and `-movflags +faststart` so the moov atom is
# at the front. That flag is the one worth having a fixture for: without it a
# clip plays fine from disk and stalls when streamed, which is the failure an
# organiser reports as "the video does not work" and a developer fails to
# reproduce locally.
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc=size=1080x1080:rate=25:duration=10" \
  -f lavfi -i "sine=frequency=440:duration=10" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  -movflags +faststart "$OUT/event-clip-1080.mp4"

# --------------------------------------------------------------- off-spec clip
#
# Deliberately wrong: 1280x720 landscape where the form asks for square, and
# half the duration. Kept because a fixture that only ever passes proves the
# happy path and nothing else — this is what the form's guidance is checked
# against.
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc=size=1280x720:rate=25:duration=5" \
  -f lavfi -i "sine=frequency=220:duration=5" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  -movflags +faststart "$OUT/event-clip-offspec-720.mp4"

echo "wrote:"
ls -lh "$OUT"

# The faststart claim, asserted rather than trusted: `moov` must come before
# `mdat`, and a plain ffmpeg encode puts it after.
for clip in event-clip-1080 event-clip-offspec-720; do
  moov=$(grep -abo moov "$OUT/$clip.mp4" | head -1 | cut -d: -f1)
  mdat=$(grep -abo mdat "$OUT/$clip.mp4" | head -1 | cut -d: -f1)
  if [ -n "$moov" ] && [ -n "$mdat" ] && [ "$moov" -lt "$mdat" ]; then
    echo "$clip.mp4: faststart ok (moov @ $moov, mdat @ $mdat)"
  else
    echo "$clip.mp4: NOT faststart — moov @ ${moov:-?}, mdat @ ${mdat:-?}" >&2
    exit 1
  fi
done
