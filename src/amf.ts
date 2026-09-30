import { float2, float3, float4, float3x4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Material, Texture, Object3D, Instance, Attribute, flatten, triangles } from './common';
import { point, checkIndices, text, encode, startsWith, palette, colorKey, base64 } from './utils';
import { openZip, extract } from './zip';
import { Element, parseTree, kids, kid, textOf, numberOf, metadataOf } from './xmltree';

const rad = (deg: number) => deg * Math.PI / 180;

// <color><r/><g/><b/><a/></color>, or undefined when absent or given by formulas (which extras.xml keeps)
function colorOf(e: Element) {
	const c = kid(e, 'color');
	if (!c)
		return undefined;
	const [r, g, b] = ['r', 'g', 'b'].map(n => numberOf(c, n));
	const a = kid(c, 'a') ? numberOf(c, 'a') : 1;
	return [r, g, b, a].every(Number.isFinite) ? float4(r, g, b, a) : undefined;
}

interface Context {
	materials:	Map<string, number>;	// by id, an index into Model.materials
	textures:	Map<string, number>;
}

// The object's volumes as one mesh: each volume a face set (by its name, or its index), its material per face. A
// corner's colour is its triangle's, else its vertex's, its volume's or its object's, the most specific given.
function meshOf(object: Element, mesh: Element, ctx: Context): {mesh: Mesh, edges: unknown[]} {
	const vertices	= kids(kid(mesh, 'vertices') ?? new Element('vertices'), 'vertex');
	const points	= vertices.map(v => {
		const c = kid(v, 'coordinates');
		return point(c ? numberOf(c, 'x') : NaN, c ? numberOf(c, 'y') : NaN, c ? numberOf(c, 'z') : NaN, 'AMF vertex');
	});
	const vcolors	= vertices.map(colorOf);
	const vnormals	= vertices.map(v => kid(v, 'normal')).map(n => n && float3(numberOf(n, 'nx'), numberOf(n, 'ny'), numberOf(n, 'nz')));
	const ocolor	= colorOf(object);

	const faces: number[][] = [], faceMaterials: number[] = [], cornerColors: (float4 | undefined)[][] = [];
	const uvs: float2[][] = [], texmaps: unknown[] = [], volumes: Record<string, number[]> = {};
	kids(mesh, 'volume').forEach((volume, vi) => {
		const vcolor	= colorOf(volume);
		const material	= volume.attributes.materialid;
		const set		= volumes[metadataOf(volume, 'type').name ?? String(vi)] = [] as number[];
		for (const t of kids(volume, 'triangle')) {
			const face	= ['v1', 'v2', 'v3'].map(n => numberOf(t, n));
			const tcolor = colorOf(t);
			set.push(faces.length);
			faces.push(face);
			faceMaterials.push(material === undefined ? -1 : ctx.materials.get(material) ?? -1);
			cornerColors.push(face.map(i => tcolor ?? vcolors[i] ?? vcolor ?? ocolor));
			const tm = kid(t, 'texmap');
			texmaps.push(tm && {
				...Object.fromEntries(['rtexid', 'gtexid', 'btexid', 'atexid'].filter(k => k in tm.attributes).map(k => [k, ctx.textures.get(tm.attributes[k]) ?? -1])),
				w: [1, 2, 3].map(k => kid(tm, `wtex${k}`) ? numberOf(tm, `wtex${k}`) : undefined),
			});
			uvs.push(tm ? [1, 2, 3].map(k => float2(numberOf(tm, `utex${k}`), numberOf(tm, `vtex${k}`))) : []);
		}
	});
	checkIndices(faces, points.length, 'AMF object');

	const m: Mesh = {points, faces, faceSets: {volume: volumes}};
	if (faceMaterials.some(i => i >= 0))
		m.faceMaterials = faceMaterials;
	if (vnormals.some(n => n)) {
		let n = 0;
		m.normals = {per: 'vertex', values: vnormals.filter(v => v) as float3[], indices: vnormals.map(v => v ? n++ : -1)};
	}
	if (cornerColors.some(c => c.some(v => v))) {
		const {values, indices} = palette(cornerColors.flat().filter(c => c) as float4[], colorKey);
		let k = 0;
		m.colors = {per: 'corner', values, indices: cornerColors.map(f => f.map(c => c ? indices[k++] : -1))};
	}
	if (uvs.some(u => u.length)) {
		let k = 0;
		m.uvs = {per: 'corner', values: uvs.flat(), indices: uvs.map(u => u.length ? u.map(() => k++) : [-1, -1, -1])};
		m.properties = {texmap: {per: 'face', values: texmaps} as Attribute<unknown>};
	}
	const edges = kids(kid(mesh, 'edges') ?? new Element('edges'), 'edge').map(e => ({
		v1: numberOf(e, 'v1'), d1: float3(numberOf(e, 'dx1'), numberOf(e, 'dy1'), numberOf(e, 'dz1')),
		v2: numberOf(e, 'v2'), d2: float3(numberOf(e, 'dx2'), numberOf(e, 'dy2'), numberOf(e, 'dz2')),
	}));
	return {mesh: m, edges};
}

