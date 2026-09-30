import { float2, float3, float4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Material, Texture, Attribute, ReadOptions, modelOf, flatten } from './common';
import { point, checkIndices, text, encode, startsWith } from './utils';

type Scalar = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const SCALARS: Record<string, Scalar> = {
	char: 'int8', uchar: 'uint8', short: 'int16', ushort: 'uint16', int: 'int32', uint: 'uint32', float: 'float32', double: 'float64',
	int8: 'int8', uint8: 'uint8', int16: 'int16', uint16: 'uint16', int32: 'int32', uint32: 'uint32', float32: 'float32', float64: 'float64',
};

const SIZES: Record<Scalar, number> = {int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8};

const GETTERS: Record<Scalar, (v: DataView, at: number, le: boolean) => number> = {
	int8:		(v, at) => v.getInt8(at),
	uint8:		(v, at) => v.getUint8(at),
	int16:		(v, at, le) => v.getInt16(at, le),
	uint16:		(v, at, le) => v.getUint16(at, le),
	int32:		(v, at, le) => v.getInt32(at, le),
	uint32:		(v, at, le) => v.getUint32(at, le),
	float32:	(v, at, le) => v.getFloat32(at, le),
	float64:	(v, at, le) => v.getFloat64(at, le),
};

interface Property {
	name:	string;
	type:	Scalar;
	count?:	Scalar;		// the type of a list's length
}

interface Element {
	name:		string;
	count:		number;
	properties:	Property[];
}

function scalar(name: string) {
	const s = SCALARS[name];
	if (!s)
		throw new Error(`PLY property of unknown type '${name}'`);
	return s;
}

function parseHeader(data: Uint8Array) {
	// the header is ASCII, so up to its end a character is a byte, whatever decoding the body after it gives
	const head	= text(data.subarray(0, 65536));
	const end	= /end_header\r?\n/.exec(head);
	if (!end)
		throw new Error('PLY header has no end_header');
	const header = head.slice(0, end.index).split(/\r?\n/).map(l => l.trim());
	const elements: Element[] = [], comments: string[] = [], info: string[] = [];
	let format = '';
	for (const line of header) {
		const w = line.split(/\s+/);
		if (w[0] === 'format')
			format = w[1];
		else if (w[0] === 'comment')
			comments.push(line.slice(7).trim());
		else if (w[0] === 'obj_info')
			info.push(line.slice(8).trim());
		else if (w[0] === 'element')
			elements.push({name: w[1], count: Number(w[2]), properties: []});
		else if (w[0] === 'property' && w[1] === 'list')
			elements.at(-1)!.properties.push({name: w[4], count: scalar(w[2]), type: scalar(w[3])});
		else if (w[0] === 'property')
			elements.at(-1)!.properties.push({name: w[2], type: scalar(w[1])});
	}
	if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format))
		throw new Error(`PLY of unknown format '${format}'`);
	return {format, elements, comments, info, body: end.index + end[0].length};
}

// each element's rows, each a value (or a list of values) per property
function readRows(data: Uint8Array, format: string, elements: Element[], body: number) {
	if (format === 'ascii') {
		const words = text(data.subarray(body)).split(/\s+/).filter(Boolean).map(Number);
		let at = 0;
		return elements.map(e => Array.from({length: e.count}, () => e.properties.map(p =>
			p.count ? words.slice(at + 1, at += 1 + words[at]) : words[at++]
		)));
	}
	const view	= new DataView(data.buffer, data.byteOffset, data.byteLength);
	const le	= format === 'binary_little_endian';
	let at = body;
	const read = (t: Scalar) => {
		const v = GETTERS[t](view, at, le);
		at += SIZES[t];
		return v;
	};
	return elements.map(e => Array.from({length: e.count}, () => e.properties.map(p =>
		p.count ? Array.from({length: read(p.count)}, () => read(p.type)) : read(p.type)
	)));
}

const isFloat = (p: Property) => p.type === 'float32' || p.type === 'float64';

