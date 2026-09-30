import { float2, float3, float4, float3x4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Object3D, Instance, Attribute, flatten, triangles } from './common';
import { point, checkIndices, text, encode, startsWith, hexColor, palette, colorKey } from './utils';
import { openZip, extract, makeZip } from './zip';
import { Element, Attributes, parseTree, kids, textOf } from './xmltree';

const MODEL_REL		= 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const THUMBNAIL_REL	= 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';
const CORE			= 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

// the prefixes names are given here, by namespace, whatever prefixes a file declares for them
const PREFIXES: Record<string, string> = {
	'http://schemas.microsoft.com/3dmanufacturing/material/2015/02':		'm:',
	'http://schemas.microsoft.com/3dmanufacturing/production/2015/06':		'p:',
	'http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02':		'b:',
	'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07':			's:',
};

// Names as PREFIXES spells them; an unprefixed one (core, the default namespace), or one in a namespace not listed, as
// the file has it
class Names {
	private declared: Record<string, string> = {};
	declare(a: Attributes) {
		for (const [k, v] of Object.entries(a))
			if (k.startsWith('xmlns:'))
				this.declared[k.slice(6)] = v;
	}
	name(qname: string) {
		const colon = qname.indexOf(':');
		const ns = colon < 0 ? undefined : this.declared[qname.slice(0, colon)];
		return ns && ns in PREFIXES ? PREFIXES[ns] + qname.slice(colon + 1) : qname;
	}
	attributes(a: Attributes): Attributes {
		return Object.fromEntries(Object.entries(a).map(([k, v]) => [k.startsWith('xmlns') ? k : this.name(k), v]));
	}
}

// the elements a mesh has thousands of, taken as their attributes rather than built, by the element they are in
const BULK = new Set(['vertex', 'triangle', 'b:beam', 'b:ball', 'b:ref', 'b:ballref', 'm:color', 'm:tex2coord', 'm:composite', 'm:multi', 'base']);

interface Part {
	path:	string;
	xml:	Element;
	bulk:	Map<Element, Map<string, Attributes[]>>;
	names:	Names;
}

function parsePart(path: string, xml: string): Part {
	const names = new Names(), bulk: Part['bulk'] = new Map();
	const root = parseTree(xml, (qname, a, parent) => {
		names.declare(a);
		const name = names.name(qname);
		if (!BULK.has(name))
			return false;
		const byName = bulk.get(parent) ?? bulk.set(parent, new Map()).get(parent)!;
		(byName.get(name) ?? byName.set(name, []).get(name)!).push(names.attributes(a));
		return true;
	});
	const model = root.allElements().find(e => e.name === 'model');
	if (!model)
		throw new Error(`3MF part ${path} has no model element`);
	return {path, xml: model, bulk, names};
}

const els		= (part: Part, e: Element | undefined, name: string) => e ? e.allElements().filter(c => part.names.name(c.name) === name) : [];
const el		= (part: Part, e: Element | undefined, name: string) => els(part, e, name)[0];
const attrs		= (part: Part, e: Element) => part.names.attributes(e.attributes);
const bulkOf	= (part: Part, e: Element | undefined, name: string) => (e && part.bulk.get(e)?.get(name)) ?? [];
const numbers	= (s?: string) => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number);

// 3MF's 12 numbers are the matrix's first three columns row by row: a row vector times it, so x' = x m00 + y m10 + z m20 + m30
function matrix(s?: string) {
	if (!s)
		return undefined;
	const m = numbers(s);
	if (m.length !== 12 || m.some(v => !Number.isFinite(v)))
		throw new Error(`3MF transform that cannot be read: '${s}'`);
	return float3x4(float3(m[0], m[1], m[2]), float3(m[3], m[4], m[5]), float3(m[6], m[7], m[8]), float3(m[9], m[10], m[11]));
}

// What an entry of a property group gives a triangle's corner
interface Property {
	material?:	number;
	color?:		float4;
	uv?:		float2;
}

interface Resources {
	groups:		Map<string, (index: number) => Property>;	// by part#id
	textures:	Map<string, number>;						// by part#id, an index into Model.textures
	objects:	Map<string, Object3D>;
	model:		Model;
	parts:		Record<string, Uint8Array>;
}

const key = (part: Part, id: string) => `${part.path}#${id}`;

