import { Button, Label, SearchField } from '@heroui/react';
import { useState } from 'react';

const PREVIEW_LIMIT = 24;
const SEARCH_THRESHOLD = 8;

export function useGatewayModelBrowser(models: string[], nameOf: (id: string) => string = id => id, limit = PREVIEW_LIMIT) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? models.filter(id => id.toLowerCase().includes(needle) || nameOf(id).toLowerCase().includes(needle)) : models;
  const shown = needle || expanded ? filtered : filtered.slice(0, limit);
  return { query, setQuery, filtered, shown, expanded, setExpanded, limit, searchable: models.length > SEARCH_THRESHOLD, hidden: filtered.length - shown.length };
}

type Browser = ReturnType<typeof useGatewayModelBrowser>;

export function GatewayModelSearch({ browser, isDisabled }: { browser: Browser; isDisabled?: boolean }) {
  if (!browser.searchable) return null;
  return <SearchField value={browser.query} onChange={browser.setQuery} isDisabled={isDisabled}>
    <Label className="sr-only">搜索模型</Label>
    <SearchField.Group className="h-8! min-h-8!">
      <SearchField.SearchIcon />
      <SearchField.Input className="text-xs!" placeholder="搜索模型" />
      <SearchField.ClearButton />
    </SearchField.Group>
  </SearchField>;
}

export function GatewayModelExpand({ browser }: { browser: Browser }) {
  if (browser.query.trim() || browser.filtered.length <= browser.limit) return null;
  return <Button size="sm" variant="ghost" className="transform-none! h-7 justify-self-start px-2 text-xs text-muted" onPress={() => browser.setExpanded(value => !value)}>
    {browser.expanded ? '收起' : `展开其余 ${browser.hidden} 个`}
  </Button>;
}
