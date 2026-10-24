// For the importers' tests: what a fake client's create records, once it has
// checked that the create names an id minted for it. A create that names none
// throws, so an importer that stops minting fails every test that writes
// (R2-RULES-5). Imported by tests only.

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The id a create names, after checking it is a UUIDv7. */
export function mintedId(id, what) {
  if (typeof id !== 'string' || !UUIDV7.test(id)) {
    throw new Error(`${what} sent without a minted id`);
  }
  return id;
}

/** A bulk create's specs without their ids, after checking each has one. */
export const mintedSpecs = (specs, what) =>
  specs.map(({ id, ...spec }) => {
    mintedId(id, what);
    return spec;
  });
