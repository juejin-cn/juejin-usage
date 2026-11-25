export type ReceiptThemeId =
  | 'classic'
  | 'paper'
  | 'kraft'
  | 'juejin'
  | 'obsidian';

export type ReceiptTextureKind =
  | 'none'
  | 'paper'
  | 'kraft'
  | 'grid'
  | 'carbon';

export interface ReceiptTheme {
  id: ReceiptThemeId;
  label: string;
  chassisTop: string;
  chassisBottom: string;
  chassisStroke: string;
  panelFill: string;
  panelStroke: string;
  slotTop: string;
  slotBottom: string;
  slotShadowOpacity: number;
  statusText: string;
  ledColor: string;
  paperTop: string;
  paperBottom: string;
  paperStroke: string;
  /** Solid representative paper color used for icon cutout blending. */
  paperFlat: string;
  texture: ReceiptTextureKind;
  inkPrimary: string;
  inkSecondary: string;
  inkTertiary: string;
  inkMuted: string;
  inkDivider: string;
  inkAccent: string;
  avatarBg: string;
  avatarStroke: string;
  shadowColor: string;
  shadowOpacity: number;
  swatchBg: string;
  swatchAccent: string;
  swatchBorder: string;
}

export const RECEIPT_THEMES: readonly ReceiptTheme[] = [
  {
    id: 'classic',
    label: '经典热敏',
    chassisTop: '#f3f3f5',
    chassisBottom: '#e6e6eb',
    chassisStroke: '#dcdce2',
    panelFill: '#ffffff',
    panelStroke: '#ececf0',
    slotTop: '#1b1b1f',
    slotBottom: '#46464d',
    slotShadowOpacity: 0.14,
    statusText: '#6e6e73',
    ledColor: '#34c759',
    paperTop: '#ffffff',
    paperBottom: '#fcfcfd',
    paperStroke: '#e8eaef',
    paperFlat: '#ffffff',
    texture: 'none',
    inkPrimary: '#18181b',
    inkSecondary: '#52525b',
    inkTertiary: '#8e8e93',
    inkMuted: '#a1a1aa',
    inkDivider: '#d4d4d8',
    inkAccent: '#18181b',
    avatarBg: '#f4f4f6',
    avatarStroke: '#e4e4e7',
    shadowColor: '#18181b',
    shadowOpacity: 0.08,
    swatchBg: '#ffffff',
    swatchAccent: '#18181b',
    swatchBorder: '#e4e4e7',
  },
  {
    id: 'paper',
    label: '模拟纸',
    chassisTop: '#ede6d8',
    chassisBottom: '#dfd6c5',
    chassisStroke: '#d4c9b5',
    panelFill: '#faf6ee',
    panelStroke: '#e6dece',
    slotTop: '#2a231c',
    slotBottom: '#50453a',
    slotShadowOpacity: 0.16,
    statusText: '#6d6255',
    ledColor: '#4da362',
    paperTop: '#fbf7ee',
    paperBottom: '#f2ead9',
    paperStroke: '#e2d7c2',
    paperFlat: '#f7f1e4',
    texture: 'paper',
    inkPrimary: '#2a221a',
    inkSecondary: '#594c3e',
    inkTertiary: '#857766',
    inkMuted: '#9e907e',
    inkDivider: '#cfc2ac',
    inkAccent: '#2a221a',
    avatarBg: '#ede4d3',
    avatarStroke: '#d8ccb7',
    shadowColor: '#3d2f1e',
    shadowOpacity: 0.1,
    swatchBg: '#f6efe0',
    swatchAccent: '#3d3022',
    swatchBorder: '#dfd3bc',
  },
  {
    id: 'kraft',
    label: '牛皮纸',
    chassisTop: '#ccb594',
    chassisBottom: '#b89d79',
    chassisStroke: '#a98d68',
    panelFill: '#e6d5ba',
    panelStroke: '#c9b290',
    slotTop: '#2b1c10',
    slotBottom: '#513722',
    slotShadowOpacity: 0.22,
    statusText: '#5e432b',
    ledColor: '#e5921a',
    paperTop: '#e0c79f',
    paperBottom: '#cfa977',
    paperStroke: '#bc9562',
    paperFlat: '#d8ba8d',
    texture: 'kraft',
    inkPrimary: '#331f10',
    inkSecondary: '#593a21',
    inkTertiary: '#785538',
    inkMuted: '#8a6646',
    inkDivider: '#a98357',
    inkAccent: '#331f10',
    avatarBg: '#cdb084',
    avatarStroke: '#b28e5f',
    shadowColor: '#3a220e',
    shadowOpacity: 0.16,
    swatchBg: '#d7b88b',
    swatchAccent: '#3b2412',
    swatchBorder: '#bc9765',
  },
  {
    id: 'juejin',
    label: '掘金蓝',
    chassisTop: '#e8f2ff',
    chassisBottom: '#d6e7ff',
    chassisStroke: '#c2dafc',
    panelFill: '#f7fbff',
    panelStroke: '#d8e8ff',
    slotTop: '#0d274d',
    slotBottom: '#234a82',
    slotShadowOpacity: 0.16,
    statusText: '#496a99',
    ledColor: '#1f80ff',
    paperTop: '#f7fbff',
    paperBottom: '#eaf3ff',
    paperStroke: '#cfe1fc',
    paperFlat: '#f0f7ff',
    texture: 'grid',
    inkPrimary: '#0e2954',
    inkSecondary: '#305282',
    inkTertiary: '#5d7ca8',
    inkMuted: '#7e9bc2',
    inkDivider: '#b7d0f2',
    inkAccent: '#1f80ff',
    avatarBg: '#dcebff',
    avatarStroke: '#bfd8fa',
    shadowColor: '#103b7a',
    shadowOpacity: 0.1,
    swatchBg: '#edf5ff',
    swatchAccent: '#1f80ff',
    swatchBorder: '#c5ddfc',
  },
  {
    id: 'obsidian',
    label: '暗夜碳黑',
    chassisTop: '#2b2b33',
    chassisBottom: '#1e1e24',
    chassisStroke: '#383842',
    panelFill: '#151519',
    panelStroke: '#2d2d36',
    slotTop: '#050507',
    slotBottom: '#19191f',
    slotShadowOpacity: 0.45,
    statusText: '#9c9ca8',
    ledColor: '#34d399',
    paperTop: '#1d1d23',
    paperBottom: '#15151a',
    paperStroke: '#2d2d36',
    paperFlat: '#19191f',
    texture: 'carbon',
    inkPrimary: '#f4f4f6',
    inkSecondary: '#c4c4ce',
    inkTertiary: '#8e8e9c',
    inkMuted: '#6f6f7d',
    inkDivider: '#343440',
    inkAccent: '#ffffff',
    avatarBg: '#272730',
    avatarStroke: '#3a3a47',
    shadowColor: '#000000',
    shadowOpacity: 0.36,
    swatchBg: '#1b1b21',
    swatchAccent: '#ffffff',
    swatchBorder: '#353540',
  },
] as const;

export function isReceiptThemeId(value: unknown): value is ReceiptThemeId {
  return RECEIPT_THEMES.some((theme) => theme.id === value);
}

export function getReceiptTheme(id: ReceiptThemeId): ReceiptTheme {
  return RECEIPT_THEMES.find((theme) => theme.id === id) ?? RECEIPT_THEMES[0]!;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return [
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0,
  ];
}
