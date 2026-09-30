import * as dwg from '@isopodlabs/dwg';
import { float3, float4, float3x4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Object3D, Instance, Attribute, flatten } from './common';
import { startsWith, text } from './utils';

// what DXF.read gives and DWG.contents() resolves a DWG into
interface Document {
	layers:			Map<string, dwg.Obj>;
	blocks:			Map<string, {block: dwg.Obj, entities: dwg.Obj[]}>;
	entities:		dwg.Obj[];
	unsupported:	Map<string, number>;
}

// $INSUNITS, as 3MF names units where it has one
const UNITS: Record<number, string> = {
	1: 'inch', 2: 'foot', 3: 'mile', 4: 'millimeter', 5: 'centimeter', 6: 'meter', 7: 'kilometer', 8: 'microinch', 9: 'mil',
	10: 'yard', 11: 'angstrom', 12: 'nanometer', 13: 'micron', 14: 'decimeter', 15: 'decameter', 16: 'hectometer',
	17: 'gigameter', 18: 'astronomical unit', 19: 'light year', 20: 'parsec',
};

const v3 = (p: dwg.Vec3) => float3(p.x, p.y, p.z);
const rgb = (c: number) => float4((c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1);

// The arbitrary axis algorithm: the object coordinate system an extrusion direction gives, as a transform to world
function ocs(extrusion?: dwg.Vec3) {
	const z = extrusion ? v3(extrusion) : float3(0, 0, 1);
	const x = (Math.abs(z.x) < 1 / 64 && Math.abs(z.y) < 1 / 64 ? float3(0, 1, 0) : float3(0, 0, 1)).cross(z);
	const nx = x.scale(1 / Math.hypot(x.x, x.y, x.z)), nz = z.scale(1 / Math.hypot(z.x, z.y, z.z));
	return float3x4(nx, nz.cross(nx), nz, float3(0, 0, 0));
}

// An insert's transforms, one per cell of a MINSERT's grid: its block's base point to the origin, scaled, moved to its
// cell, turned about the extrusion, and moved to its insertion point, in the extrusion's coordinate system
function placements(e: dwg.DRW_INSERT, base: dwg.Vec3) {
	const grid = e instanceof dwg.DRW_MINSERT ? e : undefined;
	const turn = float3.rotateZ(e.angle);
	const to = (x: number, y: number) =>
		ocs(e.ext_point).mulAffine(float3.translate(v3(e.base_point)))
			.mulAffine(float3x4(turn.x, turn.y, turn.z, float3(0, 0, 0)))
			.mulAffine(float3.translate(float3(x, y, 0)))
			.mulAffine(float3x4(float3(e.scale.x, 0, 0), float3(0, e.scale.y, 0), float3(0, 0, e.scale.z), float3(0, 0, 0)))
			.mulAffine(float3.translate(v3(base).scale(-1)));
	return Array.from({length: grid?.rowcount ?? 1}, (_, r) => Array.from({length: grid?.colcount ?? 1}, (_, c) => to(c * (grid?.colspace ?? 0), r * (grid?.rowspace ?? 0)))).flat();
}

class Builder {
	points:		float3[] = [];
	faces:		number[][] = [];
	lines:		number[][] = [];
	colors:		(float4 | undefined)[] = [];	// per face
	handles:	number[] = [];					// per face, the entity it is of
	invisible:	number[] = [];					// per face, a bit per edge not drawn
	layers:		Record<string, number[]> = {};

	constructor(private color: (e: dwg.Entity) => float4 | undefined) {}

	private point(p: dwg.Vec3) {
		return this.points.push(v3(p)) - 1;
	}
	face(e: dwg.Entity, corners: number[], invisible = 0, color = this.color(e)) {
		(this.layers[e.layer ?? '0'] ??= []).push(this.faces.length);
		this.faces.push(corners);
		this.colors.push(color);
		this.handles.push(e.handle);
		this.invisible.push(invisible);
	}

	// its corners; a triangle repeats its third as its fourth
	face3d(e: dwg.DRW_FACE_3D) {
		const p = [e.point1, e.point2, e.point3, e.point4];
		this.face(e, p.slice(0, p[2].x === p[3].x && p[2].y === p[3].y && p[2].z === p[3].z ? 3 : 4).map(q => this.point(q)), e.invisibleflag ?? 0);
	}

	// its vertices, then its faces' records: 1-based indices of up to four vertices, negative for an edge not drawn,
	// 0 for none; a face record's own colour is the face's, when it has one
	polyface(e: dwg.DRW_POLYLINE_PFACE) {
		const first = this.points.length;
		e.vertices.filter(v => v instanceof dwg.DRW_VERTEX_PFACE).forEach(v => this.point(v.point));
		for (const f of e.vertices.filter(v => v instanceof dwg.DRW_VERTEX_PFACE_FACE)) {
			const index = f.index.filter(i => i !== 0);
			this.face(e, index.map(i => first + Math.abs(i) - 1), index.reduce((bits, i, k) => i < 0 ? bits | 1 << k : bits, 0), this.color(f) ?? this.color(e));
		}
	}

	// an M by N grid of vertices (by rows of N), each cell a quad, closed in M or N as its flags say; a surface fitted to
	// it is drawn, when there is one, at its densities
	polymesh(e: dwg.DRW_POLYLINE_MESH) {
		const fitted = e.vertices.filter(v => v instanceof dwg.Vertex && (v.flags & 8));
		const [m, n, verts] = fitted.length ? [e.m_density, e.n_density, fitted] : [e.num_m_verts, e.num_n_verts, e.vertices.filter(v => v instanceof dwg.Vertex)];
		const first = this.points.length;
		(verts as dwg.Vertex[]).forEach(v => this.point(v.point));
		const [closedM, closedN] = [(e.flags & 1) !== 0, (e.flags & 32) !== 0];
		const at = (i: number, j: number) => first + (i % m) * n + j % n;
		for (let i = 0; i < (closedM ? m : m - 1); i++)
			for (let j = 0; j < (closedN ? n : n - 1); j++)
				this.face(e, [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)]);
	}

	line(points: dwg.Vec3[], closed = false) {
		const i = points.map(p => this.point(p));
		this.lines.push(closed ? [...i, i[0]] : i);
	}

	mesh(): Mesh | undefined {
		if (!this.faces.length && !this.lines.length)
			return undefined;
		const mesh: Mesh = {points: this.points, faces: this.faces, faceSets: {layer: this.layers}};
		if (this.lines.length)
			mesh.lines = this.lines;
		if (this.colors.some(c => c)) {
			let n = 0;
			mesh.colors = {per: 'face', values: this.colors.filter(c => c) as float4[], indices: this.colors.map(c => c ? n++ : -1)};
		}
		const properties: Record<string, Attribute<unknown>> = {handle: {per: 'face', values: this.handles}};
		if (this.invisible.some(i => i))
			properties.invisibleEdges = {per: 'face', values: this.invisible};
		mesh.properties = properties;
		return mesh;
	}
}

