import { Buffer } from "node:buffer";

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("RFC 8785 JSON string contains an unpaired surrogate");
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("RFC 8785 JSON string contains an unpaired surrogate");
    }
  }
}

function serialize(value, ancestors) {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      assertUnicodeScalarString(value);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("RFC 8785 JSON numbers must be finite");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`RFC 8785 requires JSON values, received ${typeof value}`);
  }

  if (ancestors.has(value)) throw new TypeError("RFC 8785 JSON value must not be cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("RFC 8785 requires JSON arrays without holes");
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("RFC 8785 requires plain JSON objects");
    }
    const symbolKeys = Object.getOwnPropertySymbols(value)
      .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
    if (symbolKeys.length > 0) throw new TypeError("RFC 8785 JSON objects cannot contain symbol keys");

    const keys = Object.keys(value).sort();
    const properties = [];
    for (const key of keys) {
      assertUnicodeScalarString(key);
      properties.push(`${JSON.stringify(key)}:${serialize(value[key], ancestors)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return serialize(value, new Set());
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}
