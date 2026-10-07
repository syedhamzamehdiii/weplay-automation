"""Parse Appium / uiautomator page source into tap targets."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass

BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
DUMPSYS_BOUNDS_RE = re.compile(r"(\d+),(\d+)-(\d+),(\d+)")


@dataclass(frozen=True)
class Bounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return max(0, self.right - self.left)

    @property
    def height(self) -> int:
        return max(0, self.bottom - self.top)

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def center(self) -> tuple[int, int]:
        return (self.left + self.right) // 2, (self.top + self.bottom) // 2

    @property
    def usable(self) -> bool:
        return self.width >= 8 and self.height >= 8


@dataclass(frozen=True)
class UiNode:
    class_name: str
    package: str
    resource_id: str
    content_desc: str
    text: str
    clickable: bool
    password: bool
    bounds: Bounds | None
    raw: dict[str, str]

    @property
    def haystack(self) -> str:
        return " ".join(
            part for part in (self.resource_id, self.content_desc, self.text, self.class_name) if part
        ).lower()


def parse_xml_bounds(value: str | None) -> Bounds | None:
    if not value:
        return None
    match = BOUNDS_RE.fullmatch(value.strip())
    if not match:
        return None
    bounds = Bounds(*(int(g) for g in match.groups()))
    return bounds if bounds.usable else None


def parse_dumpsys_bounds(line: str) -> Bounds | None:
    match = DUMPSYS_BOUNDS_RE.search(line)
    if not match:
        return None
    bounds = Bounds(*(int(g) for g in match.groups()))
    return bounds if bounds.usable else None


def _attr(node: ET.Element, *names: str) -> str:
    for name in names:
        value = node.attrib.get(name)
        if value:
            return value
    return ""


def iter_ui_nodes(page_source: str) -> list[UiNode]:
    if not page_source or not page_source.lstrip().startswith("<"):
        return []
    try:
        root = ET.fromstring(page_source)
    except ET.ParseError:
        return []
    nodes: list[UiNode] = []
    for element in root.iter():
        attrib = element.attrib
        if not attrib:
            continue
        if not any(attrib.get(key) for key in ("class", "className", "package", "resource-id", "resourceId", "text", "content-desc", "contentDescription")):
            continue
        clickable = _attr(element, "clickable").lower() == "true"
        password = _attr(element, "password").lower() == "true"
        nodes.append(
            UiNode(
                class_name=_attr(element, "class", "className"),
                package=_attr(element, "package"),
                resource_id=_attr(element, "resource-id", "resourceId"),
                content_desc=_attr(element, "content-desc", "contentDescription"),
                text=_attr(element, "text"),
                clickable=clickable,
                password=password,
                bounds=parse_xml_bounds(_attr(element, "bounds")),
                raw=dict(attrib),
            )
        )
    return nodes


def visible_texts(nodes: list[UiNode]) -> list[str]:
    texts: list[str] = []
    for node in nodes:
        for value in (node.text, node.content_desc):
            cleaned = value.strip()
            if cleaned:
                texts.append(cleaned)
    return texts


def page_text(page_source: str) -> str:
    return " ".join(visible_texts(iter_ui_nodes(page_source))).lower()
