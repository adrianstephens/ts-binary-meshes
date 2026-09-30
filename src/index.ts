export * from './common';
export { STL } from './stl';
export { OFF } from './off';
export { OBJ, readMtl, type Statement } from './obj';
export { PLY } from './ply';
export { AMF } from './amf';
export { ThreeMF } from './threemf';
export { DXF, DWG } from './cad';

import { Format } from './common';
import { STL } from './stl';
import { OFF } from './off';
import { OBJ } from './obj';
import { PLY } from './ply';
import { AMF } from './amf';
import { ThreeMF } from './threemf';
import { DXF, DWG } from './cad';

export const formats: Format[] = [STL, OFF, OBJ, PLY, AMF, ThreeMF, DXF, DWG];

// by extension (with its dot, any case)
export function formatOf(ext: string) {
	return formats.find(f => f.extensions.includes(ext.toLowerCase()));
}
