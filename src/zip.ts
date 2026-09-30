import * as bin from '@isopodlabs/binary';
import { zip } from '@isopodlabs/binary_archives';

export async function openZip(data: Uint8Array) {
	const doc = new zip.Document(new bin.stream(data));
	await doc.ready;
	return doc;
}

// a file in the archive, by a path that may start with '/' (as package relationships write them)
export async function extract(doc: zip.Document, path: string) {
	const entry = doc.findEntry(path.replace(/^\//, ''));
	if (!entry)
		throw new Error(`archive has no '${path}'`);
	const data = await entry.extract();
	if (!data)
		throw new Error(`archive's '${path}' is compressed by a method that cannot be read`);
	return data;
}

export async function makeZip(files: Record<string, Uint8Array>) {
	const doc = new zip.Document();
	for (const [name, data] of Object.entries(files))
		doc.addEntry(name, data);
	const s = new bin.growingStream();
	await doc.writeAll(s);
	return s.terminate();
}