// an entry of a list, which a file's index must be within
const entry = <T>(list: T[], what: string) => (i: number) => {
	if (!(i >= 0 && i < list.length))
		throw new Error(`3MF ${what} index ${i} out of range`);
	return list[i];
};

// Property groups: base materials and composites as materials, colour groups as colours, texture groups as texture
// coordinates (with a material of their texture), multiproperties as what their layers give together
function readResources(part: Part, resources: Element, r: Resources) {
	const {materials, textures} = r.model;
	for (const e of resources.allElements()) {
		const a = attrs(part, e), id = a.id;
		switch (part.names.name(e.name)) {
			case 'basematerials': {
				const first = materials.length;
				bulkOf(part, e, 'base').forEach((b, i) => materials.push({
					name:		b.name,
					color:		b.displaycolor ? hexColor(b.displaycolor, '3MF base material') : undefined,
					properties:	{group: id, index: i, ...b},
				}));
				const ids = Array.from({length: materials.length - first}, (_, k) => first + k);
				r.groups.set(key(part, id), i => ({material: entry(ids, 'base material')(i)}));
				break;
			}
			case 'm:colorgroup': {
				const colors = bulkOf(part, e, 'm:color').map(c => hexColor(c.color, '3MF colour'));
				r.groups.set(key(part, id), i => ({color: entry(colors, 'colour')(i)}));
				break;
			}
			case 'm:texture2d':
				r.textures.set(key(part, id), textures.push({path: a.path, data: r.parts[a.path.replace(/^\//, '')], contentType: a.contenttype, properties: a}) - 1);
				break;
			case 'm:texture2dgroup': {
				const material	= materials.push({texture: r.textures.get(key(part, a.texid)), properties: {group: id, ...a}}) - 1;
				const coords	= bulkOf(part, e, 'm:tex2coord').map(t => float2(Number(t.u), Number(t.v)));
				r.groups.set(key(part, id), i => ({material, uv: entry(coords, 'texture coordinate')(i)}));
				break;
			}
			case 'm:compositematerials': {
				const base		= r.groups.get(key(part, a.matid));
				const indices	= numbers(a.matindices);
				const colors	= indices.map(k => base?.(k).material).map(m => m === undefined ? undefined : materials[m].color);
				const ids		= bulkOf(part, e, 'm:composite').map((c, i) => {
					const values = numbers(c.values), total = values.reduce((s, v) => s + v, 0);
					const mixed = total > 0 && colors.every(c => c) ? colors.reduce<float4>((s, c, k) => s.add(c!.scale(values[k] / total)), float4(0, 0, 0, 0)) : undefined;
					return materials.push({color: mixed, properties: {group: id, index: i, matid: a.matid, matindices: indices, values}}) - 1;
				});
				r.groups.set(key(part, id), i => ({material: entry(ids, 'composite')(i)}));
				break;
			}
			case 'm:multiproperties': {
				const pids		= a.pids.split(/\s+/);
				const multis	= bulkOf(part, e, 'm:multi').map(m => numbers(m.pindices));
				// each layer adds what it gives to what the ones before gave
				r.groups.set(key(part, id), i => entry(multis, 'multiproperty')(i).reduce((p: Property, k, layer) => ({...p, ...r.groups.get(key(part, pids[layer]))?.(k)}), {}));
				break;
			}
		}
	}
}

// its beams (also the mesh's lines), balls and beam sets, each as its attributes
function beamLattice(part: Part, lattice: Element) {
	return {
		attributes:	attrs(part, lattice),
		beams:		bulkOf(part, el(part, lattice, 'b:beams'), 'b:beam'),
		balls:		bulkOf(part, el(part, lattice, 'b:balls'), 'b:ball'),
		beamsets:	els(part, el(part, lattice, 'b:beamsets'), 'b:beamset').map(s => ({
			attributes:	attrs(part, s),
			refs:		bulkOf(part, s, 'b:ref').map(r => Number(r.index)),
			ballrefs:	bulkOf(part, s, 'b:ballref').map(r => Number(r.index)),
		})),
	};
}

// A mesh's triangles, each corner's property resolved through its group (the triangle's pid, or the object's, and p1..p3,
// p2 and p3 defaulting to p1): materials per face (p1's), colours and texture coordinates per corner.
// properties.pid and properties.pindex keep them as written.
function readMesh(part: Part, e: Element, object: Attributes, r: Resources): Mesh {
	const points	= bulkOf(part, el(part, e, 'vertices'), 'vertex').map(v => point(Number(v.x), Number(v.y), Number(v.z), '3MF vertex'));
	const tris		= bulkOf(part, el(part, e, 'triangles'), 'triangle');
	const faces		= tris.map(t => [Number(t.v1), Number(t.v2), Number(t.v3)]);
	checkIndices(faces, points.length, `3MF object ${object.id}`);
	const pids		= tris.map(t => t.pid ?? object.pid);
	const pindex	= tris.map(t => {
		const p1 = t.p1 ?? (t.pid === undefined ? object.pindex : undefined);
		return p1 === undefined ? [] : [p1, t.p2 ?? p1, t.p3 ?? p1].map(Number);
	});
	const props		= tris.map((_, f) => {
		const group = pids[f] === undefined ? undefined : r.groups.get(key(part, pids[f]));
		if (pids[f] !== undefined && !group)
			throw new Error(`3MF triangle refers to property group ${pids[f]}, which ${part.path} does not have`);
		return group ? pindex[f].map(group) : [];
	});

	// a corner attribute of what the properties give, -1 where a corner's gives nothing
	const corners = <T>(values: (T | undefined)[][], k: (v: T) => string): Attribute<T> => {
		const p = palette(values.flat().filter(v => v !== undefined), k);
		let n = 0;
		return {per: 'corner', values: p.values, indices: values.map(c => c.length ? c.map(v => v === undefined ? -1 : p.indices[n++]) : [-1, -1, -1])};
	};
	const colors	= props.map(p => p.map(q => q.color));
	const uvs		= props.map(p => p.map(q => q.uv));
	const mesh: Mesh = {points, faces};
	if (props.some(p => p[0]?.material !== undefined))
		mesh.faceMaterials = props.map(p => p[0]?.material ?? -1);
	if (colors.some(c => c.some(v => v)))
		mesh.colors = corners(colors, colorKey);
	if (uvs.some(c => c.some(v => v)))
		mesh.uvs = corners(uvs, v => `${v.x},${v.y}`);
	if (pids.some(p => p !== undefined))
		mesh.properties = {
			pid:	{per: 'face', values: pids.map(p => p ?? '')},
			pindex:	corners(pindex, String),
		};
	return mesh;
}

// every relationship in every .rels part, with the part it is in
function relationshipsOf(parts: Record<string, Uint8Array>) {
	return Object.entries(parts).filter(([p]) => p.endsWith('.rels')).flatMap(([source, d]) =>
		kids(parseTree(text(d)).allElements().find(e => e.name === 'Relationships') ?? new Element(''), 'Relationship').map(r => ({source, id: r.attributes.Id, type: r.attributes.Type, target: r.attributes.Target}))
	);
}

async function read(data: Uint8Array): Promise<Model> {
	if (!startsWith(data, 'PK'))
		throw new Error('not a 3MF: not a zip archive');
	const doc	= await openZip(data);
	const parts: Record<string, Uint8Array> = Object.fromEntries(await Promise.all(doc.entries.filter(e => !e.isDirectory).map(async e => [e.filename, await extract(doc, e.filename)])));
	const relationships = relationshipsOf(parts);
	const root	= relationships.find(r => r.source === '_rels/.rels' && r.type === MODEL_REL)?.target;
	if (!root)
		throw new Error('3MF with no 3D model relationship');

	const models = new Map<string, Part>();
	const partOf = (path: string) => {
		const clean = path.replace(/^\//, '');
		if (!models.has(clean)) {
			if (!parts[clean])
				throw new Error(`3MF has no model part '${path}'`);
			models.set(clean, parsePart(clean, text(parts[clean])));
		}
		return models.get(clean)!;
	};
	const main		= partOf(root);
	const model: Model = {
		unit:		main.xml.attributes.unit ?? 'millimeter',
		metadata:	Object.fromEntries(els(main, main.xml, 'metadata').map(m => [m.attributes.name, textOf(m) ?? ''])),
		materials:	[], textures: [], objects: [], build: [], extras: {},
	};
	const r: Resources = {groups: new Map(), textures: new Map(), objects: new Map(), model, parts};

	// every model part's resources, then its objects, whose components may be in any part
	const all = [main, ...Object.keys(parts).filter(p => p.endsWith('.model')).map(partOf).filter(p => p !== main)];
	all.forEach(part => readResources(part, el(part, part.xml, 'resources') ?? new Element(''), r));
	const pending: [Part, Element, Object3D][] = [];
	for (const part of all) {
		for (const o of els(part, el(part, part.xml, 'resources'), 'object')) {
			const a = attrs(part, o);
			const metadata	= Object.fromEntries(els(part, el(part, o, 'metadatagroup'), 'metadata').map(m => [m.attributes.name, textOf(m) ?? '']));
			const meshEl	= el(part, o, 'mesh');
			const object: Object3D = {name: a.name, children: [], metadata, properties: {...a, part: part.path}};
			if (meshEl) {
				object.mesh = readMesh(part, meshEl, a, r);
				const lattice = el(part, meshEl, 'b:beamlattice');
				if (lattice) {
					const beams = beamLattice(part, lattice);
					object.properties.beamlattice = beams;
					object.mesh.lines = beams.beams.map(b => [Number(b.v1), Number(b.v2)]);
				}
			}
			r.objects.set(key(part, a.id), object);
			model.objects.push(object);
			pending.push([part, o, object]);
		}
	}
	const instance = (part: Part, a: Attributes): Instance => {
		const where = a['p:path'] ? partOf(a['p:path']) : part;
		const object = r.objects.get(key(where, a.objectid));
		if (!object)
			throw new Error(`3MF refers to object ${a.objectid}, which ${where.path} does not have`);
		const {objectid: _, transform, ...properties} = a;
		return {object, transform: matrix(transform), properties};
	};
	for (const [part, o, object] of pending)
		object.children = els(part, el(part, o, 'components'), 'component').map(c => instance(part, attrs(part, c)));

	const build		= el(main, main.xml, 'build');
	const thumbnail	= relationships.find(r => r.source === '_rels/.rels' && r.type === THUMBNAIL_REL)?.target;
	model.build		= els(main, build, 'item').map(i => instance(main, attrs(main, i)));
	model.extras	= {
		model:			attrs(main, main.xml),
		build:			build && attrs(main, build),
		relationships,
		thumbnail:		thumbnail && {path: thumbnail, data: parts[thumbnail.replace(/^\//, '')]},
		parts,
		xml:			Object.fromEntries([...models].map(([path, p]) => [path, p.xml])),
	};
	return model;
}

export const ThreeMF = {
	extensions: ['.3mf'],
	check(data: Uint8Array) {
		return startsWith(data, 'PK');
	},
	// Every object in every model part (properties its attributes and part; metadata its metadatagroup; children its
	// components, with their transforms and production attributes; a mesh as readMesh makes it; a beam lattice as the
	// mesh's lines and properties.beamlattice), and the build's items. Materials from base materials, composites (their
	// colour mixed from their bases') and texture groups; textures with their parts' data. extras: the model and build
	// elements' attributes, every package relationship, the thumbnail, every part's bytes, and every model part's XML
	// (less the vertices, triangles and other elements read into meshes) for anything else, slices say.
	read,
	async load(data: Uint8Array): Promise<Mesh> {
		return flatten(await read(data));
	},
	save(mesh: Mesh, unit = 'millimeter'): Promise<Uint8Array> {
		return makeZip({
			'[Content_Types].xml': encode([
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
				'<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
				'</Types>', ''
			].join('\n')),
			'_rels/.rels': encode([
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
				`<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${MODEL_REL}"/>`,
				'</Relationships>', ''
			].join('\n')),
			'3D/3dmodel.model': encode([
				'<?xml version="1.0" encoding="UTF-8"?>',
				`<model unit="${unit}" xml:lang="en-US" xmlns="${CORE}">`,
				'<resources><object id="1" type="model"><mesh><vertices>',
				...mesh.points.map(p => `<vertex x="${p.x}" y="${p.y}" z="${p.z}"/>`),
				'</vertices><triangles>',
				...triangles(mesh).map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`),
				'</triangles></mesh></object></resources>',
				'<build><item objectid="1"/></build>',
				'</model>', ''
			].join('\n')),
		});
	},
};
