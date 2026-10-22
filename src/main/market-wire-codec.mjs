// hmc1 is immutable: append a NEW version for schema changes. Mirrored in the
// desktop shared module (byte equality is covered by the protocol tests).
export const MARKET_WIRE_CODEC = "hmc1";
const schemas = Object.freeze([
  ["e", "E", "s", "a", "p", "q", "f", "l", "T", "m", "M"], // aggTrade
  ["e", "E", "s", "k"], // kline
  ["e", "E", "s", "p", "P", "w", "x", "c", "Q", "b", "B", "a", "A", "o", "h", "l", "v", "q", "O", "C", "F", "L", "n"], // ticker
  ["e", "E", "s", "c", "o", "h", "l", "v", "q"], // miniTicker
  ["e", "u", "s", "b", "B", "a", "A", "T", "E"], // bookTicker
  ["e", "E", "s", "p", "i", "P", "r", "T"], // markPrice
  ["t", "T", "s", "i", "f", "L", "o", "c", "h", "l", "v", "n", "x", "q", "V", "Q", "B"], // nested candle
]);
const schemaIds = { aggTrade: 0, kline: 1, "24hrTicker": 2, "24hrMiniTicker": 3, bookTicker: 4, markPriceUpdate: 5 };
const fields = schemas.map((keys) => new Set(keys));

function packObject(value, schemaId) {
  const keys = schemas[schemaId];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields[schemaId].has(key))) return null;
  let mask = 0;
  const values = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!Object.hasOwn(value, key)) continue;
    let item = value[key];
    if (schemaId === 1 && key === "k") {
      item = packObject(item, 6);
      if (!item) return null;
    }
    mask |= 1 << index;
    values.push(item);
  }
  return [mask, ...values];
}

export function compactMarketPayload(event, combined) {
  const type = event.data?.e;
  const schemaId = Object.hasOwn(schemaIds, type) ? schemaIds[type]
    : (event.data?.u != null && event.data?.b != null && event.data?.a != null ? 4 : undefined);
  if (schemaId === undefined) return null;
  const packed = packObject(event.data, schemaId);
  return packed ? [MARKET_WIRE_CODEC, combined ? event.stream : null, schemaId, ...packed] : null;
}

function unpackObject(packed, schemaId) {
  const keys = schemas[schemaId];
  const mask = packed[0];
  if (!keys || !Number.isSafeInteger(mask) || mask < 0 || mask >= 2 ** keys.length) throw new TypeError("Invalid market frame mask");
  const value = {};
  let cursor = 1;
  for (let index = 0; index < keys.length; index++) {
    if (!(mask & (1 << index))) continue;
    if (cursor >= packed.length) throw new TypeError("Truncated market frame");
    const item = packed[cursor++];
    value[keys[index]] = schemaId === 1 && keys[index] === "k" ? unpackObject(item, 6) : item;
  }
  if (cursor !== packed.length) throw new TypeError("Extra market frame values");
  return value;
}

export function decodeMarketPayload(payload) {
  if (!Array.isArray(payload) || payload[0] !== MARKET_WIRE_CODEC) return payload;
  if (payload.length < 4 || !(payload[1] === null || typeof payload[1] === "string") ||
      !Number.isInteger(payload[2]) || payload[2] < 0 || payload[2] > 5) throw new TypeError("Invalid market frame");
  const data = unpackObject(payload.slice(3), payload[2]);
  return payload[1] === null ? data : { stream: payload[1], data };
}
