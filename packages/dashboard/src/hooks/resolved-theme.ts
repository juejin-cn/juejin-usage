import { createContext } from 'react';
import type { Theme } from '@/lib/theme';

export const ResolvedThemeContext = createContext<Theme>('light');
