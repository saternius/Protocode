// Creates a pink cube under Root mirroring Root/PinkCube's component layout.
// Returns "cube created" via fnCompleted.

if (!client) {
  log('no ResoniteLink client — is protocode.resonitelinkPort configured?');
  fnCompleted('no client');
  return;
}

log('creating PinkCube slot under Root');
const slot = await client.addSlot('Root', 'PinkCube', { position: { x: 0, y: 1, z: 0 } });
log('slot id=' + slot.id);

// Add all 6 components in the exact order Root/PinkCube uses.
const boxMesh   = await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.BoxMesh');
const renderer  = await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.MeshRenderer');
const collider  = await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.BoxCollider');
const valueCopy = await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.ValueCopy<float3>');
await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.Grabbable');
const material  = await client.addComponent(slot.id, '[FrooxEngine]FrooxEngine.PBS_Metallic');

// Set the pink AlbedoColor (exact values from the reference cube).
await client.updateComponent(material.id, {
  AlbedoColor: {
    $type: 'colorX',
    value: { r: 1, g: 0.48388755, b: 0.7291229, a: 1, profile: 'sRGB' },
  },
});

// Wire the MeshRenderer: Mesh -> BoxMesh, Materials -> [PBS_Metallic].
await client.updateComponent(renderer.id, {
  Mesh: { $type: 'reference', targetId: boxMesh.id },
  Materials: {
    $type: 'list',
    elements: [{ $type: 'reference', targetId: material.id }],
  },
});

// ValueCopy<float3> needs field IDs (not component IDs) for Source/Target.
// Fetch both components to discover the Size member's field id.
const boxMeshFull  = await client.getComponent(boxMesh.id);
const colliderFull = await client.getComponent(collider.id);
const boxMeshSizeFieldId  = boxMeshFull.members.Size.id;
const colliderSizeFieldId = colliderFull.members.Size.id;

await client.updateComponent(valueCopy.id, {
  Source: { $type: 'reference', targetId: boxMeshSizeFieldId },
  Target: { $type: 'reference', targetId: colliderSizeFieldId },
});

log('cube created at slot ' + slot.id);
fnCompleted('cube created');
