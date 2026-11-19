"""Subset the reading face (Source Serif 4 roman) to what the site renders.

docs/fonts/source-serif-4-latin.woff2 is preloaded on every page and served
from /fonts/ (scripts/prepare-deploy.mjs copies docs/fonts into the deploy).
This script rewrites it with:

  * the SAME codepoints (Basic Latin, Latin-1, the 11 punctuation marks in the
    @font-face unicode-range of shadcn/src/index.css and docs/styles.css), so
    no character changes face;
  * the SAME axes and ranges (wght 400-700, opsz 10-36). Optical size is not
    pinned: the CSS leaves font-optical-sizing at `auto`, so browsers set opsz
    from the font size (17px prose up to the 40px h1), and the masters differ
    in width, so pinning would change line breaks;
  * only the OpenType features the live CSS can reach: the browser defaults
    (ccmp, locl, liga, kern, mark, mkmk) and the numeric features the CSS
    names (lnum + pnum for prose, tnum for numbered lists). Dropped: smcp,
    c2sc, onum, zero, frac, numr, dnom, which nothing live sets (the legacy
    docs/fonts/fonts.css client used them; it is not deployed). Dropping
    them drops their ~160 glyphs and their kerning. lnum disappears from the
    output too: it only maps oldstyle figures back to lining ones, and the
    default figures are already lining (tabular), so it had nothing left.

The italic (source-serif-4-italic-latin.woff2) is left alone: no live page
sets serif italic, so browsers never request it.

Run from the repo root (fontTools is not a project dependency):

    git show 25363cf:docs/fonts/source-serif-4-latin.woff2 > /tmp/ss4-source.woff2
    uvx --from fonttools==4.68.0 --with brotli python scripts/subset-reading-font.py \\
        /tmp/ss4-source.woff2 docs/fonts/source-serif-4-latin.woff2

25363cf holds the last file before this subset (102,184 bytes, 425 glyphs).
Re-running on the script's own output keeps the same glyphs, codepoints and
features. To add a character or a feature, start from that source, edit
UNICODES or FEATURES, and widen the CSS unicode-range in both stylesheets to
match. Keep the file name: /fonts/* is served `immutable` (vercel.json), so
a returning reader keeps whichever copy they have, which is only harmless
while both render the same.

The script refuses to write unless the result keeps every codepoint, both
axes, the vertical metrics and the advance width of every codepoint.
"""

import sys

from fontTools import subset
from fontTools.ttLib import TTFont

UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2032, 0x2033, 0x2192]
)

FEATURES = ["ccmp", "locl", "liga", "kern", "mark", "mkmk", "lnum", "pnum", "tnum"]


def options():
    o = subset.Options()
    o.flavor = "woff2"
    o.layout_features = FEATURES
    o.layout_scripts = ["*"]
    o.name_IDs = ["*"]
    o.name_languages = ["*"]
    o.notdef_outline = True
    o.glyph_names = False
    o.hinting = True
    o.drop_tables = []  # keep BASE (the default would drop it)
    return o


def metrics(font):
    hhea, os2, head = font["hhea"], font["OS/2"], font["head"]
    return {
        "unitsPerEm": head.unitsPerEm,
        "hhea": (hhea.ascent, hhea.descent, hhea.lineGap),
        "typo": (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap),
        "win": (os2.usWinAscent, os2.usWinDescent),
        "useTypo": bool(os2.fsSelection & (1 << 7)),
        "xHeight/capHeight": (os2.sxHeight, os2.sCapHeight),
    }


def axes(font):
    return [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes]


def advances(font):
    cmap, hmtx = font.getBestCmap(), font["hmtx"]
    return {cp: hmtx[name][0] for cp, name in cmap.items()}


def main(src, out):
    source = TTFont(src)
    font = TTFont(src)
    sub = subset.Subsetter(options())
    sub.populate(unicodes=UNICODES)
    sub.subset(font)

    problems = []
    lost = sorted(set(source.getBestCmap()) - set(font.getBestCmap()))
    if lost:
        problems.append("codepoints lost: " + " ".join(f"U+{c:04X}" for c in lost))
    if axes(font) != axes(source):
        problems.append(f"axes changed: {axes(source)} -> {axes(font)}")
    if metrics(font) != metrics(source):
        problems.append(f"vertical metrics changed: {metrics(source)} -> {metrics(font)}")
    before, after = advances(source), advances(font)
    moved = [c for c in after if after[c] != before.get(c)]
    if moved:
        problems.append("default advances changed: " + " ".join(f"U+{c:04X}" for c in moved))
    if problems:
        sys.exit("subset-reading-font: refusing to write\n  " + "\n  ".join(problems))

    font.flavor = "woff2"
    font.save(out)
    kept = sorted({r.FeatureTag for r in font["GSUB"].table.FeatureList.FeatureRecord}
                  | {r.FeatureTag for r in font["GPOS"].table.FeatureList.FeatureRecord})
    print(f"{out}: {len(source.getGlyphOrder())} -> {len(font.getGlyphOrder())} glyphs, "
          f"{len(font.getBestCmap())} codepoints, axes {axes(font)}, features {' '.join(kept)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
