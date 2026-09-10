#!/usr/bin/env python3
"""
Turn Twilio's shared Lucid shape libraries into an asset this app can draw.

Run against the `.lcsl` files Lucid exports:

    python scripts/convert_lucid_shapes.py ~/Desktop/"APP BOILER PLATE"/*.lcsl

It writes `frontend/src/canvas/shapes/lucid.json`, which the palette imports. Re-run it to pick up a
newer export; nothing else in the build reads the `.lcsl` files, so they do not need to live in the
repo (and should not -- see the note on licensing at the bottom).

## What an .lcsl actually is

Plain JSON, despite the extension: `{AccountId, Created, Id, Name, Shapes, UserId}`. Each entry in
`Shapes` has a `class` and a `properties` string that is *itself* JSON -- so the geometry is two
levels of encoding down, which is why this looked like a "weird format" at first glance.

The shapes worth having are `class: "Group"`. Their decoded `properties` carries:

    Size          {w, h}         the shape's own box
    Objects[]     one per member; the interesting ones have
                  Action.Class == "SVGPathBlock2" and
                  Action.Properties.DrawData.Data[].a  -- an SVG path
                  Action.Properties.FillColor          -- the block's fill

Path coordinates are already normalised to 0..1, which is the single most useful fact here: the output
needs no transform and can be dropped into `viewBox="0 0 1 1"` at any size.

Per-path `f`/`s`/`w` are either a literal colour or the string `"prop"`, meaning "inherit from the
block". So a path's fill is its own `f` when that is a colour, and the block's `FillColor` otherwise.

## What cannot be converted, and why it is skipped rather than approximated

`UserImage2Block` shapes reference `/imageBlocks/image/<uuid>` -- bitmaps on Lucid's servers, not in
the export. There is nothing in the file to draw, so they are dropped and counted. That is most of the
Logo Library, which is why that file yields almost nothing; the third-party logos it holds would have
to be sourced separately.

`FreehandBlock` is a stroke recorded as input samples rather than a path. Convertible in principle and
skipped here: they are a handful of annotations in libraries whose value is the icons.

## Licensing

These are Twilio's own shape libraries. The generated JSON is Twilio artwork, so it is committed to a
private repository and should not be published. Noted here rather than left implicit because the file
is machine-generated and nothing else about it says where it came from.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

# Where the asset lands. Relative to the repo root, which is this file's parent's parent.
OUT = Path(__file__).resolve().parent.parent / "frontend" / "src" / "canvas" / "shapes" / "lucid.json"

# A colour is a literal; anything else -- notably the string "prop" -- means "inherit from the block".
def literal_colour(value: str | None) -> str | None:
    if isinstance(value, str) and value.startswith("#"):
        return value
    return None


def decode(raw):
    """`properties` is JSON inside JSON. Tolerant, because one malformed shape must not lose a file."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def slugify(name: str) -> str:
    kept = [c.lower() if c.isalnum() else "-" for c in (name or "").strip()]
    slug = "".join(kept)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "shape"


def paths_of(group_props: dict) -> list[dict]:
    """
    Every drawable path in one group, flattened, in paint order.

    Flattened deliberately: Lucid's nesting is an editing convenience and carries no meaning this app
    needs -- the shape is drawn as one thing. `ZOrder` is respected where present, because a fill
    painted over its own detail lines is a solid blob.
    """
    members = []
    for entry in group_props.get("Objects") or []:
        action = (entry or {}).get("Action") or {}
        if action.get("Class") != "SVGPathBlock2":
            continue
        props = action.get("Properties") or {}
        draw = props.get("DrawData") or {}
        block_fill = literal_colour(props.get("FillColor"))
        block_stroke = literal_colour(props.get("LineColor"))
        width = props.get("LineWidth")
        order = props.get("ZOrder", 0)

        for item in draw.get("Data") or []:
            d = (item or {}).get("a")
            if not isinstance(d, str) or not d.strip():
                continue
            members.append(
                {
                    "order": order if isinstance(order, (int, float)) else 0,
                    "d": d.strip(),
                    # Per-path colour wins over the block's; `None` means "use the component's own
                    # colour", which is what lets a converted icon be recoloured on the canvas.
                    "fill": literal_colour(item.get("f")) or block_fill,
                    "stroke": literal_colour(item.get("s")) or block_stroke,
                    "strokeWidth": width if isinstance(width, (int, float)) else None,
                }
            )

    members.sort(key=lambda member: member["order"])
    for member in members:
        del member["order"]
    return members


def convert(path: Path, stats: Counter) -> list[dict]:
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as err:
        print(f"  ! {path.name}: cannot read ({err})", file=sys.stderr)
        return []

    library = doc.get("Name") or path.stem
    out: list[dict] = []
    seen: set[str] = set()

    for shape in doc.get("Shapes") or []:
        cls = shape.get("class")
        if cls not in ("Group", "SVGPathBlock2"):
            stats[f"skipped:{cls}"] += 1
            continue

        props = decode(shape.get("properties"))
        if not props:
            stats["skipped:unreadable"] += 1
            continue

        # A library can hold a bare path block rather than wrapping it in a group -- "Twilio Shapes
        # 2025" is entirely that shape, and treating Groups as the only source silently dropped the
        # whole file. Same extraction either way: a bare block is a group of one.
        paths = paths_of(props) if cls == "Group" else paths_of({"Objects": [{"Action": {"Class": "SVGPathBlock2", "Properties": props}}]})
        if not paths:
            # A group whose members are all images or freehand. Nothing in the file to draw.
            stats["skipped:no-vector-paths"] += 1
            continue

        name = shape.get("name") or "Untitled"
        # Scoped by library, so two libraries may both have an "add-ons" without colliding -- and
        # de-duplicated within one, because an export can repeat a name.
        base = f"{slugify(library)}/{slugify(name)}"
        ident = base
        suffix = 2
        while ident in seen:
            ident = f"{base}-{suffix}"
            suffix += 1
        seen.add(ident)

        size = props.get("Size") or {}
        out.append(
            {
                "id": ident,
                "name": name,
                "library": library,
                # The shape's own aspect ratio, so a wide illustration is not squeezed into a square.
                # Paths are normalised 0..1, so this is only ever used as a ratio.
                "width": size.get("w") or 80,
                "height": size.get("h") or 80,
                "paths": paths,
            }
        )
        stats["converted"] += 1

    print(f"  {path.name}: {len(out)} converted")
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2

    stats: Counter = Counter()
    shapes: list[dict] = []
    print("Converting Lucid shape libraries…")
    for name in argv:
        shapes.extend(convert(Path(name), stats))

    if not shapes:
        print("Nothing converted; leaving the existing asset alone.", file=sys.stderr)
        return 1

    # Sorted, so re-running against the same input produces the same file and a diff shows only what
    # actually changed in the export.
    shapes.sort(key=lambda shape: shape["id"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(shapes, indent=1, ensure_ascii=False) + "\n")

    print(f"\nWrote {len(shapes)} shapes to {OUT.relative_to(OUT.parent.parent.parent.parent)}")
    for key, count in sorted(stats.items()):
        print(f"  {key}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
