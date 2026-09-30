import { float2, float3, float4 } from '@isopodlabs/maths/vector';
import { Mesh, Model, Material, Texture, ReadOptions, Attribute, modelOf, flatten } from './common';
import { point, text, encode } from './utils';

export interface Statement {
	keyword:	string;
	args:		string[];
	line:		number;		// 1-based, in the file it is in
}

// statements, one per line, a trailing backslash continuing a line and # starting a comment
function statements(s: string): Statement[] {
	const out: Statement[] = [];
	let pending = '', start = 0;
	s.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.replace(/#.*$/, '');
		if (!pending)
			start = i + 1;
		if (line.trimEnd().endsWith('\\')) {
			pending += line.trimEnd().slice(0, -1) + ' ';
			return;
		}
		const words = (pending + line).trim().split(/\s+/);
		pending = '';
		if (words[0])
			out.push({keyword: words[0], args: words.slice(1), line: start});
	});
	return out;
}

const MAP_OPTIONS: Record<string, number> = {'-blendu': 1, '-blendv': 1, '-bm': 1, '-boost': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-type': 1};

// a map statement's options (each with its values) and file name, which may contain spaces
function mapOf(args: string[]) {
	const options: Record<string, string[]> = {};
	let i = 0;
	while (i < args.length && args[i] in MAP_OPTIONS) {
		const n = MAP_OPTIONS[args[i]];
		options[args[i].slice(1)] = args.slice(i + 1, i + 1 + n);
		i += 1 + n;
	}
	return {file: args.slice(i).join(' '), options};
}

const isNumbers = (args: string[]) => args.length > 0 && args.every(a => a !== '' && Number.isFinite(Number(a)));

// Materials in MTL form: each statement kept in properties by its keyword (numbers as numbers, a map as {file,
// options, texture}), Kd (with d, or 1 - Tr, as alpha) as the colour and map_Kd as the texture.
export function readMtl(data: Uint8Array, textures: Texture[], options?: ReadOptions): Material[] {
	const materials: Material[] = [];
	const textureOf = (file: string) => {
		const found = textures.findIndex(t => t.path === file);
		return found >= 0 ? found : textures.push({path: file, data: options?.file?.(file), properties: {}}) - 1;
	};
	for (const {keyword, args} of statements(text(data))) {
		if (keyword === 'newmtl') {
			materials.push({name: args.join(' '), properties: {}});
		} else if (materials.length) {
			const m = materials.at(-1)!;
			if (/^(map_|bump$|disp$|decal$|refl$|norm$)/.test(keyword)) {
				const map = mapOf(args);
				m.properties[keyword] = {...map, texture: textureOf(map.file)};
			} else {
				m.properties[keyword] = isNumbers(args) ? (args.length === 1 ? Number(args[0]) : args.map(Number)) : args.join(' ');
			}
		}
	}
	for (const m of materials) {
		const kd = m.properties.Kd, d = m.properties.d, tr = m.properties.Tr;
		if (Array.isArray(kd) && kd.length >= 3)
			m.color = float4(kd[0], kd[1], kd[2], typeof d === 'number' ? d : typeof tr === 'number' ? 1 - tr : 1);
		const map = m.properties.map_Kd as {texture: number} | undefined;
		if (map)
			m.texture = map.texture;
	}
	return materials;
}

function read(data: Uint8Array, options?: ReadOptions): Model {
	const points: float3[] = [], vcolors: float4[] = [], ws: number[] = [];
	const uvs: float2[] = [], uvws: number[] = [], normals: float3[] = [];
	const faces: number[][] = [], faceUV: number[][] = [], faceN: number[][] = [], faceMaterials: number[] = [];
	const lines: number[][] = [], lone: number[] = [];
	const sets: Record<string, Record<string, number[]>> = {object: {}, group: {}, smoothing: {}};
	const materials: Material[] = [], textures: Texture[] = [], libraries: string[] = [], unparsed: Statement[] = [];
	let material = -1, groups = ['default'], object: string | undefined, smoothing: string | undefined;

	// an index as written, 1-based or negative from the end, made 0-based; NaN (absent) is -1
	const index = (s: string | undefined, count: number, what: string) => {
		if (!s)
			return -1;
		const i = parseInt(s);
		const j = i < 0 ? count + i : i - 1;
		if (!(j >= 0 && j < count))
			throw new Error(`OBJ ${what} index out of range: '${s}'`);
		return j;
	};
	const materialNamed = (name: string) => {
		const found = materials.findIndex(m => m.name === name);
		return found >= 0 ? found : materials.push({name, properties: {}}) - 1;
	};
	const addTo = (kind: string, name: string | undefined, face: number) => {
		if (name !== undefined)
			(sets[kind][name] ??= []).push(face);
	};

	for (const st of statements(text(data))) {
		const {keyword, args} = st;
		const n = args.map(Number);
		switch (keyword) {
			case 'v':
				// x y z, with w, or with r g b (and a) as many writers add
				points.push(point(n[0], n[1], n[2], `OBJ vertex on line ${st.line}`));
				if (args.length === 4)
					ws[points.length - 1] = n[3];
				if (args.length >= 6)
					vcolors[points.length - 1] = float4(n[3], n[4], n[5], args.length > 6 ? n[6] : 1);
				break;
			case 'vt':
				uvs.push(float2(n[0], args.length > 1 ? n[1] : 0));
				if (args.length > 2)
					uvws[uvs.length - 1] = n[2];
				break;
			case 'vn':
				normals.push(float3(n[0], n[1], n[2]));
				break;
			case 'f': {
				const corners = args.map(a => a.split('/'));
				const face = faces.length;
				faces.push(corners.map(c => index(c[0], points.length, 'vertex')));
				faceUV.push(corners.map(c => index(c[1], uvs.length, 'texture')));
				faceN.push(corners.map(c => index(c[2], normals.length, 'normal')));
				faceMaterials.push(material);
				groups.forEach(g => addTo('group', g, face));
				addTo('object', object, face);
				addTo('smoothing', smoothing, face);
				break;
			}
			case 'l':
				lines.push(args.map(a => index(a.split('/')[0], points.length, 'vertex')));
				break;
			case 'p':
				lone.push(...args.map(a => index(a, points.length, 'vertex')));
				break;
			case 'o':
				object = args.join(' ');
				break;
			case 'g':
				groups = args.length ? args : ['default'];
				break;
			case 's':
				smoothing = args[0] === 'off' || args[0] === '0' ? undefined : args[0];
				break;
			case 'usemtl':
				material = materialNamed(args.join(' '));
				break;
			case 'mtllib':
				for (const file of args) {
					libraries.push(file);
					const bytes = options?.file?.(file);
					if (bytes)
						readMtl(bytes, textures, options).forEach(m => {
							const at = materials.findIndex(x => x.name === m.name);
							if (at >= 0)
								materials[at] = m;
							else
								materials.push(m);
						});
				}
				break;
			default:
				unparsed.push(st);
		}
	}

	const mesh: Mesh = {points, faces};
	if (faceUV.some(l => l.some(i => i >= 0)))
		mesh.uvs = {per: 'corner', values: uvs, indices: faceUV};
	if (faceN.some(l => l.some(i => i >= 0)))
		mesh.normals = {per: 'corner', values: normals, indices: faceN};
	if (vcolors.length) {
		let n = 0;
		mesh.colors = {per: 'vertex', values: vcolors.filter(c => c), indices: points.map((_, i) => vcolors[i] ? n++ : -1)};
	}
	if (faceMaterials.some(m => m >= 0))
		mesh.faceMaterials = faceMaterials;
	if (lines.length)
		mesh.lines = lines;
	if (lone.length)
		mesh.vertices = lone;
	mesh.faceSets = Object.fromEntries(Object.entries(sets).filter(([, v]) => Object.keys(v).length));
	const properties: Record<string, Attribute<unknown>> = {};
	if (ws.length)
		properties.w = {per: 'vertex', values: points.map((_, i) => ws[i] ?? 1)};
	if (uvws.length)
		properties.uvw = {per: 'corner', values: uvs.map((_, i) => uvws[i] ?? 0), indices: faceUV};
	if (Object.keys(properties).length)
		mesh.properties = properties;

	const model		= modelOf(mesh);
	model.materials	= materials;
	model.textures	= textures;
	model.extras	= {libraries, statements: unparsed};
	return model;
}

export const OBJ = {
	extensions: ['.obj'],
	check(data: Uint8Array) {
		return statements(text(data.subarray(0, 4096))).some(s => /^(v|vt|vn|f|o|g|mtllib)$/.test(s.keyword));
	},
	// One mesh: vt and vn as per-corner uvs and normals, a v's colour (x y z r g b) per vertex, usemtl per face, o, g and
	// s as faceSets object, group and smoothing; l as lines and p as vertices. properties.w a v's w, properties.uvw a vt's
	// w. mtllib files are read through options.file, their maps' images too (see readMtl); extras.libraries names them.
	// extras.statements holds every other statement (curves, surfaces, vp, ...) as written.
	read(data: Uint8Array, options?: ReadOptions): Model {
		return read(data, options);
	},
	load(data: Uint8Array, options?: ReadOptions): Mesh {
		return flatten(OBJ.read(data, options));
	},
	save(mesh: Mesh): Uint8Array {
		return encode([
			...mesh.points.map(p => `v ${p.x} ${p.y} ${p.z}`),
			...mesh.faces.map(f => `f ${f.map(i => i + 1).join(' ')}`),
			''
		].join('\n'));
	},
};
