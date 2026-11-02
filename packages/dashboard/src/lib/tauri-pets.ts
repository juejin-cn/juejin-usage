export interface PetDefinition {
  id: string;
  displayName: string;
  description?: string;
  source: 'builtin' | 'local' | 'remote';
  previewUrl?: string;
}
export interface PetCatalog {
  pets: PetDefinition[];
  invalidPets?: {directory:string;reason:string}[];
  error?: string;
}
export async function petRequest<T>(suffix = '', body?: object): Promise<T> {
  const response = await fetch(`/functions/tud-desktop-pets${suffix}`, body ? {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  } : undefined);
  const value = await response.json();
  if(!response.ok || !value.success)throw new Error(value.message ?? '宠物操作失败');
  return value.data;
}