// the names a quantity goes by, in the order they are looked for
const NAMES = {
	normal:	[['nx', 'ny', 'nz'], ['normal_x', 'normal_y', 'normal_z']],
	color:	[['red', 'green', 'blue', 'alpha'], ['r', 'g', 'b', 'a'], ['diffuse_red', 'diffuse_green', 'diffuse_blue', 'diffuse_alpha']],
	uv:		[['s', 't'], ['u', 'v'], ['texture_u', 'texture_v'], ['texture_s', 'texture_t']],
};

// An element as columns, by property name, and which of its properties a mapping has used
function columns(e: Element, rows: (number | number[])[][]) {
	const used = new Set<string>();
	const col = (name: string) => {
		const i = e.properties.findIndex(p => p.name === name);
		if (i >= 0)
			used.add(name);
		return i < 0 ? undefined : {property: e.properties[i], values: rows.map(r => r[i])};
	};
	// the first set of names whose leading ones (all but a trailing alpha) are all there
	const group = (sets: string[][], need: number) => {
		const names = sets.find(s => s.slice(0, need).every(n => e.properties.some(p => p.name === n)));
		return names?.map(col).filter(c => c !== undefined);
	};
	return {col, group, used};
}

function colorsOf(cols: {property: Property, values: (number | number[])[]}[]) {
	return cols[0].values.map((_, i) => {
		const c = cols.map(({property, values}) => (values[i] as number) / (isFloat(property) ? 1 : 255));
		return float4(c[0], c[1], c[2], c[3] ?? 1);
	});
}

