import { float2, float3, float4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Attribute, modelOf, flatten } from './common';
import { lines, numbers, checkIndices, text, encode, color } from './utils';

const reMagic = /^(ST)?(C)?(N)?(4)?(n)?OFF$/;

interface Header {
	st:				boolean;
	c:				boolean;
	n:				boolean;
	homogeneous:	boolean;
	dimension:		number;
}

interface Vertex {
	coords:		number[];
	normal?:	number[];
	color?:		number[];
	st?:		number[];
}

interface Parsed {
	h:				Header;
	vertices:		Vertex[];
	faces:			number[][];
	faceColors:		number[][];		// 0 numbers, 1 (an index into a colour map), or 3 or 4
	edges:			number;
}

function header(magic: RegExpExecArray | null): Header {
	return {st: !!magic?.[1], c: !!magic?.[2], n: !!magic?.[3], homogeneous: !!magic?.[4], dimension: 3};
}

// a vertex from its numbers: coordinates, then as the header says a normal, a colour and a texture coordinate, the
// colour (3 or 4 numbers in text) being whatever is between the normal and the texture coordinate
function vertex(h: Header, v: number[], colorCount?: number): Vertex {
	const nc	= h.dimension + (h.homogeneous ? 1 : 0);
	const cEnd	= h.c ? (colorCount === undefined ? v.length - (h.st ? 2 : 0) : nc + (h.n ? 3 : 0) + colorCount) : nc + (h.n ? 3 : 0);
	return {
		coords:	v.slice(0, nc),
		normal:	h.n ? v.slice(nc, nc + 3) : undefined,
		color:	h.c ? v.slice(nc + (h.n ? 3 : 0), cEnd) : undefined,
		st:		h.st ? v.slice(cEnd, cEnd + 2) : undefined,
	};
}

// each vertex and face on a line of its own; the header's words may be spread over lines
function parseText(s: string): Parsed {
	const rows	= lines(s).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean).map(l => l.split(/\s+/));
	const magic	= reMagic.exec(rows[0]?.[0] ?? '');
	const h		= header(magic);
	let r = 0, c = magic ? 1 : 0;
	const word = () => {
		while (r < rows.length && c >= rows[r].length)
			[r, c] = [r + 1, 0];
		return Number(rows[r]?.[c++]);
	};
	if (magic?.[5])
		h.dimension = word();
	const [nv, nf] = [word(), word()];
	const edges = c < rows[r].length ? word() : 0;
	if (!(nv >= 0) || !(nf >= 0))
		throw new Error('OFF header does not give its counts');
	if (rows.length < r + 1 + nv + nf)
		throw new Error('OFF ends before its last face');
	const vrows = rows.slice(r + 1, r + 1 + nv).map(numbers);
	const frows = rows.slice(r + 1 + nv, r + 1 + nv + nf).map(numbers);
	return {
		h, edges,
		vertices:	vrows.map(v => vertex(h, v)),
		faces:		frows.map(f => f.slice(1, 1 + f[0])),
		faceColors:	frows.map(f => f.slice(1 + f[0])),
	};
}

// big-endian 32-bit ints and floats after the header line; a vertex colour is 4 floats, a face's preceded by its count
function parseBinary(data: Uint8Array, start: number, h: Header): Parsed {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let at = start;
	const int	= () => (at += 4, view.getInt32(at - 4));
	const float	= () => (at += 4, view.getFloat32(at - 4));
	if (h.dimension < 0)
		h.dimension = int();
	const [nv, nf, edges] = [int(), int(), int()];
	const per = h.dimension + (h.homogeneous ? 1 : 0) + (h.n ? 3 : 0) + (h.c ? 4 : 0) + (h.st ? 2 : 0);
	const vertices = Array.from({length: nv}, () => vertex(h, Array.from({length: per}, float), 4));
	const faces: number[][] = [], faceColors: number[][] = [];
	for (let i = 0; i < nf; i++) {
		faces.push(Array.from({length: int()}, int));
		faceColors.push(Array.from({length: int()}, float));
	}
	return {h, vertices, faces, faceColors, edges};
}

// the running index among those that pass, -1 for those that don't
function indicesOf<T>(all: T[], test: (v: T) => boolean) {
	let n = 0;
	return all.map(v => test(v) ? n++ : -1);
}

