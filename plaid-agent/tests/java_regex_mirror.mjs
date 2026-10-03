// plaid-ui's pattern translator (src/domain/javaRegex.js), run over the cases
// test_java_regex.py writes, so the agent's copy (core/java_regex.py) can be
// compared with it: the same pattern sent to the server, or the same refusal.
//
// Reads a JSON array of [pattern, options] as argv[2] and writes, for each,
// {server, error} to stdout.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../plaid-ui/src");
const { translatePattern } = await import(
  pathToFileURL(resolve(SRC, "domain/javaRegex.js")).href
);

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify(
    cases.map(([p, o]) => {
      const { server, error } = translatePattern(p, o);
      return { server, error };
    }),
  ),
);
