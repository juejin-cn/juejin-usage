export interface DesktopPetDefinition {
  id: string;
  displayName: string;
  description: string;
  glow: { primary: string; accent: string };
  source: 'builtin' | 'local';
}

export interface DesktopPetCatalog {
  pets: DesktopPetDefinition[];
  invalidPets: Array<{ directory: string; reason: string }>;
  directory: string;
}
