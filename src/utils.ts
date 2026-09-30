import { float3, float4 } from '@isopodlabs/maths/vector';

export function lines(text: string) {
	return text.split(/\r?\n/).map(l => l.trim());
}

export function numbers(words: string[]) {
	return words.map(Number);
}

export function point(x: number, y: number, z: number, what: string): float3 {
	if (!Number.isFinite(x + y + z))
		throw new Error(`${what} has a coordinate that is not a number`);
	return float3(x, y, z);
}

export function checkIndices(faces: number[][], count: number, what: string) {
	if (faces.some(f => f.some(i => !(Number.isInteger(i) && i >= 0 && i < count))))
		throw new Error(`${what} has a face index out of range`);
}

export const text	= (data: Uint8Array) => new TextDecoder().decode(data);
export const encode	= (s: string) => new TextEncoder().encode(s);

// true when data begins with the ASCII string
export function startsWith(data: Uint8Array, s: string) {
	return data.length >= s.length && [...s].every((c, i) => data[i] === c.charCodeAt(0));
}

// #RRGGBB or #RRGGBBAA, as 3MF writes colours
export function hexColor(s: string, what: string): float4 {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s.trim());
	if (!m)
		throw new Error(`${what} colour that cannot be read: '${s}'`);
	const n = parseInt(m[1], 16);
	return float4((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1);
}

// components of 0..255 when any is above 1 (as integer colours are written), otherwise already 0..1; alpha 1 if absent
export function color(c: number[]): float4 {
	const s = c.some(v => v > 1) ? 1 / 255 : 1;
	return float4(c[0] * s, c[1] * s, c[2] * s, c.length > 3 ? c[3] * s : 1);
}

// each value's index in a palette of the distinct ones, by key, so repeated values are stored once
export function palette<T>(values: T[], key: (v: T) => string) {
	const map = new Map<string, number>(), unique: T[] = [];
	const indices = values.map(v => {
		const k = key(v);
		if (!map.has(k)) {
			map.set(k, unique.length);
			unique.push(v);
		}
		return map.get(k)!;
	});
	return {values: unique, indices};
}

export const colorKey = (c: float4) => `${c.x},${c.y},${c.z},${c.w}`;

export function base64(s: string) {
	return new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'base64'));
}
