import {assert, drop, int, nonnull} from './base.js';
import {Color, Tensor2, Tensor3, Vec3} from './base.js';
import {EntityComponentSystem} from './ecs.js';
import {Renderer, Texture, InstancedMesh, VoxelMesh} from './renderer.js';
import {TerrainMesher} from './mesher.js';
import {kSweepResolution, sweep} from './sweep.js';

//////////////////////////////////////////////////////////////////////////////

type Input = 'up' | 'left' | 'down' | 'right' | 'hover' | 'call' |
             'mouse0' | 'mouse1' | 'space' | 'pointer';

interface KeyBinding {input: Input, handled: boolean};

class Container {
  element: Element;
  canvas: HTMLCanvasElement;
  stats: Element | null;
  bindings: Map<int, KeyBinding>;
  inputs: Record<Input, boolean>;
  deltas: {x: int, y: int, scroll: int};

  constructor(id: string) {
    this.element = nonnull(document.getElementById(id), () => id);
    this.canvas = nonnull(this.element.querySelector('canvas'));
    this.stats = document.getElementById('stats');
    this.inputs = {
      up: false,
      left: false,
      down: false,
      right: false,
      hover: false,
      call: false,
      space: false,
      mouse0: false,
      mouse1: false,
      pointer: false,
    };
    this.deltas = {x: 0, y: 0, scroll: 0};

    this.bindings = new Map();
    this.addBinding('W', 'up');
    this.addBinding('A', 'left');
    this.addBinding('S', 'down');
    this.addBinding('D', 'right');
    this.addBinding('E', 'hover');
    this.addBinding('Q', 'call');
    this.addBinding(' ', 'space');

    const canvas = this.canvas;
    const target = nonnull(this.canvas.parentElement);
    target.addEventListener('click', (e: Event) => {
      if (this.inputs.pointer) return;
      this.onMimicPointerLock(e, true);
      this.insistOnPointerLock();
    });

    document.addEventListener('keydown', e => this.onKeyInput(e, true));
    document.addEventListener('keyup', e => this.onKeyInput(e, false));
    document.addEventListener('mousedown', e => this.onMouseDown(e));
    document.addEventListener('mousemove', e => this.onMouseMove(e));
    document.addEventListener('touchmove', e => this.onMouseMove(e));
    document.addEventListener('pointerlockchange', e => this.onPointerInput(e));
    document.addEventListener('wheel', e => this.onMouseWheel(e));
  }

  displayStats(stats: string): void {
    if (this.stats) this.stats.textContent = stats;
  }

  private addBinding(key: string, input: Input): void {
    assert(key.length === 1);
    this.bindings.set(int(key.charCodeAt(0)), {input, handled: false});
  }

  private insistOnPointerLock(): void {
    if (!this.inputs.pointer) return;
    if (document.pointerLockElement === this.canvas) return;
    this.canvas.requestPointerLock();
    setTimeout(() => this.insistOnPointerLock(), 100);
  }

  private onKeyInput(e: Event, down: boolean): void {
    if (!this.inputs.pointer) return;
    const keycode = int((e as KeyboardEvent).keyCode);
    if (keycode === 27) return this.onMimicPointerLock(e, false);
    const binding = this.bindings.get(keycode);
    if (!binding || binding.handled === down) return;
    this.onInput(e, binding.input, down);
    binding.handled = down;
  }

  private onMouseDown(e: Event): void {
    if (!this.inputs.pointer) return;
    const button = (e as MouseEvent).button;
    if (button === 0) this.inputs.mouse0 = true;
    if (button !== 0) this.inputs.mouse1 = true;
  }

  private onMouseMove(e: Event): void {
    if (!this.inputs.pointer) return;
    this.deltas.x += (e as MouseEvent).movementX;
    this.deltas.y += (e as MouseEvent).movementY;
  }

  private onMouseWheel(e: Event): void {
    if (!this.inputs.pointer) return;
    this.deltas.scroll += (e as any).deltaY;
  }

  private onMimicPointerLock(e: Event, locked: boolean): void {
    if (locked) this.element.classList.remove('paused');
    if (!locked) this.element.classList.add('paused');
    this.onInput(e, 'pointer', locked);
  }

  private onPointerInput(e: Event): void {
    const locked = document.pointerLockElement === this.canvas;
    this.onMimicPointerLock(e, locked);
  }

  private onInput(e: Event, input: Input, state: boolean): void {
    this.inputs[input] = state;
    e.stopPropagation();
    e.preventDefault();
  }
};

//////////////////////////////////////////////////////////////////////////////

type BlockId = int & {__type__: 'BlockId'};
type MaterialId = int & {__type__: 'MaterialId'};
type MaybeMaterialId = MaterialId | 0;

interface Material {
  color: Color,
  liquid: boolean,
  texture: Texture | null,
  textureIndex: int,
};

interface BlockSprite {
  url: string,
  x: int,
  y: int,
  w: int,
  h: int,
};

const kBlack: Color = [0, 0, 0, 1];
const kWhite: Color = [1, 1, 1, 1];

const kNoMaterial = 0 as 0;

const kEmptyBlock = 0 as BlockId;
const kUnknownBlock = 1 as BlockId;

class Registry {
  opaque: boolean[];
  solid: boolean[];
  private faces: MaybeMaterialId[];
  private meshes: (InstancedMesh | null)[];
  private materials: Material[];
  private ids: Map<string, MaterialId>;

  constructor() {
    this.opaque = [false, false];
    this.solid = [false, true];
    this.faces = []
    for (let i = 0; i < 12; i++) {
      this.faces.push(kNoMaterial);
    }
    this.meshes = [null, null];
    this.materials = [];
    this.ids = new Map();
  }

  addBlock(xs: string[], solid: boolean): BlockId {
    type Materials = [string, string, string, string, string, string];
    const materials = ((): Materials => {
      switch (xs.length) {
        // All faces for this block use same material.
        case 1: return [xs[0], xs[0], xs[0], xs[0], xs[0], xs[0]];
        // xs specifies [top/bottom, sides]
        case 2: return [xs[1], xs[1], xs[0], xs[0], xs[1], xs[1]];
        // xs specifies [top, bottom, sides]
        case 3: return [xs[2], xs[2], xs[0], xs[1], xs[2], xs[2]];
        // xs specifies [+x, -x, +y, -y, +z, -z]
        case 6: return xs as Materials;
        // Uninterpretable case.
        default: throw new Error(`Unexpected materials: ${JSON.stringify(xs)}`);
      }
    })();

    let opaque = true;
    materials.forEach(x => {
      const id = this.ids.get(x);
      if (id === undefined) throw new Error(`Unknown material: ${x}`);
      const material = id + 1 as MaterialId;
      this.faces.push(material);

      const data = this.getMaterialData(material);
      const alphaBlend = data.color[3] < 1;
      const alphaTest = data.texture && data.texture.alphaTest;
      if (alphaBlend || alphaTest) opaque = false;
    });

    const result = this.opaque.length as BlockId;
    this.opaque.push(opaque);
    this.solid.push(solid);
    this.meshes.push(null);
    return result;
  }

