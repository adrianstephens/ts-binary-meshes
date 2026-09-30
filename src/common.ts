import { float2, float3, float4, float3x4, safeNormalise } from '@isopodlabs/maths/vector';

// Values of some quantity, for each vertex (parallel to points), each face (parallel to faces) or each corner of each
// face. Without indices, values are parallel to what they are per; with indices, each vertex, face or corner names its
// value in values (a palette), -1 where it has none. A corner attribute always has indices, a loop per face.
export type Attribute<T> =
	| {per: 'vertex' | 'face', values: T[], indices?: number[]}
	| {per: 'corner', values: T[], indices: number[][]};

export interface Mesh {
	points:			float3[];
	// each a loop of indices into points, anticlockwise seen from outside
	faces:			number[][];
	lines?:			number[][];		// polylines (OBJ l, PLY edges, 3MF beams)
	vertices?:		number[];		// lone points (OBJ p)
	normals?:		Attribute<float3>;
	colors?:		Attribute<float4>;	// r, g, b, a, each 0..1
	uvs?:			Attribute<float2>;
	faceMaterials?:	number[];		// per face, an index into Model.materials, -1 where it has none
	// named sets of faces by kind, as {group: {wheels: [0, 1, ...]}}: OBJ's o, g and s, AMF's volumes
	faceSets?:		Record<string, Record<string, number[]>>;
	// whatever else the file gives per vertex, face or corner, by the file's own name for it
	properties?:	Record<string, Attribute<unknown>>;
}

export interface Texture {
	path?:			string;			// where the file says it is: a 3MF part, an OBJ/PLY image file
	data?:			Uint8Array;		// its bytes, when the file (or the options' file()) has them
	contentType?:	string;
	properties:		Record<string, unknown>;
}

export interface Material {
	name?:			string;
	color?:			float4;
	texture?:		number;			// its main (diffuse) texture, an index into Model.textures
	properties:		Record<string, unknown>;
}

export interface Object3D {
	name?:			string;
	mesh?:			Mesh;
	children:		Instance[];		// other objects placed within this one (3MF components, AMF constellation instances)
	metadata:		Record<string, string>;
	properties:		Record<string, unknown>;
}

// An object placed by a transform; the same object may be placed any number of times
export interface Instance {
	object:			Object3D;
	transform?:		float3x4;
	properties?:	Record<string, unknown>;
}

export interface Model {
	unit?:			string;			// what a coordinate is measured in, when the file says; nothing is scaled by it
	metadata:		Record<string, string>;
	materials:		Material[];
	textures:		Texture[];
	objects:		Object3D[];		// every object the file defines, placed or not
	build:			Instance[];		// what the file is a model of
	extras:			Record<string, unknown>;	// everything format-specific; see each format
}

export interface ReadOptions {
	// the bytes of another file a file names (an OBJ's mtllib, a texture image), relative to the one being read
	file?(name: string): Uint8Array | undefined;
}

export interface Format {
	extensions:	string[];
	check(data: Uint8Array): boolean;
	read(data: Uint8Array, options?: ReadOptions): Model | Promise<Model>;
	load(data: Uint8Array, options?: ReadOptions): Mesh | Promise<Mesh>;
	save?(mesh: Mesh): Uint8Array | Promise<Uint8Array>;
}

// the sum of its edges' cross products: twice its area along its normal, for any planar face, concave or not
function newell(points: float3[], face: number[]) {
	return face.reduce((n, i, k) => n.add(points[i].cross(points[face[(k + 1) % face.length]])), float3(0, 0, 0));
}

// A face's triangles, as indices of its corners (0 its first), by ear clipping in the plane of its Newell normal, so a
// concave face is cut as it is drawn. When no ear is left the rest has no area, and is fanned.
export function faceTriangles({points}: Mesh, face: number[]): number[][] {
	if (face.length === 3)
		return [[0, 1, 2]];
	const n		= newell(points, face);
	const a		= Math.abs(n.x) > Math.abs(n.y) ? (Math.abs(n.x) > Math.abs(n.z) ? 'x' : 'z') : (Math.abs(n.y) > Math.abs(n.z) ? 'y' : 'z');
	const [u, v] = a === 'x' ? ['y', 'z'] as const : a === 'y' ? ['z', 'x'] as const : ['x', 'y'] as const;
	const flip	= n[a] < 0 ? -1 : 1;
	const p2	= (k: number) => ({u: points[face[k]][u], v: points[face[k]][v] * flip});
	const cross	= (o: number, b: number, c: number) => {
		const [P, Q, R] = [o, b, c].map(p2);
		return (Q.u - P.u) * (R.v - P.v) - (Q.v - P.v) * (R.u - P.u);
	};
	const inside = (i: number, a: number, b: number, c: number) => cross(a, b, i) >= 0 && cross(b, c, i) >= 0 && cross(c, a, i) >= 0;

	const ring = face.map((_, k) => k), tris: number[][] = [];
	while (ring.length > 3) {
		const k = ring.findIndex((b, k) => {
			const a = ring[(k + ring.length - 1) % ring.length], c = ring[(k + 1) % ring.length];
			return cross(a, b, c) > 0 && !ring.some(i => i !== a && i !== b && i !== c && inside(i, a, b, c));
		});
		if (k < 0)
			return [...tris, ...ring.slice(1, -1).map((_, j) => [ring[0], ring[j + 1], ring[j + 2]])];
		tris.push([ring[(k + ring.length - 1) % ring.length], ring[k], ring[(k + 1) % ring.length]]);
		ring.splice(k, 1);
	}
	return [...tris, ring];
}

// every face's triangles, as indices into points
export function triangles(mesh: Mesh) {
	return mesh.faces.flatMap(f => faceTriangles(mesh, f).map(t => t.map(k => f[k])));
}

export function faceNormal(mesh: Mesh, face: number[]): float3 {
	return safeNormalise(newell(mesh.points, face)) ?? float3(0, 0, 0);
}

export function bounds(mesh: Mesh): {min: float3, max: float3} | undefined {
	return mesh.points.length ? {min: mesh.points.reduce((a, p) => a.min(p)), max: mesh.points.reduce((a, p) => a.max(p))} : undefined;
}

// the geometry, moved; its attributes are left behind
export function transform(mesh: Mesh, m: float3x4): Mesh {
	return {points: mesh.points.map(p => m.mulPos(p)), faces: mesh.faces};
}

// one mesh of the geometry of all of them, their indices offset past the points before
export function merge(meshes: Mesh[]): Mesh {
	let points: float3[] = [], faces: number[][] = [];
	for (const m of meshes) {
		faces	= faces.concat(m.faces.map(f => f.map(i => i + points.length)));
		points	= points.concat(m.points);
	}
	return {points, faces};
}

// every mesh the instances place, with the transform that places it (theirs composed with their parents')
export function placed(instances: Instance[], parent = float3x4.identity()): {mesh: Mesh, transform: float3x4}[] {
	return instances.flatMap(({object, transform}) => {
		const m = transform ? parent.mulAffine(transform) : parent;
		return [...(object.mesh ? [{mesh: object.mesh, transform: m}] : []), ...placed(object.children, m)];
	});
}

// the geometry of everything the model's build places, as one mesh
export function flatten(model: Model): Mesh {
	return merge(placed(model.build).map(({mesh, transform: m}) => transform(mesh, m)));
}

// a model of one mesh, placed once
export function modelOf(mesh: Mesh, name?: string): Model {
	const object: Object3D = {name, mesh, children: [], metadata: {}, properties: {}};
	return {metadata: {}, materials: [], textures: [], objects: [object], build: [{object}], extras: {}};
}
