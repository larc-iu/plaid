// A TypeScript consumer of the generated declarations, type-checked under
// `strict` by test/types.test.js. Each line holds a type the hand-written
// index.d.ts used to give, so the generated set cannot quietly weaken: an
// answer that turns into `any` fails a `NotAny` check or makes a
// `@ts-expect-error` line unused, and either fails the check.
import { PlaidClient } from "./dts/index.js";

type IsAny<T> = 0 extends 1 & T ? true : false;
// Compiles only for a T that is not `any`.
const notAny = <T>(
  _value: T,
  _check: IsAny<T> extends false ? true : never,
): void => {};

export async function use(c: PlaidClient): Promise<void> {
  // Constraint answers.
  const checked = await c.spanLayers.checkConstraints("L", [
    { type: "single-span" },
  ]);
  const kinds: string[] = checked.violations.map((v) => v.constraint);
  const count: number = checked.violationCount;
  const repaired = await c.tokenLayers.repairConstraints("L", []);
  const deleted: number = repaired.repaired.reduce(
    (n, r) => n + r.deleted + r.joined,
    0,
  );
  const lockedBy: string[] = repaired.locked.map((l) => l.lockedBy);
  const set = await c.relationLayers.setConstraints("L", "igt", []);
  const igt = set.constraints["igt"];
  notAny(igt, true);
  const types: string[] = (igt ?? []).map((k) => k.type);
  const refused = await c.spanLayers.refusedValues(
    "L",
    { values: ["N"], delimiters: ".", parts: "all" },
    { limit: 5 },
  );
  const refusedN: number = refused.count + refused.valueCount;
  const refusedParts: string[][] = refused.values.map((v) => v.parts);
  const refusedTimes: number[] = refused.values.map((v) => v.count);
  // @ts-expect-error a token layer holds no value-set rule
  c.tokenLayers.refusedValues;

  // audit.tally's rows.
  const rows = await c.audit.tally();
  const who: string = rows[0].user.id;
  const shown: string | undefined = rows[0].user.displayName;

  // The family methods answer Promises.
  const meta = c.spans.setMetadata("s", {});
  // @ts-expect-error a forgotten await: a Promise has no value
  void meta.value;
  // @ts-expect-error
  void c.tokens.patchMetadata("t", []).entries;
  // @ts-expect-error
  void c.documents.deleteMetadata("d").then2;
  // @ts-expect-error
  void c.projects.setConfig("p", "igt", "k", 1).value;
  // @ts-expect-error
  void c.vocabLayers.deleteConfig("v", "igt", "k").value;
  // @ts-expect-error
  void c.spanLayers.get("L").name;
  // @ts-expect-error
  void c.tokenLayers.delete("L").ok;
  // @ts-expect-error
  void c.textLayers.update("L", "n").name;
  // @ts-expect-error
  void c.relationLayers.shift("L", "up").ok;
  // @ts-expect-error
  void c.spanLayers.deleteConstraints("L", "igt").ok;
  const awaited: unknown = await c.vocabLinks.setMetadata("l", {});

  // userData.get's entry.
  const entry = await c.userData.get("u", "k");
  const version: number = entry.version;
  const updatedAt: string = entry.updatedAt;
  // @ts-expect-error no such field on an entry
  void entry.nonexistentField;

  // Private members are not part of the surface.
  // @ts-expect-error
  void c._request;
  // @ts-expect-error
  void c._postBatch;
  // @ts-expect-error
  void c._retryListeners;
  // @ts-expect-error
  void c._serverFacts;
  // @ts-expect-error
  void c._installResources;
  // @ts-expect-error
  void c._noteRetry;

  // The client's own settings.
  c.timeout = null;
  c.batchTimeout = null;
  c.timeout = 5000;

  // Named answers.
  notAny(await c.server.health(), true);
  notAny(await c.server.limits(), true);
  notAny(await c.admin.server(), true);
  notAny(await c.admin.backup(), true);
  notAny(await c.admin.rateLimits(), true);
  notAny(await c.admin.logs(), true);
  const locks = await c.admin.locks();
  const lockHolder: string = locks.entries[0].userId;
  notAny(await c.admin.userData(), true);
  notAny(await c.comments.get("c"), true);
  notAny(await c.comments.list("p"), true);
  notAny(await c.comments.listPage("p"), true);
  notAny(await c.guidelines.get("g"), true);
  notAny(await c.events.list("p"), true);
  notAny(await c.invites.list(), true);
  notAny(await c.messages.discoverServices("p"), true);
  notAny(
    await c.vocabLayers.restoreItem("v", "i", "2026-01-01T00:00:00Z"),
    true,
  );
  const edits: Record<string, string> = await c.projects.myLastEdits("p");
  const counts: Record<string, number> = await c.comments.counts("p");
  notAny(c.batch(), true);
  notAny(c.keySeed(), true);

  // Entity reads and writes answer the entity, a create its id, and a write
  // with no body nothing.
  const relation = await c.relations.get("r");
  const ends: string[] = [relation.layer, relation.source, relation.target];
  // @ts-expect-error a relation names its ends source and target
  void relation.sourceId;
  const made: string = (await c.relations.create("rl", "s", "t", "dep")).id;
  const label: string | number | boolean | null = (
    await c.spans.update("s", "N")
  ).value;
  const spanTokens: string[] = (await c.spans.setMetadata("s", {})).tokens;
  const tokenText: string = (await c.tokens.patchMetadata("t", [])).text;
  const linked: string = (await c.vocabLinks.setMetadata("l", {})).vocabItem;
  const form: string = (await c.vocabItems.deleteMetadata("i")).form;
  const docVersion: number = (await c.documents.get("d")).version;
  const sentences = (await c.documents.get("d", true)).textLayers ?? [];
  const relationsRead: string[] = sentences.flatMap((tl) =>
    tl.tokenLayers.flatMap((kl) =>
      kl.spanLayers.flatMap((sl) =>
        sl.relationLayers.flatMap((rl) => rl.relations.map((r) => r.source)),
      ),
    ),
  );
  const digest: string = (await c.texts.edit("x", [])).reshape.deleted
    .relations[0];
  const maintainers: string[] = (await c.projects.get("p")).maintainers;
  const parent: string | null = (await c.tokenLayers.get("L")).parentTokenLayer;
  const overSpans: string = (await c.relationLayers.update("L", "n")).spanLayer;
  const vocabMaintainers: string[] = (await c.vocabLayers.get("v"))
    .maintainers;
  const admin: boolean = (await c.users.get("u")).isAdmin;
  const lockId: string = (await c.documents.acquireLock("d")).lockId;
  const restored: number = (await c.documents.restore("d", "t")).tokens
    .inserted;
  const right: string = (await c.tokens.split("t", 1)).id;
  const group: string | null = (await c.operationGroups.get("g")).message;
  const queried = await c.query({ find: ["?s"], where: [] });
  const queryCount: number = queried.count;
  const stats: number = c.messages.listen("p", () => {}).getStats()
    .durationSeconds;
  const nothing: void = await c.relations.delete("r");
  // @ts-expect-error a delete answers no body
  void (await c.spans.delete("s")).id;
  notAny(await c.projects.addWriter("p", "u"), true);
  notAny(await c.textLayers.shift("L", "up"), true);
  notAny(await c.users.getAvatar("u"), true);
  notAny(await c.messages.sendMessage("p", {}), true);

  // withOperation answers what its function does.
  const n: number = await c.withOperation("Op", async () => 1);
  // @ts-expect-error a number is not a string
  const s: string = await c.withOperation("Op", async () => 1);

  console.log(
    kinds,
    count,
    deleted,
    lockedBy,
    types,
    who,
    shown,
    awaited,
    version,
    updatedAt,
  );
  console.log(lockHolder, edits, counts, n, s);
  console.log(ends, made, label, spanTokens, tokenText, linked, form);
  console.log(docVersion, relationsRead, digest, maintainers, parent);
  console.log(overSpans, vocabMaintainers, admin, lockId, restored, right);
  console.log(group, queryCount, stats, nothing);
}