// The document as objects: model space (and the active paper space, not built), and a block per object, each with the
// meshes of its 3DFACEs, polyface and polygon meshes, its LINEs and 3D polylines as lines, and its INSERTs as instances.
function toModel(doc: Document, unitCode: number | undefined, extras: Record<string, unknown>): Model {
	const layerColors = new Map([...doc.layers].map(([name, l]) => [name, (l as {color?: dwg.Color}).color]));
	// a BYBLOCK colour depends on the insert, and so is left none
	const color = (e: dwg.Entity) => {
		const value = dwg.rgbOf(e.color ?? {index: 256}, layerColors.get(e.layer ?? '0'));
		return value === undefined ? undefined : rgb(value);
	};

	const objects: Object3D[] = [], byBlock = new Map<string, Object3D>();
	const other = new Map<string, number>();
	// an object is listed before it is filled, so a block that inserts itself refers to it
	const objectOf = (name: string, entities: dwg.Obj[]): Object3D => {
		const b = new Builder(color), children: Instance[] = [];
		const object: Object3D = {name, children, metadata: {}, properties: {}};
		objects.push(object);
		if (doc.blocks.has(name))
			byBlock.set(name, object);
		for (const e of entities) {
			if (e instanceof dwg.DRW_FACE_3D) {
				b.face3d(e);
			} else if (e instanceof dwg.DRW_POLYLINE_PFACE) {
				b.polyface(e);
			} else if (e instanceof dwg.DRW_POLYLINE_MESH) {
				b.polymesh(e);
			} else if (e instanceof dwg.DRW_POLYLINE_3D) {
				b.line(e.vertices.filter(v => v instanceof dwg.Vertex).map(v => v.point), (e.flags & 1) !== 0);
			} else if (e instanceof dwg.DRW_LINE) {
				b.line([e.point1, e.point2]);
			} else if (e instanceof dwg.DRW_INSERT && e.block_name !== undefined && doc.blocks.has(e.block_name)) {
				const block = doc.blocks.get(e.block_name)!;
				const target = byBlock.get(e.block_name) ?? objectOf(e.block_name, block.entities);
				for (const transform of placements(e, (block.block as {base_point?: dwg.Vec3}).base_point ?? {x: 0, y: 0, z: 0}))
					children.push({object: target, transform, properties: {handle: e.handle, layer: e.layer}});
			} else {
				const type = e.constructor.name.replace(/^DRW_/, '');
				other.set(type, (other.get(type) ?? 0) + 1);
			}
		}
		object.mesh = b.mesh();
		return object;
	};

	const model	= objectOf('*Model_Space', doc.entities.filter(e => !(e instanceof dwg.Entity) || e.entmode !== 1));
	const paper	= doc.entities.filter(e => e instanceof dwg.Entity && e.entmode === 1);
	if (paper.length)
		objectOf('*Paper_Space', paper);
	for (const [name, block] of doc.blocks)
		if (!byBlock.has(name))
			objectOf(name, block.entities);
	return {
		unit:		unitCode === undefined ? undefined : UNITS[unitCode],
		metadata:	{},
		materials:	[],
		textures:	[],
		objects,
		build:		[{object: model}],
		extras:		{...extras, document: doc, entities: Object.fromEntries(other), unsupported: doc.unsupported},
	};
}

