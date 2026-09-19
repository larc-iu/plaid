import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SentenceBlock } from './SentenceBlock.jsx';
import { CrossLinks } from './CrossLinks.jsx';
import { LOOK_ATTR } from '../../../lib/look.js';
import { ListPager } from '@ui/components/shared/list-search';
import { usePagedList, pageKey, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { readProjectLanguage } from '../../../utils/umrLayerUtils.js';
import { loadFrames } from '../../../domain/lexicon.js';
import { EMPTY_LEXICON, loadVocabularies } from '../../../domain/vocabLexicon.js';

// The frame file of the project's language, once it has loaded; null for a
// language without one, or until it arrives.
const NO_PROBLEMS = Object.freeze([]);

const useFrames = (languageTag) => {
  const [frames, setFrames] = useState(null);
  useEffect(() => {
    let live = true;
    setFrames(null);
    loadFrames(languageTag).then((f) => live && setFrames(f));
    return () => {
      live = false;
    };
  }, [languageTag]);
  return frames;
};

// The project's vocabularies as a lexicon, read once per project. Live
// even under a past state: what the vocabulary says now is the lexicon.
const useLexicon = (client, project) => {
  const [lexicon, setLexicon] = useState(EMPTY_LEXICON);
  const key = (project?.vocabs || []).map((v) => v.id).join(',');
  useEffect(() => {
    let live = true;
    setLexicon(EMPTY_LEXICON);
    if (!client || !key) return undefined;
    loadVocabularies(client, project).then((l) => live && setLexicon(l));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return lexicon;
};

// Scroll a rendered node into view and focus it.
const focusElement = (el) => {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
};

// The document as a column of sentence blocks, one page at a time. Reads the
// document it is handed, live or a snapshot, so a past state draws as readily
// as the present one.
//
// Everything a sentence is addressed by stays global to the document (its
// number, what a citation calls it), so paging changes what is in the DOM and
// nothing else. Every way of reaching a node on another page (the ?sent= deep
// link, a coref chain hop) turns the page first and focuses once the block is
// there: a querySelector for a block off the page finds nothing.
export const UmrCanvas = ({
  doc,
  readOnly = true,
  sentParam = null,
  varParam = null,
  focusNonce = 0,
}) => {
  const frames = useFrames(readProjectLanguage(doc.project));
  const lexicon = useLexicon(doc.client, doc.project);
  const graph = doc.graph;
  const problems = doc.problemsBySentence;
  const sentences = graph.sentences;

  // The page is remembered per document, because coming back to a corpus
  // means coming back to where the work stopped.
  const paged = usePagedList(sentences, {
    pageSize: TALL_LIST_PAGE_SIZE,
    storageKey: pageKey('umr-annotate', doc.id),
  });
  const { page, setPage } = paged;

  // A sentence's page, from its number.
  const pageOfSentence = useMemo(() => {
    const map = new Map();
    sentences.forEach((s, i) => map.set(String(s.index), Math.floor(i / TALL_LIST_PAGE_SIZE)));
    return map;
  }, [sentences]);

  // What is waiting to be focused once its page has rendered. A selector for
  // the element, and a nonce so the same target asked twice is answered twice.
  const [pending, setPending] = useState(null);
  const reveal = useCallback(
    (sentenceIndex, selector) => {
      const target = pageOfSentence.get(String(sentenceIndex));
      if (target == null) return;
      setPage(target);
      setPending({ selector, nonce: Date.now() });
    },
    [pageOfSentence, setPage],
  );

  useEffect(() => {
    if (!pending) return;
    const raf = requestAnimationFrame(() => {
      focusElement(window.document.querySelector(pending.selector));
      setPending(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pending, page]);

  // Jump to a node anywhere in the document: a chain hop, or a click on a
  // reentrant edge's far end. A constant sits in every block's margin, so it
  // is found where the reader is.
  const goToNode = useCallback(
    (nodeId) => {
      const node = graph.nodesById.get(nodeId);
      const selector = `[data-node-id="${nodeId}"]`;
      if (node?.sentence != null) reveal(node.sentence, selector);
      else focusElement(window.document.querySelector(selector));
    },
    [graph, reveal],
  );

  // The deep link: ?sent=<sentence number> scrolls to that sentence's block
  // and focuses one of its nodes, the one ?var= names or the first. The
  // assistant's citations and the shell's focusHere use it, and the nonce
  // makes a repeat of the same link scroll again.
  const answered = useRef(null);
  useEffect(() => {
    if (!sentParam) return;
    const asked = `${sentParam}:${varParam}:${focusNonce}`;
    if (answered.current === asked) return;
    answered.current = asked;
    const index = String(sentParam).replace(/^s/, '');
    const block = `.umr-block[data-sentence-index="${index}"]`;
    const node = varParam ? `[data-node-var="${CSS.escape(varParam)}"]` : '.umr-node';
    reveal(index, `${block} ${node}`);
  }, [sentParam, varParam, focusNonce, reveal]);

  // The node whose cross-sentence relations are drawn. Each block says which
  // of its nodes is active, and at most two are at once (one hovered, one
  // holding focus): the one that became active last wins, so hover is seen
  // over focus, and focus is seen again once the pointer leaves.
  const activesRef = useRef(new Map());
  const [activeId, setActiveId] = useState(null);
  const onActive = useCallback((index, id) => {
    const actives = activesRef.current;
    actives.delete(index);
    if (id) actives.set(index, id);
    setActiveId([...actives.values()].pop() || null);
  }, []);

  // Turning the page from the bottom of the list leaves the reader at the
  // bottom of a page they have not read yet, so that pager takes them back
  // up. The top one does not, because they are already there.
  const listTopRef = useRef(null);
  const handlePageFromBottom = useCallback(
    (next) => {
      setPage(next);
      listTopRef.current?.scrollIntoView({ block: 'start' });
    },
    [setPage],
  );

  if (sentences.length === 0) {
    return (
      <p className="py-10 text-center text-muted-foreground">
        No sentences. Import a .umr file, or add text to this document in Plaid IGT or Plaid UD.
      </p>
    );
  }
  return (
    <div className="umr-canvas-list" ref={listTopRef} data-look={LOOK_ATTR || undefined}>
      <CrossLinks
        listRef={listTopRef}
        graph={graph}
        activeId={activeId}
        version={doc.dataVersion}
      />
      <ListPager {...paged} onPage={setPage} position="top" className="mx-6 rounded-md border" />
      {paged.pageItems.map((sentence) => (
        <SentenceBlock
          key={sentence.tokenId}
          doc={doc}
          sentence={sentence}
          nodesById={graph.nodesById}
          dataVersion={doc.dataVersion}
          direction={doc.textDirection}
          readOnly={readOnly}
          frames={frames}
          lexicon={lexicon}
          problems={problems.get(sentence.index) || NO_PROBLEMS}
          goToNode={goToNode}
          onActive={onActive}
        />
      ))}
      <ListPager {...paged} onPage={handlePageFromBottom} className="mx-6 mb-6 rounded-md border" />
    </div>
  );
};
