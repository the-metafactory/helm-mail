import type { AdapterDeclaration } from "@the-metafactory/cortex/desk-sdk";

export function composeDeclaration(base: AdapterDeclaration, extra: AdapterDeclaration): AdapterDeclaration {
  if (base.adapterId !== extra.adapterId) throw new Error("Declarations must name the same adapter.");
  return {
    ...base,
    schemas: [...base.schemas, ...extra.schemas.filter(item => !base.schemas.some(old => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...extra.objectTypes.filter(item => !base.objectTypes.some(old => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...extra.capabilities],
  };
}