function toModel({h, vertices, faces, faceColors, edges}: Parsed): Model {
	if (vertices.some(v => v.coords.length < h.dimension || v.coords.some(x => !Number.isFinite(x))))
		throw new Error('OFF vertex has a coordinate that cannot be read');
	checkIndices(faces, vertices.length, 'OFF');
	const points = vertices.map(({coords: c}) => {
		const w = h.homogeneous ? c[h.dimension] : 1;
		return float3((c[0] ?? 0) / w, (c[1] ?? 0) / w, (c[2] ?? 0) / w);
	});
	const mesh: Mesh = {points, faces};
	const properties: Record<string, Attribute<unknown>> = {};
	if (h.n)
		mesh.normals = {per: 'vertex', values: vertices.map(({normal: n}) => float3(n![0], n![1], n![2]))};
	if (h.c)
		mesh.colors = {per: 'vertex', values: vertices.map(v => color(v.color!))};
	if (h.st)
		mesh.uvs = {per: 'vertex', values: vertices.map(({st}) => float2(st![0], st![1]))};
	if (h.homogeneous)
		properties.w = {per: 'vertex', values: vertices.map(v => v.coords[h.dimension])};
	if (h.dimension !== 3)
		properties.coordinates = {per: 'vertex', values: vertices.map(v => v.coords.slice(0, h.dimension))};

	const own = (c: number[]) => c.length >= 3;
	if (faceColors.some(own)) {
		const attr: Attribute<float4> = {per: 'face', values: faceColors.filter(own).map(color), indices: indicesOf(faceColors, own)};
		if (h.c)
			properties.faceColor = attr;
		else
			mesh.colors = attr;
	}
	if (faceColors.some(c => c.length === 1))
		properties.colorMapIndex = {per: 'face', values: faceColors.map(c => c.length === 1 ? c[0] : -1)};
	if (Object.keys(properties).length)
		mesh.properties = properties;

	const model = modelOf(mesh);
	model.extras = {edges, ...(h.dimension !== 3 ? {dimension: h.dimension} : {})};
	return model;
}

export const OFF = {
	extensions: ['.off'],
	check(data: Uint8Array) {
		return /^\S*OFF\b/.test(text(data.subarray(0, 64)));
	},
	// Text or binary, with any of the ST, C, N, 4 and n prefixes, or with no header word at all. A vertex's normal,
	// colour and texture coordinate become the mesh's per-vertex attributes; a face's colour its per-face colours
	// (properties.faceColor when the vertices have colours too), or properties.colorMapIndex for an index into a colour
	// map. properties.w holds a 4OFF's homogeneous coordinate (the points are divided by it); properties.coordinates all
	// of an nOFF's, when it is not 3-D. extras.edges is the header's edge count; extras.dimension an nOFF's dimension.
	read(data: Uint8Array): Model {
		const first = /^\s*(\S+)[ \t]*(BINARY)?/.exec(text(data.subarray(0, 64)));
		if (first?.[2]) {
			const magic = reMagic.exec(first[1]);
			if (!magic)
				throw new Error(`not a binary OFF: '${first[1]}'`);
			const h = header(magic);
			if (magic[5])
				h.dimension = -1;
			return toModel(parseBinary(data, data.indexOf(10) + 1, h));
		}
		return toModel(parseText(text(data)));
	},
	load(data: Uint8Array): Mesh {
		return flatten(OFF.read(data));
	},
	// with its per-vertex colours, when it has them
	save(mesh: Mesh): Uint8Array {
		const vc = mesh.colors?.per === 'vertex' && !mesh.colors.indices ? mesh.colors.values : undefined;
		const c = (v: float4) => ` ${v.x} ${v.y} ${v.z} ${v.w}`;
		return encode([
			vc ? 'COFF' : 'OFF',
			`${mesh.points.length} ${mesh.faces.length} 0`,
			...mesh.points.map((p, i) => `${p.x} ${p.y} ${p.z}${vc ? c(vc[i]) : ''}`),
			...mesh.faces.map(f => `${f.length} ${f.join(' ')}`),
			''
		].join('\n'));
	},
};
