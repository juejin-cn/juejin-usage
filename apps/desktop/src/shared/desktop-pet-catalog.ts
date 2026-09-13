export interface DesktopPetDefinition {
  id: string;
  displayName: string;
  description: string;
  glow: { primary: string; accent: string };
  /** builtin/local are selectable; remote needs install before use. */
  source: 'builtin' | 'local' | 'remote';
  /** Remote-only: raw spritesheet URL for Select idle-frame preview before install. */
  previewUrl?: string;
}

export interface DesktopPetCatalog {
  pets: DesktopPetDefinition[];
  invalidPets: Array<{ directory: string; reason: string }>;
  directory: string;
}