  addBlockMesh(mesh: InstancedMesh, solid: boolean): BlockId {
    const result = this.opaque.length as BlockId;
    for (let i = 0; i < 6; i++) this.faces.push(kNoMaterial);
    this.meshes.push(mesh);
    this.opaque.push(false);
    this.solid.push(solid);
    return result;
  }

  addMaterialOfColor(name: string, color: Color, liquid: boolean = false) {
    this.addMaterialHelper(name, color, liquid, null);
  }

  addMaterialOfTexture(name: string, texture: Texture,
                       color: Color = kWhite, liquid: boolean = false) {
    this.addMaterialHelper(name, color, liquid, texture);
  }

  // faces has 6 elements for each block type: [+x, -x, +y, -y, +z, -z]
  getBlockFaceMaterial(id: BlockId, face: int): MaybeMaterialId {
    return this.faces[id * 6 + face];
  }

  getBlockMesh(id: BlockId): InstancedMesh | null {
    return this.meshes[id];
  }

  getMaterialData(id: MaterialId): Material {
    assert(0 < id && id <= this.materials.length);
    return this.materials[id - 1];
  }

  private addMaterialHelper(
      name: string, color: Color, liquid: boolean, texture: Texture | null) {
    assert(name.length > 0, () => 'Empty material name!');
    assert(!this.ids.has(name), () => `Duplicate material: ${name}`);
    this.ids.set(name, this.materials.length as MaterialId);
    this.materials.push({color, liquid, texture, textureIndex: 0});
  }
};

//////////////////////////////////////////////////////////////////////////////

class Performance {
  private now: any;
  private index: int;
  private ticks: int[];
  private last: number;
  private sum: int;

  constructor(now: any, samples: int) {
    assert(samples > 0);
    this.now = now;
    this.index = 0;
    this.ticks = new Array(samples).fill(0);
    this.last = 0;
    this.sum = 0;
  }

  begin() {
    this.last = this.now.now();
  }

  end() {
    const index = this.index;
    const next_index = index + 1;
    this.index = int(next_index < this.ticks.length ? next_index : 0);
    const tick = int(Math.round(1000 * (this.now.now() - this.last)));
    this.sum += tick - this.ticks[index];
    this.ticks[index] = tick;
  }

  frame(): int {
    return this.index;
  }

  max(): number {
    return Math.max.apply(null, this.ticks);
  }

  mean(): number {
    return this.sum / this.ticks.length;
  }
};

//////////////////////////////////////////////////////////////////////////////

const kTickResolution = 4;
const kTicksPerFrame = 4;
const kTicksPerSecond = 60;

type Callback = (dt: number) => void;

class Timing {
  private now: any;
  private remesh: Callback;
  private render: Callback;
  private update: Callback;
  private renderBinding: () => void;
  private updateDelay: number;
  private updateLimit: number;
  private lastRender: int;
  private lastUpdate: int;
  remeshPerf: Performance;
  renderPerf: Performance;
  updatePerf: Performance;

  constructor(remesh: Callback, render: Callback, update: Callback) {
    this.now = performance || Date;
    this.remesh = remesh;
    this.render = render;
    this.update = update;

    const now = this.now.now();
    this.lastRender = now;
    this.lastUpdate = now;

    this.renderBinding = this.renderHandler.bind(this);
    requestAnimationFrame(this.renderBinding);

    this.updateDelay = 1000 / kTicksPerSecond;
    this.updateLimit = this.updateDelay * kTicksPerFrame;
    const updateInterval = this.updateDelay / kTickResolution;
    setInterval(this.updateHandler.bind(this), updateInterval);

    this.remeshPerf = new Performance(this.now, 60);
    this.renderPerf = new Performance(this.now, 60);
    this.updatePerf = new Performance(this.now, 60);
  }

  renderHandler() {
    requestAnimationFrame(this.renderBinding);
    this.updateHandler();

    const now = this.now.now();
    const dt = (now - this.lastRender) / 1000;
    this.lastRender = now;

    try {
      this.remeshPerf.begin();
      this.remesh(dt);
      this.remeshPerf.end();
      this.renderPerf.begin();
      this.render(dt);
      this.renderPerf.end();
    } catch (e) {
      this.onError(e);
    }
  }

  private updateHandler() {
    let now = this.now.now();
    const delay = this.updateDelay;
    const limit = now + this.updateLimit;

    while (this.lastUpdate + delay < now) {
      try {
        this.updatePerf.begin();
        this.update(delay / 1000);
        this.updatePerf.end();
      } catch (e) {
        this.onError(e);
      }
      this.lastUpdate += delay;
      now = this.now.now();

      if (now > limit) {
        this.lastUpdate = now;
        break;
      }
    }
  }

  private onError(e: any) {
    this.remesh = this.render = this.update = () => {};
    console.error(e);
  }
};

//////////////////////////////////////////////////////////////////////////////

type Loader = (x: int, z: int, column: Column) => void;

class Column {
  private decorations: int[];
  private data: Int16Array;
  private last: int = 0;
  private size: int = 0;

  // For computing "chunk equi-levels" efficiently. An "equi-level" is a
  // height in a chunk at which all columns have the same block.
  private mismatches: Int16Array;
  private reference_data: Int16Array;
  private reference_size: int = 0;

  constructor() {
    this.decorations = [];
    this.data = new Int16Array(2 * kWorldHeight);
    this.mismatches = new Int16Array(kWorldHeight);
    this.reference_data = new Int16Array(2 * kWorldHeight);
  }

  clear(): void {
    this.decorations.length = 0;
    this.last = 0;
    this.size = 0;
  }

  fillChunk(x: int, z: int, chunk: Chunk, first: boolean): void {
    let last = int(0);
    for (let i = 0; i < this.size; i++) {
      const offset = 2 * i;
      const block = this.data[offset + 0] as BlockId;
      const level = int(this.data[offset + 1]);
      chunk.setColumn(x, z, last, int(level - last), block);
      last = level;
    }
    for (let i = 0; i < this.decorations.length; i += 2) {
      const block = this.decorations[i + 0] as BlockId
      const level = this.decorations[i + 1];
      chunk.setColumn(x, z, level, 1, block);
    }
    this.detectEquiLevelChanges(first);
  }

  fillEquilevels(equilevels: Int8Array): void {
    let current = 0;
    const mismatches = this.mismatches;
    for (let i = 0; i < kWorldHeight; i++) {
      current += mismatches[i];
      equilevels[i] = (current === 0 ? 1 : 0);
    }
  }

  overwrite(block: BlockId, y: int) {
    if (!(0 <= y && y < kWorldHeight)) return;
    this.decorations.push(block);
    this.decorations.push(y);
  }

  push(block: BlockId, height: int): void {
    height = int(Math.min(height, kWorldHeight));
    if (height <= this.last) return;
    this.last = height;
    const offset = 2 * this.size;
    this.data[offset + 0] = block;
    this.data[offset + 1] = this.last;
    this.size++;
  }

