import PlaidClient from '@larc-iu/plaid-client';
import {
  test,
  expect,
  seedAuth,
  readToken,
  collectClientErrors,
  cleanDiagnostics,
} from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { importUmrDocument } from '../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';

// The editing gestures, on a document of their own so the fixture corpus
// stays as imported. One sentence, the AnCast sample.
const SAMPLE = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:
(s1s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s1l)))


`;

// Two sentences with a coreference from the second back to the first, for
// what is drawn across sentences.
const TWO = `################################################################################
# :: snt1\tThe cat chased a mouse .
Index: 1 2 3 4 5 6
Words: The cat chased a mouse .

# sentence level graph:
(s1c / chase-01
    :ARG0 (s1c2 / cat)
    :ARG1 (s1m / mouse))

# alignment:
s1c: 3-3
s1c2: 2-2
s1m: 5-5

# document level annotation:
(s1s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s1c)))

################################################################################
# :: snt2\tIt escaped .
Index: 1 2 3
Words: It escaped .

# sentence level graph:
(s2e / escape-01
    :ARG0 (s2c / cat))

# alignment:
s2e: 2-2
s2c: 1-1

# document level annotation:
(s2s0 / sentence
    :coref ((s2c :same-entity s1c2)))


`;

const API = 'http://localhost:8085';

async function makeDocument(text = SAMPLE) {
  const { projectId } = await getFixture();
  const { token } = readToken();
  const client = new PlaidClient(API, token);
  const project = await client.projects.get(projectId);
  const name = `editing ${Date.now()}`;
  const { document } = await importUmrDocument(
    client,
    projectId,
    name,
    text,
    getUmrLayerInfo(project),
  );
  return { projectId, documentId: document.id, client };
}

const editor = (page) => page.locator('.umr-inline-editor input');
const nodeByConcept = (page, concept) =>
  page
    .locator('.umr-node')
    .filter({ has: page.locator('.umr-node-concept', { hasText: concept }) });

test.describe('editing', () => {
  let ids;
  test.beforeAll(async () => {
    ids = await makeDocument();
  });
  test.afterAll(async () => {
    if (ids) await ids.client.documents.delete(ids.documentId);
  });

  test('adds, renames, attributes, deletes and drags', async ({ page }) => {
    await seedAuth(page);
    const diag = collectClientErrors(page);
    await page.goto(`/#/projects/${ids.projectId}/documents/${ids.documentId}/annotate`);
    const block = page.locator('.umr-block').first();
    await expect(block.locator('.umr-edge-label').first()).toBeVisible();

    // Double-clicking a word asks for the concept rather than writing the
    // word itself: the picker opens prefilled, with the frame file's senses
    // of that word above it, and Escape leaves the document alone.
    await block.locator('.umr-word').nth(3).dblclick();
    await expect(editor(page)).toHaveValue('order');
    await expect(page.locator('[role="option"]', { hasText: /^order-01 / }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(nodeByConcept(page, 'order')).toHaveCount(0);

    // Tab from the root: word 7 (lunch) as :ARG1 of eat-01... from leave-02.
    const leave = nodeByConcept(page, 'leave-02');
    await leave.click();
    await page.keyboard.press('Tab');
    await expect(editor(page)).toBeVisible();
    await editor(page).fill('7');
    await page.keyboard.press('Enter');
    // The word is the anchor, not the concept: the concept is asked next,
    // with the word's senses. Enter keeps the form as typed.
    await expect(editor(page)).toHaveValue('lunch');
    await expect(page.locator('[role="option"]', { hasText: /^lunch-01 ARG/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveValue('');
    await editor(page).fill('ARG1');
    await page.keyboard.press('Enter');
    const lunch = nodeByConcept(page, 'lunch');
    await expect(lunch).toBeVisible();
    await expect(block.locator('.umr-edge-label', { hasText: ':ARG1' })).toBeVisible();
    // The new node is anchored to the word and focused. Hover outranks
    // focus for the word highlight, so the pointer leaves the graph first.
    await expect(lunch).toHaveClass(/umr-node--focused/);
    await page.mouse.move(2, 2);
    await expect(block.locator('.umr-word--lit .umr-word-text')).toHaveText('lunch');

    // Enter opens the concept with the frame file's senses of the word first.
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="option"]', { hasText: /^lunch-01 ARG/ })).toBeVisible();
    await editor(page).fill('lunch-01');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch-01')).toBeVisible();

    // `a` opens the attribute picker. A coarse aspect value reveals the finer
    // ones under it, every pick writes at once, and Escape closes it.
    await page.keyboard.press('a');
    const picker = page.getByRole('dialog', { name: 'Attributes' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'imperfective', exact: true }).click();
    await picker.getByRole('button', { name: 'state', exact: true }).click();
    await picker.getByRole('button', { name: 'singular', exact: true }).click();
    await expect(nodeByConcept(page, 'lunch-01').locator('.umr-chip-value')).toHaveText([
      'state',
      'singular',
    ]);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(nodeByConcept(page, 'lunch-01')).toBeFocused();

    // Shift+Backspace deletes the edge and the leaf it reached, no question.
    await page.keyboard.press('Shift+Backspace');
    await expect(nodeByConcept(page, 'lunch-01')).toHaveCount(0);
    await expect(leave).toHaveClass(/umr-node--focused/);

    // Drag the grip of eat-01 onto the word "lunch": a new anchored child.
    const eat = nodeByConcept(page, 'eat-01');
    await eat.hover();
    const grip = eat.locator('.umr-grip');
    const gripBox = await grip.boundingBox();
    const word = block.locator('.umr-word').nth(6);
    const wordBox = await word.boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2, {
      steps: 8,
    });
    await expect(word).toHaveClass(/umr-word--drop/);
    await page.mouse.up();
    await expect(editor(page)).toHaveValue('lunch');
    // The list opens under the pointer, and a hovered option is the one Enter
    // takes, so the pointer leaves first.
    await page.mouse.move(2, 2);
    await page.keyboard.press('Enter');
    // The role editor lists the parent's own arguments first.
    await expect(page.locator('[role="option"]', { hasText: /^:ARG1 / }).first()).toBeVisible();
    await editor(page).fill(':ARG1');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch')).toBeVisible();

    // Validation marks: the corpus sentence has no :temporal for its events,
    // so the header counts problems and a node wears a mark.
    await expect(block.locator('.umr-problems-toggle')).toBeVisible();
    await block.locator('.umr-problems-toggle').click();
    await expect(block.locator('.umr-problem').first()).toBeVisible();
    await expect(block.locator('.umr-node-mark').first()).toBeVisible();
    await block.locator('.umr-problems-toggle').click();

    // Text mode: the graph as PENMAN, a node added by typing, applied as one.
    await block.locator('.umr-text-toggle').click();
    const area = block.locator('textarea.umr-penman-text');
    await expect(area).toHaveValue(/^\(s1l \/ leave-02/);
    const typed = (await area.inputValue()).replace(
      ':purpose (s1e / eat-01',
      ':purpose (s1e / eat-01 :time (s1t / today)',
    );
    await area.fill(typed);
    await expect(block.locator('.umr-penman-status')).toContainText('Changed');
    await block.getByRole('button', { name: 'Apply' }).click();
    await expect(nodeByConcept(page, 'today')).toBeVisible();
    await expect(block.locator('.umr-edge-label', { hasText: ':time' })).toBeVisible();
    await block.screenshot({ path: process.env.UMR_EDIT_SHOT || 'test-results/editing.png' });

    // The document lane. `o` on a node: a conceiver, then a modal relation,
    // drawn to the pinned constant in the margin.
    await nodeByConcept(page, 'today').click();
    await page.keyboard.press('o');
    await editor(page).fill('author');
    await page.keyboard.press('Enter');
    await editor(page).fill(':full-affirmative');
    await page.keyboard.press('Enter');
    // The relation is a tag on the node; the sample already gives leave-02 one.
    await expect(
      block.locator('.umr-doc-tag', { hasText: 'author :full-affirmative' }),
    ).toHaveCount(2);
    await expect(block.locator('.umr-const--used', { hasText: 'author' })).toBeVisible();
    // At rest the document level is tags only. The focused node's own
    // relations are drawn, and go when focus leaves.
    await expect(block.locator('.umr-doc-edge')).toHaveCount(1);
    // Focusing another node takes the lines with it. That click focuses and
    // no more, which is why the `c` below reaches the block.
    await nodeByConcept(page, 'lunch').click();
    await expect(block.locator('.umr-doc-edge')).toHaveCount(0);
    // `c`: coreference with another node, a chain chip on both.
    await page.keyboard.press('c');
    await editor(page).fill('s1p');
    await page.keyboard.press('Enter');
    await editor(page).fill(':same-entity');
    await page.keyboard.press('Enter');
    await expect(block.locator('.umr-chain')).toHaveCount(2);
    // Dragging the grip of eat-01 onto document-creation-time: a temporal one.
    const eat2 = nodeByConcept(page, 'eat-01');
    await eat2.hover();
    const grip2 = await eat2.locator('.umr-grip').boundingBox();
    const dct = block.locator('[data-const-name="document-creation-time"]');
    const dctBox = await dct.boundingBox();
    await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2);
    await page.mouse.down();
    await page.mouse.move(dctBox.x + dctBox.width / 2, dctBox.y + dctBox.height / 2, { steps: 8 });
    await expect(dct).toHaveClass(/umr-const--drop/);
    await page.mouse.up();
    await page.mouse.move(2, 2);
    await editor(page).fill(':before');
    await page.keyboard.press('Enter');
    await expect(
      block.locator('.umr-doc-tag', { hasText: 'document-creation-time :before' }),
    ).toBeVisible();
    await block.screenshot({ path: process.env.UMR_LANE_SHOT || 'test-results/lane.png' });
    // A tag opens its relation on the first click, the node not focused, and
    // each temporal relation says what it means for the two ends.
    await nodeByConcept(page, 'lunch').click();
    await block.locator('.umr-doc-tag', { hasText: 'document-creation-time :before' }).click();
    await expect(
      page.getByRole('option', { name: /s1e before document-creation-time/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // `t` from an event: the node picked is its reference time, so the
    // triple runs from it to the event.
    await nodeByConcept(page, 'today').click();
    await page.keyboard.press('t');
    await editor(page).fill('s1l');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: /s1t before s1l/ })).toBeVisible();
    await editor(page).fill(':before');
    await page.keyboard.press('Enter');
    await expect(block.locator('.umr-doc-tag', { hasText: 's1l :before' })).toBeVisible();

    // Alt+Right moves a child later in the written order. eat-01 was typed
    // with :time first; afterwards :ARG0 comes first in text mode.
    await nodeByConcept(page, 'today').click();
    await page.keyboard.press('Alt+ArrowRight');
    await block.locator('.umr-text-toggle').click();
    const area2 = block.locator('textarea.umr-penman-text');
    await expect(area2).toHaveValue(/eat-01[^()]*:ARG0 s1p[^()]*:time \(s1t \/ today\)/);
    await block.locator('.umr-text-toggle').click();

    // Every write landed.
    const clean = cleanDiagnostics(diag);
    expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
    expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);

    // The export says the same.
    await page.goto(`/#/projects/${ids.projectId}/documents/${ids.documentId}/export`);
    await expect(page.locator('pre, textarea').first()).toContainText(':ARG1 (s1l2 / lunch)');
    await expect(page.locator('pre, textarea').first()).toContainText(':time (s1t / today)');
    await expect(page.locator('pre, textarea').first()).toContainText(
      '(author :full-affirmative s1t)',
    );
    await expect(page.locator('pre, textarea').first()).toContainText(
      ':coref ((s1l2 :same-entity s1p))',
    );
    await expect(page.locator('pre, textarea').first()).toContainText(
      '(document-creation-time :before s1e)',
    );
    await expect(page.locator('pre, textarea').first()).toContainText('(s1l :before s1t)');
  });

  // Every gesture has a mouse path: the node's own parts are click targets,
  // and the rest is on the menu, by right-click or by the ⋯ button.
  test('the mouse reaches every action', async ({ page }) => {
    const own = await makeDocument();
    try {
      const diag = collectClientErrors(page);
      await seedAuth(page);
      await page.goto(`/#/projects/${own.projectId}/documents/${own.documentId}/annotate`);
      const block = page.locator('.umr-block').first();
      await expect(block.locator('.umr-edge-label').first()).toBeVisible();

      // One rule for the node's parts: a click focuses, and a double-click
      // on a part edits that part. So a click on a chip cannot swallow the
      // click that was only meant to focus the node.
      const leave = nodeByConcept(page, 'leave-02');
      const picker = page.getByRole('dialog', { name: 'Attributes' });
      await leave.locator('.umr-chip').first().click();
      await expect(picker).toHaveCount(0);
      await expect(leave).toHaveClass(/umr-node--focused/);

      // A double-click on the variable renames.
      await leave.locator('.umr-node-var').dblclick();
      await expect(editor(page)).toHaveValue('s1l');
      await editor(page).fill('s1go');
      await page.keyboard.press('Enter');
      await expect(leave.locator('.umr-node-var')).toHaveText('s1go');

      // And the chip opens the attribute picker at that node.
      await leave.locator('.umr-chip').first().dblclick();
      await expect(picker).toBeVisible();
      await expect(picker.locator('[aria-pressed="true"]')).toHaveText('performance');
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);

      // The picker opens from the menu too, and is placed against the WINDOW:
      // the canvas clips (it scrolls sideways), and the picker is taller than
      // a node near the foot of a sentence.
      await leave.click({ button: 'right' });
      await page
        .getByRole('menu')
        .getByRole('menuitem', { name: /^Attributes/ })
        .click();
      await expect(picker).toBeVisible();
      await expect(picker.locator('button:focus')).toHaveCount(1);
      expect(
        await picker.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= -1 && r.bottom <= window.innerHeight + 1;
        }),
      ).toBe(true);
      await block.locator('.umr-block-text').click();
      await expect(picker).toHaveCount(0);

      // A second single click on the concept only keeps the focus, so a
      // command letter typed next is a command. A double-click edits it.
      const person = nodeByConcept(page, 'person').first();
      await person.locator('.umr-node-concept').click();
      await expect(editor(page)).toHaveCount(0);
      await expect(person).toHaveClass(/umr-node--focused/);
      await person.locator('.umr-node-concept').click();
      await expect(editor(page)).toHaveCount(0);
      await person.locator('.umr-node-concept').dblclick();
      await expect(editor(page)).toHaveValue('person');
      await page.keyboard.press('Escape');

      // Right-click opens the menu, which says which key does the same.
      await person.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: /Edit concept/ })).toContainText('Enter');
      await expect(menu.getByRole('menuitem', { name: /^Attributes/ })).toContainText('A');
      // A leaf has a parent, so it can move and be deleted; it is not the root.
      await expect(menu.getByRole('menuitem', { name: /Make this the root/ })).toBeEnabled();
      await menu.getByRole('menuitem', { name: /Rename variable/ }).click();
      await expect(editor(page)).toHaveValue('s1p');
      await page.keyboard.press('Escape');

      // The ⋯ button opens the same menu. On the root, the items that need a
      // parent are greyed out.
      await leave.hover();
      await leave.locator('.umr-more').click();
      await expect(menu).toBeVisible();
      for (const name of [/Relation to parent/, /Delete relation to parent/, /Move earlier/]) {
        await expect(menu.getByRole('menuitem', { name })).toBeDisabled();
      }
      await expect(menu.getByRole('menuitem', { name: /Make this the root/ })).toBeDisabled();

      // An action picked from the menu runs against that node: the root's
      // anchor mode, which the word clicks then drive.
      await menu.getByRole('menuitem', { name: /Change anchor/ }).click();
      await expect(block.locator('.umr-block-note--mode')).toContainText('Click words');
      // Anchor mode ends no other way with a mouse: a click on the graph is a
      // word to anchor to, so the way out is a button.
      await block.getByRole('button', { name: 'Done' }).click();
      await expect(block.locator('.umr-block-note--mode')).toHaveCount(0);

      // A child from the menu: the next click says where, here a word, whose
      // senses the concept picker then offers. The menu names Tab for it.
      const eat = nodeByConcept(page, 'eat-01');
      await eat.click({ button: 'right' });
      await expect(menu.getByRole('menuitem', { name: /Add a child/ })).toContainText('Tab');
      await menu.getByRole('menuitem', { name: /Add a child/ }).click();
      await expect(block.locator('.umr-block-note--mode')).toContainText("child's word");
      await block.locator('.umr-word', { hasText: 'lunch' }).click();
      await expect(editor(page)).toHaveValue('lunch');
      await page.locator('[role="option"]', { hasText: /^lunch-01 ARG/ }).click();
      await page
        .locator('[role="option"]', { hasText: /^:ARG1/ })
        .first()
        .click();
      await expect(nodeByConcept(page, 'lunch-01')).toBeVisible();
      await expect(block.locator('.umr-block-note--mode')).toHaveCount(0);
      // Or empty space, for a child with no word: the top right of the graph,
      // where the root's row has nothing.
      await nodeByConcept(page, 'lunch-01').click({ button: 'right' });
      await menu.getByRole('menuitem', { name: /Add a child/ }).click();
      const graphBox = await block.locator('.umr-graph').boundingBox();
      await page.mouse.click(graphBox.x + graphBox.width - 24, graphBox.y + 10);
      await expect(editor(page)).toHaveValue('');
      await editor(page).fill('thing');
      await page.keyboard.press('Enter');
      await editor(page).fill(':mod');
      await page.keyboard.press('Enter');
      await expect(nodeByConcept(page, 'thing')).toBeVisible();
      await expect(nodeByConcept(page, 'thing')).toHaveClass(/umr-node--unaligned/);

      // And one that writes: the menu deletes the node with its subtree, name
      // and all, after a confirm that counts what goes.
      await person.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: /Delete node and all below it/ }).click();
      await page.getByRole('button', { name: 'Delete' }).click();
      await expect(nodeByConcept(page, 'person')).toHaveCount(0);
      await expect(nodeByConcept(page, 'name')).toHaveCount(0);

      // A document-level relation is deleted from its own editor: the node
      // menu cannot name one, and Shift+Backspace there is keyboard-only.
      // Deleting a node focuses its parent, which wears a document-level tag,
      // so that tag is one click away.
      const tagged = block.locator('.umr-node--focused');
      await expect(tagged.locator('.umr-doc-tag').first()).toBeVisible();
      const before = await block.locator('.umr-doc-tag').count();
      await tagged.locator('.umr-doc-tag').first().click();
      await expect(editor(page)).toBeVisible();
      await page.locator('.umr-inline-delete').click();
      await expect(block.locator('.umr-doc-tag')).toHaveCount(before - 1);

      const clean = cleanDiagnostics(diag);
      expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
      expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
    } finally {
      await own.client.documents.delete(own.documentId);
    }
  });

  // A document relation reaching another sentence is a tag on BOTH ends,
  // not a pill under the later graph, and is drawn across the blocks for
  // the focused node alone.
  test('relations across sentences', async ({ page }) => {
    const own = await makeDocument(TWO);
    try {
      const diag = collectClientErrors(page);
      await seedAuth(page);
      await page.goto(`/#/projects/${own.projectId}/documents/${own.documentId}/annotate`);
      const one = page.locator('.umr-block').nth(0);
      const two = page.locator('.umr-block').nth(1);
      const byVar = (v) => page.locator(`[data-node-var="${v}"]`);
      await expect(byVar('s2c')).toBeVisible();

      // The earlier node wears the relation as much as the later one. Under
      // the graphs is left only what belongs to no node.
      await expect(byVar('s1c2').locator('.umr-doc-tag')).toHaveText(['s2c :same-entity ●']);
      await expect(byVar('s2c').locator('.umr-doc-tag')).toHaveText(['● :same-entity s1c2']);
      await expect(one.locator('.umr-doc-chip')).toHaveText(['root :modal author']);
      await expect(two.locator('.umr-doc-chip')).toHaveCount(0);

      // Opening the document focuses the first sentence's first node, s1c2
      // here, and a focused node draws its line. Escape lets it go, and at
      // rest nothing is drawn across. Focus draws the line again, and rings
      // the node at the other end.
      const links = page.locator('.umr-cross-link');
      await expect(byVar('s1c2')).toBeFocused();
      await expect(links).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(links).toHaveCount(0);
      await byVar('s2c').click();
      await expect(links).toHaveCount(1);
      await expect(page.locator('.umr-cross-ring')).toHaveCount(1);

      // Only the block holding focus shows a focused node: a node focused
      // earlier in another block does not stay lit, even when a click on
      // nothing (the sentence's text) came in between.
      await two.locator('.umr-block-text').click();
      await expect(byVar('s2c')).toHaveClass(/umr-node--focused/);
      await byVar('s1m').click();
      await expect(page.locator('.umr-node--focused')).toHaveCount(1);
      await expect(byVar('s1m')).toHaveClass(/umr-node--focused/);
      await expect(links).toHaveCount(0);

      // A new one from the menu, to a node of the other sentence.
      await byVar('s2e').click({ button: 'right' });
      await page
        .getByRole('menu')
        .getByRole('menuitem', { name: /Temporal relation/ })
        .click();
      await page.locator('[role="option"]', { hasText: /^s1c chase-01/ }).click();
      // The node picked is s2e's reference time, and the option says so.
      await page.locator('[role="option"]', { hasText: /^:after s2e after s1c/ }).click();
      await expect(byVar('s2e').locator('.umr-doc-tag')).toHaveText(['s1c :after ●']);
      await expect(byVar('s1c').locator('.umr-doc-tag')).toContainText(['● :after s2e']);
      await expect(links).toHaveCount(1);

      // Changed from the earlier end: the tag there opens the same relation.
      await byVar('s1c').click();
      await byVar('s1c').locator('.umr-doc-tag', { hasText: ':after s2e' }).click();
      await expect(editor(page)).toHaveValue(':after');
      await page.locator('[role="option"]', { hasText: /^:overlap/ }).click();
      await expect(byVar('s2e').locator('.umr-doc-tag')).toHaveText(['s1c :overlap ●']);

      const clean = cleanDiagnostics(diag);
      expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
      expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
    } finally {
      await own.client.documents.delete(own.documentId);
    }
  });

  // A drafted graph wears the machine's mark, a dashed violet border and no
  // fill, until Accept graph takes it off every node at once.
  test('a drafted graph is marked until Accept graph', async ({ page }) => {
    const own = await makeDocument();
    try {
      const d = await own.client.documents.get(own.documentId, true);
      const spans = d.textLayers[0].tokenLayers.find((t) => t.name === 'UMR nodes').spanLayers[0]
        .spans;
      for (const s of spans) {
        await own.client.spans.patchMetadata(s.id, [
          { op: 'set', path: ['prov'], value: 'inferred' },
          { op: 'set', path: ['provSource'], value: 'service:e2e' },
        ]);
      }
      const diag = collectClientErrors(page);
      await seedAuth(page);
      await page.goto(`/#/projects/${own.projectId}/documents/${own.documentId}/annotate`);
      const block = page.locator('.umr-block').first();
      await expect(block.locator('.umr-edge-label').first()).toBeVisible();
      const nodes = await block.locator('.umr-node').count();
      expect(nodes).toBeGreaterThan(1);
      await expect(block.locator('.umr-node--machine')).toHaveCount(nodes);

      const plain = block
        .locator('.umr-node--machine:not(.umr-node--unaligned)')
        .filter({ hasNot: page.locator('.umr-node-mark--warning, .umr-node-mark--error') })
        .first();
      const style = await plain.evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopStyle, color: s.borderTopColor, fill: s.backgroundColor };
      });
      expect(style).toEqual({
        border: 'dashed',
        color: 'rgb(109, 40, 217)',
        fill: 'rgb(255, 255, 255)',
      });

      // A problem on a drafted node rings it from outside and leaves the
      // violet border alone (red or amber there read as another kind of node).
      const flagged = await block
        .locator('.umr-node--machine')
        .filter({ has: page.locator('.umr-node-mark') })
        .evaluateAll((els) =>
          els.map((el) => {
            const s = getComputedStyle(el);
            return { color: s.borderTopColor, outline: s.outlineStyle };
          }),
        );
      for (const f of flagged) expect(f).toEqual({ color: 'rgb(109, 40, 217)', outline: 'solid' });

      // Focus keeps the violet border too, so it shows as a solid blue ring
      // hugging it, and a problem's ring steps out past that.
      const ring = 'rgb(36, 99, 235) 0px 0px 0px 2px';
      await plain.focus();
      await expect(plain).toHaveCSS('box-shadow', ring);
      await expect(plain).toHaveCSS('border-top-color', 'rgb(109, 40, 217)');
      const flaggedNode = block
        .locator('.umr-node--machine')
        .filter({ has: page.locator('.umr-node-mark') })
        .first();
      if (await flaggedNode.count()) {
        await flaggedNode.focus();
        await expect(flaggedNode).toHaveCSS('box-shadow', ring);
        await expect(flaggedNode).toHaveCSS('border-top-color', 'rgb(109, 40, 217)');
        await expect(flaggedNode).toHaveCSS('outline-offset', '4px');
      }

      const accept = block.getByRole('button', { name: 'Accept graph' });
      await expect(accept).toHaveCSS('color', 'rgb(109, 40, 217)');
      // Full strength at rest: the quiet look is the outline, not opacity.
      await expect(accept).toHaveCSS('opacity', '1');
      await accept.click();
      await expect(block.locator('.umr-node--machine')).toHaveCount(0);
      await expect(accept).toHaveCount(0);
      await expect
        .poll(async () => {
          const after = await own.client.documents.get(own.documentId, true);
          return after.textLayers[0].tokenLayers
            .find((t) => t.name === 'UMR nodes')
            .spanLayers[0].spans.filter((s) => s.metadata?.provConfirmed === true).length;
        })
        .toBeGreaterThanOrEqual(nodes);

      const clean = cleanDiagnostics(diag);
      expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
      expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
    } finally {
      await own.client.documents.delete(own.documentId);
    }
  });

  // Discard graph takes the drafted nodes and relations off a sentence, after
  // a question, and keeps what was accepted with the node it hangs from.
  test('Discard graph removes the draft and keeps what was accepted', async ({ page }) => {
    const own = await makeDocument();
    try {
      const d = await own.client.documents.get(own.documentId, true);
      const concepts = d.textLayers[0].tokenLayers.find((t) => t.name === 'UMR nodes')
        .spanLayers[0];
      const drafted = [
        { op: 'set', path: ['prov'], value: 'inferred' },
        { op: 'set', path: ['provSource'], value: 'service:e2e' },
      ];
      const eat = concepts.spans.find((s) => s.value === 'eat-01');
      const purpose = concepts.relationLayers
        .flatMap((l) => l.relations || [])
        .find((r) => r.value === ':purpose');
      const accepted = new Set([eat.id, purpose.id]);
      const stamp = (id) =>
        accepted.has(id)
          ? [...drafted, { op: 'set', path: ['provConfirmed'], value: true }]
          : drafted;
      for (const s of concepts.spans) await own.client.spans.patchMetadata(s.id, stamp(s.id));
      for (const r of concepts.relationLayers.flatMap((l) => l.relations || [])) {
        await own.client.relations.patchMetadata(r.id, stamp(r.id));
      }
      const diag = collectClientErrors(page);
      await seedAuth(page);
      await page.goto(`/#/projects/${own.projectId}/documents/${own.documentId}/annotate`);
      const block = page.locator('.umr-block').first();
      await expect(block.locator('.umr-edge-label').first()).toBeVisible();
      await expect(block.locator('.umr-node')).toHaveCount(4);

      const discard = block.getByRole('button', { name: 'Discard graph' });
      await expect(discard).toHaveCSS('color', 'rgb(220, 38, 38)');
      // Keyboard: the button takes focus and Enter asks.
      await discard.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('alertdialog', { name: 'Discard the drafted graph?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('2 nodes and 5 relations. Restorable from History.');
      await dialog.getByRole('button', { name: 'Discard' }).click();

      // leave-02 stays, still drafted, for the accepted :purpose under it.
      await expect(block.locator('.umr-node')).toHaveCount(2);
      await expect(nodeByConcept(page, 'eat-01')).toBeVisible();
      await expect(nodeByConcept(page, 'leave-02')).toHaveClass(/umr-node--machine/);
      await expect(discard).toHaveCount(0);
      await expect(block.getByRole('button', { name: 'Accept graph' })).toBeVisible();
      await expect
        .poll(async () => {
          const after = await own.client.documents.get(own.documentId, true);
          const layer = after.textLayers[0].tokenLayers.find((t) => t.name === 'UMR nodes')
            .spanLayers[0];
          return {
            concepts: layer.spans
              .filter((s) => !s.metadata?.umr?.constant)
              .map((s) => s.value)
              .sort(),
            relations: layer.relationLayers.flatMap((l) => l.relations || []).map((r) => r.value),
          };
        })
        .toEqual({ concepts: ['eat-01', 'leave-02'], relations: [':purpose'] });

      const clean = cleanDiagnostics(diag);
      expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
      expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
    } finally {
      await own.client.documents.delete(own.documentId);
    }
  });

  // Text mode shows every node of the sentence: a part the root does not
  // reach is a graph of its own after the root's, applying the text as shown
  // changes nothing, and a node taken out of the text goes. A role UMR does
  // not have is refused before anything is written.
  test('text mode holds the loose parts of a sentence', async ({ page }) => {
    const own = await makeDocument();
    try {
      const diag = collectClientErrors(page);
      await seedAuth(page);
      await page.goto(`/#/projects/${own.projectId}/documents/${own.documentId}/annotate`);
      const block = page.locator('.umr-block').first();
      await expect(block.locator('.umr-edge-label').first()).toBeVisible();
      await block.locator('.umr-text-toggle').click();
      const area = block.locator('textarea.umr-penman-text');
      const stored = await area.inputValue();
      await area.fill(`${stored}\n\n(s1z / zebra\n    :mod (s1s / striped))`);
      await block.getByRole('button', { name: 'Apply' }).click();
      await expect(nodeByConcept(page, 'zebra')).toBeVisible();
      await expect(nodeByConcept(page, 'striped')).toBeVisible();

      await block.locator('.umr-text-toggle').click();
      await expect(area).toHaveValue(/\n\n\(s1z \/ zebra\n {4}:mod \(s1s \/ striped\)\)$/);
      await expect(block.locator('.umr-penman-status')).toHaveText('As stored.');

      await area.fill(stored.replace(':ARG0 s1p', ':poss s1p'));
      await expect(block.locator('.umr-penman-status')).toContainText("Unknown relation ':poss'");
      await expect(block.getByRole('button', { name: 'Apply' })).toBeDisabled();

      await area.fill(stored);
      await expect(block.locator('.umr-penman-status')).toContainText('Changed');
      await block.getByRole('button', { name: 'Apply' }).click();
      await expect(nodeByConcept(page, 'zebra')).toHaveCount(0);
      await expect(nodeByConcept(page, 'striped')).toHaveCount(0);
      await expect(nodeByConcept(page, 'leave-02')).toBeVisible();

      const clean = cleanDiagnostics(diag);
      expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
      expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
    } finally {
      await own.client.documents.delete(own.documentId);
    }
  });
});