export const DXF = {
	extensions: ['.dxf'],
	check(data: Uint8Array) {
		return /^\s*0\s*\r?\n\s*SECTION\b/.test(text(data.subarray(0, 64))) || startsWith(data, 'AutoCAD Binary DXF');
	},
	// See toModel. extras.document is the DXF as @isopodlabs/dwg reads it (every entity, table and block, 2-D ones
	// included), extras.entities counts the entities no mesh or line was made of, by type, and extras.unsupported those
	// the reader has no class for; extras.header the HEADER variables.
	read(data: Uint8Array): Model {
		const doc = dwg.DXF.read(data);
		return toModel(doc, doc.vars.get('$INSUNITS')?.num(70), {version: doc.version, header: doc.vars});
	},
	load(data: Uint8Array): Mesh {
		return flatten(DXF.read(data));
	},
};

export const DWG = {
	extensions: ['.dwg'],
	check(data: Uint8Array) {
		return /^AC10\d\d/.test(text(data.subarray(0, 6)));
	},
	// As DXF's, extras.document being what DWG.contents() resolves the drawing into, and extras.header its header
	// variables; extras.unsupported counts entities whose layout is known not to be read (modeler geometry in AcDs).
	async read(data: Uint8Array): Promise<Model> {
		const file = new dwg.DWG(data);
		try {
			if (!await file.ready)
				throw new Error('not a DWG of a version that can be read');
			return toModel(await file.contents(), file.vars.y2000?.INSUNITS, {version: file.version, header: file.vars});
		} finally {
			await file.close();
		}
	},
	async load(data: Uint8Array): Promise<Mesh> {
		return flatten(await DWG.read(data));
	},
};