  getNthBlock(n: int, bedrock: BlockId): BlockId {
    return n < 0 ? bedrock : this.data[2 * n + 0] as BlockId;
  }

  getNthLevel(n: int): int {
    return n < 0 ? 0 : int(this.data[2 * n + 1]);
  }

  getSize(): int {
    return this.size;
  }

  private detectEquiLevelChanges(first: boolean): void {
    if (this.last < kWorldHeight) {
      const offset = 2 * this.size;
      this.data[offset + 0] = kEmptyBlock;
      this.data[offset + 1] = kWorldHeight;
      this.size++;
    }

    if (first) this.mismatches.fill(0);

    for (let i = 0; i < this.decorations.length; i += 2) {
      const level = this.decorations[i + 1];
      this.mismatches[level]++;
      if (level + 1 < kWorldHeight) this.mismatches[level + 1]--;
    }

    if (first) {
      for (let i = 0; i < 2 * this.size; i++) {
        this.reference_data[i] = this.data[i];
      }
      this.reference_size = this.size;
      return;
    }

    let matched = true;
    let di = 0, ri = 0;
    let d_start = 0, r_start = 0;
    while (di < this.size && ri < this.reference_size) {
      const d_offset = 2 * di;
      const d_block = this.data[d_offset + 0];
      const d_limit = this.data[d_offset + 1];

      const r_offset = 2 * ri;
      const r_block = this.reference_data[r_offset + 0];
      const r_limit = this.reference_data[r_offset + 1];

      if (matched !== (d_block === r_block)) {
        const height = Math.max(d_start, r_start);
        this.mismatches[height] += matched ? 1 : -1;
        matched = !matched;
      }

      if (d_limit <= r_limit) {
        d_start = d_limit;
        di++;
      }
      if (r_limit <= d_limit) {
        r_start = r_limit;
        ri++;
      }
    }

    assert(di === this.size);
    assert(ri === this.reference_size);
    assert(d_start === kWorldHeight);
    assert(r_start === kWorldHeight);
  }
};

//////////////////////////////////////////////////////////////////////////////

interface CircleElement {
  cx: int;
  cz: int;
  dispose(): void;
};

class Circle<T extends CircleElement> {
  private center_x: int = 0;
  private center_z: int = 0;
  private deltas: Int32Array;
  private points: Int32Array;
  private elements: (T | null)[];
  private shift: int;
  private mask: int;

  constructor(radius: number) {
    const bound = radius * radius;
    const floor = Math.floor(radius);

    const points = [];
    for (let i = -floor; i <= floor; i++) {
      for (let j = -floor; j <= floor; j++) {
        const distance = i * i + j * j;
        if (distance > bound) continue;
        points.push({i, j, distance});
      }
    }
    points.sort((a, b) => a.distance - b.distance);

    let current = 0;
    this.deltas = new Int32Array(floor + 1);
    this.points = new Int32Array(2 * points.length);
    for (const {i, j} of points) {
      this.points[current++] = i;
      this.points[current++] = j;
      const ai = Math.abs(i), aj = Math.abs(j);
      this.deltas[ai] = Math.max(this.deltas[ai], aj);
    }
    assert(current === this.points.length);

    let shift = 0;
    while ((1 << shift) < 2 * floor + 1) shift++;
    this.elements = new Array(1 << (2 * shift)).fill(null);
    this.shift = int(shift);
    this.mask = int((1 << shift) - 1);
  }

  center(center_x: int, center_z: int): void {
    if (center_x === this.center_x && center_z === this.center_z) return;
    this.each((cx: int, cz: int): boolean => {
      const ax = Math.abs(cx - center_x);
      const az = Math.abs(cz - center_z);
      if (az <= this.deltas[ax]) return false;

      const index = this.index(cx, cz);
      const value = this.elements[index];
      if (value === null) return false;
      value.dispose();
      this.elements[index] = null;
      return false;
    });
    this.center_x = center_x;
    this.center_z = center_z;
  }

  each(fn: (cx: int, cz: int) => boolean) {
    const {center_x, center_z, points} = this;
    const length = points.length;
    for (let i = 0; i < length; i += 2) {
      const done = fn(int(points[i] + center_x), int(points[i + 1] + center_z));
      if (done) break;
    }
  }

  get(cx: int, cz: int): T | null {
    const value = this.elements[this.index(cx, cz)];
    return value && value.cx === cx && value.cz === cz ? value : null;
  }

  set(cx: int, cz: int, value: T): void {
    const index = this.index(cx, cz);
    assert(this.elements[index] === null);
    this.elements[index] = value;
  }

  private index(cx: int, cz: int): int {
    const {mask, shift} = this;
    return int(((cz & mask) << shift) | (cx & mask));
  }
};

//////////////////////////////////////////////////////////////////////////////

const kChunkBits   = int(4);
const kChunkWidth  = int(1 << kChunkBits);
const kChunkMask   = int(kChunkWidth - 1);
const kWorldHeight = int(256);

const kChunkRadius = 12;

const kNumChunksToLoadPerFrame = 1;
const kNumChunksToMeshPerFrame = 1;
const kNumLODChunksToMeshPerFrame = 1;

const kFrontierLOD = 2;
const kFrontierRadius = 8;
const kFrontierLevels = 6;

// Enable debug assertions for the equi-levels optimization.
const kCheckEquilevels = false;

// List of neighboring chunks to include when meshing.
type Point = [int, int, int];
const kNeighborOffsets = ((): [Point, Point, Point, Point][] => {
  const W = kChunkWidth;
  const H = kWorldHeight;
  const L = int(W - 1);
  const N = int(W + 1);
  return [
    [[ 0,  0,  0], [1, 1, 1], [0, 0, 0], [W, H, W]],
    [[-1,  0,  0], [0, 1, 1], [L, 0, 0], [1, H, W]],
    [[ 1,  0,  0], [N, 1, 1], [0, 0, 0], [1, H, W]],
    [[ 0,  0, -1], [1, 1, 0], [0, 0, L], [W, H, 1]],
    [[ 0,  0,  1], [1, 1, N], [0, 0, 0], [W, H, 1]],
  ];
})();

class Chunk {
  cx: int;
  cz: int;
  private dirty: boolean = false;
  private ready: boolean = false;
  private neighbors: int = 0;
  private instances: Map<InstancedMesh, Map<int, int>>;
  private solid: VoxelMesh | null = null;
  private water: VoxelMesh | null = null;
  private world: World;
  private voxels: Tensor3;
  private heightmap: Tensor2;
  private light_map: Tensor2;
  private equilevels: Int8Array;

  constructor(cx: int, cz: int, world: World, loader: Loader) {
    this.cx = cx;
    this.cz = cz;
    this.world = world;
    this.instances = new Map();
    this.voxels = new Tensor3(kChunkWidth, kWorldHeight, kChunkWidth);
    this.heightmap = new Tensor2(kChunkWidth, kChunkWidth);
    this.light_map = new Tensor2(kChunkWidth, kChunkWidth);
    this.equilevels = new Int8Array(kWorldHeight);
    this.load(loader);
  }

