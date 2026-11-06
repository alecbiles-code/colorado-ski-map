"""Tag rules that map OSM ways to contract feature classes.

A way becomes a ski route feature only when a source tag supports winter or
ski use. Every result carries a short basis string so the app and the
coverage report can show why a feature has its class. Resort (lift-served)
context is decided spatially in build.py, not here.
"""

from __future__ import annotations

import re

ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "track"}
GROOMED = {"classic", "skating", "classic+skating", "classic;skating", "classic+mogul", "mogul", "nordic", "alpine"}
UNGROOMED = {"backcountry", "no", "user_compacted"}
GENERIC_TOUR = {"skitour", "backcountry", "yes"}
EXCLUDED_TYPES = {"fatbike", "sled", "snow_park", "ski_jump", "ice_skate", "connection", "playground", "ice_rink"}
UPHILL_NAME = re.compile(r"\b(uphill|up ?track|skin(ning)?( track| route)?)\b", re.I)
DESCENT_NAME = re.compile(r"\b(couloirs?|coulior|face|chutes?|bowl|gully|glades?)\b", re.I)


def piste_types(tags: dict[str, str]) -> set[str]:
    """Split a piste:type value such as 'nordic; fatbike' into lowercase parts."""
    raw = tags.get("piste:type") or ""
    return {p.strip().lower() for p in re.split(r"[;:]", raw) if p.strip()}


def winter_access(tags: dict[str, str], allowed: set[str]) -> list[str]:
    """Return the winter-use access keys (ski, ski:nordic, snowshoe) that permit use."""
    return [k for k in ("ski", "ski:nordic", "snowshoe") if tags.get(k) in allowed]


def classify_tour(tags: dict[str, str], types: set[str]) -> tuple[str, str]:
    """Classify a generic ski-tour way (skitour, backcountry, yes, uphill)."""
    hw = tags.get("highway")
    label = "/".join(sorted(types))
    name = " ".join(filter(None, [tags.get("name"), tags.get("piste:name")]))
    if "uphill" in types or UPHILL_NAME.search(name):
        return "ascent_skin", f"piste:type={label}; uphill tag or name"
    if hw in ROAD_CLASSES:
        return "approach", f"piste:type={label} on highway={hw}"
    if not hw and DESCENT_NAME.search(name):
        return "ski_descent", f"piste:type={label}; source name names a descent feature"
    return "ascent_skin", f"piste:type={label}; OSM tour route with no direction, shown as tour/skin route"


def classify_way(tags: dict[str, str], allowed: set[str]) -> tuple[str | None, str]:
    """Classify one way into a route class, or None with an exclusion bucket.

    Args:
        tags: Effective OSM tags (own tags, with relation piste tags filled in).
        allowed: Access values that count as permitted (yes, designated, ...).

    Returns:
        (class, basis) where class is None for excluded ways and basis names
        the rule or the exclusion bucket.
    """
    types = piste_types(tags)
    grooming = (tags.get("piste:grooming") or "").lower()
    if types & {"downhill", "glades"}:
        return "ski_descent", "piste:type=downhill outside lift-served context"
    if types & (GENERIC_TOUR | {"uphill"}):
        return classify_tour(tags, types)
    if types & {"nordic", "hike", "snowshoe", "traverse"}:
        if grooming in GROOMED:
            return None, "groomed_piste"
        if "nordic" in types and grooming not in UNGROOMED:
            return None, "nordic_grooming_unknown"
        return "approach", f"piste:type={'/'.join(sorted(types))}, grooming={grooming or 'none'}"
    if types:
        return None, "other_piste_type" if not types <= EXCLUDED_TYPES else "non_ski_piste"
    access = winter_access(tags, allowed)
    if access:
        return "approach", "winter access tag " + ", ".join(f"{k}={tags[k]}" for k in access)
    return None, "no_winter_tag"


def is_area(tags: dict[str, str], closed: bool) -> bool:
    """True when a closed piste way should be read as an area (touring area)."""
    if not closed or tags.get("area") == "no":
        return False
    if tags.get("area") == "yes":
        return True
    return bool(piste_types(tags) & ({"downhill", "glades"} | GENERIC_TOUR)) and not tags.get("highway")
