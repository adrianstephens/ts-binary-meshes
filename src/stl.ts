import * as bin from '@isopodlabs/binary';
import { float3, float4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Object3D, Material, triangles, faceNormal, flatten } from './common';
import { lines, numbers, point, text, encode } from './utils';

const Vec3LE = bin.Struct({x: bin.Float32_LE, y: bin.Float32_LE, z: bin.Float32_LE});
const STLBinary = {
	header:	bin.Buffer(80),
	facets:	bin.Array(bin.UINT32_LE, bin.Struct({normal: Vec3LE, a: Vec3LE, b: Vec3LE, c: Vec3LE, attributes: bin.UINT16_LE})),
};

// a binary STL's size is exactly what its count says; a binary header may itself begin "solid", so that decides nothing
function isBinary(data: Uint8Array) {
	return data.length >= 84 && data.length === 84 + 50 * new DataView(data.buffer, data.byteOffset + 80, 4).getUint32(0, true);
}

const v3 = (v: {x: number, y: number, z: number}) => float3(v.x, v.y, v.z);

function soup(tris: float3[][], normals: float3[]): Mesh {
	return {
		points:		tris.flat(),
		faces:		tris.map((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]),
		normals:	{per: 'face', values: normals},
	};
}

function object(mesh: Mesh, name?: string): Object3D {
	return {name, mesh, children: [], metadata: {}, properties: {}};
}

// 5 bits each, lowest first
const rgb15 = (a: number) => [a & 31, (a >> 5) & 31, (a >> 10) & 31].map(c => c / 31);
const rgba8 = (b: Uint8Array) => float4(b[0] / 255, b[1] / 255, b[2] / 255, b[3] / 255);

// The two conventions for colour in the attribute word. Materialise Magics (the header has COLOR=, its default): bit 15
// clear for a facet's own colour, red lowest. VisCAM/SolidView: bit 15 set for a valid colour, blue lowest.
function facetColors(header: Uint8Array, attributes: number[]): {model?: float4, colors?: Mesh['colors']} {
	const at = text(header).indexOf('COLOR=');
	if (at >= 0) {
		const model = rgba8(header.subarray(at + 6, at + 10));
		return {model, colors: {per: 'face', values: attributes.map(a => {
			if (a & 0x8000)
				return model;
			const [r, g, b] = rgb15(a);
			return float4(r, g, b, 1);
		})}};
	}
	if (!attributes.some(a => a & 0x8000))
		return {};
	return {colors: {per: 'face', values: attributes.map(a => {
		const [b, g, r] = rgb15(a);
		return float4(r, g, b, 1);
	}), indices: attributes.map((a, i) => a & 0x8000 ? i : -1)}};
}

// Materialise's MATERIAL= : diffuse, specular and ambient, 4 bytes each
function headerMaterial(header: Uint8Array): Material | undefined {
	const at = text(header).indexOf('MATERIAL=');
	if (at < 0)
		return undefined;
	const [diffuse, specular, ambient] = [0, 4, 8].map(o => rgba8(header.subarray(at + 9 + o, at + 13 + o)));
	return {color: diffuse, properties: {diffuse, specular, ambient}};
}

function readBinary(data: Uint8Array): Model {
	const {header, facets} = bin.read(new bin.stream(data), STLBinary);
	const mesh			= soup(facets.map(f => [v3(f.a), v3(f.b), v3(f.c)]), facets.map(f => v3(f.normal)));
	const attributes	= facets.map(f => f.attributes);
	const {model, colors} = facetColors(header, attributes);
	const material		= headerMaterial(header);
	mesh.colors			= colors;
	mesh.properties		= {attributes: {per: 'face', values: attributes}};
	if (material)
		mesh.faceMaterials = facets.map(() => 0);
	const o = object(mesh);
	return {
		metadata:	{header: text(header).replace(/\0.*$/s, '').trim()},
		materials:	material ? [material] : [],
		textures:	[],
		objects:	[o],
		build:		[{object: o}],
		extras:		{header, ...(model ? {color: model} : {})},
	};
}

// one object per solid; a facet may have more than three vertices
function readText(s: string): Model {
	const objects: Object3D[] = [];
	let tris: float3[][] = [], normals: float3[] = [], loop: float3[] = [], name: string | undefined;
	for (const line of lines(s)) {
		const w = line.split(/\s+/);
		if (w[0] === 'solid') {
			[tris, normals, name] = [[], [], line.slice(5).trim() || undefined];
		} else if (w[0] === 'facet') {
			const n = numbers(w.slice(2, 5));
			normals.push(point(n[0], n[1], n[2], 'STL facet normal'));
		} else if (line.startsWith('outer loop')) {
			loop = [];
		} else if (w[0] === 'endloop') {
			if (loop.length < 3)
				throw new Error(`STL loop with ${loop.length} vertices`);
			tris.push(loop);
		} else if (w[0] === 'vertex') {
			const v = numbers(w.slice(1));
			if (v.length !== 3)
				throw new Error(`STL vertex that cannot be read: '${line}'`);
			loop.push(point(v[0], v[1], v[2], 'STL vertex'));
		} else if (w[0] === 'endsolid') {
			const points = tris.flat();
			let at = 0;
			objects.push(object({
				points,
				faces:		tris.map(t => t.map(() => at++)),
				normals:	{per: 'face', values: normals},
			}, name));
		}
	}
	if (!objects.length)
		throw new Error('STL ends before its endsolid');
	return {metadata: {}, materials: [], textures: [], objects, build: objects.map(object => ({object})), extras: {}};
}

export const STL = {
	extensions: ['.stl'],
	check(data: Uint8Array) {
		return isBinary(data) || text(data.subarray(0, 5)) === 'solid';
	},
	// binary: metadata.header its header's text, extras.header its bytes, extras.color Materialise's default colour, and
	// the mesh's properties.attributes each facet's attribute word. ASCII: an object per solid, named as it is.
	// Either way the facets' normals, as written, are the mesh's face normals.
	read(data: Uint8Array): Model {
		if (isBinary(data))
			return readBinary(data);
		if (text(data.subarray(0, 5)) !== 'solid')
			throw new Error('not an STL: neither binary nor starting with "solid"');
		return readText(text(data));
	},
	load(data: Uint8Array): Mesh {
		return flatten(STL.read(data));
	},
	// binary, each face cut into triangles with the normal its winding gives
	save(mesh: Mesh, name = 'mesh'): Uint8Array {
		const s = new bin.growingStream();
		const header = new Uint8Array(80);
		header.set(encode(`binary STL from ${name}`.slice(0, 80)));
		const facets = triangles(mesh).map(t => {
			const [a, b, c] = t.map(i => mesh.points[i]);
			return {normal: faceNormal(mesh, t), a, b, c, attributes: 0};
		});
		bin.write(s, STLBinary, {header, facets});
		return s.terminate();
	},
	saveText(mesh: Mesh, name = 'mesh'): Uint8Array {
		const v = (p: float3) => `${p.x} ${p.y} ${p.z}`;
		return encode([
			`solid ${name}`,
			...triangles(mesh).flatMap(t => [
				`facet normal ${v(faceNormal(mesh, t))}`,
				'outer loop',
				...t.map(i => `vertex ${v(mesh.points[i])}`),
				'endloop',
				'endfacet',
			]),
			`endsolid ${name}`, ''
		].join('\n'));
	},
};
