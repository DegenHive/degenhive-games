// A small JSON Schema validator for the subset our schemas use, plus the game.json
// rules a schema cannot express. No dependencies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA_DIR = fileURLToPath(new URL("../../../schemas/", import.meta.url));

export function loadSchema(name) {
  return JSON.parse(readFileSync(SCHEMA_DIR + name, "utf8"));
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => {
      if (!node || !(key in node)) throw new Error(`unresolved $ref ${ref}`);
      return node[key];
    }, root);
}

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const cps = (s) => [...s].length;

/**
 * Validates `value` against `schema`. Returns a list of { path, message }; empty means valid.
 */
export function validate(schema, value, root = schema, path = "") {
  const errors = [];
  const err = (message, p = path) => errors.push({ path: p || "/", message });

  if (schema === true) return errors;
  if (schema === false) {
    err("is not allowed");
    return errors;
  }
  if (schema.$ref) errors.push(...validate(resolveRef(root, schema.$ref), value, root, path));

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      err(`must be ${types.join(" or ")}`);
      return errors; // the rest of the keywords would only repeat this
    }
  }
  if ("const" in schema && !deepEqual(value, schema.const)) err(`must be ${show(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    err(`must be one of: ${schema.enum.map(show).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && cps(value) < schema.minLength) {
      err(schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && cps(value) > schema.maxLength) {
      err(`must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      err(`does not match the required format (${schema.pattern})`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      err(`must be more than ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      err(`must be less than ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      err(`needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const v of value) {
        const k = JSON.stringify(v);
        if (seen.has(k)) err(`has ${show(v)} twice`);
        seen.add(k);
      }
    }
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}/${i}`)));
  }

  if (typeOf(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) err(`is missing "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (key in props) errors.push(...validate(props[key], v, root, `${path}/${key}`));
      else if (schema.additionalProperties === false) err(`has an unknown field "${key}"`, `${path}/${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}/${key}`));
      }
    }
  }

  for (const sub of schema.allOf || []) errors.push(...validate(sub, value, root, path));
  if (schema.anyOf) {
    const runs = schema.anyOf.map((sub) => validate(sub, value, root, path));
    if (!runs.some((r) => r.length === 0)) {
      // Report the branch that got furthest: the fewest errors that are not a plain type mismatch.
      const best = runs
        .filter((r) => !(r.length === 1 && r[0].message.startsWith("must be ") && r[0].path === (path || "/")))
        .sort((a, b) => a.length - b.length)[0];
      if (best) errors.push(...best);
      else err("does not match any allowed form");
    }
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((sub) => validate(sub, value, root, path).length === 0).length;
    if (ok !== 1) err(ok === 0 ? "does not match any allowed form" : "matches more than one form");
  }
  if (schema.if !== undefined) {
    const pass = validate(schema.if, value, root, path).length === 0;
    if (pass && schema.then !== undefined) errors.push(...validate(schema.then, value, root, path));
    if (!pass && schema.else !== undefined) errors.push(...validate(schema.else, value, root, path));
  }

  // De-duplicate (allOf and $ref can report the same thing twice).
  const seen = new Set();
  return errors.filter((e) => {
    const k = e.path + "\u0000" + e.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

let gameSchema;
export function validateGameJson(game) {
  gameSchema ||= loadSchema("game.schema.json");
  return validate(gameSchema, game);
}

let assetsSchema;
export function validateAssetsJson(value) {
  assetsSchema ||= loadSchema("assets.schema.json");
  return validate(assetsSchema, value);
}

export function formatErrors(errors, file) {
  return errors.map((e) => `${file}${e.path === "/" ? "" : " " + e.path}: ${e.message}`);
}