// an instance's deltas and rotations (degrees, about x, then y, then z), as a transform
function placement(i: Element) {
	const n = (name: string) => kid(i, name) ? numberOf(i, name) : 0;
	const r = float3.rotateZ(rad(n('rz'))).matmul(float3.rotateY(rad(n('ry')))).matmul(float3.rotateX(rad(n('rx'))));
	return float3x4(r.x, r.y, r.z, float3(n('deltax'), n('deltay'), n('deltaz')));
}

function loadXml(xml: string): Model {
	const amf = kid(parseTree(xml), 'amf');
	if (!amf)
		throw new Error('not an AMF: no amf element');
	const ctx: Context = {materials: new Map(), textures: new Map()};

	const textures: Texture[] = kids(amf, 'texture').map((t, i) => {
		ctx.textures.set(t.attributes.id, i);
		return {data: base64(textOf(t) ?? ''), properties: {...t.attributes}};
	});
	const materialElements = kids(amf, 'material');
	materialElements.forEach((m, i) => ctx.materials.set(m.attributes.id, i));
	const materials: Material[] = materialElements.map(m => {
		const metadata = metadataOf(m, 'type');
		return {
			name:		metadata.name,
			color:		colorOf(m),
			properties:	{
				id:			m.attributes.id,
				metadata,
				composites:	kids(m, 'composite').map(c => ({material: ctx.materials.get(c.attributes.materialid) ?? -1, formula: textOf(c)})),
			},
		};
	});

	const byId = new Map<string, Object3D>();
	const objects: Object3D[] = kids(amf, 'object').map(o => {
		const metadata	= metadataOf(o, 'type');
		const mesh		= kid(o, 'mesh');
		const read		= mesh && meshOf(o, mesh, ctx);
		const object: Object3D = {name: metadata.name, mesh: read?.mesh, children: [], metadata, properties: {id: o.attributes.id, ...(read?.edges.length ? {edges: read.edges} : {})}};
		byId.set(o.attributes.id, object);
		return object;
	});

	// constellations, which may place each other, once every one exists
	const constellations = kids(amf, 'constellation');
	const placedIds = new Set<string>();
	for (const c of constellations) {
		const metadata = metadataOf(c, 'type');
		const object: Object3D = {name: metadata.name, children: [], metadata, properties: {id: c.attributes.id, constellation: true}};
		byId.set(c.attributes.id, object);
		objects.push(object);
	}
	for (const c of constellations)
		byId.get(c.attributes.id)!.children = kids(c, 'instance').map(i => {
			const object = byId.get(i.attributes.objectid);
			if (!object)
				throw new Error(`AMF instance of ${i.attributes.objectid}, which there is no object or constellation of`);
			placedIds.add(i.attributes.objectid);
			return {object, transform: placement(i)};
		});

	const build: Instance[] = constellations.length
		? constellations.filter(c => !placedIds.has(c.attributes.id)).map(c => ({object: byId.get(c.attributes.id)!}))
		: objects.map(object => ({object}));
	return {
		unit:		amf.attributes.unit,
		metadata:	metadataOf(amf, 'type'),
		materials, textures, objects, build,
		extras:		{version: amf.attributes.version, lang: amf.attributes.lang, xml: amf},
	};
}

async function unzipped(data: Uint8Array) {
	const doc	= await openZip(data);
	const files	= doc.entries.filter(e => !e.isDirectory);
	const entry	= files.find(e => e.filename.toLowerCase().endsWith('.amf')) ?? files[0];
	if (!entry)
		throw new Error('zipped AMF with no file in it');
	return extract(doc, entry.filename);
}

export const AMF = {
	extensions: ['.amf'],
	check(data: Uint8Array) {
		return startsWith(data, 'PK') || /<amf[\s>]/.test(text(data.subarray(0, 1024)));
	},
	// An object per AMF object (its volumes one mesh, see meshOf; properties.id, and properties.edges its curved-edge
	// tangents), and per constellation (its instances as children); the build is the constellations no other places,
	// or else every object. Materials with their composites, textures with their decoded data. extras.xml is the whole
	// document, for anything else (colour formulas, say); extras.version and extras.lang the amf element's.
	readText(data: Uint8Array): Model {
		return loadXml(text(data));
	},
	// plain XML, or zipped (the file inside named for the archive, or its only file)
	async read(data: Uint8Array): Promise<Model> {
		return loadXml(text(startsWith(data, 'PK') ? await unzipped(data) : data));
	},
	async load(data: Uint8Array): Promise<Mesh> {
		return flatten(await AMF.read(data));
	},
	save(mesh: Mesh, unit = 'millimeter'): Uint8Array {
		return encode([
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<amf unit="${unit}" version="1.1">`,
			'<object id="0"><mesh><vertices>',
			...mesh.points.map(p => `<vertex><coordinates><x>${p.x}</x><y>${p.y}</y><z>${p.z}</z></coordinates></vertex>`),
			'</vertices><volume>',
			...triangles(mesh).map(([a, b, c]) => `<triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`),
			'</volume></mesh></object>',
			'</amf>', ''
		].join('\n'));
	},
};