  dispose(): void {
    this.dropMeshes();

    const {cx, cz} = this;
    const neighbor = (x: int, z: int) => {
      const chunk = this.world.chunks.get(int(x + cx), int(z + cz));
      if (chunk) chunk.notifyNeighborDisposed();
    };
    neighbor(1, 0); neighbor(-1, 0);
    neighbor(0, 1); neighbor(0, -1);
  }

  getBlock(x: int, y: int, z: int): BlockId {
    const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
    return this.voxels.get(xm, y, zm) as BlockId;
  }

  getLitHeight(x: int, z: int): int {
    const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
    return this.light_map.get(xm, zm);
  }

  setBlock(x: int, y: int, z: int, block: BlockId): void {
    const voxels = this.voxels;
    const xm = int(x & kChunkMask), zm = int(z & kChunkMask);

    const old = voxels.get(xm, y, zm) as BlockId;
    if (old === block) return;
    const index = voxels.index(xm, y, zm);
    voxels.data[index] = block;
    this.dirty = true;

    this.updateHeightmap(xm, zm, index, y, 1, block);
    this.equilevels[y] = 0;

    const neighbor = (x: int, y: int, z: int) => {
      const {cx, cz} = this;
      const chunk = this.world.chunks.get(int(x + cx), int(z + cz));
      if (chunk) chunk.dirty = true;
    };
    if (xm === 0) neighbor(-1, 0, 0);
    if (xm === kChunkMask) neighbor(1, 0, 0);
    if (zm === 0) neighbor(0, 0, -1);
    if (zm === kChunkMask) neighbor(0, 0, 1);
  }

  setColumn(x: int, z: int, start: int, count: int, block: BlockId): void {
    const voxels = this.voxels;
    const xm = int(x & kChunkMask), zm = int(z & kChunkMask);

    assert(voxels.stride[1] === 1);
    const index = voxels.index(xm, start, zm);
    voxels.data.fill(block, index, index + count);

    this.updateHeightmap(xm, zm, index, start, count, block);
  }

  hasMesh(): boolean {
    return !!(this.solid || this.water);
  }

  needsRemesh(): boolean {
    return this.dirty && this.ready;
  }

  remeshChunk(): void {
    assert(this.dirty);
    this.remeshSprites();
    this.remeshTerrain();
    this.dirty = false;
  }

  private load(loader: Loader): void {
    const {cx, cz, world} = this;
    const column = world.column;
    const dx = cx << kChunkBits;
    const dz = cz << kChunkBits;
    for (let x = 0; x < kChunkWidth; x++) {
      for (let z = 0; z < kChunkWidth; z++) {
        const first = x + z === 0;
        const ax = int(x + dx), az =  int(z + dz);
        loader(ax, az, column);
        column.fillChunk(ax, az, this, first);
        column.clear();
      }
    }
    column.fillEquilevels(this.equilevels);

    if (kCheckEquilevels) {
      for (let y = int(0); y < kWorldHeight; y++) {
        if (this.equilevels[y] === 0) continue;
        const base = this.voxels.get(0, y, 0);
        for (let x = int(0); x < kChunkWidth; x++) {
          for (let z = int(0); z < kChunkWidth; z++) {
            assert(this.voxels.get(x, y, z) === base);
          }
        }
      }
    }

    const neighbor = (x: int, z: int) => {
      const chunk = this.world.chunks.get(int(x + cx), int(z + cz));
      if (!chunk) return;
      chunk.notifyNeighborLoaded();
      this.neighbors++;
    };
    neighbor(1, 0); neighbor(-1, 0);
    neighbor(0, 1); neighbor(0, -1);

    this.dirty = true;
    this.ready = this.checkReady();
  }

  private checkReady(): boolean {
    return this.neighbors === 4;
  }

  private dropMeshes(): void {
    this.dropInstancedMeshes();
    if (this.hasMesh()) {
      this.world.frontier.markDirty(0);
    }
    this.solid?.dispose();
    this.water?.dispose();
    this.solid = null;
    this.water = null;
    this.dirty = true;
  }

  private dropInstancedMeshes(): void {
    const instances = this.instances;
    for (const [mesh, map] of instances.entries()) {
      for (const index of map.values()) mesh.removeInstance(index);
    }
    instances.clear();
  }

  private notifyNeighborDisposed(): void {
    assert(this.neighbors > 0);
    this.neighbors--;
    const old = this.ready;
    this.ready = this.checkReady();
    if (old && !this.ready) this.dropMeshes();
  }

  private notifyNeighborLoaded(): void {
    assert(this.neighbors < 4);
    this.neighbors++;
    this.ready = this.checkReady();
  }

  private remeshSprites(): void {
    this.dropInstancedMeshes();
    const {equilevels, instances, voxels, world} = this;
    const {registry, renderer} = world;
    const {data, stride} = voxels;

    const bx = this.cx << kChunkBits;
    const bz = this.cz << kChunkBits;

    assert(stride[1] === 1);
    for (let y = int(0); y < kWorldHeight; y++) {
      const block = data[y] as BlockId;
      if (equilevels[y] && !registry.getBlockMesh(block)) continue;
      for (let x = int(0); x < kChunkWidth; x++) {
        for (let z = int(0); z < kChunkWidth; z++) {
          const index = voxels.index(x, y, z);
          const mesh = registry.getBlockMesh(data[index] as BlockId);
          if (!mesh) continue;

          if (!instances.get(mesh)) instances.set(mesh, new Map());
          const map = instances.get(mesh)!;
          map.set(index, mesh.addInstance(bx + x + 0.5, y, bz + z + 0.5));
        }
      }
    }
  }

  private remeshTerrain(): void {
    const {cx, cz, world} = this;
    const {bedrock, buffer, heightmap, light_map, equilevels} = world;
    equilevels.set(this.equilevels, 1);
    for (const offset of kNeighborOffsets) {
      const [c, dstPos, srcPos, size] = offset;
      const chunk = world.chunks.get(int(cx + c[0]), int(cz + c[2]));
      const delta = int(dstPos[1] - srcPos[1]);
      assert(delta === 1);
      if (chunk) {
        this.copyHeightmap(heightmap, dstPos, chunk.heightmap, srcPos, size);
        this.copyHeightmap(light_map, dstPos, chunk.light_map, srcPos, size);
        this.copyVoxels(buffer, dstPos, chunk.voxels, srcPos, size);
      } else {
        this.zeroHeightmap(heightmap, dstPos, size, delta);
        this.zeroHeightmap(light_map, dstPos, size, delta);
        this.zeroVoxels(buffer, dstPos, size);
      }
      if (chunk !== this) {
        this.copyEquilevels(equilevels, chunk, srcPos, size, delta);
      }
    }

    if (kCheckEquilevels) {
      for (let y = int(0); y < buffer.shape[1]; y++) {
        if (equilevels[y] === 0) continue;
        const base = buffer.get(1, y, 1);
        for (let x = int(0); x < buffer.shape[0]; x++) {
          for (let z = int(0); z < buffer.shape[2]; z++) {
            if ((x !== 0 && x !== buffer.shape[0] - 1) ||
                (z !== 0 && z !== buffer.shape[2] - 1)) {
              assert(buffer.get(x, y, z) === base);
            }
          }
        }
      }
    }

    const x = cx << kChunkBits, z = cz << kChunkBits;
    const meshed = world.mesher.meshChunk(
        buffer, heightmap, light_map, equilevels, this.solid, this.water);
    const [solid, water] = meshed;
    solid?.setPosition(x, 0, z);
    water?.setPosition(x, 0, z);
    this.solid = solid;
    this.water = water;
  }

