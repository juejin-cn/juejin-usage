import { dotenvDocument, editDotenv } from './dotenv.js';
import { parse, parseTree, findNodeAtLocation, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser';
import { parseDocument, isMap, isSeq, isAlias, visit, type Document } from 'yaml';
import { RouterError } from '../config.js';
export type Selector = string | { field: string; value: string; where?: Record<string, string> };
export type KeyPath = Selector[];
export type Format = 'json' | 'toml' | 'yaml' | 'yaml-sequence' | 'dotenv';
export type Value = { present: boolean; value?: unknown };
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function document(text: string, format: Format): Record<string, any> {
  try {
    if (format === 'dotenv') return dotenvDocument(text);
    if (format === 'yaml' || format === 'yaml-sequence') return yamlDocument(text, format === 'yaml-sequence').toJS({ maxAliasCount: 0 });
    if (format === 'toml') return getStaticTOMLValue(parseTOML(text)) as Record<string, any>;
    const errors: ParseError[] = []; const result = parse(text || '{}', errors, { allowTrailingComma: true });
    if (errors.length || !result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409); }
}
/** Refuse ambiguous YAML rather than rewriting aliases or duplicate keys. */
function yamlDocument(text: string, sequence = false): Document {
  const doc = parseDocument(text || (sequence ? '[]' : '{}'));
  if (doc.contents === null && !doc.errors.length) return yamlDocument(text + (sequence ? '\n[]\n' : '\n{}\n'), sequence);
  if (doc.errors.length || !(sequence ? isSeq(doc.contents) : isMap(doc.contents))) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
  visit(doc, (_, node) => {
    if (isAlias(node) || node !== null && typeof node === 'object' && 'tag' in node && typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
  });
  return doc;
}
export function readValue(doc: any, path: KeyPath): Value {
  let value = doc;
  for (const segment of path) {
    if (typeof segment === 'object') {
      if (!Array.isArray(value)) return { present: false };
      const matches = value.filter(item => item?.[segment.field] === segment.value && Object.entries(segment.where ?? {}).every(([key, value]) => item?.[key] === value));
      if (matches.length > 1) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      value = matches[0];
      if (value === undefined) return { present: false };
    } else {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return { present: false };
      value = value[segment];
    }
  }
  return { present: true, value };
}
function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(tomlValue).join(', ') + ']';
  if (value && typeof value === 'object') return '{ ' + Object.entries(value).map(([key, v]) => `${JSON.stringify(key)} = ${tomlValue(v)}`).join(', ') + ' }';
  throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
}
function editToml(text: string, path: string[], desired: Value): string {
  const ast = parseTOML(text); let found: AST.TOMLKeyValue | undefined;
  const scan = (body: AST.TOMLKeyValue[], prefix: string[]) => {
    for (const node of body) {
      const keys = [...prefix, ...node.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)];
      if (equal(keys, path)) found = node;
      if (node.value.type === 'TOMLInlineTable') scan(node.value.body, keys);
    }
  };
  scan(ast.body[0].body.filter((n): n is AST.TOMLKeyValue => n.type === 'TOMLKeyValue'), []);
  for (const node of ast.body[0].body) if (node.type === 'TOMLTable' && node.kind === 'standard') scan(node.body, node.resolvedKey.map(String));
  let result: string;
  if (found) {
    if (desired.present) result = text.slice(0, found.value.range[0]) + tomlValue(desired.value) + text.slice(found.value.range[1]);
    else {
      if (found.parent.type === 'TOMLInlineTable') {
        const siblings = found.parent.body; const index = siblings.indexOf(found);
        const start = index ? siblings[index - 1].range[1] : found.range[0];
        const end = !index && siblings.length > 1 ? siblings[1].range[0] : found.range[1];
        result = text.slice(0, start) + text.slice(end);
      } else result = text.slice(0, found.range[0]) + text.slice(found.range[1]);
    }
  } else if (!desired.present) {
    // Removing the last leaf leaves an explicit TOML table behind. An empty
    // provider still exists semantically, so remove its declaration as well.
    const table = ast.body[0].body.find((n): n is AST.TOMLTable => n.type === 'TOMLTable' && n.kind === 'standard' && equal(n.resolvedKey, path));
    const current = readValue(document(text, 'toml'), path);
    if (!table || !current.present || !current.value || Object.keys(current.value).length) return text;
    const end = text.indexOf(']', table.key.range[1]) + 1;
    result = text.slice(0, table.range[0]) + text.slice(end);
  }
  else {
    const parent = path.slice(0, -1);
    // An existing inline ancestor must be edited structurally, not redeclared as a table.
    const inline = ast.body[0].body.flatMap(n => n.type === 'TOMLTable' ? n.body : [n]).find(n => {
      const prefix = n.parent.type === 'TOMLTable' ? n.parent.resolvedKey.map(String) : [];
      const keys = [...prefix, ...n.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)];
      return n.value.type === 'TOMLInlineTable' && keys.length < path.length && keys.every((key, i) => path[i] === key);
    });
    if (inline) {
      const prefix = inline.parent.type === 'TOMLTable' ? inline.parent.resolvedKey.map(String) : [];
      const keys = [...prefix, ...inline.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)];
      const object = structuredClone(getStaticTOMLValue(inline.value)) as any;
      let cursor = object;
      for (const key of path.slice(keys.length, -1)) { cursor[key] ??= {}; cursor = cursor[key]; }
      cursor[path.at(-1)!] = desired.value;
      result = text.slice(0, inline.value.range[0]) + tomlValue(object) + text.slice(inline.value.range[1]);
    } else {
      const table = ast.body[0].body.find((n): n is AST.TOMLTable => n.type === 'TOMLTable' && n.kind === 'standard' && equal(n.resolvedKey, parent));
      const entry = `${JSON.stringify(path.at(-1)!)} = ${tomlValue(desired.value)}\n`;
      if (!parent.length) result = entry + text;
      else if (table) {
        const at = table.range[1]; result = text.slice(0, at) + '\n' + entry + text.slice(at);
      } else result = text + '\n[' + parent.map(key => JSON.stringify(key)).join('.') + ']\n' + entry;
    }
  }
  document(result, 'toml'); return result;
}
export function editValue(text: string, format: Format, path: KeyPath, desired: Value): string {
  if (equal(readValue(document(text, format), path), desired)) return text;
  if (format === 'dotenv') {
    if (path.length !== 1 || typeof path[0] !== 'string') throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
    return editDotenv(text, path[0], desired);
  }
  if (format === 'yaml' || format === 'yaml-sequence') {
    try {
      const doc = yamlDocument(text, format === 'yaml-sequence');
      if (isSeq(doc.contents) && !doc.contents.items.length) doc.contents.flow = false;
      const resolved: (string | number)[] = [];
      for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        const current = doc.getIn(resolved, true);
        if (typeof segment === 'string') {
          if (!isMap(current)) throw new Error();
          resolved.push(segment);
        } else {
          if (!isSeq(current)) throw new Error();
          const matches = current.items.flatMap((item, index) => isMap(item) && item.get(segment.field) === segment.value && Object.entries(segment.where ?? {}).every(([key, value]) => item.get(key) === value) ? [index] : []);
          if (matches.length > 1) throw new Error();
          if (!matches.length) {
            if (!desired.present) return text;
            current.add(doc.createNode({ ...segment.where, [segment.field]: segment.value }));
          }
          resolved.push(matches[0] ?? current.items.length - 1);
        }
        if (i < path.length - 1 && !doc.hasIn(resolved)) {
          if (!desired.present) return text;
          doc.setIn(resolved, doc.createNode(typeof path[i + 1] === 'object' ? [] : {}));
        }
      }
      if (desired.present) doc.setIn(resolved, doc.createNode(desired.value));
      else if (doc.hasIn(resolved)) doc.deleteIn(resolved);
      const result = doc.toString();
      document(result, format);
      return text.includes('\r\n') ? result.replace(/\r?\n/g, '\r\n') : result;
    } catch { throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409); }
  }
  if (format === 'toml') return editToml(text, path as string[], desired);
  const doc = document(text, 'json'); const resolved: (string | number)[] = []; let cursor: any = doc;
  for (const segment of path) {
    if (typeof segment === 'string') { resolved.push(segment); cursor = cursor?.[segment]; }
    else {
      if (cursor !== undefined && !Array.isArray(cursor)) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      const matches = (cursor ?? []).map((item: any, i: number) => item?.[segment.field] === segment.value && Object.entries(segment.where ?? {}).every(([key, value]) => item?.[key] === value) ? i : -1).filter((i: number) => i >= 0);
      if (matches.length > 1) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      const index = matches[0] ?? -1;
      if (index < 0 && !desired.present) return text;
      if (index < 0 && cursor === undefined) {
        text = applyEdits(text || '{}', modify(text || '{}', resolved, [], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      }
      resolved.push(index); cursor = index < 0 ? undefined : cursor[index];
    }
  }
  if (!desired.present && typeof resolved.at(-1) === 'number') {
    const tree = parseTree(text)!; const node = findNodeAtLocation(tree, resolved);
    if (!node?.parent?.children) return text;
    const siblings = node.parent.children; const index = siblings.indexOf(node);
    const start = index > 0 ? siblings[index - 1].offset + siblings[index - 1].length : node.offset;
    const end = index === 0 && siblings.length > 1 ? siblings[1].offset : node.offset + node.length;
    const result = text.slice(0, start) + text.slice(end); document(result, 'json'); return result;
  }
  const result = applyEdits(text || '{}', modify(text || '{}', resolved, desired.present ? desired.value : undefined,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
  document(result, 'json'); return result;
}
