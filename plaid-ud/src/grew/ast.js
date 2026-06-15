// AST shapes produced by parser.js and consumed by compile.js. The parser
// emits plain objects with a `kind`/`type` tag (no classes); this module just
// documents the shapes and exports the small set of tag constants.
//
// Request:
//   { blocks: Block[], nonInjective: string[] }   // node ids marked `X$`
//
// Block:
//   { type: 'pattern'|'with'|'without'|'global', items: Clause[], line }
//
// Clause (pattern/with/without):
//   { kind:'node', id, alts: FeatureStruct[], line }          // X [..] | [..]
//   { kind:'nodefeat', node, feat, op:'='|'<>', value: Value } // X.lemma = "be"
//   { kind:'featcmp', left:{node,feat}, op:'='|'<>', right:{node,feat} } // X.lemma = Y.lemma
//   { kind:'edge', id|null, src:Ref, tgt:Ref, label: Label }   // X -[nsubj]-> Y
//   { kind:'dominates', id|null, left:Ref, right:Ref, label: Label } // X ->> Y
//   { kind:'order', op:'<'|'<<', left, right }                 // X < Y / X << Y
//   { kind:'cross', left, right }                              // e1 >< e2
//   { kind:'dist', fn:'delta'|'length', a, b, op, n }          // delta(X,Y) = 3
//
// Global item:
//   { kind:'globalflag', name }            // is_tree, is_projective, is_not_cyclic…
//   { kind:'globalmeta', key, op, value }  // text = re"…", sent_id = "…", k = v
//
// Ref:           { wild:true } | { wild:false, id }
// FeatureStruct: FeatItem[]
// FeatItem:      { name, op:'='|'<>'|'defined'|'undefined', value: Value|null }
// Value:         { type:'lit', value } | { type:'regex', pattern, flavor, flags }
//              | { type:'any' } | { type:'disj', items: Value[] }
// Label:         { type:'any' }
//              | { type:'list', labels: string[], negated: bool }
//              | { type:'regex', pattern, flavor, flags }
//              | { type:'features', feats: {key,val}[] }

export const BLOCK_TYPES = new Set(['pattern', 'with', 'without', 'global']);