  private updateHeightmap(xm: int, zm: int, index: int,
                          start: int, count: int, block: BlockId): void {
    const end = start + count;
    const offset = this.heightmap.index(xm, zm);
    const height = this.heightmap.data[offset];
    const light_ = this.light_map.data[offset];
    const voxels = this.voxels;
    assert(voxels.stride[1] === 1);

    if (block === kEmptyBlock && start < height && height <= end) {
      let i = 0;
      for (; i < start; i++) {
        if (voxels.data[index - i - 1] !== kEmptyBlock) break;
      }
      this.heightmap.data[offset] = start - i;
    } else if (block !== kEmptyBlock && height <= end) {
      this.heightmap.data[offset] = end;
    }

    const solid = this.world.registry.solid;
    if (!solid[block] && start < light_ && light_ <= end) {
      let i = 0;
      for (; i < start; i++) {
        if (solid[voxels.data[index - i - 1]]) break;
      }
      this.light_map.data[offset] = start - i;
    } else if (solid[block] && light_ <= end) {
      this.light_map.data[offset] = end;
    }
  }

  private copyEquilevels(dst: Int8Array, chunk: Chunk | null,
                         srcPos: Point, size: Point, delta: int): void {
    assert(this.voxels.stride[1] === 1);
    const data = this.voxels.data;

    if (chunk === null) {
      for (let i = 0; i < kWorldHeight; i++) {
        if (dst[i + delta] === 0) continue;
        if (data[i] !== kEmptyBlock) dst[i + delta] = 0;
      }
      return;
    }

    assert(chunk.voxels.stride[1] === 1);
    assert(size[0] === 1 || size[2] === 1);
    const stride = chunk.voxels.stride[size[0] === 1 ? 2 : 0];
    const index = chunk.voxels.index(srcPos[0], srcPos[1], srcPos[2]);
    const limit = stride * (size[0] === 1 ? size[2] : size[0]);

    const chunk_equilevels = chunk.equilevels;
    const chunk_data = chunk.voxels.data;

    for (let i = 0; i < kWorldHeight; i++) {
      if (dst[i + delta] === 0) continue;
      const base = data[i];
      if (chunk_equilevels[i] === 1 && chunk_data[i] === base) continue;
      for (let offset = 0; offset < limit; offset += stride) {
        if (chunk_data[index + offset + i] === base) continue;
        dst[i + delta] = 0;
        break;
      }
    }
  }

  private copyHeightmap(dst: Tensor2, dstPos: Point,
                        src: Tensor2, srcPos: Point, size: Point): void {
    const ni = size[0], nk = size[2];
    const di = dstPos[0], dk = dstPos[2];
    const si = srcPos[0], sk = srcPos[2];
    const offset = dstPos[1] - srcPos[1];

    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        const sindex = src.index(int(si + i), int(sk + k));
        const dindex = dst.index(int(di + i), int(dk + k));
        dst.data[dindex] = src.data[sindex] + offset;
      }
    }
  }

  private copyVoxels(dst: Tensor3, dstPos: Point,
                     src: Tensor3, srcPos: Point, size: Point): void {
    const [ni, nj, nk] = size;
    const [di, dj, dk] = dstPos;
    const [si, sj, sk] = srcPos;
    assert(dst.stride[1] === 1);
    assert(src.stride[1] === 1);

    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        const sindex = src.index(int(si + i), sj, int(sk + k));
        const dindex = dst.index(int(di + i), dj, int(dk + k));
        dst.data.set(src.data.subarray(sindex, sindex + nj), dindex);
      }
    }
  }

  private zeroHeightmap(
      dst: Tensor2, dstPos: Point, size: Point, delta: int): void {
    const ni = size[0], nk = size[2];
    const di = dstPos[0], dk = dstPos[2];

    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        dst.set(int(di + i), int(dk + k), delta);
      }
    }
  }

  private zeroVoxels(dst: Tensor3, dstPos: Point, size: Point): void {
    const [ni, nj, nk] = size;
    const [di, dj, dk] = dstPos;
    const dsj = dst.stride[1];
    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        // Unroll along the y-axis, since it's the longest chunk dimension.
        let dindex = dst.index(int(di + i), dj, int(dk + k));
        for (let j = 0; j < nj; j++, dindex += dsj) {
          dst.data[dindex] = kEmptyBlock;
        }
      }
    }
  }
};

//////////////////////////////////////////////////////////////////////////////

const kMultiMeshBits = int(2);
const kMultiMeshSide = int(1 << kMultiMeshBits);
const kMultiMeshArea = int(kMultiMeshSide * kMultiMeshSide);
const kLODSingleMask = int((1 << 4) - 1);

class LODMultiMesh {
  solid: VoxelMesh | null;
  water: VoxelMesh | null;
  meshed: boolean[];

  private mask: Int32Array;
  private visible: int = 0;
  private enabled: boolean[];

  constructor() {
    this.solid = null;
    this.water = null;
    this.meshed = new Array(kMultiMeshArea).fill(false);
    this.enabled = new Array(kMultiMeshArea).fill(false);
    this.mask = new Int32Array(2);
    this.mask[0] = this.mask[1] = -1;
  }

  disable(index: int): void {
    if (!this.enabled[index]) return;
    this.setMask(index, kLODSingleMask);
    this.enabled[index] = false;
    if (this.enabled.some(x => x)) return;

    for (let i = 0; i < this.meshed.length; i++) this.meshed[i] = false;
    this.solid?.dispose();
    this.water?.dispose();
    this.solid = null;
    this.water = null;
    this.mask[0] = this.mask[1] = -1;
  }

  index(chunk: FrontierChunk): int {
    const mask = kMultiMeshSide - 1;
    return int(((chunk.cz & mask) << kMultiMeshBits) | (chunk.cx & mask));
  }

  show(index: int, mask: int): void {
    assert(this.meshed[index]);
    this.setMask(index, mask);
    this.enabled[index] = true;
  }

  private setMask(index: int, mask: int): void {
    const mask_index = index >> 3;
    const mask_shift = (index & 7) * 4;
    this.mask[mask_index] &= ~(kLODSingleMask << mask_shift);
    this.mask[mask_index] |= mask << mask_shift;

    const shown = (this.mask[0] & this.mask[1]) !== -1;
    this.solid?.show(this.mask, shown);
    this.water?.show(this.mask, shown);
  }
};

