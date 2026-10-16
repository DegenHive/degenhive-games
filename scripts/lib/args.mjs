// Tiny argv parser: --key value, --key=value, --flag (true), --no-flag (false).
export function parseArgs(argv = process.argv.slice(2), { flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[camel(a.slice(2, eq))] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith("no-")) {
      out[camel(key.slice(3))] = false;
      continue;
    }
    const next = argv[i + 1];
    if (flags.includes(key) || next === undefined || next.startsWith("--")) {
      out[camel(key)] = true;
    } else {
      out[camel(key)] = next;
      i++;
    }
  }
  return out;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}
