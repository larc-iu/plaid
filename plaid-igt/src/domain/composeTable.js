// Backslash compose codes, derived from Praat's own table (kar/longchar.cpp in
// praat/praat, resolved through the Unicode character database). Praat is the
// reference on purpose: a phonetician already has these codes in their fingers,
// they are documented at fon.hum.uva.nl/praat/manual/Phonetic_symbols.html, and
// every code is EXACTLY two characters, which makes the set prefix-free and the
// scan in compose.js unambiguous without lookahead.
//
// GENERATED from longchar.cpp, plus ONE hand-added alias: `\0/` for ∅. Praat
// spells the empty set `\O|`, which is kept, but a zero morph is roughly one
// morpheme in eight in real FLEx data, so it also gets a code parallel to
// `\o/` (ø) and `\O/` (Ø). Do not hand-edit anything else here.
//
// 442 codes.

export const COMPOSE_TABLE = Object.freeze({
  '!d': '¡', // inverted exclamation mark
  '"l': '“', // left double quotation mark
  '"p': '″', // double prime
  '"r': '”', // right double quotation mark
  "''": '\u030B', // combining double acute accent
  "'-": '\u1DC7', // combining acute-macron
  "'1": 'ˈ', // modifier letter vertical line
  "'2": 'ˌ', // modifier letter low vertical line
  "'^": '\u0301', // combining acute accent
  "'a": "'", // apostrophe
  "'p": '′', // prime
  '+-': '±', // plus-minus sign
  '+v': '\u031F', // combining plus sign below
  "-'": '\u1DC4', // combining macron-acute
  '--': '–', // en dash
  '-/': '\u0336', // combining long stroke overlay
  '-1': '˩', // modifier letter extra-low tone bar
  '-2': '˨', // modifier letter low tone bar
  '-3': '˧', // modifier letter mid tone bar
  '-4': '˦', // modifier letter high tone bar
  '-5': '˥', // modifier letter extra-high tone bar
  '->': '→', // rightwards arrow
  '-^': '\u0304', // combining macron
  '-`': '\u1DC6', // combining macron-grave
  '-h': '\u00AD', // soft hyphen
  '-m': '−', // minus sign
  '-v': '\u0320', // combining minus sign below
  '..': '⋯', // midline horizontal ellipsis
  '.3': '∴', // therefore
  '.c': '·', // middle dot
  '.f': 'ˑ', // modifier letter half triangular colon
  '.v': '\u0323', // combining dot below
  '//': '\u0338', // combining long solidus overlay
  '/d': '∕', // division slash
  '0/': '∅', // empty set
  '0^': '\u030A', // combining ring above
  '0v': '\u0325', // combining ring below
  '3v': '\u0339', // combining right half ring below
  '9+': 'ע', // hebrew letter ayin
  '9-': 'ʢ', // latin letter reversed glottal stop with stroke
  '9e': 'ʕ', // latin letter pharyngeal voiced fricative
  ':-': '÷', // division sign
  ':^': '\u0308', // combining diaeresis
  ':f': 'ː', // modifier letter triangular colon
  ':v': '\u0324', // combining diaeresis below
  '<-': '←', // leftwards arrow
  '<<': '«', // left-pointing double angle quotation mark
  '<=': '⇐', // leftwards double arrow
  '<>': '↔', // left right arrow
  '<_': '≤', // less-than or equal to
  '=/': '≠', // not equal to
  '=3': '≡', // identical to
  '=>': '⇒', // rightwards double arrow
  '=~': '≅', // approximately equal to
  '>>': '»', // right-pointing double angle quotation mark
  '>_': '≥', // greater-than or equal to
  '?+': 'א', // hebrew letter alef
  '?-': 'ʡ', // latin letter glottal stop with stroke
  '?d': '¿', // inverted question mark
  '?g': 'ʔ', // latin letter glottal stop
  '[f': '[', // left square bracket
  ']f': ']', // right square bracket
  '^#': '⇑', // upwards double arrow
  '^9': 'ˁ', // modifier letter reversed glottal stop
  '^?': 'ˀ', // modifier letter glottal stop
  '^^': '\u0302', // combining circumflex accent
  '^f': 'ᶠ', // modifier letter small f
  '^G': 'ᶭ', // modifier letter small turned m with long leg
  '^g': 'ˠ', // modifier letter small gamma
  '^H': 'ʱ', // modifier letter small h with hook
  '^h': 'ʰ', // modifier letter small h
  '^j': 'ʲ', // modifier letter small j
  '^l': 'ˡ', // modifier letter small l
  '^M': 'ᵚ', // modifier letter small turned m
  '^m': 'ᵐ', // modifier letter small m
  '^N': 'ᵑ', // modifier letter small eng
  '^n': 'ⁿ', // superscript latin small letter n
  '^s': 'ˢ', // modifier letter small s
  '^w': 'ʷ', // modifier letter small w
  '^x': 'ˣ', // modifier letter small x
  '^Y': 'ᶣ', // modifier letter small turned h
  '^y': 'ʸ', // modifier letter small y
  '^|': '↑', // upwards arrow
  '_#': '⇓', // downwards double arrow
  _u: '‿', // undertie
  '_|': '↓', // downwards arrow
  '`-': '\u1DC5', // combining grave-macron
  '`^': '\u0300', // combining grave accent
  '``': '\u030F', // combining double grave accent
  'A"': 'Ä', // latin capital letter a with diaeresis
  'a"': 'ä', // latin small letter a with diaeresis
  "A'": 'Á', // latin capital letter a with acute
  "a'": 'á', // latin small letter a with acute
  'A;': 'Ą', // latin capital letter a with ogonek
  'a;': 'ą', // latin small letter a with ogonek
  'A^': 'Â', // latin capital letter a with circumflex
  'a^': 'â', // latin small letter a with circumflex
  a_: 'ª', // feminine ordinal indicator
  'A`': 'À', // latin capital letter a with grave
  'a`': 'à', // latin small letter a with grave
  ab: 'ɒ', // latin small letter turned alpha
  Ae: 'Æ', // latin capital letter ae
  ae: 'æ', // latin small letter ae
  Al: 'Α', // greek capital letter alpha
  al: 'α', // greek small letter alpha
  an: '∧', // logical and
  Ao: 'Å', // latin capital letter a with ring above
  ao: 'å', // latin small letter a with ring above
  ap: 'ʼ', // modifier letter apostrophe
  as: 'ɑ', // latin small letter alpha
  At: '∀', // for all
  at: 'ɐ', // latin small letter turned a
  ay: 'ɒ', // latin small letter turned alpha
  'A~': 'Ã', // latin capital letter a with tilde
  'a~': 'ã', // latin small letter a with tilde
  'B+': 'ב', // hebrew letter bet
  'b^': 'ɓ', // latin small letter b with hook
  bc: 'ʙ', // latin letter small capital b
  Be: 'Β', // greek capital letter beta
  be: 'β', // greek small letter beta
  bf: 'β', // greek small letter beta
  bs: '\\', // reverse solidus
  bu: '•', // bullet
  'C%': 'ץ', // hebrew letter final tsadi
  "C'": 'Ć', // latin capital letter c with acute
  "c'": 'ć', // latin small letter c with acute
  'C+': 'צ', // hebrew letter tsadi
  'C,': 'Ç', // latin capital letter c with cedilla
  'c,': 'ç', // latin small letter c with cedilla
  'c/': '¢', // cent sign
  'C<': 'Č', // latin capital letter c with caron
  'c<': 'č', // latin small letter c with caron
  'c=': '⊂', // subset of
  cc: 'ɕ', // latin small letter c with curl
  cE: '\u05B5', // hebrew point tsere
  cf: 'χ', // greek small letter chi
  Ci: 'Χ', // greek capital letter chi
  ci: 'χ', // greek small letter chi
  cl: '♣', // black club suit
  cn: '\u031A', // combining left angle above
  co: '©', // copyright sign
  ct: 'ɔ', // latin small letter open o
  cu: '¤', // currency sign
  cv: '\u031C', // combining left half ring below
  'D+': 'ד', // hebrew letter dalet
  'D-': 'Đ', // latin capital letter d with stroke
  'd-': 'đ', // latin small letter d with stroke
  'd.': 'ɖ', // latin small letter d with tail
  'D<': 'Ď', // latin capital letter d with caron
  'd<': 'ď', // latin small letter d with caron
  'd^': 'ɗ', // latin small letter d with hook
  dd: '∂', // partial differential
  De: 'Δ', // greek capital letter delta
  de: 'δ', // greek small letter delta
  dg: '°', // degree sign
  dh: 'ð', // latin small letter eth
  di: '♦', // black diamond suit
  dq: '\u05BC', // hebrew point dagesh or mapiq
  Dv: '\u033B', // combining square below
  dZ: 'ʤ', // latin small letter dezh digraph
  dz: 'ʣ', // latin small letter dz digraph
  'E"': 'Ë', // latin capital letter e with diaeresis
  'e"': 'ë', // latin small letter e with diaeresis
  "E'": 'É', // latin capital letter e with acute
  "e'": 'é', // latin small letter e with acute
  'e-': 'ɘ', // latin small letter reversed e
  'E;': 'Ę', // latin capital letter e with ogonek
  'e;': 'ę', // latin small letter e with ogonek
  'E<': 'Ě', // latin capital letter e with caron
  'e<': 'ě', // latin small letter e with caron
  'e=': '∈', // element of
  'E^': 'Ê', // latin capital letter e with circumflex
  'e^': 'ê', // latin small letter e with circumflex
  'E`': 'È', // latin capital letter e with grave
  'e`': 'è', // latin small letter e with grave
  ef: 'ɛ', // latin small letter open e
  Ep: 'Ε', // greek capital letter epsilon
  ep: 'ε', // greek small letter epsilon
  eq: '⇔', // left right double arrow
  Er: '∃', // there exists
  er: 'ɜ', // latin small letter reversed open e
  Et: 'Η', // greek capital letter eta
  et: 'η', // greek small letter eta
  eu: '€', // euro sign
  'f.': 'ɽ', // latin small letter r with tail
  f2: 'ϕ', // greek phi symbol
  f5: '❀', // white florette
  fd: 'ƒ', // latin small letter f with hook
  ff: 'ɸ', // latin small letter phi
  fh: 'ɾ', // latin small letter r with fishhook
  Fi: 'Φ', // greek capital letter phi
  fi: 'φ', // greek small letter phi
  fr: '\u1DC9', // combining acute-grave-acute
  'G+': 'ג', // hebrew letter gimel
  'G<': 'Ǧ', // latin capital letter g with caron
  'g<': 'ǧ', // latin small letter g with caron
  'G^': 'ʛ', // latin letter small capital g with hook
  'g^': 'ɠ', // latin small letter g with hook
  Ga: 'Γ', // greek capital letter gamma
  ga: 'γ', // greek small letter gamma
  gc: 'ɢ', // latin letter small capital g
  gf: 'ɣ', // latin small letter gamma
  gs: 'ɡ', // latin small letter script g
  'H+': 'ה', // hebrew letter he
  'h-': 'ħ', // latin small letter h with stroke
  'h^': 'ɦ', // latin small letter h with hook
  hc: 'ʜ', // latin letter small capital h
  he: '♥', // black heart suit
  hI: '\u05B4', // hebrew point hiriq
  hj: 'ɧ', // latin small letter heng with hook
  hO: '\u05B9', // hebrew point holam
  hr: '˞', // modifier letter rhotic hook
  hs: 'ʊ', // latin small letter upsilon
  ht: 'ɥ', // latin small letter turned h
  'I"': 'Ï', // latin capital letter i with diaeresis
  'i"': 'ï', // latin small letter i with diaeresis
  "I'": 'Í', // latin capital letter i with acute
  "i'": 'í', // latin small letter i with acute
  'i-': 'ɨ', // latin small letter i with stroke
  'I^': 'Î', // latin capital letter i with circumflex
  'i^': 'î', // latin small letter i with circumflex
  'I`': 'Ì', // latin capital letter i with grave
  'i`': 'ì', // latin small letter i with grave
  ic: 'ɪ', // latin letter small capital i
  id: 'ɿ', // latin small letter reversed r with fishhook
  in: '∫', // integral
  Io: 'Ι', // greek capital letter iota
  io: 'ι', // greek small letter iota
  ir: 'ʅ', // latin small letter squat reversed esh
  'J+': 'י', // hebrew letter yod
  'j-': 'ɟ', // latin small letter dotless j with stroke
  'j^': 'ʄ', // latin small letter dotless j with stroke and hook
  jc: 'ʝ', // latin small letter j with crossed-tail
  'K%': 'ך', // hebrew letter final kaf
  'K+': 'כ', // hebrew letter kaf
  Ka: 'Κ', // greek capital letter kappa
  ka: 'κ', // greek small letter kappa
  kb: 'ɞ', // latin small letter closed reversed open e
  'L+': 'ל', // hebrew letter lamed
  'l-': 'ɬ', // latin small letter l with belt
  'l.': 'ɭ', // latin small letter l with retroflex hook
  'L/': 'Ł', // latin capital letter l with stroke
  'l/': 'ł', // latin small letter l with stroke
  La: 'Λ', // greek capital letter lamda
  la: 'λ', // greek small letter lamda
  lc: 'ʟ', // latin letter small capital l
  LI: '\u035C', // combining double breve below
  li: '\u0361', // combining double inverted breve
  Lp: '£', // pound sign
  lz: 'ɮ', // latin small letter lezh
  'l~': 'ɫ', // latin small letter l with middle tilde
  'M%': 'ם', // hebrew letter final mem
  'M+': 'מ', // hebrew letter mem
  mj: 'ɱ', // latin small letter m with hook
  ml: 'ɰ', // latin small letter turned m with long leg
  mt: 'ɯ', // latin small letter turned m
  Mu: 'Μ', // greek capital letter mu
  mu: 'μ', // greek small letter mu
  mv: '\u033C', // combining seagull below
  'N%': 'ן', // hebrew letter final nun
  "N'": 'Ń', // latin capital letter n with acute
  "n'": 'ń', // latin small letter n with acute
  'N+': 'נ', // hebrew letter nun
  'n.': 'ɳ', // latin small letter n with retroflex hook
  'N<': 'Ň', // latin capital letter n with caron
  'n<': 'ň', // latin small letter n with caron
  'N^': '\u0306', // combining breve
  nc: 'ɴ', // latin letter small capital n
  NE: '↗', // north east arrow
  ng: 'ŋ', // latin small letter eng
  ni: '∩', // intersection
  nj: 'ɲ', // latin small letter n with left hook
  no: '¬', // not sign
  Nu: 'Ν', // greek capital letter nu
  nu: 'ν', // greek small letter nu
  Nv: '\u032A', // combining bridge below
  nv: '\u032F', // combining inverted breve below
  NW: '↖', // north west arrow
  'N~': 'Ñ', // latin capital letter n with tilde
  'n~': 'ñ', // latin small letter n with tilde
  'O"': 'Ö', // latin capital letter o with diaeresis
  'o"': 'ö', // latin small letter o with diaeresis
  "O'": 'Ó', // latin capital letter o with acute
  "o'": 'ó', // latin small letter o with acute
  'o+': '⊕', // circled plus
  'o-': 'ɵ', // latin small letter barred o
  'O.': 'ʘ', // latin letter bilabial click
  'O/': 'Ø', // latin capital letter o with stroke
  'o/': 'ø', // latin small letter o with stroke
  o2: 'ϖ', // greek pi symbol
  'O:': 'Ő', // latin capital letter o with double acute
  'o:': 'ő', // latin small letter o with double acute
  'O^': 'Ô', // latin capital letter o with circumflex
  'o^': 'ô', // latin small letter o with circumflex
  o_: 'º', // masculine ordinal indicator
  'O`': 'Ò', // latin capital letter o with grave
  'o`': 'ò', // latin small letter o with grave
  oc: '∝', // proportional to
  Oe: 'ɶ', // latin letter small capital oe
  oe: 'œ', // latin small ligature oe
  Om: 'Ω', // greek capital letter omega
  om: 'ω', // greek small letter omega
  On: 'Ο', // greek capital letter omicron
  on: 'ο', // greek small letter omicron
  oo: '∞', // infinity
  or: '∨', // logical or
  ox: '⊗', // circled times
  'O|': '∅', // empty set
  'O~': 'Õ', // latin capital letter o with tilde
  'o~': 'õ', // latin small letter o with tilde
  'P%': 'ף', // hebrew letter final pe
  'P+': 'פ', // hebrew letter pe
  pA: '\u05B7', // hebrew point patah
  pf: '☞', // white right pointing index
  Pi: 'Π', // greek capital letter pi
  pi: 'π', // greek small letter pi
  Ps: 'Ψ', // greek capital letter psi
  ps: 'ψ', // greek small letter psi
  'Q+': 'ק', // hebrew letter qof
  qA: '\u05B8', // hebrew point qamats
  qU: '\u05BB', // hebrew point qubuts
  'R+': 'ר', // hebrew letter resh
  'r.': 'ɻ', // latin small letter turned r with hook
  'R<': 'Ř', // latin capital letter r with caron
  'r<': 'ř', // latin small letter r with caron
  rc: 'ʀ', // latin letter small capital r
  re: '®', // registered sign
  rf: '\u1DC8', // combining grave-acute-grave
  rh: 'ɤ', // latin small letter rams horn
  ri: 'ʁ', // latin letter small capital inverted r
  rl: 'ɺ', // latin small letter turned r with long leg
  Ro: 'Ρ', // greek capital letter rho
  ro: 'ρ', // greek small letter rho
  rt: 'ɹ', // latin small letter turned r
  "S'": 'Ś', // latin capital letter s with acute
  "s'": 'ś', // latin small letter s with acute
  'S+': 'ס', // hebrew letter samekh
  'S,': 'Ş', // latin capital letter s with cedilla
  's,': 'ş', // latin small letter s with cedilla
  's.': 'ʂ', // latin small letter s with hook
  s2: 'ς', // greek small letter final sigma
  'S<': 'Š', // latin capital letter s with caron
  's<': 'š', // latin small letter s with caron
  SE: '↘', // south east arrow
  sE: '\u05B6', // hebrew point segol
  sh: 'ʃ', // latin small letter esh
  Si: 'Σ', // greek capital letter sigma
  si: 'σ', // greek small letter sigma
  sp: '♠', // black spade suit
  sr: 'ɚ', // latin small letter schwa with hook
  SS: '§', // section sign
  ss: 'ß', // latin small letter sharp s
  su: '∑', // n-ary summation
  SW: '↙', // south west arrow
  sw: 'ə', // latin small letter schwa
  'T(': '\u0318', // combining left tack below
  'T)': '\u0319', // combining right tack below
  'T+': 'ת', // hebrew letter tav
  'T,': 'Ţ', // latin capital letter t with cedilla
  't,': 'ţ', // latin small letter t with cedilla
  't.': 'ʈ', // latin small letter t with retroflex hook
  t2: 'ϑ', // greek theta symbol
  'T<': 'Ť', // latin capital letter t with caron
  't<': 'ť', // latin small letter t with caron
  'T^': '\u031D', // combining up tack below
  Ta: 'Τ', // greek capital letter tau
  ta: 'τ', // greek small letter tau
  Te: 'Θ', // greek capital letter theta
  te: 'θ', // greek small letter theta
  tf: 'θ', // greek small letter theta
  Th: 'Þ', // latin capital letter thorn
  th: 'þ', // latin small letter thorn
  TM: '™', // trade mark sign
  tm: '™', // trade mark sign
  tS: 'ʧ', // latin small letter tesh digraph
  ts: 'ʦ', // latin small letter ts digraph
  Tt: '⊥', // up tack
  Tv: '\u031E', // combining down tack below
  'U"': 'Ü', // latin capital letter u with diaeresis
  'u"': 'ü', // latin small letter u with diaeresis
  "U'": 'Ú', // latin capital letter u with acute
  "u'": 'ú', // latin small letter u with acute
  'u-': 'ʉ', // latin small letter u bar
  'U:': 'Ű', // latin capital letter u with double acute
  'u:': 'ű', // latin small letter u with double acute
  'U^': 'Û', // latin capital letter u with circumflex
  'u^': 'û', // latin small letter u with circumflex
  'U`': 'Ù', // latin capital letter u with grave
  'u`': 'ù', // latin small letter u with grave
  un: '_', // low line
  Uo: 'Ů', // latin capital letter u with ring above
  uo: 'ů', // latin small letter u with ring above
  Up: 'Υ', // greek capital letter upsilon
  up: 'υ', // greek small letter upsilon
  uu: '∪', // union
  Uv: '\u033A', // combining inverted bridge below
  'V+': 'ו', // hebrew letter vav
  'V^': 'ⱱ', // latin small letter v with right hook
  'v^': '\u030C', // combining caron
  Vr: '√', // square root
  vs: 'ʋ', // latin small letter v with hook
  vt: 'ʌ', // latin small letter turned v
  vv: '\u032C', // combining caron below
  'W+': 'ש', // hebrew letter shin
  wt: 'ʍ', // latin small letter turned w
  wv: '\u032B', // combining inverted double arch below
  'X+': 'ח', // hebrew letter het
  'x^': '\u033D', // combining x above
  Xi: 'Ξ', // greek capital letter xi
  xi: 'ξ', // greek small letter xi
  xx: '×', // multiplication sign
  'Y"': 'Ÿ', // latin capital letter y with diaeresis
  'y"': 'ÿ', // latin small letter y with diaeresis
  "Y'": 'Ý', // latin capital letter y with acute
  "y'": 'ý', // latin small letter y with acute
  'Y+': 'ט', // hebrew letter tet
  'Y=': '¥', // yen sign
  yc: 'ʏ', // latin letter small capital y
  yt: 'ʎ', // latin small letter turned y
  'Z!': 'Ż', // latin capital letter z with dot above
  'z!': 'ż', // latin small letter z with dot above
  "Z'": 'Ź', // latin capital letter z with acute
  "z'": 'ź', // latin small letter z with acute
  'Z+': 'ז', // hebrew letter zayin
  'z.': 'ʐ', // latin small letter z with retroflex hook
  'Z<': 'Ž', // latin capital letter z with caron
  'z<': 'ž', // latin small letter z with caron
  zc: 'ʑ', // latin small letter z with curl
  Ze: 'Ζ', // greek capital letter zeta
  ze: 'ζ', // greek small letter zeta
  zh: 'ʒ', // latin small letter ezh
  '|-': 'ǂ', // latin letter alveolar click
  '|1': 'ǀ', // latin letter dental click
  '|2': 'ǁ', // latin letter lateral click
  '|f': '|', // vertical line
  '|v': '\u0329', // combining vertical line below
  '||': '¶', // pilcrow sign
  '~/': '\u0334', // combining tilde overlay
  '~<': '\u0334', // combining tilde overlay
  '~^': '\u0303', // combining tilde
  '~v': '\u0330', // combining tilde below
  '~~': '≈', // almost equal to
});