class FrontierChunk {
  cx: int;
  cz: int;
  index: int;
  level: int;
  mesh: LODMultiMesh;
  frontier: Frontier;

  constructor(cx: int, cz: int, level: int,
              mesh: LODMultiMesh, frontier: Frontier) {
    this.cx = cx;
    this.cz = cz;
    this.level = level;
    this.mesh = mesh;
    this.frontier = frontier;
    this.index = mesh.index(this);
  }

  dispose() {
    if (this.hasMesh()) {
      this.frontier.markDirty(int(this.level + 1));
    }
    this.mesh.disable(this.index);
  }

  hasMesh() {
    return this.mesh.meshed[this.index];
  }
};

class Frontier {
  private world: World;
  private dirty: boolean[];
  private levels: Circle<FrontierChunk>[];
  private meshes: Map<int, LODMultiMesh>;
  private solid_heightmap: Uint32Array;
  private water_heightmap: Uint32Array;
  private side: int;

  constructor(world: World) {
    this.world = world;
    this.meshes = new Map();

    this.dirty = [];
    this.levels = [];
    let radius = (kChunkRadius | 0) + 0.5;
    for (let i = 0; i < kFrontierLevels; i++) {
      radius = (radius + kFrontierRadius) / 2;
      this.levels.push(new Circle(radius));
      this.dirty.push(true);
    }

    assert(kChunkWidth % kFrontierLOD === 0);
    const side = int(kChunkWidth / kFrontierLOD);
    const size = int(2 * (side + 2) * (side + 2));
    this.solid_heightmap = new Uint32Array(size);
    this.water_heightmap = new Uint32Array(size);
    this.side = side;
  }

  center(cx: int, cz: int) {
    for (const level of this.levels) {
      cx = int(cx >> 1);
      cz = int(cz >> 1);
      level.center(cx, cz);
    }
  }

  markDirty(level: int) {
    if (level < this.dirty.length) this.dirty[level] = true;
  }

  remeshFrontier() {
    for (let i = int(0); i < kFrontierLevels; i++) {
      this.computeLODAtLevel(i);
    }
  }

  private computeLODAtLevel(l: int) {
    if (!this.dirty[l]) return;
    const world = this.world;
    const level = this.levels[l];

    const meshed = (dx: int, dz: int): boolean => {
      if (l > 0) {
        const chunk = this.levels[l - 1].get(dx, dz);
        return chunk !== null && chunk.hasMesh();
      } else {
        const chunk = world.chunks.get(dx, dz);
        return chunk !== null && chunk.hasMesh();
      }
    };

    let counter = 0;
    let skipped = false;
    level.each((cx: int, cz: int): boolean => {
      let mask = int(0);
      for (let i = 0; i < 4; i++) {
        const dx = int((cx << 1) + (i & 1 ? 1 : 0));
        const dz = int((cz << 1) + (i & 2 ? 1 : 0));
        if (meshed(dx, dz)) mask = int(mask | (1 << i));
      }

      const shown = mask !== 15;
      const extra = counter < kNumLODChunksToMeshPerFrame;
      const create = shown && (extra || mask !== 0);
      if (shown && !create) skipped = true;

      const existing = level.get(cx, cz);
      if (!existing && !create) return false;

      const lod = (() => {
        if (existing) return existing;
        const created = this.createFrontierChunk(cx, cz, l);
        level.set(cx, cz, created);
        return created;
      })();

      if (shown && !lod.hasMesh()) {
        this.createLODMeshes(lod);
        this.markDirty(int(l + 1));
        counter++;
      }
      lod.mesh.show(lod.mesh.index(lod), mask);
      return false;
    });
    this.dirty[l] = skipped;
  }

  private createLODMeshes(chunk: FrontierChunk): void {
    const {side, world} = this;
    const {cx, cz, level, mesh} = chunk;
    const {bedrock, column, loadFrontier, registry} = world;
    const {solid_heightmap, water_heightmap} = this;
    if (!loadFrontier) return;

    assert(kFrontierLOD % 2 === 0);
    assert(registry.solid[bedrock]);
    const lshift = kChunkBits + level;
    const lod = int(kFrontierLOD << level);
    const x = (2 * cx + 1) << lshift;
    const z = (2 * cz + 1) << lshift;

    // The (x, z) position of the center of the multimesh for this mesh.
    const multi = kMultiMeshSide;
    const mx = (2 * (cx & ~(multi - 1)) + multi) << lshift;
    const mz = (2 * (cz & ~(multi - 1)) + multi) << lshift;

    for (let k = 0; k < 4; k++) {
      const dx = (k & 1 ? 0 : -1 << lshift);
      const dz = (k & 2 ? 0 : -1 << lshift);
      const ax = x + dx + lod / 2;
      const az = z + dz + lod / 2;

      for (let i = 0; i < side; i++) {
        for (let j = 0; j < side; j++) {
          loadFrontier(int(ax + i * lod), int(az + j * lod), column);
          const offset = 2 * ((i + 1) + (j + 1) * (side + 2));

          const size = column.getSize();
          const last_block = column.getNthBlock(int(size - 1), bedrock);
          const last_level = column.getNthLevel(int(size - 1));

          if (registry.solid[last_block]) {
            solid_heightmap[offset + 0] = last_block;
            solid_heightmap[offset + 1] = last_level;
            water_heightmap[offset + 0] = 0;
            water_heightmap[offset + 1] = 0;
          } else {
            water_heightmap[offset + 0] = last_block;
            water_heightmap[offset + 1] = last_level;

            for (let i = size; i > 0; i--) {
              const block = column.getNthBlock(int(i - 2), bedrock);
              const level = column.getNthLevel(int(i - 2));
              if (!registry.solid[block]) continue;
              solid_heightmap[offset + 0] = block;
              solid_heightmap[offset + 1] = level;
              break;
            }
          }
          column.clear();
        }
      }

      const n = int(side + 2);
      const px = int(x + dx - mx - lod);
      const pz = int(z + dz - mz - lod);
      const mask = int(k + 4 * mesh.index(chunk));
      mesh.solid = this.world.mesher.meshFrontier(
          solid_heightmap, mask, px, pz, n, n, lod, mesh.solid, true);
      mesh.water = this.world.mesher.meshFrontier(
          water_heightmap, mask, px, pz, n, n, lod, mesh.water, false);
    }

    mesh.solid?.setPosition(mx, 0, mz);
    mesh.water?.setPosition(mx, 0, mz);
    mesh.meshed[mesh.index(chunk)] = true;
  }

