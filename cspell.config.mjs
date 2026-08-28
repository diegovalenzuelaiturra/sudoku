/* Spelling for the half of this repository a player actually reads.

   Every other check here judges code. A misspelling in the Spanish copy is
   invisible to all of them: it compiles, it lints, it passes the browser suite,
   and it is the one class of defect every single visitor sees. Nothing looked
   at it before this file.

   Scoped hard on purpose. Run over the whole tree with the default settings
   this finds nothing useful and a great deal of noise, because a source file is
   mostly identifiers, and an identifier is not a word. So the file list is the
   two documents that hold player-facing text, and the patterns below delete the
   parts of them that are code before a single word is checked.

   es-ES and en are both on. The interface is Spanish, the comments and the
   identifiers around it are English, and they share a file. */

export default {
  version: '0.2',
  /* en-GB before en, because this repository writes British English throughout:
     colours, serialises, unrecognised, sanitised. Without it the checker
     reports the house style as a mistake 8 times and the first person to run it
     switches it off. */
  language: 'es-ES,en-GB,en',
  import: ['@cspell/dict-es-es/cspell-ext.json'],

  files: ['index.html', 'app.js', '404.html'],

  /* The words this project uses that no dictionary has. Kept short and
     explained, because a dictionary that grows without thought is how a
     misspelling gets accepted permanently on the day it is introduced. */
  words: [
    /* The four difficulty tiers. Chilean Spanish, and deliberately not the
       words a dictionary would offer. */
    'Piola',
    'Peludo',
    'Brígido',
    /* The techniques the ladder grades by, and the prize the wallet pays. */
    'directas',
    'bloques',
    'chocolates',
    /* Product and platform nouns. */
    'sudoku',
    'webmanifest',
    'preconnect',
    'noopener',
    'noreferrer',
    /* Identifiers that reach the checked text as one lowercase run, so the
       camel case splitter cannot help: element ids, stored key names, and the
       lowercased KeyboardEvent.key values the keyboard handler compares
       against. */
    'prefs',
    'genstatus',
    'arrowup',
    'arrowdown',
    'arrowleft',
    'arrowright',
    /* The two prize glyph names, and the journalism term the code borrows for
       the first line of the record. */
    'frychip',
    'chocochip',
    'lede',
    /* Undo is a verb this code pluralises as a noun, and pillarbox is the
       letterbox term for the bars beside a too-narrow board. */
    'undos',
    'pillarbox',
    'downscales',
    /* Two words the comments use as technical verbs. inert is an HTML
       attribute, and the comment describes applying it. */
    'evictable',
    'inerting',
  ],

  /* Anything matching these is removed from the text before it is checked, so
     the dictionary never has to learn a hex colour or a CSS keyword. */
  ignoreRegExpList: [
    /* Attribute and property names, URLs, entities, data URIs, hex colours. */
    'HexValues',
    'Urls',
    'HtmlSGMLEntity',
    'Base64MultiLine',
    /* The inline stylesheet and every style attribute: CSS is not prose. */
    String.raw`<style[\s\S]*?</style>`,
    String.raw`style="[^"]*"`,
    /* The icon sprite, which is a wall of path data. */
    String.raw`<svg[\s\S]*?</svg>`,
    String.raw`\bd="[^"]*"`,
    /* localStorage keys and other colon separated identifiers. */
    String.raw`sudoku:[a-z]+`,
  ],
};
