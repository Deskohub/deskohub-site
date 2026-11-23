/**
 * Whether `record` holds its own entry for each of `keys`, which TypeScript
 * can't tell of a record built from the keys at run time.
 */
export const hasEveryKey = <Key extends string, Value>(
  record: Readonly<Record<string, Value>>,
  keys: ReadonlyArray<Key>
): record is Readonly<Record<Key, Value>> =>
  keys.every((key) => Object.hasOwn(record, key));