  private createFrontierChunk(cx: int, cz: int, level: int): FrontierChunk {
    const bits = kMultiMeshBits;
    const mesh = this.getOrCreateMultiMesh(
        int(cx >> bits), int(cz >> bits), level);
    const result = new FrontierChunk(cx, cz, level, mesh, this);
    // A FrontierChunk's mesh is just a fragment of data in its LODMultiMesh.
    // That means that we may already have a mesh when we construct the chunk,
    // if we previously disposed it without discarding data in the multi-mesh.
    // We count this case as meshing a chunk and mark l + 1 dirty.
    if (result.hasMesh()) this.markDirty(int(level + 1));
    return result;
  }

  private getOrCreateMultiMesh(cx: int, cz: int, level: int): LODMultiMesh {
    const shift = 12;
    const mask = (1 << shift) - 1;
    const base = ((cz & mask) << shift) | (cx & mask);
    const key = int(base * kFrontierLevels + level);

    const result = this.meshes.get(key);
    if (result) return result;
    const created = new LODMultiMesh();
    this.meshes.set(key, created);
    return created;
  }
};

//////////////////////////////////////////////////////////////////////////////

class World {
  chunks: Circle<Chunk>;
  column: Column;
  renderer: Renderer;
  registry: Registry;
  frontier: Frontier;
  mesher: TerrainMesher;
  bedrock: BlockId;
  loadChunk: Loader | null;
  loadFrontier: Loader | null;
  buffer: Tensor3;
  heightmap: Tensor2;
  light_map: Tensor2;
  equilevels: Int8Array;

  constructor(registry: Registry, renderer: Renderer) {
    const radius = (kChunkRadius | 0) + 0.5;
    this.chunks = new Circle(radius);
    this.column = new Column();
    this.renderer = renderer;
    this.registry = registry;
    this.frontier = new Frontier(this);
    this.mesher = new TerrainMesher(registry, renderer);
    this.loadChunk = null;
    this.loadFrontier = null;
    this.bedrock = kEmptyBlock;

    // Add a one-block-wide plane of extra space on each side of our voxels,
    // so that we can include adjacent chunks and use their contents for AO.
    //
    // We add a two-block-wide plane below our voxel data, so that we also
    // have room for a plane of bedrock blocks below this chunk (in case we
    // dig all the way to y = 0).
    const w = int(kChunkWidth + 2);
    const h = int(kWorldHeight + 2);
    this.buffer = new Tensor3(w, h, w);
    this.heightmap = new Tensor2(w, w);
    this.light_map = new Tensor2(w, w);
    this.equilevels = new Int8Array(h);
    this.equilevels[0] = this.equilevels[h - 1] = 1;
  }

  isBlockLit(x: int, y: int, z: int): boolean {
    const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
    const chunk = this.chunks.get(cx, cz);
    return chunk ? y >= chunk.getLitHeight(x, z) : true;
  }

  getBlock(x: int, y: int, z: int): BlockId {
    if (y < 0) return this.bedrock;
    if (y >= kWorldHeight) return kEmptyBlock;
    const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
    const chunk = this.chunks.get(cx, cz);
    return chunk ? chunk.getBlock(x, y, z) : kUnknownBlock;
  }

  setBlock(x: int, y: int, z: int, block: BlockId) {
    if (!(0 <= y && y < kWorldHeight)) return;
    const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
    const chunk = this.chunks.get(cx, cz);
    chunk?.setBlock(x, y, z, block);
  }

  setLoader(bedrock: BlockId, loadChunk: Loader, loadFrontier?: Loader) {
    this.bedrock = bedrock;
    this.loadChunk = loadChunk;
    this.loadFrontier = loadFrontier || loadChunk;

    const buffer = this.buffer;
    for (let x = int(0); x < buffer.shape[0]; x++) {
      for (let z = int(0); z < buffer.shape[2]; z++) {
        buffer.set(x, 0, z, bedrock);
      }
    }
  }

  recenter(x: number, y: number, z: number) {
    const {chunks, frontier, loadChunk} = this;
    const cx = int(Math.floor(x) >> kChunkBits);
    const cz = int(Math.floor(z) >> kChunkBits);
    chunks.center(cx, cz);
    frontier.center(cx, cz);

    if (!loadChunk) return;

    let loaded = 0;
    chunks.each((cx: int, cz: int): boolean => {
      const existing = chunks.get(cx, cz);
      if (existing) return false;
      const chunk = new Chunk(cx, cz, this, loadChunk);
      chunks.set(cx, cz, chunk);
      return (++loaded) === kNumChunksToLoadPerFrame;
    });
  }

  remesh() {
    const {chunks, frontier} = this;
    let meshed = 0, total = 0;
    chunks.each((cx: int, cz: int): boolean => {
      total++;
      if (total > 9 && meshed >= kNumChunksToMeshPerFrame) return true;
      const chunk = chunks.get(cx, cz);
      if (!chunk || !chunk.needsRemesh()) return false;
      if (!chunk.hasMesh()) frontier.markDirty(0);
      chunk.remeshChunk();
      meshed++;
      return false;
    });
    frontier.remeshFrontier();
  }

  private distance(cx: int, cz: int, x: number, z: number) {
    const half = kChunkWidth / 2;
    const dx = (cx << kChunkBits) + half - x;
    const dy = (cz << kChunkBits) + half - z;
    return dx * dx + dy * dy;
  }
};

//////////////////////////////////////////////////////////////////////////////

const kTmpPos     = Vec3.create();
const kTmpMin     = Vec3.create();
const kTmpMax     = Vec3.create();
const kTmpDelta   = Vec3.create();
const kTmpImpacts = Vec3.create();

const kMinZLowerBound = 0.001;
const kMinZUpperBound = 0.1;

class Env {
  container: Container;
  entities: EntityComponentSystem;
  registry: Registry;
  renderer: Renderer;
  world: World;
  private cameraAlpha = 0;
  private cameraBlock = kEmptyBlock;
  private cameraColor = kWhite;
  private highlight: VoxelMesh;
  private highlightMask: Int32Array;
  private highlightSide: int = -1;
  private highlightPosition: Vec3;
  private timing: Timing;
  private frame: int = 0;

  constructor(id: string) {
    this.container = new Container(id);
    this.entities = new EntityComponentSystem();
    this.registry = new Registry();
    this.renderer = new Renderer(this.container.canvas);
    this.world = new World(this.registry, this.renderer);
    this.highlight = this.world.mesher.meshHighlight();
    this.highlightMask = new Int32Array(2);
    this.highlightPosition = Vec3.create();

    const remesh = this.world.remesh.bind(this.world);
    const render = this.render.bind(this);
    const update = this.update.bind(this);
    this.timing = new Timing(remesh, render, update);
  }

  getTargetedBlock(): Vec3 | null {
    return this.highlightSide < 0 ? null : this.highlightPosition;
  }

  getTargetedBlockSide(): int {
    return this.highlightSide;
  }

  setCameraTarget(x: number, y: number, z: number): void {
    this.renderer.camera.setTarget(x, y, z);
    this.setSafeZoomDistance();
  }

  refresh(): void {
    const saved = this.container.inputs.pointer;
    this.container.inputs.pointer = true;
    this.update(0);
    this.render(0);
    this.container.inputs.pointer = saved;
  }

