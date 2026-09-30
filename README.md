# Binary Meshes
[![npm version](https://img.shields.io/npm/v/@isopodlabs/binary_meshes.svg)](https://www.npmjs.com/package/@isopodlabs/binary_meshes)
[![GitHub stars](https://img.shields.io/github/stars/adrianstephens/ts-binary-meshes.svg?style=social)](https://github.com/adrianstephens/ts-binary-meshes)
[![License](https://img.shields.io/npm/l/@isopodlabs/binary_meshes.svg)](LICENSE.txt)

This package reads and writes 3D mesh formats, using the @isopodlabs/binary, @isopodlabs/binary_archives and
@isopodlabs/xml libraries.

## ☕ Support My Work
If you use this package, consider [buying me a cup of tea](https://coff.ee/adrianstephens) to support future updates!

## Usage

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { formatOf, flatten, placed, STL, OBJ } from '@isopodlabs/binary_meshes';

// everything in the file: objects and how they are placed, materials, textures, per-vertex/face/corner attributes
const model = await formatOf('.3mf')!.read(new Uint8Array(fs.readFileSync('part.3mf')));
for (const {mesh, transform} of placed(model.build))
    draw(mesh, transform, model.materials);

// an OBJ's .mtl (and texture images) are read through a callback
const obj = OBJ.read(bytes, {file: name => fs.readFileSync(path.join(dir, name))});

// or just the geometry of what the file builds, as one mesh
const mesh = await formatOf('.3mf')!.load(bytes);        // = flatten(await read(bytes))
fs.writeFileSync('part.stl', STL.save(mesh));
```

`read` and `load` return a `Promise` for AMF and 3MF (either can be zipped); the others return directly. Malformed
files throw an `Error` saying what is wrong with them.

## Supported File Types

| Format | Extensions | Read | Write |
|---|---|---|---|
| STL | `.stl` | binary and ASCII | binary (`save`), ASCII (`saveText`) |
| OFF | `.off` | text and binary, with the `ST`, `C`, `N`, `4` and `n` prefixes | text, with vertex colours |
| OBJ | `.obj` | every statement; `.mtl` materials through `options.file` | `v` and `f` lines |
| PLY | `.ply` | ASCII, binary little- and big-endian; every element and property | binary little-endian |
| AMF | `.amf` | plain or zipped; objects, volumes, materials, textures, constellations | plain |
| 3MF | `.3mf` | core, materials, production and beam lattice extensions; every part of the package | one object |

Writers take a `Mesh`'s geometry (and OFF its vertex colours). STL, AMF and 3MF are written as triangles cut by ear
clipping, so concave faces come out right.

## What each format's `read` gives

- **STL**: binary: the header's text as `metadata.header` (its bytes as `extras.header`); the facets' normals as face
  normals; each facet's attribute word as `properties.attributes`; colours from it by the Materialise convention
  (`COLOR=` in the header, its default as `extras.color`, and `MATERIAL=` as a material) or the VisCAM/SolidView one.
  ASCII: an object per `solid`, with its name and facet normals.
- **OFF**: per-vertex normals, colours and texture coordinates as the prefixes say; face colours (or a colour map
  index, `properties.colorMapIndex`); 4OFF's `w` and nOFF's coordinates in `properties`; the header's edge count.
- **OBJ**: `vt` and `vn` as per-corner uvs and normals; vertex colours (`v x y z r g b`); `usemtl` per face; `o`, `g` and
  `s` as face sets; `l` as lines, `p` as vertices; `w` components in `properties`. `.mtl` statements are kept by keyword
  in each material's `properties` (maps with their options), `Kd`/`d` as its colour and `map_Kd` as its texture (see
  also `readMtl`). Every other statement (curves, surfaces, `vp`, ...) is in `extras.statements` as written.
- **PLY**: every element with its properties' types and data (`extras.elements`), the comments and `obj_info` lines;
  normals, colours and uvs by their usual names, `texcoord` lists as corner uvs, `material_index`, `edge` elements as
  lines, `material` elements as materials, `TextureFile` comments as textures; any other vertex or face property in
  the mesh's `properties`.
- **AMF**: an object per `object` (its volumes as one mesh, a face set each, their materials per face; colours per
  corner from triangle, vertex, volume or object; `texmap` coordinates; vertex normals; curved-edge tangents), and per
  `constellation` (its instances as children, placed by their deltas and rotations); materials with metadata and
  composites; textures decoded. `extras.xml` is the whole document.
- **3MF**: every object of every model part, with its attributes, metadata group and components (with their
  transforms and production attributes); base materials, composites (their colour mixed) and texture groups as
  materials, colour groups as per-corner colours, texture coordinates as corner uvs, multiproperties resolved through
  their layers, and each triangle's `pid`/`p1..p3` as written; beam lattices as lines and `properties.beamlattice`.
  `extras`: the model and build attributes, every relationship, the thumbnail, every part's bytes, and every model
  part's XML (less the elements read into meshes) for anything else, such as slices.

## API

### Model

```typescript
interface Model {
    unit?:      string;                     // what a coordinate is measured in, when the file says; nothing is scaled by it
    metadata:   Record<string, string>;
    materials:  Material[];
    textures:   Texture[];
    objects:    Object3D[];                 // every object the file defines, placed or not
    build:      Instance[];                 // what the file is a model of
    extras:     Record<string, unknown>;    // everything format-specific (see above)
}
interface Object3D {
    name?:      string;
    mesh?:      Mesh;
    children:   Instance[];                 // other objects placed within this one
    metadata:   Record<string, string>;
    properties: Record<string, unknown>;
}
interface Instance {                        // an object placed by a transform; an object may be placed any number of times
    object:     Object3D;
    transform?: float3x4;
    properties?: Record<string, unknown>;
}
interface Material {
    name?:      string;
    color?:     float4;                     // r, g, b, a, 0..1
    texture?:   number;                     // index into Model.textures
    properties: Record<string, unknown>;
}
interface Texture {
    path?:      string;
    data?:      Uint8Array;
    contentType?: string;
    properties: Record<string, unknown>;
}
```

### Mesh

```typescript
interface Mesh {
    points:         float3[];               // float2/3/4 and float3x4 from @isopodlabs/maths/vector
    faces:          number[][];             // each a loop of indices into points, anticlockwise seen from outside
    lines?:         number[][];
    vertices?:      number[];
    normals?:       Attribute<float3>;
    colors?:        Attribute<float4>;
    uvs?:           Attribute<float2>;
    faceMaterials?: number[];               // per face, index into Model.materials, -1 for none
    faceSets?:      Record<string, Record<string, number[]>>;   // e.g. {group: {wheels: [0, 1]}}
    properties?:    Record<string, Attribute<unknown>>;          // anything else, by the file's name for it
}

// per vertex or face: values parallel to points or faces, or indices into values (-1 for none);
// per corner: an index loop per face, parallel to its corners
type Attribute<T> =
    | {per: 'vertex' | 'face', values: T[], indices?: number[]}
    | {per: 'corner', values: T[], indices: number[][]};
```

### Format

```typescript
interface Format {
    extensions: string[];
    check(data: Uint8Array): boolean;
    read(data: Uint8Array, options?: ReadOptions): Model | Promise<Model>;
    load(data: Uint8Array, options?: ReadOptions): Mesh | Promise<Mesh>;
    save?(mesh: Mesh): Uint8Array | Promise<Uint8Array>;
}
interface ReadOptions {
    file?(name: string): Uint8Array | undefined;    // another file the one being read names: an .mtl, a texture image
}
```

Also `STL.saveText(mesh, name?)`, `AMF.readText(data)` (an uncompressed AMF, synchronously), and `readMtl(data,
textures, options?)`.

### Functions

```typescript
const formats: Format[];
function formatOf(ext: string): Format | undefined;        // '.stl', any case
function placed(instances: Instance[]): {mesh: Mesh, transform: float3x4}[];  // every mesh placed, transforms composed
function flatten(model: Model): Mesh;                       // the geometry of the build, as one mesh
function modelOf(mesh: Mesh, name?: string): Model;
function triangles(mesh: Mesh): number[][];                 // every face cut into triangles
function faceNormal(mesh: Mesh, face: number[]): float3;    // unit, concave faces too; zero for a face of no area
function bounds(mesh: Mesh): {min: float3, max: float3} | undefined;
function transform(mesh: Mesh, m: float3x4): Mesh;          // the geometry moved
function merge(meshes: Mesh[]): Mesh;                       // the geometry of all, as one
```

## License

This project is licensed under the MIT License.
