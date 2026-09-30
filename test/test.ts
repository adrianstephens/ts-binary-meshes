import { float3 } from '@isopodlabs/maths/vector';
import { Mesh, formats, formatOf, flatten, triangles, faceNormal, bounds, STL, OFF, OBJ, PLY, AMF, ThreeMF } from '../dist/index';
import { makeZip } from '../dist/zip';

let bad = 0;
function check(ok: boolean, msg: string) {
	if (!ok) {
		console.log(`FAIL: ${msg}`);
		bad++;
	}
}

const encode = (s: string) => new TextEncoder().encode(s);

function volume(mesh: Mesh) {
	return triangles(mesh).reduce((v, [a, b, c]) => v + mesh.points[a].dot(mesh.points[b].cross(mesh.points[c])), 0) / 6;
}

// 2 x 3 x 4 box at (1, 1, 1), quads anticlockwise from outside
const P = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4]];
const box: Mesh = {
	points: P.map(([x, y, z]) => float3(x + 1, y + 1, z + 1)),
	faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
};

function same(mesh: Mesh, what: string, vol = 24, lo = [1, 1, 1], hi = [3, 4, 5]) {
	const b = bounds(mesh)!;
	check(Math.abs(volume(mesh) - vol) < 1e-4, `${what}: volume ${volume(mesh)}, expected ${vol}`);
	check([b.min.x, b.min.y, b.min.z].every((v, i) => Math.abs(v - lo[i]) < 1e-5) && [b.max.x, b.max.y, b.max.z].every((v, i) => Math.abs(v - hi[i]) < 1e-5),
		`${what}: bounds ${JSON.stringify(b)}`);
}

async function throws(f: () => unknown, what: string) {
	try {
		await f();
		check(false, `${what}: did not throw`);
	} catch {}
}

(async () => {
	for (const f of formats) {
		const saved = await f.save!(box);
		check(f.check(saved), `${f.extensions[0]}: check of its own output`);
		check(formatOf(f.extensions[0].toUpperCase()) === f, `${f.extensions[0]}: formatOf`);
		same(await f.load(saved), `${f.extensions[0]} round trip`);
	}
	same(STL.load(STL.saveText(box)), 'ascii STL');
	same(flatten(AMF.readText(AMF.save(box))), 'AMF text');
	same(await AMF.load(await makeZip({'box.amf': AMF.save(box)})), 'zipped AMF');

	// OBJ: negative indices and v/vt/vn
	same(OBJ.load(encode(OBJ.save(box).toString() && [
		...box.points.map(p => `v ${p.x} ${p.y} ${p.z}`),
		'vt 0 0',
		'vn 0 0 1',
		...box.faces.map(f => `f ${f.map(i => `${i - 8}/1/1`).join(' ')}`),
	].join('\n'))), 'OBJ negative indices');

	// OFF: comments, counts on the magic line, colour after a face
	same(OFF.load(encode([
		'OFF 8 6 0 # box',
		...box.points.map(p => `${p.x} ${p.y} ${p.z}`),
		...box.faces.map((f, i) => `4 ${f.join(' ')}${i === 0 ? ' 255 0 0' : ''}`),
	].join('\n'))), 'OFF with comments');

	// PLY: ascii with an extra property and element; big-endian binary from the little-endian writer's bytes
	same(PLY.load(encode([
		'ply', 'format ascii 1.0', 'comment hi', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red',
		'element face 6', 'property list uchar int vertex_index', 'element edge 0', 'property int vertex1', 'end_header',
		...box.points.map(p => `${p.x} ${p.y} ${p.z} 7`),
		...box.faces.map(f => `4 ${f.join(' ')}`),
	].join('\n'))), 'ascii PLY');
	const header = 'ply\nformat binary_big_endian 1.0\nelement vertex 8\nproperty double x\nproperty double y\nproperty double z\nelement face 6\nproperty list uchar ushort vertex_indices\nend_header\n';
	const be = new DataView(new ArrayBuffer(header.length + 8 * 24 + 6 * 9));
	let at = header.length;
	box.points.forEach(p => [p.x, p.y, p.z].forEach(v => (be.setFloat64(at, v), at += 8)));
	box.faces.forEach(f => (be.setUint8(at++, 4), f.forEach(i => (be.setUint16(at, i), at += 2))));
	const beBytes = new Uint8Array(be.buffer);
	beBytes.set(encode(header));
	same(PLY.load(beBytes), 'big-endian PLY');

	// 3MF: one object used twice through a component, each placed by a transform; the second copy mirrored in x, so
	// its winding (and volume) comes out negative and cancels the first
	const vertices = box.points.map(p => `<vertex x="${p.x}" y="${p.y}" z="${p.z}"/>`).join('');
	const tris = triangles(box).map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
	const threemf = (build: string) => makeZip({
		'_rels/.rels': encode(`<Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
		'3D/3dmodel.model': encode(`<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
			<object id="1"><mesh><vertices>${vertices}</vertices><triangles>${tris}</triangles></mesh></object>
			<object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>
			</resources><build>${build}</build></model>`),
	});
	const moved = await ThreeMF.load(await threemf('<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 100"/>'));
	same(moved, '3MF component and item transforms', 24, [11, 1, 101], [13, 4, 105]);
	const unit = (await ThreeMF.read(await threemf('<item objectid="1"/>'))).unit;
	check(unit === 'inch', `3MF unit ${unit}`);
	same(await ThreeMF.load(await threemf('<item objectid="1"/><item objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/>')), '3MF scaled second item', 72, [1, 1, 1], [6, 4, 5]);

	// a concave face, in the y-z plane, starting where a fan would cut outside it: every triangle wound as the face is,
	// covering its area exactly once
	{
		const L = [[10, 4], [4, 4], [4, 10], [0, 10], [0, 0], [10, 0]];
		const mesh: Mesh = {points: L.map(([y, z]) => float3(7, y, z)), faces: [L.map((_, i) => i)]};
		const areas = triangles(mesh).map(([a, b, c]) => mesh.points[b].sub(mesh.points[a]).cross(mesh.points[c].sub(mesh.points[a])).x / 2);
		const n = faceNormal(mesh, mesh.faces[0]);
		check(n.x === 1 && n.y === 0 && n.z === 0, `concave face normal ${[n.x, n.y, n.z]}`);
		check(areas.length === 4 && areas.every(a => a > 0) && Math.abs(areas.reduce((s, a) => s + a) - 64) < 1e-9, `concave face triangles: areas ${areas}`);
	}

	await throws(() => OFF.load(encode('OFF\n1 1 0\n0 0 0\n3 0 1 2')), 'OFF index out of range');
	await throws(() => OBJ.load(encode('v 0 0 0\nf 1 2 3')), 'OBJ index out of range');
	await throws(() => STL.load(encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\n')), 'STL without endsolid');
	await throws(() => PLY.load(encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n')), 'PLY without y, z');
	await throws(() => AMF.readText(encode('<notamf/>')), 'not AMF');
	await throws(async () => ThreeMF.load(await makeZip({'x': encode('')})), '3MF with no rels');

	console.log(bad ? `${bad} failed` : 'all passed');
	process.exitCode = bad ? 1 : 0;
})();
