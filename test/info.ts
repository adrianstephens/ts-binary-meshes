// What each reader gives besides geometry: attributes, materials, textures, hierarchy, metadata and extras
import { float3 } from '@isopodlabs/maths/vector';
import { Model, Mesh, flatten, placed, STL, OFF, OBJ, PLY, AMF, ThreeMF, DXF, DWG } from '../dist/index';
import { existsSync, readFileSync } from 'fs';
import { makeZip } from '../dist/zip';

let bad = 0, checks = 0;
function check(ok: boolean, msg: string) {
	checks++;
	if (!ok) {
		console.log(`FAIL: ${msg}`);
		bad++;
	}
}

const encode	= (s: string) => new TextEncoder().encode(s);
const vec		= (v: any) => v === undefined ? 'undefined' : [v.x, v.y, v.z, v.w].filter(x => x !== undefined).map((x: number) => +x.toFixed(4)).join(',');
const eq		= (a: unknown, b: unknown, what: string) => check(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const vecs		= (a: any[] | undefined, b: string[], what: string) => eq(a?.map(vec), b, what);
const meshOf	= (m: Model, i = 0) => m.objects[i].mesh!;
// an attribute's value at each index (-1: none)
const at		= (attr: any, i: number) => attr.indices ? (attr.indices[i] < 0 ? undefined : attr.values[attr.indices[i]]) : attr.values[i];
const corner	= (attr: any, f: number) => attr.indices[f].map((i: number) => i < 0 ? 'none' : vec(attr.values[i]));

const tri: Mesh = {points: [float3(0, 0, 0), float3(1, 0, 0), float3(0, 1, 0), float3(1, 1, 0)], faces: [[0, 1, 2], [1, 3, 2]]};

(async () => {
	//--- STL --------------------------------------------------------------------------------------------------------
	{
		// Materialise: a default colour in the header, a facet's own when bit 15 is clear (red lowest)
		const bytes = STL.save(tri);
		const header = new Uint8Array(80);
		header.set(encode('COLOR='));
		header.set([255, 0, 0, 255], 6);
		header.set(encode(' MATERIAL='), 10);
		header.set([0, 255, 0, 255, 1, 2, 3, 4, 5, 6, 7, 8], 20);
		bytes.set(header);
		const view = new DataView(bytes.buffer);
		view.setUint16(84 + 48, 0x8000, true);
		view.setUint16(84 + 50 + 48, 31 | (31 << 10), true);
		const m = STL.read(bytes), mesh = meshOf(m);
		vecs(mesh.colors!.values, ['1,0,0,1', '1,0,1,1'], 'STL Materialise colours');
		eq((mesh.properties!.attributes as any).values, [0x8000, 31 | (31 << 10)], 'STL attribute words');
		vecs([m.materials[0].color], ['0,1,0,1'], 'STL MATERIAL= diffuse');
		vecs(mesh.normals!.values, ['0,0,1', '0,0,1'], 'STL facet normals');
		check(m.metadata.header.startsWith('COLOR='), `STL header text ${m.metadata.header}`);

		// VisCAM: bit 15 set for a valid colour, blue lowest
		const bytes2 = STL.save(tri);
		new DataView(bytes2.buffer).setUint16(84 + 48, 0x8000 | 31, true);
		const c2 = meshOf(STL.read(bytes2)).colors!;
		check(vec(at(c2, 0)) === '0,0,1,1' && at(c2, 1) === undefined, `STL VisCAM colours ${vec(at(c2, 0))} ${vec(at(c2, 1))}`);

		const solids = STL.read(encode(['a', 'b'].map(n => `solid ${n}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${n}`).join('\n')));
		eq(solids.objects.map(o => o.name), ['a', 'b'], 'STL solids');
		eq(solids.build.length, 2, 'STL build');
	}

	//--- OFF --------------------------------------------------------------------------------------------------------
	{
		const cn = OFF.read(encode('CNOFF\n3 1 0\n0 0 0 0 0 1 255 0 0\n1 0 0 0 0 1 0 255 0\n0 1 0 0 0 1 0 0 255\n3 0 1 2 1 0.5 0 1\n'));
		const mesh = meshOf(cn);
		vecs(mesh.colors!.values, ['1,0,0,1', '0,1,0,1', '0,0,1,1'], 'COFF vertex colours');
		vecs(mesh.normals!.values, ['0,0,1', '0,0,1', '0,0,1'], 'NOFF normals');
		vecs([at(mesh.properties!.faceColor, 0)], ['1,0.5,0,1'], 'OFF face colour beside vertex colours');

		const st = meshOf(OFF.read(encode('STOFF\n3 1\n0 0 0 0 0\n1 0 0 1 0\n0 1 0 0 1\n3 0 1 2 7\n')));
		vecs(st.uvs!.values, ['0,0', '1,0', '0,1'], 'STOFF uvs');
		eq((st.properties!.colorMapIndex as any).values, [7], 'OFF colour map index');

		const h = OFF.read(encode('4OFF\n3 1 0\n0 0 0 2\n2 0 0 2\n0 2 0 2\n3 0 1 2\n'));
		vecs(meshOf(h).points, ['0,0,0', '1,0,0', '0,1,0'], '4OFF points');
		eq((meshOf(h).properties!.w as any).values, [2, 2, 2], '4OFF w');

		// binary: big-endian counts, then each vertex's floats (colour 4), each face's count, indices and colour
		const head = encode('COFF BINARY\n');
		const view = new DataView(new ArrayBuffer(head.length + 12 + 3 * 7 * 4 + 4 * 5 + 4 * 4));
		let o = head.length;
		const int = (v: number) => (view.setInt32(o, v), o += 4), float = (v: number) => (view.setFloat32(o, v), o += 4);
		[3, 1, 0].forEach(int);
		[[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach(p => [...p, 0, 0, 1, 1].forEach(float));
		[3, 0, 1, 2, 4].forEach(int);
		[1, 0, 0, 1].forEach(float);
		const bin = new Uint8Array(view.buffer);
		bin.set(head);
		const b = meshOf(OFF.read(bin));
		vecs(b.points, ['0,0,0', '1,0,0', '0,1,0'], 'binary OFF points');
		vecs(b.colors!.values, ['0,0,1,1', '0,0,1,1', '0,0,1,1'], 'binary OFF vertex colours');
		vecs([at(b.properties!.faceColor, 0)], ['1,0,0,1'], 'binary OFF face colour');
	}

	//--- OBJ and MTL ------------------------------------------------------------------------------------------------
	{
		const files: Record<string, Uint8Array> = {
			'a.mtl':			encode('newmtl red\nKd 1 0 0\nd 0.5\nNs 10\nillum 2\nmap_Kd -s 2 2 1 tex image.png\n'),
			'tex image.png':	new Uint8Array([1, 2, 3]),
		};
		const m = OBJ.read(encode([
			'mtllib a.mtl', 'v 0 0 0 1 0 0', 'v 1 0 0 0 1 0', 'v 0 1 0 0 0 1', 'v 1 1 0',
			'vt 0 0', 'vt 1 0', 'vt 0 1', 'vn 0 0 1',
			'o thing', 'g left right', 's 1', 'usemtl red', 'f 1/1/1 2/2/1 3/3/1',
			'g right', 's off', 'usemtl missing', 'f 2 4 \\', '3',
			'l 1 2 4', 'p 4', 'cstype bspline',
		].join('\n')), {file: name => files[name]});
		const mesh = meshOf(m);
		eq(m.materials.map(x => x.name), ['red', 'missing'], 'OBJ materials');
		vecs([m.materials[0].color], ['1,0,0,0.5'], 'MTL Kd and d');
		eq([m.materials[0].properties.Ns, m.materials[0].properties.illum], [10, 2], 'MTL numbers');
		eq((m.materials[0].properties.map_Kd as any).options, {s: ['2', '2', '1']}, 'MTL map options');
		eq([m.materials[0].texture, m.textures[0].path, [...m.textures[0].data!]], [0, 'tex image.png', [1, 2, 3]], 'MTL texture');
		eq(mesh.faceMaterials, [0, 1], 'OBJ usemtl');
		eq(corner(mesh.uvs, 0), ['0,0', '1,0', '0,1'], 'OBJ corner uvs');
		eq(corner(mesh.uvs, 1), ['none', 'none', 'none'], 'OBJ face without uvs');
		eq(corner(mesh.normals, 0), ['0,0,1', '0,0,1', '0,0,1'], 'OBJ corner normals');
		eq([0, 1, 2, 3].map(i => vec(at(mesh.colors, i))), ['1,0,0,1', '0,1,0,1', '0,0,1,1', 'undefined'], 'OBJ vertex colours');
		eq(mesh.faceSets, {object: {thing: [0, 1]}, group: {left: [0], right: [0, 1]}, smoothing: {1: [0]}}, 'OBJ face sets');
		eq([mesh.lines, mesh.vertices, mesh.faces[1]], [[[0, 1, 3]], [3], [1, 3, 2]], 'OBJ lines, points and a continued line');
		eq((m.extras.statements as any[]).map(s => s.keyword), ['cstype'], 'OBJ other statements');
	}

	//--- PLY --------------------------------------------------------------------------------------------------------
	{
		const m = PLY.read(encode([
			'ply', 'format ascii 1.0', 'comment TextureFile tex.png', 'comment made by me', 'obj_info author someone',
			'element vertex 3', ...['x', 'y', 'z', 'nx', 'ny', 'nz'].map(p => `property float ${p}`),
			'property uchar red', 'property uchar green', 'property uchar blue', 'property float s', 'property float t', 'property float quality',
			'element face 1', 'property list uchar int vertex_indices', 'property list uchar float texcoord', 'property int material_index',
			'property float red', 'property float green', 'property float blue',
			'element edge 1', 'property int vertex1', 'property int vertex2',
			'element material 1', 'property uchar diffuse_red', 'property uchar diffuse_green', 'property uchar diffuse_blue', 'property float specular_power',
			'end_header',
			'0 0 0 0 0 1 255 0 0 0 0 0.5', '1 0 0 0 0 1 0 255 0 1 0 0.25', '0 1 0 0 0 1 0 0 255 0 1 1',
			'3 0 1 2 6 0 0 1 0 0 1 0 0.5 0.5 0.5',
			'0 1',
			'255 0 0 20',
		].join('\n')), {file: name => name === 'tex.png' ? new Uint8Array([5]) : undefined});
		const mesh = meshOf(m);
		vecs(mesh.normals!.values, ['0,0,1', '0,0,1', '0,0,1'], 'PLY normals');
		vecs(mesh.colors!.values, ['1,0,0,1', '0,1,0,1', '0,0,1,1'], 'PLY uchar colours');
		vecs((mesh.properties!.faceColor as any).values, ['0.5,0.5,0.5,1'], 'PLY float face colour');
		eq(corner(mesh.uvs, 0), ['0,0', '1,0', '0,1'], 'PLY texcoord');
		vecs((mesh.properties!.vertexUV as any)?.values, ['0,0', '1,0', '0,1'], 'PLY vertex s, t beside texcoord');
		eq((mesh.properties!.quality as any).values, [0.5, 0.25, 1], 'PLY other property');
		eq([mesh.faceMaterials, mesh.lines], [[0], [[0, 1]]], 'PLY material_index and edges');
		vecs([m.materials[0].color], ['1,0,0,1'], 'PLY material element');
		eq(m.materials[0].properties.specular_power, 20, 'PLY material property');
		eq([m.textures[0].path, [...m.textures[0].data!]], ['tex.png', [5]], 'PLY TextureFile');
		eq([m.metadata.author, (m.extras.comments as string[]).length, (m.extras.elements as any[]).map(e => e.name)], ['someone', 2, ['vertex', 'face', 'edge', 'material']], 'PLY header');
	}

	//--- AMF --------------------------------------------------------------------------------------------------------
	{
		const c = (r: number, g: number, b: number) => `<color><r>${r}</r><g>${g}</g><b>${b}</b></color>`;
		const v = (x: number, y: number, z: number, extra = '') => `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates>${extra}</vertex>`;
		const t = (a: number, b: number, d: number, extra = '') => `<triangle><v1>${a}</v1><v2>${b}</v2><v3>${d}</v3>${extra}</triangle>`;
		const m = await AMF.read(encode(`<?xml version="1.0"?>
			<amf unit="inch" version="1.1"><metadata type="name">Doc</metadata>
			<material id="1"><metadata type="name">Steel</metadata>${c(0.5, 0.5, 0.5)}</material>
			<material id="2"><composite materialid="1">0.3</composite></material>
			<texture id="7" width="2" height="1" depth="1" type="grayscale">AAEC</texture>
			<object id="10"><metadata type="name">Tet</metadata>${c(0, 0, 1)}<mesh><vertices>
				${v(0, 0, 0, c(1, 0, 0))}${v(1, 0, 0)}${v(0, 1, 0, '<normal><nx>0</nx><ny>0</ny><nz>1</nz></normal>')}${v(0, 0, 1)}
				</vertices>
				<edges><edge><v1>0</v1><dx1>1</dx1><dy1>0</dy1><dz1>0</dz1><v2>1</v2><dx2>1</dx2><dy2>0</dy2><dz2>0</dz2></edge></edges>
				<volume materialid="1"><metadata type="name">base</metadata>${t(0, 2, 1, c(0, 1, 0))}${t(0, 1, 3, '<texmap rtexid="7" gtexid="7" btexid="7"><utex1>0</utex1><utex2>1</utex2><utex3>0</utex3><vtex1>0</vtex1><vtex2>0</vtex2><vtex3>1</vtex3></texmap>')}</volume>
				<volume>${t(0, 3, 2)}${t(1, 2, 3)}</volume>
			</mesh></object>
			<constellation id="20"><instance objectid="10"><deltax>10</deltax><rz>90</rz></instance></constellation>
			<constellation id="21"><instance objectid="20"><deltaz>5</deltaz></instance><instance objectid="10"/></constellation>
			</amf>`));
		const mesh = meshOf(m);
		eq([m.unit, m.metadata.name, m.extras.version], ['inch', 'Doc', '1.1'], 'AMF model');
		eq([m.materials[0].name, vec(m.materials[0].color), m.materials[1].properties.composites], ['Steel', '0.5,0.5,0.5,1', [{material: 0, formula: '0.3'}]], 'AMF materials');
		eq([...m.textures[0].data!], [0, 1, 2], 'AMF texture data');
		eq([m.objects[0].name, mesh.faceSets, mesh.faceMaterials], ['Tet', {volume: {base: [0, 1], 1: [2, 3]}}, [0, 0, -1, -1]], 'AMF volumes');
		// triangle colour, else vertex, else volume, else object
		eq(corner(mesh.colors, 0), ['0,1,0,1', '0,1,0,1', '0,1,0,1'], 'AMF triangle colour');
		eq(corner(mesh.colors, 2), ['1,0,0,1', '0,0,1,1', '0,0,1,1'], 'AMF vertex over object colour');
		eq(corner(mesh.uvs, 1), ['0,0', '1,0', '0,1'], 'AMF texmap');
		eq((mesh.properties!.texmap as any).values[1].rtexid, 0, 'AMF texmap texture');
		eq([0, 1, 2, 3].map(i => vec(at(mesh.normals, i))), ['undefined', 'undefined', '0,0,1', 'undefined'], 'AMF vertex normal');
		eq((m.objects[0].properties.edges as any[]).length, 1, 'AMF edges');
		eq([m.objects.length, m.build.map(b => b.object.properties.id)], [3, ['21']], 'AMF constellations');
		eq(placed(m.build).length, 2, 'AMF placed meshes');
		check(flatten(m).points.some(p => vec(p) === '10,1,5'), 'AMF nested instance: (1, 0, 0) turned 90 about z, moved 10 in x, then 5 in z');
	}

	//--- 3MF --------------------------------------------------------------------------------------------------------
	{
		const tet = (triangles: string, extra = '') => `<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles>${triangles}</triangles>${extra}</mesh>`;
		const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
		const data = await makeZip({
			'_rels/.rels': encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
				<Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
				<Relationship Target="/Metadata/thumb.png" Id="r1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
				</Relationships>`),
			'3D/3dmodel.model': encode(`<?xml version="1.0"?>
				<model unit="centimeter" xml:lang="en-US" ${NS} xmlns:mm="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
					xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02">
				<metadata name="Title">Test</metadata>
				<resources>
					<basematerials id="1"><base name="Red" displaycolor="#FF0000"/><base name="Blue" displaycolor="#0000FFFF"/></basematerials>
					<mm:colorgroup id="2"><mm:color color="#00FF00"/><mm:color color="#FFFFFF80"/></mm:colorgroup>
					<mm:texture2d id="3" path="/3D/Texture/t.png" contenttype="image/png" tilestyleu="wrap"/>
					<mm:texture2dgroup id="4" texid="3"><mm:tex2coord u="0" v="0"/><mm:tex2coord u="1" v="0"/><mm:tex2coord u="0" v="1"/></mm:texture2dgroup>
					<mm:compositematerials id="5" matid="1" matindices="0 1"><mm:composite values="1 3"/></mm:compositematerials>
					<mm:multiproperties id="6" pids="1 2"><mm:multi pindices="1 0"/></mm:multiproperties>
					<object id="10" name="Tet" pid="1" pindex="0" type="model" partnumber="PN">
						<metadatagroup><metadata name="Note">hi</metadata></metadatagroup>
						${tet('<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3" pid="2" p1="0" p2="1"/><triangle v1="0" v2="3" v3="2" pid="4" p1="0" p2="1" p3="2"/><triangle v1="1" v2="2" v3="3" pid="6" p1="0"/>',
							'<b:beamlattice radius="0.5" minlength="0.1"><b:beams><b:beam v1="0" v2="3" r1="0.2"/></b:beams><b:beamsets><b:beamset name="set"><b:ref index="0"/></b:beamset></b:beamsets></b:beamlattice>')}
					</object>
					<object id="11" name="Comp"><components><component objectid="10" transform="1 0 0 0 1 0 0 0 1 5 0 0"/><component objectid="20" p:path="/3D/other.model" p:UUID="u-1"/></components></object>
					<object id="12">${tet('<triangle v1="0" v2="2" v3="1" pid="5" p1="0"/>')}</object>
				</resources>
				<build p:UUID="b-1"><item objectid="11" partnumber="X" p:UUID="i-1"/><item objectid="12"/></build>
				</model>`),
			'3D/other.model': encode(`<model unit="centimeter" ${NS}><resources><object id="20" name="Other">${tet('<triangle v1="0" v2="2" v3="1"/>')}</object></resources><build/></model>`),
			'3D/Texture/t.png': new Uint8Array([9, 9]),
			'Metadata/thumb.png': new Uint8Array([8]),
		});
		const m = await ThreeMF.read(data);
		const tetObj = m.objects.find(o => o.name === 'Tet')!, mesh = tetObj.mesh!;
		eq([m.unit, m.metadata.Title], ['centimeter', 'Test'], '3MF model');
		eq(m.materials.map(x => vec(x.color)), ['1,0,0,1', '0,0,1,1', 'undefined', '0.25,0,0.75,1'], '3MF materials: base, texture group, composite mixed');
		eq([m.materials[2].texture, [...m.textures[0].data!], m.textures[0].contentType], [0, [9, 9], 'image/png'], '3MF texture');
		eq(mesh.faceMaterials, [0, -1, 2, 1], '3MF face materials (object default, texture group, multiproperties)');
		eq(corner(mesh.colors, 1), ['0,1,0,1', '1,1,1,0.502', '0,1,0,1'], '3MF colour group, p3 defaulting to p1');
		eq(corner(mesh.colors, 3), ['0,1,0,1', '0,1,0,1', '0,1,0,1'], '3MF multiproperties colour');
		eq(corner(mesh.uvs, 2), ['0,0', '1,0', '0,1'], '3MF texture coordinates');
		eq((mesh.properties!.pid as any).values, ['1', '2', '4', '6'], '3MF pids as written');
		eq([tetObj.metadata.Note, tetObj.properties.partnumber], ['hi', 'PN'], '3MF object metadata and attributes');
		const lattice = tetObj.properties.beamlattice as any;
		eq([mesh.lines, lattice.attributes.radius, lattice.beams[0].r1, lattice.beamsets[0].refs], [[[0, 3]], '0.5', '0.2', [0]], '3MF beam lattice');
		const comp = m.objects.find(o => o.name === 'Comp')!;
		eq([comp.children[1].object.name, comp.children[1].properties!['p:UUID'], vec(comp.children[0].transform!.w)], ['Other', 'u-1', '5,0,0'], '3MF components');
		eq([m.build.length, m.build[0].properties!.partnumber, m.build[0].properties!['p:UUID'], (m.extras.build as any)['p:UUID']], [2, 'X', 'i-1', 'b-1'], '3MF build');
		eq([[...(m.extras.thumbnail as any).data], m.objects.length], [[8], 4], '3MF thumbnail and objects');
		eq(placed(m.build).length, 3, '3MF placed meshes');
	}

	//--- DXF and DWG ------------------------------------------------------------------------------------------------
	{
		// entities as group codes and values; points as 10/20/30 (and 11..13/21..23/31..33 for the others)
		const pt = (n: number, [x, y, z]: number[]) => [10 + n, x, 20 + n, y, 30 + n, z];
		const entity = (type: string, ...groups: (string | number)[]) => [0, type, ...groups];
		const face = (corners: number[][], ...groups: (string | number)[]) => entity('3DFACE', 8, '0', ...groups, ...corners.flatMap((c, i) => pt(i, c)));
		const vertex = (flags: number, p: number[], ...groups: (string | number)[]) => entity('VERTEX', 8, 'red', 70, flags, ...pt(0, p), ...groups);
		const doc = [
			0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC',
			0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER',
			0, 'LAYER', 2, '0', 70, 0, 62, 7, 0, 'LAYER', 2, 'red', 70, 0, 62, 1,
			0, 'ENDTAB', 0, 'ENDSEC',
			0, 'SECTION', 2, 'BLOCKS',
			0, 'BLOCK', 8, '0', 2, 'tri', 70, 0, ...pt(0, [1, 0, 0]), ...face([[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 1, 0]]), 0, 'ENDBLK',
			0, 'ENDSEC',
			0, 'SECTION', 2, 'ENTITIES',
			...face([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], 70, 1).map(g => g === '0' ? 'red' : g),
			...face([[0, 0, 1], [1, 0, 1], [0, 1, 1], [0, 1, 1]], 62, 3),
			...face([[0, 0, 2], [1, 0, 2], [0, 1, 2], [0, 1, 2]], 420, 0x123456),
			...face([[0, 0, 3], [1, 0, 3], [0, 1, 3], [0, 1, 3]], 67, 1),
			...entity('POLYLINE', 8, 'red', 66, 1, 70, 64, 71, 4, 72, 1, ...pt(0, [0, 0, 0])),
			...[[0, 0, 4], [1, 0, 4], [1, 1, 4], [0, 1, 4]].flatMap(p => vertex(192, p)),
			...vertex(128, [0, 0, 0], 71, 1, 72, 2, 73, -3, 74, 4, 62, 5), 0, 'SEQEND',
			...entity('POLYLINE', 8, 'red', 66, 1, 70, 17, 71, 3, 72, 2, ...pt(0, [0, 0, 0])),
			...[[0, 0, 5], [0, 1, 5], [1, 0, 5], [1, 1, 5], [2, 0, 5], [2, 1, 5]].flatMap(p => vertex(64, p)), 0, 'SEQEND',
			...entity('POLYLINE', 8, 'red', 66, 1, 70, 9, ...pt(0, [0, 0, 0])),
			...[[0, 0, 6], [1, 0, 6], [0, 1, 6]].flatMap(p => vertex(32, p)), 0, 'SEQEND',
			...entity('LINE', 8, '0', ...pt(0, [0, 0, 7]), ...pt(1, [1, 0, 7])),
			...entity('INSERT', 8, '0', 2, 'tri', ...pt(0, [10, 0, 0]), 41, 2, 42, 2, 43, 2, 50, 90),
			...entity('INSERT', 8, '0', 2, 'tri', ...pt(0, [0, 20, 0]), 70, 2, 44, 5),
			...entity('CIRCLE', 8, '0', ...pt(0, [0, 0, 0]), 40, 1),
			0, 'ENDSEC', 0, 'EOF',
		].join('\n');
		const m = DXF.read(encode(doc));
		const model = m.objects[0], mesh = model.mesh!;
		eq([m.unit, model.name, m.objects.map(o => o.name)], ['millimeter', '*Model_Space', ['*Model_Space', 'tri', '*Paper_Space']], 'DXF objects');
		eq(mesh.faces.map(f => f.length), [4, 3, 3, 4, 4, 4, 4], 'DXF faces: 3DFACEs (a quad, triangles), polyface, closed 3x2 mesh');
		eq(mesh.faces.slice(3).map(f => f.map(i => vec(mesh.points[i]))), [
			['0,0,4', '1,0,4', '1,1,4', '0,1,4'],
			['0,0,5', '0,1,5', '1,1,5', '1,0,5'], ['1,0,5', '1,1,5', '2,1,5', '2,0,5'], ['2,0,5', '2,1,5', '0,1,5', '0,0,5'],
		], 'DXF polyface and polygon mesh corners');
		eq(mesh.faces.map((_, i) => vec(at(mesh.colors, i))), ['1,0,0,1', '0,1,0,1', '0.0706,0.2039,0.3373,1', '0,0,1,1', '1,0,0,1', '1,0,0,1', '1,0,0,1'],
			'DXF colours: BYLAYER, ACI, true colour, a polyface face record\'s own');
		eq((mesh.properties!.invisibleEdges as any).values, [1, 0, 0, 4, 0, 0, 0], 'DXF invisible edges');
		eq(mesh.faceSets!.layer, {red: [0, 3, 4, 5, 6], 0: [1, 2]}, 'DXF layers');
		eq(mesh.lines!.map(l => l.map(i => vec(mesh.points[i]))), [['0,0,6', '1,0,6', '0,1,6', '0,0,6'], ['0,0,7', '1,0,7']], 'DXF 3D polyline (closed) and LINE');
		eq([model.children.length, (m.extras.entities as any).CIRCLE], [3, 1], 'DXF inserts (a 2x1 MINSERT is two) and what is not mesh');
		eq(m.objects[2].mesh!.faces.length, 1, 'DXF paper space, not built');
		// tri's base point to the origin, scaled 2, turned 90, moved to (10, 0, 0); the MINSERT's second cell 5 along x
		const flat = flatten(m).points.map(vec);
		check(['10,0,0', '10,2,0', '8,0,0'].every(p => flat.includes(p)), `DXF insert transform: ${flat.slice(-9)}`);
		check(['5,20,0', '6,20,0', '5,21,0'].every(p => flat.includes(p)), 'DXF MINSERT cell');

		// a DWG of the same drawing gives what its DXF does
		const dir = '/Volumes/DevSSD/dev/github/libredwg/test/test-data';
		if (existsSync(`${dir}/example_2004.dwg`)) {
			const [a, b] = [DXF.read(readFileSync(`${dir}/example_2004.dxf`)), await DWG.read(readFileSync(`${dir}/example_2004.dwg`))];
			const shape = (x: Model) => [x.unit, placed(x.build).length, flatten(x).faces.length, flatten(x).points.map(vec).sort(),
				x.objects[0].mesh!.faces.map((_, i) => vec(at(x.objects[0].mesh!.colors, i)))];
			eq(shape(b), shape(a), 'DWG as its DXF');
		}
	}

	console.log(bad ? `${bad} of ${checks} failed` : `all information read (${checks} checks)`);
	process.exitCode = bad ? 1 : 0;
})();