  render(dt: number): void {
    if (!this.container.inputs.pointer) return;

    this.frame = int((this.frame + 1) & 0xffff);
    const pos = this.frame / 256;
    const rad = 2 * Math.PI * pos;
    const move = 0.25 * (Math.cos(rad) * 0.5 + pos);
    const wave = 0.05 * (Math.sin(rad) + 3);

    const camera = this.renderer.camera;
    const deltas = this.container.deltas;
    camera.applyInputs(deltas.x, deltas.y, deltas.scroll);
    deltas.x = deltas.y = deltas.scroll = 0;

    this.entities.render(dt);
    this.updateHighlightMesh();
    this.updateOverlayColor(wave);
    const renderer_stats = this.renderer.render(move, wave);

    const timing = this.timing;
    if (timing.renderPerf.frame() % 20 !== 0) return;
    const stats = `Update: ${this.formatStat(timing.updatePerf)}\r\n` +
                  `Remesh: ${this.formatStat(timing.remeshPerf)}\r\n` +
                  `Render: ${this.formatStat(timing.renderPerf)}\r\n` +
                  renderer_stats;
    this.container.displayStats(stats);
  }

  update(dt: number): void {
    if (!this.container.inputs.pointer) return;
    this.entities.update(dt);
  }

  private formatStat(perf: Performance): string {
    const format = (x: number) => (x / 1000).toFixed(2);
    return `${format(perf.mean())}ms / ${format(perf.max())}ms`;
  }

  private getRenderBlock(x: int, y: int, z: int): BlockId {
    const result = this.world.getBlock(x, y, z);
    if (result === kEmptyBlock || result === kUnknownBlock ||
        this.registry.getBlockFaceMaterial(result, 3) === kNoMaterial) {
      return kEmptyBlock;
    }
    return result;
  }

  private setSafeZoomDistance(): void {
    const camera = this.renderer.camera;
    const {direction, target, zoom} = camera;

    const check = (x: int, y: int, z: int) => {
      const block = this.world.getBlock(x, y, z);
      return !this.registry.solid[block];
    };

    const [x, y, z] = target;
    const buffer = kMinZUpperBound;
    Vec3.set(kTmpMin, x - buffer, y - buffer, z - buffer);
    Vec3.set(kTmpMax, x + buffer, y + buffer, z + buffer);
    Vec3.scale(kTmpDelta, direction, -zoom);
    sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);

    Vec3.add(kTmpDelta, kTmpMin, kTmpMax);
    Vec3.scale(kTmpDelta, kTmpDelta, 0.5);
    Vec3.sub(kTmpDelta, kTmpDelta, target);
    camera.setSafeZoomDistance(Vec3.length(kTmpDelta));
  }

  private updateHighlightMesh(): void {
    const camera = this.renderer.camera;
    const {direction, target, zoom} = camera;

    let move = false;
    this.highlightMask[0] = (1 << 6) - 1;

    const check = (x: int, y: int, z: int) => {
      const block = this.world.getBlock(x, y, z);
      if (!this.registry.solid[block]) return true;

      let mask = 0;
      const pos = kTmpPos;
      Vec3.set(pos, x, y, z);
      for (let d = 0; d < 3; d++) {
        pos[d] += 1;
        const b0 = this.world.getBlock(int(pos[0]), int(pos[1]), int(pos[2]));
        if (this.registry.opaque[b0]) mask |= (1 << (2 * d + 0));
        pos[d] -= 2;
        const b1 = this.world.getBlock(int(pos[0]), int(pos[1]), int(pos[2]));
        if (this.registry.opaque[b1]) mask |= (1 << (2 * d + 1));
        pos[d] += 1;
      }
      move = pos[0] !== this.highlightPosition[0] ||
             pos[1] !== this.highlightPosition[1] ||
             pos[2] !== this.highlightPosition[2];
      this.highlightMask[0] = mask;
      Vec3.copy(this.highlightPosition, pos);
      return false;
    };

    const buffer = 1 / kSweepResolution;
    const x = Math.floor(target[0] * kSweepResolution) / kSweepResolution;
    const y = Math.floor(target[1] * kSweepResolution) / kSweepResolution;
    const z = Math.floor(target[2] * kSweepResolution) / kSweepResolution;

    Vec3.set(kTmpMin, x - buffer, y - buffer, z - buffer);
    Vec3.set(kTmpMax, x + buffer, y + buffer, z + buffer);
    Vec3.scale(kTmpDelta, direction, 10);
    sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);

    for (let i = 0; i < 3; i++) {
      const impact = kTmpImpacts[i];
      if (impact === 0) continue;
      this.highlightSide = int(2 * i + (impact < 0 ? 0 : 1));
      break;
    }

    if (move) {
      const pos = this.highlightPosition;
      this.highlight.setPosition(pos[0], pos[1], pos[2]);
    }
    this.highlight.show(this.highlightMask, true);
  }

  private updateOverlayColor(wave: number): void {
    const [x, y, z] = this.renderer.camera.position;
    const xi = int(Math.floor(x));
    const yi = int(Math.floor(y));
    const zi = int(Math.floor(z));
    let boundary = 1;

    // We should only apply wave if the block above a liquid is an air block.
    const new_block = ((): BlockId => {
      const below = this.getRenderBlock(xi, yi, zi);
      if (below === kEmptyBlock) return below;
      const above = this.getRenderBlock(xi, int(yi + 1), zi);
      if (above !== kEmptyBlock) return below;
      const delta = y + wave - yi - 1;
      boundary = Math.abs(delta);
      return delta > 0 ? kEmptyBlock : below;
    })();

    const old_block = this.cameraBlock;
    this.cameraBlock = new_block;

    const max = kMinZUpperBound;
    const min = kMinZLowerBound;
    const minZ = Math.max(Math.min(boundary / 2, max), min);
    this.renderer.camera.setMinZ(minZ);

    if (new_block === kEmptyBlock) {
      const changed = new_block !== old_block;
      if (changed) this.renderer.setOverlayColor(kWhite);
      return;
    }

    if (new_block !== old_block) {
      const material = this.registry.getBlockFaceMaterial(new_block, 3);
      const color = material !== kNoMaterial
        ? this.registry.getMaterialData(material).color
        : kWhite;
      this.cameraColor = color.slice() as Color;
      this.cameraAlpha = color[3];
    }

    const falloff = (() => {
      const max = 2, step = 32;
      const limit = max * step;
      for (let i = 1; i < limit; i++) {
        const other = this.world.getBlock(xi, int(yi + i), zi);
        if (other !== new_block) return Math.pow(2, i / step);
      }
      return Math.pow(2, max);
    })();
    this.cameraColor[3] = 1 - (1 - this.cameraAlpha) / falloff;
    this.renderer.setOverlayColor(this.cameraColor);
  }
};

//////////////////////////////////////////////////////////////////////////////

export {BlockId, MaterialId, Column, Env};
export {kChunkWidth, kEmptyBlock, kNoMaterial, kWorldHeight};
