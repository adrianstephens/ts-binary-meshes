import { sax, Element, Attributes } from '@isopodlabs/xml';

export { Element, Attributes };

// An element tree, as xml.parse builds, but failing on malformed XML rather than logging it. bulk may take an element
// instead of it being built (it returns true), for the many small elements a mesh is made of; it is given the element
// it is in, and what is inside it is skipped.
export function parseTree(xml: string, bulk?: (name: string, attributes: Attributes, parent: Element) => boolean) {
	const root = new Element('');
	let current = root, skip = 0;
	sax(xml, {
		onerror: e => {
			throw e;
		},
		onopentag: (name, attributes) => {
			if (skip || bulk?.(name, attributes, current)) {
				skip++;
			} else {
				const element = new Element(name, attributes);
				current.add(element);
				current = element;
			}
		},
		onclosetag: name => {
			if (skip) {
				skip--;
			} else {
				if (name !== current.name)
					throw new Error(`XML closes <${name}> inside <${current.name}>`);
				current = current.parent!;
			}
		},
		ontext: t => {
			if (!skip && (t = t.trim()))
				current.add(t);
		},
	});
	if (current !== root)
		throw new Error(`XML ends inside <${current.name}>`);
	return root;
}

export const kids		= (e: Element, name: string) => e.allElements().filter(c => c.name === name);
export const kid		= (e: Element, name: string) => e.allElements().find(c => c.name === name);
export const textOf		= (e?: Element) => e?.allText().join(' ');
export const numberOf	= (e: Element, name: string) => Number(textOf(kid(e, name)));

// <metadata type="name">value</metadata> (AMF) or <metadata name="name">value</metadata> (3MF), by name
export function metadataOf(e: Element, key: 'type' | 'name'): Record<string, string> {
	return Object.fromEntries(kids(e, 'metadata').map(m => [m.attributes[key], textOf(m) ?? '']));
}