function toModel(format: string, elements: Element[], rows: (number | number[])[][][], comments: string[], info: string[], options?: ReadOptions): Model {
	const vi = elements.findIndex(e => e.name === 'vertex');
	if (vi < 0)
		throw new Error('PLY has no vertex element');
	const v = columns(elements[vi], rows[vi]);
	const [x, y, z] = ['x', 'y', 'z'].map(v.col);
	if (!x || !y || !z)
		throw new Error('PLY vertex without x, y and z');
	const points	= x.values.map((_, i) => point(x.values[i] as number, y.values[i] as number, z.values[i] as number, 'PLY vertex'));
	const mesh: Mesh = {points, faces: []};
	const properties: Record<string, Attribute<unknown>> = {};

	const normal = v.group(NAMES.normal, 3);
	if (normal)
		mesh.normals = {per: 'vertex', values: points.map((_, i) => float3(...normal.map(c => c.values[i] as number) as [number, number, number]))};
	const vcolor = v.group(NAMES.color, 3);
	if (vcolor)
		mesh.colors = {per: 'vertex', values: colorsOf(vcolor)};
	const uv = v.group(NAMES.uv, 2);
	if (uv)
		mesh.uvs = {per: 'vertex', values: points.map((_, i) => float2(uv[0].values[i] as number, uv[1].values[i] as number))};

	const fi = elements.findIndex(e => e.name === 'face');
	if (fi >= 0) {
		const f = columns(elements[fi], rows[fi]);
		const indices = f.col('vertex_indices') ?? f.col('vertex_index');
		if (!indices)
			throw new Error('PLY face without vertex_indices');
		mesh.faces = indices.values as number[][];
		checkIndices(mesh.faces, points.length, 'PLY');
		const fcolor = f.group(NAMES.color, 3);
		if (fcolor) {
			const values = colorsOf(fcolor);
			if (mesh.colors)
				properties.faceColor = {per: 'face', values};
			else
				mesh.colors = {per: 'face', values};
		}
		// a face's texture coordinates, u v for each corner
		const texcoord = f.col('texcoord');
		if (texcoord) {
			if (mesh.uvs)
				properties.vertexUV = mesh.uvs;
			let n = 0;
			const flat = texcoord.values as number[][];
			mesh.uvs = {per: 'corner', values: flat.flatMap(t => t.flatMap((_, k) => k % 2 ? [] : [float2(t[k], t[k + 1])])), indices: flat.map(t => t.flatMap((_, k) => k % 2 ? [] : [n++]))};
		}
		const material = f.col('material_index');
		if (material)
			mesh.faceMaterials = material.values as number[];
		for (const p of elements[fi].properties.filter(p => !f.used.has(p.name)))
			properties[p.name] = {per: 'face', values: f.col(p.name)!.values};
	}
	for (const p of elements[vi].properties.filter(p => !v.used.has(p.name)))
		properties[p.name] = {per: 'vertex', values: v.col(p.name)!.values};
	if (Object.keys(properties).length)
		mesh.properties = properties;

	const ei = elements.findIndex(e => e.name === 'edge');
	if (ei >= 0) {
		const e = columns(elements[ei], rows[ei]);
		const [a, b] = ['vertex1', 'vertex2'].map(e.col);
		if (a && b)
			mesh.lines = a.values.map((_, i) => [a.values[i] as number, b.values[i] as number]);
	}

	const materials: Material[] = [];
	const mi = elements.findIndex(e => e.name === 'material');
	if (mi >= 0) {
		const m = columns(elements[mi], rows[mi]);
		const diffuse = m.group([NAMES.color[2], NAMES.color[0]], 3);
		const colors = diffuse && colorsOf(diffuse);
		rows[mi].forEach((row, i) => materials.push({
			color:		colors?.[i],
			properties:	Object.fromEntries(elements[mi].properties.map((p, k) => [p.name, row[k]])),
		}));
	}
	const textures: Texture[] = comments.filter(c => /^TextureFile\s/i.test(c)).map(c => {
		const path = c.replace(/^TextureFile\s+/i, '');
		return {path, data: options?.file?.(path), properties: {}};
	});

	const model		= modelOf(mesh);
	model.materials	= materials;
	model.textures	= textures;
	model.metadata	= Object.fromEntries(info.map(i => i.split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
	model.extras	= {
		format, comments, info,
		elements: elements.map((e, i) => ({...e, data: Object.fromEntries(e.properties.map((p, k) => [p.name, rows[i].map(r => r[k])]))})),
	};
	return model;
}

export const PLY = {
	extensions: ['.ply'],
	check(data: Uint8Array) {
		return startsWith(data, 'ply\n') || startsWith(data, 'ply\r\n');
	},
	// Every element: extras.elements, each with its properties (and their types) and data, a column per property;
	// extras.comments and extras.info its comment and obj_info lines, metadata the obj_info lines as key and value.
	// The mesh: vertex x, y, z and face vertex_indices (or vertex_index), with normals (nx...), colours (red..., r...,
	// diffuse_red...; integers are 0..255), uvs (s t, u v, texture_u..., or a face's texcoord list) and material_index;
	// edge vertex1, vertex2 as lines; material elements as materials; TextureFile comments as textures. Any other vertex
	// or face property is in the mesh's properties, a face colour there as faceColor when the vertices have colours too.
	read(data: Uint8Array, options?: ReadOptions): Model {
		if (!PLY.check(data))
			throw new Error('not a PLY: does not start with "ply"');
		const {format, elements, comments, info, body} = parseHeader(data);
		return toModel(format, elements, readRows(data, format, elements, body), comments, info, options);
	},
	load(data: Uint8Array, options?: ReadOptions): Mesh {
		return flatten(PLY.read(data, options));
	},
	// binary little-endian, float coordinates
	save(mesh: Mesh): Uint8Array {
		const header = encode([
			'ply', 'format binary_little_endian 1.0',
			`element vertex ${mesh.points.length}`, 'property float x', 'property float y', 'property float z',
			`element face ${mesh.faces.length}`, 'property list uchar int vertex_indices',
			'end_header', ''
		].join('\n'));
		const size	= header.length + mesh.points.length * 12 + mesh.faces.reduce((n, f) => n + 1 + f.length * 4, 0);
		const out	= new Uint8Array(size);
		const view	= new DataView(out.buffer);
		out.set(header);
		let at = header.length;
		const put = (p: float3) => [p.x, p.y, p.z].forEach(v => {
			view.setFloat32(at, v, true);
			at += 4;
		});
		mesh.points.forEach(put);
		for (const f of mesh.faces) {
			view.setUint8(at++, f.length);
			for (const i of f) {
				view.setInt32(at, i, true);
				at += 4;
			}
		}
		return out;
	},
};
