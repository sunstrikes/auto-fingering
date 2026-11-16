export function findDirectChild(parent: Element, tagName: string): Element | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      return child;
    }
  }
  return null;
}

export function findDirectChildren(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      result.push(child);
    }
  }
  return result;
}

export function textOfDirectChild(parent: Element, tagName: string): string | null {
  const child = findDirectChild(parent, tagName);
  return child ? (child.textContent ?? "").trim() : null;
}

export function createNsElement(xmlDoc: Document, tagName: string): Element {
  const ns = xmlDoc.documentElement?.namespaceURI ?? null;
  return xmlDoc.createElementNS(ns, tagName);
}
