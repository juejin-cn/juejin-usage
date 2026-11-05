// Objects are unordered; arrays, numeric amounts, null and missing fields are
// contract data. There is deliberately no blanket timestamp/epsilon filter.
export function firstDifference(expected, actual, path = '$') {
  if (Object.is(expected, actual)) return null;
  if (typeof expected !== typeof actual || expected === null || actual === null) return path;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return path;
    for (let i = 0; i < expected.length; i++) {
      const diff = firstDifference(expected[i], actual[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (typeof expected === 'object') {
    const keys = Object.keys(expected).sort();
    if (keys.join('\0') !== Object.keys(actual).sort().join('\0')) return `${path} (keys)`;
    for (const key of keys) {
      const diff = firstDifference(expected[key], actual[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return path;
}
