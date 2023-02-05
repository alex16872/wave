#pragma once

#include <array>
#include <cassert>
#include <ranges>
#include <vector>

#include "base.h"
#include "renderer.h"

//////////////////////////////////////////////////////////////////////////////

namespace voxels {

//////////////////////////////////////////////////////////////////////////////

struct MesherOffset {
  Point delta;
  Point dstPos;
  Point srcPos;
  Point size;
};

constexpr auto W = kChunkWidth;
constexpr auto L = kChunkWidth - 1;
constexpr auto N = kChunkWidth + 1;
constexpr MesherOffset kMesherOffsets[9] = {
  {{ 0,  0}, {1, 1}, {0, 0}, {W, W}},
  {{-1,  0}, {0, 1}, {L, 0}, {1, W}},
  {{ 1,  0}, {N, 1}, {0, 0}, {1, W}},
  {{ 0, -1}, {1, 0}, {0, L}, {W, 1}},
  {{ 0,  1}, {1, N}, {0, 0}, {W, 1}},
  {{-1, -1}, {0, 0}, {L, L}, {1, 1}},
  {{-1,  1}, {0, N}, {L, 0}, {1, 1}},
  {{ 1, -1}, {N, 0}, {0, L}, {1, 1}},
  {{ 1,  1}, {N, N}, {0, 0}, {1, 1}},
};

//////////////////////////////////////////////////////////////////////////////

struct Material { uint8_t id; };

struct MaybeMaterial {
  uint8_t id;

  constexpr bool operator==(const MaybeMaterial& o) const { return id == o.id; }
  constexpr bool operator!=(const MaybeMaterial& o) const { return id != o.id; }
};

constexpr MaybeMaterial kNoMaterial = {0};
constexpr Material assertMaterialUnsafe(MaybeMaterial m) {
  return Material{static_cast<uint8_t>(m.id - 1)};
}
constexpr Material assertMaterial(MaybeMaterial m) {
  assert(m != kNoMaterial);
  return Material{static_cast<uint8_t>(m.id - 1)};
}

struct MaterialData {
  bool liquid;
  bool alphaTest;
  uint8_t texture;
  double color[4];
};

struct BlockData {
  bool opaque;
  bool solid;
  int8_t light;
  MaybeMaterial faces[6];
};

struct Registry {
  static_assert(sizeof(Block) == 1);
  static_assert(sizeof(Material) == 1);

  Registry() {}

  void addBlock(Block block, BlockData data) {
    assert(static_cast<size_t>(block) == numBlocks);
    assert(static_cast<size_t>(block) < blocks.size());
    blocks[numBlocks++] = data;
  }

  void addMaterial(Material material, MaterialData data) {
    assert(material.id == numMaterials);
    assert(material.id < materials.size());
    materials[numMaterials++] = data;
  }

  const BlockData& getBlock(Block block) const {
    assert(static_cast<size_t>(block) < numBlocks);
    return getBlockUnsafe(block);
  }

  const BlockData& getBlockUnsafe(Block block) const {
    return blocks[static_cast<size_t>(block)];
  }

  const MaterialData& getMaterial(Material material) const {
    assert(material.id < numMaterials);
    return getMaterialUnsafe(material);
  }

  const MaterialData& getMaterialUnsafe(Material material) const {
    return materials[material.id];
  }

 private:
  size_t numBlocks = 0;
  size_t numMaterials = 0;

  std::array<BlockData, 256> blocks;
  std::array<MaterialData, 256> materials;

  DISALLOW_COPY_AND_ASSIGN(Registry);
};

struct Mesher {
  Mesher(const Registry& r);

  void meshChunk();

 private:
  using Quad  = VoxelMesh::Quad;
  using Quads = VoxelMesh::Quads;

  void addQuad(Quads* quads, const MaterialData& material, int dir, int ao,
               int wave, int d, int w, int h, const std::array<int, 3>& pos);
  void computeChunkGeometry(int y_min, int y_max);

  bool getTriangleHint(int ao) const;
  int getFaceDir(Block block0, Block block1, int face) const;
  int packAOMask(int ipos, int ineg, int dj, int dk) const;

 public:
  // meshChunk inputs: set up these values prior to the call.
  MeshTensor1<uint8_t> equilevels;
  MeshTensor2<uint8_t> heightmap;
  MeshTensor3<Block> voxels;

  // meshChunk outputs: read these values after the call.
  std::vector<Quad> solid_geo;
  std::vector<Quad> water_geo;

 private:
  const Registry& registry;
  std::vector<int> mask_data;
  std::vector<int> mask_union;

  DISALLOW_COPY_AND_ASSIGN(Mesher);
};

//////////////////////////////////////////////////////////////////////////////

} // namespace voxels
