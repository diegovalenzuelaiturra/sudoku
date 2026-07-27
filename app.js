/* ============ GENERATOR CLIENT ============
   The generator moved to generator.js and runs in a worker. What is left here
   is the part that asks for a board and waits for it, which is the whole reason
   the difficulty buttons no longer freeze the page: this file used to carry a
   workaround for its own freeze, dropping clicks whose timeStamp fell inside
   the hang, and that workaround is gone.

   Two paths, because a worker is not a given. Some engines refuse to construct
   one for a file:// document, and a hardened configuration or an extension can
   block it outright. If construction, or the request itself, fails then the
   same file is injected as a plain script and the same makePuzzle() runs here
   on the main thread: slower and blocking, but a game rather than an error. */
const GENERATOR_URL='./generator.js';
/* A board costs about 115ms in the worst case measured, so this only ever fires
   on a worker that is gone. It has to exist: a worker can be reclaimed by the
   browser without dispatching `error`, and a request that never settles leaves
   the difficulty buttons and "Seguir jugando" disabled with no way out of the
   dialog and no way back to the game underneath it. */
const GENERATOR_TIMEOUT=10000;
let genWorker=null,genJobs=new Map(),genNextId=1,genScript=null;

function generatorWorker(){
  if(genWorker!==null)return genWorker;
  try{
    const worker=new Worker(GENERATOR_URL);
    worker.addEventListener('message',e=>{
      const reply=e.data||{};
      const job=genJobs.get(reply.id);
      if(!job)return;
      genJobs.delete(reply.id);
      if(reply.ok)job.resolve(reply);
      /* Marked, because the fallback below must not run for this one: the
         worker ran and could not answer, so the same call on the main thread
         fails the same way, after freezing the page for the whole search. */
      else job.reject(Object.assign(new Error(reply.error||'the generator failed'),{ranAndFailed:true}));
    });
    /* A worker that dies takes every request waiting on it down too, so they
       are rejected here rather than left pending forever: the caller then falls
       back to the main thread and the player still gets a board. */
    worker.addEventListener('error',()=>{
      genWorker=false;
      for(const job of genJobs.values())job.reject(new Error('the generator worker stopped'));
      genJobs.clear();
    });
    genWorker=worker;
  }catch{genWorker=false}
  return genWorker;
}

/* Pulls generator.js into the page itself, once, for the fallback path only.
   It exports a single name onto window, which is also what keeps it from
   colliding with anything declared here: two classic scripts declaring the same
   global const is a SyntaxError, and this file has a `boxOf` and a `PEERS` of
   its own. */
function loadGeneratorScript(){
  if(genScript!==null)return genScript;
  genScript=new Promise((resolve,reject)=>{
    const el=document.createElement('script');
    el.src=GENERATOR_URL;
    el.addEventListener('load',resolve);
    el.addEventListener('error',()=>{
      /* The memo is dropped along with the element, so a failure is forgotten
         rather than cached. A rejected promise kept here made the only thing
         the player is told to do, "probá de nuevo", impossible to follow: one
         request that lost the network took the fallback out for the life of the
         page, and every later press answered instantly from the same rejection
         without touching the network again. */
      el.remove();
      genScript=null;
      reject(new Error(`could not load ${GENERATOR_URL}`));
    });
    document.head.appendChild(el);
  });
  return genScript;
}

function generateOnThisThread(request){
  return loadGeneratorScript().then(()=>window.SudokuGenerator.makePuzzle(request));
}

function requestPuzzle(request){
  const worker=generatorWorker();
  if(worker===false)return generateOnThisThread(request);
  const id=genNextId++;
  return new Promise((resolve,reject)=>{
    genJobs.set(id,{resolve,reject});
    /* The deadline, and it also clears the job: a postMessage that throws
       rejects this promise without ever removing what the line above put in
       genJobs, and nothing else would. */
    setTimeout(()=>{
      if(!genJobs.has(id))return;
      genJobs.delete(id);
      genWorker=false;
      reject(new Error('the generator worker did not answer'));
    },GENERATOR_TIMEOUT);
    worker.postMessage({clues:request.clues,grade:request.grade,seed:request.seed,id});
  }).catch(error=>{
    /* Only a worker that could not be reached is worth retrying here. One that
       ran and threw is a deterministic failure: re-running it on the main
       thread costs the player the freeze this file moved the generator off the
       main thread to remove, and then fails anyway. */
    if(error?.ranAndFailed)throw error;
    return generateOnThisThread(request);
  });
}
/* ========== END GENERATOR CLIENT ========== */

/* ================== UI =================== */
/* Two prizes, two rules. Papas fritas are paid for every win, doubled by the
   flawless bonus. Chocolates are paid only for a flawless win, so they are the
   scarce one and the count says something the fries total cannot. */
/* `grade` is the difficulty now, and `clues` is only where the search starts.
   A board is graded by the hardest technique needed to finish it, so 24 clues
   that fall to naked singles no longer get to call themselves Brígido. See
   generator.js for the ladder.

   The clue numbers are tuned starting densities, not a difficulty knob, which
   is why Peludo starts denser than Normal: measured over 60 boards a tier, that
   pairing lands exactly on the requested grade 100 percent of the time for
   Piola, Normal and Brígido, and 85 percent for Peludo, whose tier is a narrow
   band between what locked candidates alone can finish and what needs more than
   pairs. A miss is reported as the grade it really is, never as the one that
   was asked for. */
const DIFF={easy:{clues:40,grade:1,label:'Piola',fries:5,choco:1},medium:{clues:28,grade:2,label:'Normal',fries:10,choco:2},hard:{clues:32,grade:3,label:'Peludo',fries:15,choco:3},expert:{clues:24,grade:4,label:'Brígido',fries:25,choco:5}};
/* Mirrors GRADE_NAMES in generator.js. Two copies rather than one import,
   because this file is inline and that one has to run in a worker; the pair is
   pinned together by tests/generator.test.mjs. */
const GRADE_WORDS={1:'directas',2:'bloques',3:'pares',4:'avanzado'};
const $=id=>document.getElementById(id);
const boardEl=$('board'),padEl=$('pad');

let solution=new Array(81).fill(0),fixed=new Array(81).fill(false),values=new Array(81).fill(0),puzzle=new Array(81).fill(0);
let notes=Array.from({length:81},()=>new Set()),sel=-1;
let notesMode=false,mistakes=0,hints=0,seconds=0,tick=null,paused=false,solved=false,playing=false;
/* Which cells have had their answer shown. Counters stopped rewinding with the
   undo stack, which is right for a mistake but charged twice for one revealed
   digit: hint() leaves sel on the cell it filled and undo() does not restore
   sel, so H, Z, H found that cell empty and editable again and spent a second
   hint on an answer already seen. Charging is per cell, not per press.

   Deliberately not persisted. Written into the save it would be read back from
   storage the player can edit, and a planted revealed:[0..80] with hints:0 buys
   a whole board of free hints while the flawless gate still reads zero, which is
   the forged prize this game keeps having to close. The cost of keeping it in
   memory is that a reload forgets, so a cell revealed and undone before the
   reload can be charged once more. That is what every build before this one did
   for every hint, and it is not a prize anyone can farm. */
let revealed=new Set();
/* What the next render() should say out loud, for actions that change no
   counter and so would otherwise be silent. render() is the single writer of
   #srStatus during play and the only thing that keeps srLast in step; writing
   the element directly from an action clobbers whatever render() just put there
   and leaves srLast claiming it was said. */
let srAction='';
let undoStack=[],diffKey='medium',friesTotal=0,chocoTotal=0,winTimers=[],pausedByDialog=false;
/* What the board in play actually is, as opposed to what was asked for: the
   grade it was measured at and the seed it was built from. Both are shown to
   the player at the end, and the seed is what makes a board reproducible. */
let puzzleGrade=1,puzzleSeed=0;
/* Whether those two came from the generator or were guessed at. A save written
   before grading existed carries neither, and the fallbacks below are a tier
   nothing measured and a seed that rebuilds a different board, so the end of
   game summary has to stay quiet about both rather than state them with the
   same confidence as a board that was actually measured. */
let puzzleMeasured=false;
const reduceMotion=matchMedia('(prefers-reduced-motion:reduce)');
/* persistence: bump SAVE_VERSION and loadGame()'s shape checks together if this payload shape ever changes */
const SAVE_KEY='sudoku:save',SAVE_VERSION=1;
/* The prize totals live in their own key, deliberately not in the game save:
   winning is what pays them and winning is also what deletes the save, so a
   total kept in there was lost on the next reload. */
const WALLET_KEY='sudoku:wallet',WALLET_VERSION=2;
/* How many ledger entries are kept. The ledger is a record for a player who
   wants to see where the prizes went, not an audit log, and localStorage is
   both small and evictable: the oldest entry falls off the end. */
const LEDGER_MAX=40;
/* Games played and won, best times and the flawless streak. Its own key again,
   for the same reason the wallet has one: a win clears the game save. */
const STATS_KEY='sudoku:stats',STATS_VERSION=1;
let ledger=[],stats=null;

/* ---- build DOM once ---- */
const cells=[];
for(let i=0;i<81;i++){
  const b=document.createElement('button');
  b.className='cell';b.dataset.i=i;
  const v=document.createElement('span');v.className='v';
  const n=document.createElement('div');n.className='notes';
  for(let d=1;d<=9;d++)n.appendChild(document.createElement('span'));
  b.append(v,n);
  /* The selection is part of the save, so a bare click has to persist it too:
     without this a reload restores the selection from the last digit entry,
     one move behind. A click is a discrete, human paced action like that digit
     entry and a pointer cannot autorepeat, so it saves straight away with no
     coalescing; the held-arrow path is the one that needs that. */
  b.addEventListener('click',()=>{if(!playing||paused)return;sel=i;render();saveGame()});
  boardEl.appendChild(b);cells.push(b);
}
const keys=[];
for(let d=1;d<=9;d++){
  const k=document.createElement('button');
  k.className='key';k.innerHTML=`<span class="d">${d}</span><span class="c">9</span>`;
  k.addEventListener('click',()=>inputDigit(d));
  padEl.appendChild(k);keys.push(k);
}

/* ---- helpers ---- */
const pad2=n=>String(n).padStart(2,'0');
const fmt=s=>s<3600?`${(s/60)|0}:${pad2(s%60)}`:`${(s/3600)|0}:${pad2(((s/60)|0)%60)}:${pad2(s%60)}`;
/* The counters used to ride along in here and be put back by undo(), which meant
   Deshacer erased the very mistake it was undoing: the marcador rewound,
   saveGame() persisted the rewound number, and because the flawless bonus is
   gated on mistakes===0&&hints===0, guessing a digit and undoing it when wrong
   paid double papas plus the chocolates a clean solve exists to reserve. That
   was the only route to a forged prize needing nothing but the game's own
   buttons. Hints were the cheaper one: press H, read the answer, press Z, and
   the hint was off the record while the digit was still on screen. Undo restores
   a board. It cannot un-see an answer or un-make a mistake, so what the player
   did is not its to rewrite.

   7736ed4 put those two fields in here on purpose, and this reverts that half of
   it with the cost taken knowingly: a mis-tapped digit, or a stray H, now
   forfeits the bonus for the rest of the board. Its other half is why fixed is
   still snapshotted, so undoing a hint unlocks the cell instead of leaving it
   given and holding a value the player can no longer edit. */
function snapshot(){
  undoStack.push({values:values.slice(),fixed:fixed.slice(),notes:notes.map(s=>[...s])});
  if(undoStack.length>300)undoStack.shift();
}
/* Board geometry, needed here as well as in generator.js: this side of the wall
   uses it to highlight the row, column and box of the selected cell, which is
   nothing to do with generating a puzzle. Nine characters, duplicated rather
   than shipped across the worker boundary or split into a third file. */
const boxOf=i=>((((i/9)|0)/3)|0)*3+(((i%9)/3)|0);
function peers(i){
  const r=(i/9)|0,c=i%9,b=boxOf(i),out=new Set();
  for(let k=0;k<81;k++){
    if(k===i)continue;
    if(((k/9)|0)===r||k%9===c||boxOf(k)===b)out.add(k);
  }
  return out;
}
/* peer sets are fixed board geometry: build them once instead of on every render */
const PEERS=Array.from({length:81},(_,i)=>peers(i));

/* ---- overlays ---- */
const appEl=document.querySelector('.app');
const controlsEl=document.querySelector('.controls');
/* The record dialog opens on top of the start dialog, so both functions below
   ask every overlay rather than the two they used to: closing the one in front
   must not hand the board back while the one behind it is still up. */
const OVERLAYS=['startOverlay','winOverlay','recordOverlay'];
function showOverlay(el){
  el.classList.add('show');
  appEl.inert=true;
  /* This focus() shows up in a trace as a ~50ms forced reflow because it
     pulls the document's first layout of the 81-cell board into the script.
     Three alternatives were measured against it, 20 cold loads each, fresh
     browser context, no tracing overhead (tracing on its own inflates the
     reflow: 5ms warm untraced, 46ms warm traced):
       - focus() before appEl.inert: no change, reverted.
       - focus() inside requestAnimationFrame: the reflow leaves the trace
         entirely, 35.5ms of script time becomes 0.2ms, but first paint does
         not move (60ms median either way) and total main thread blocking
         barely does (35.9ms to 32.8ms median).
       - no focus() at all, the ceiling for anything done to this line:
         first paint still 60ms.
     That layout is work the first paint needs, so no reordering here can
     recover it; deferring only relabels it. Keep it synchronous, where focus
     is guaranteed to land in the dialog even in a tab that is never given an
     animation frame. */
  /* An explicit target first, then the first button that can actually take
     focus. Both halves are needed. The record dialog leads with its two redeem
     buttons, which are the wrong thing to hand a player on opening and are
     disabled outright when there is nothing to redeem, and a focus() on a
     disabled button silently does nothing: focus stayed on the body and the
     next Tab started again from the top of the page. */
  /* The overlays are siblings of .app, not children, so inerting .app does
     nothing to the dialog behind this one. Without this, Tab out of the record
     dialog walks straight into the difficulty buttons of the start dialog it is
     covering, and Enter there starts a game underneath it: hideOverlay then
     keeps .app inert because the record is still up, so the clock runs on a
     board the player cannot touch. */
  for(const id of OVERLAYS)$(id).inert=$(id)!==el;
  const first=el.querySelector('[data-autofocus]')||el.querySelector('button:not([hidden]):not([disabled])');
  if(first)first.focus();
}
function hideOverlay(el){
  el.classList.remove('show');
  /* Cleared on every overlay, because whatever was behind this one is in front
     now. Done before the caller does anything else: closeRecord() focuses
     #recordBtn straight after this, and focus() on an inert element silently
     does nothing. */
  for(const id of OVERLAYS)$(id).inert=false;
  if(!OVERLAYS.some(id=>$(id).classList.contains('show')))appEl.inert=false;
}

/* ---- timer ---- */
function startTimer(){
  clearInterval(tick);
  tick=setInterval(()=>{seconds++;$('time').textContent=fmt(seconds)},1000);
}
function setPaused(p){
  if(!playing||solved)return;
  const veil=$('veil');
  const wasShown=veil.classList.contains('show');
  paused=p;
  veil.classList.toggle('show',p);
  boardEl.classList.toggle('veiled',p);
  /* pauseBtn is icon-only: swap the sprite reference rather than assigning
     textContent, which would delete the <svg> the markup depends on. */
  $('pauseBtn').querySelector('use').setAttribute('href',p?'#i-play_arrow':'#i-pause');
  $('pauseBtn').setAttribute('aria-label',p?'Seguir':'Pausar');
  /* .board.veiled only paints the digits transparent, which hides them from
     sight and from nobody else: assistive tech still read every solved value
     and Tab still walked all 81 cells while "paused". Mark the two regions
     that leak instead - the board holds the values, the controls act on them.
     appEl cannot be used here the way showOverlay does it, because the veil
     lives inside .app and would disable its own resume button. */
  boardEl.inert=p;
  controlsEl.inert=p;
  if(p){clearInterval(tick);saveGame();$('resumeBtn').focus()} /* capture `seconds` the moment play stops, not at the last digit */
  else{startTimer();if(wasShown)$('pauseBtn').focus()}
}

/* ---- game flow ----
   Generating is asynchronous now, so starting a game is two halves: ask for a
   board and wait, then lay it out. Only the waiting half can fail, and only the
   laying out half touches game state, which keeps a failed request from leaving
   a half started game behind. */
let generating=false;

/* Disables the difficulty buttons and says what is happening. This replaces the
   old defence against the freeze, which let every click through and then threw
   away the ones whose timeStamp fell inside the hang. Nothing is thrown away
   now: the buttons are genuinely unavailable while a board is being built. */
function setGenerating(busy){
  generating=busy;
  /* Emptied on the way out and written on the way in, so a failure message from
     the previous attempt is cleared exactly when a new one starts, and so the
     live region is never carrying text it entered the tree with. */
  $('genStatus').textContent=busy?'Generando tablero...':'';
  document.querySelectorAll('.diff').forEach(b=>{b.disabled=busy});
  $('cancelNew').disabled=busy;
  /* The record button lives in this dialog too. Left alive, it opens the record
     over a picker that is about to be replaced: the board then arrives and
     startGame lays it out underneath, where hideOverlay keeps .app inert
     because the record is still up, and the clock runs on a board nobody can
     reach. */
  $('recordBtn').disabled=busy;
}

async function newGame(key){
  /* A second click while the first board is still being built would start two
     games and lay out whichever came back last. */
  if(generating)return;
  /* Killed here rather than in startGame, which is where they used to die when
     this function was synchronous and the click cleared them before returning.
     Waiting for a board is a window they would otherwise survive: the win
     dialog's own timer would open it on top of the difficulty picker, taking
     focus with it, while the next board is still being built. */
  winTimers.forEach(clearTimeout);winTimers=[];
  setGenerating(true);
  let made;
  try{
    /* A fresh seed per game, and the whole board is a pure function of it, so
       quoting the code back rebuilds exactly this puzzle. */
    const seed=(Math.random()*4294967296)>>>0;
    made=await requestPuzzle({clues:DIFF[key].clues,grade:DIFF[key].grade,seed});
  }catch{made=null}
  setGenerating(false);
  if(made===null){
    /* Both paths to a board failed, which leaves nothing to play. Said where
       the difficulty buttons are, rather than failing silently or throwing
       inside a click handler where nothing would report it.

       Written after setGenerating(false) and not before: that call empties this
       element, so a message set first was cleared before anyone could read it.
       Written into a region that has been in the accessibility tree the whole
       time, which is what makes it a change a screen reader announces. */
    $('genStatus').textContent='No se pudo armar el tablero. Probá de nuevo.';
    return;
  }
  /* Outside the try: a failure to lay out a board that did arrive is a bug in
     this file, not a generator that could not answer, and swallowing it here
     would report it to the player as the latter. */
  startGame(key,made);
}

function startGame(key,made){
  diffKey=key;
  winTimers.forEach(clearTimeout);winTimers=[];
  document.querySelectorAll('.drop').forEach(f=>{f.remove()});
  const generated=made.puzzle;
  puzzle=generated;
  solution=made.solution;
  /* What the board turned out to be, which is not always what was asked for:
     the Peludo tier is narrow and the search lands beside it about one time in
     seven. Recording the measured grade rather than DIFF[key].grade is what
     keeps the end of game summary honest. */
  puzzleGrade=made.grade;
  puzzleSeed=made.seed;
  puzzleMeasured=true;
  recordPlayed(key);
  values=generated.slice();
  fixed=generated.map(v=>v!==0);
  notes=Array.from({length:81},()=>new Set());
  undoStack=[];mistakes=0;hints=0;seconds=0;solved=false;playing=true;notesMode=false;pausedByDialog=false;revealed=new Set();
  sel=values.indexOf(0);
  $('notesBtn').setAttribute('aria-pressed','false');
  showNotesHint();
  /* The win paints the chips on a timer, and every win timer was cleared at the
     top of this function. Starting the next puzzle during the payout animation
     would otherwise leave both totals reading what they said before the prize
     was banked, until something else repainted them or the page reloaded. */
  paintWallet();
  $('diffLabel').textContent=DIFF[key].label;
  $('time').textContent='0:00';
  $('stamp').classList.remove('show');
  $('srStatus').textContent='';
  $('srAlert').textContent='';
  hideOverlay($('startOverlay'));
  hideOverlay($('winOverlay'));
  /* Not setPaused(false): laying the board out is no longer the same task as
     the click that asked for it, so the tab can be in the background by the
     time it happens. visibilitychange fired while `playing` was still false and
     setPaused returned early, so an unconditional false started the clock on a
     board nobody was looking at, and the minutes went into the best time. */
  setPaused(document.hidden); /* resets veil, pause glyph + aria-label, and starts or holds the timer */
  /* a fresh puzzle starts from zero: don't let the tracker read it as progress */
  srLast={mistakes:0,hints:0,remaining:null};
  render();
  clearSavedGame(); /* a freshly generated puzzle invalidates whatever was saved before */
  saveGame(); /* persist right away: a refresh before the first move must still resume this puzzle, not the previous one */
}

/* ---- persistence ----
   saveGame() is called from every discrete player action (digit entry, erase,
   undo, hint, pause, and selecting a cell with the pointer) rather than on a
   timer: those are human-paced clicks and keypresses, not a text-input stream,
   and the payload (a handful of 81-length arrays) is small enough that writing
   it synchronously on each one is cheap. The single exception is the arrow key
   path, which autorepeats while a key is held: it coalesces through
   saveSelectionSoon() below and writes once the burst stops. The
   `!playing||solved` guard below makes saveGame() safe to call
   unconditionally, including right after win() flips `solved`. */
/* The counters are re-read from storage before every write, for the same reason
   bankPrize() consults the wallet key again rather than trusting what this tab
   read at boot. Two tabs on one board used to lose whichever one wrote last: the
   storage listener adopts STATS_KEY and WALLET_KEY but falls through on
   SAVE_KEY, so this tab could sit on mistakes 0 while the other had counted
   three, and the next keystroke here overwrote them with 0. Since the flawless
   bonus is gated on mistakes===0&&hints===0, that paid a forged prize with two
   tabs open and no storage editing at all, which is cheaper than the edited save
   the clamp above closes.

   Both counters only ever rise within a game, so the higher of the two is the
   true count. Adopted into the live variables and not merely into the bytes,
   because the gate reads the variables: saveGame() runs before win() evaluates
   it, on the same keystroke that completes the board. Guarded to a save of this
   same puzzle, since a save of another board says nothing about this one. The
   marcador catches up on the next render rather than this instant, which is one
   action of lag on a number that was wrong until now. */
function adoptCounters(){
  let s;
  try{s=JSON.parse(localStorage.getItem(SAVE_KEY))}catch{return}
  if(!s||typeof s!=='object'||s.v!==SAVE_VERSION)return;
  if(!Array.isArray(s.solution)||s.solution.join()!==solution.join())return;
  mistakes=Math.max(mistakes,count(s.mistakes));
  hints=Math.max(hints,count(s.hints));
}
function saveGame(){
  if(!playing||solved)return;
  adoptCounters();
  try{
    localStorage.setItem(SAVE_KEY,JSON.stringify({
      v:SAVE_VERSION,
      puzzle,
      solution,
      values,
      fixed,
      notes:notes.map(s=>[...s]),
      sel,
      mistakes,
      hints,
      seconds,
      diffKey,
      solved,
      /* Both new, and neither needs a SAVE_VERSION bump. loadGame() reads them
         through the same defensive path as every other scalar and falls back to
         the difficulty's own grade, so a save written before they existed still
         restores instead of being thrown away. */
      grade:puzzleGrade,
      seed:puzzleSeed,
    }));
  }catch{/* Safari private mode throws on setItem, quota can be exceeded, etc: losing the autosave is fine, losing the game isn't */}
}
/* Selection is the one player action that can autorepeat: a held arrow key
   fires dozens of times a second, and each save serialises 81 note Sets. The
   arrow path therefore coalesces and writes once the burst stops. Clicks
   cannot repeat, so the board's click handler still saves immediately. The
   pending write re-reads the live globals and goes through saveGame(), whose
   !playing||solved guard makes a late timer a no-op rather than a resurrected
   save. */
let selSaveTimer=null;
function saveSelectionSoon(){
  clearTimeout(selSaveTimer);
  selSaveTimer=setTimeout(()=>{selSaveTimer=null;saveGame()},250);
}
function clearSavedGame(){
  try{localStorage.removeItem(SAVE_KEY)}catch{}
}
/* ---- prizes ----
   The totals live in a key of their own rather than in the game save. That
   save used to carry friesTotal, but win() is both what pays a prize and what
   calls clearSavedGame(), so the total survived only as long as the tab did:
   reloading after a win put it back to zero.

   Dropping the field needs no SAVE_VERSION bump. loadGame() checks the grids,
   the notes array and diffKey, never friesTotal, and reads every scalar
   through Number(x)||0, so a save written before this change still restores.
   Bumping would have been the expensive choice: an unrecognised version is
   rejected outright, which would have thrown away every game in progress. */
function saveWallet(){
  try{localStorage.setItem(WALLET_KEY,JSON.stringify({v:WALLET_VERSION,fries:friesTotal,choco:chocoTotal,ledger}))}catch{/* as with the autosave: a wallet that cannot be written is not worth failing a win over */}
}
/* The bytes under the key, or null when there are none and when storage itself
   is gone. Split out of readWallet() because the two answers it folds together,
   "nothing is stored" and "something is stored that this build cannot read",
   have to be told apart before anything is written back. */
function walletRaw(){
  try{return localStorage.getItem(WALLET_KEY)}catch{return null}
}
/* One rule for every total that arrives from outside this tab, whether from the
   wallet key or from the save it migrates once: a whole number this build can
   still add to, or nothing.

   The ceiling is not decoration. Beyond MAX_SAFE_INTEGER addition stops being
   exact, so a stored 1e308 makes friesTotal+fries a no-op and every win from
   then on visibly pays nothing. Infinity is worse: it renders as "Infinity",
   JSON.stringify writes it as null, and the next read turns that null into 0,
   which is the whole wallet gone by the route this code exists to close. */
function count(x){
  const n=Math.floor(Number(x));
  return Number.isFinite(n)&&n>0&&n<=Number.MAX_SAFE_INTEGER?n:0;
}
/* The stored totals, or null if there is nothing readable and current there.
   Separate from loadWallet() because banking a prize has to consult the key
   again rather than trust what this tab read at boot. */
/* One ledger entry, or null. Same rule as the totals: anything this build cannot
   make sense of is dropped rather than guessed at, and a dropped entry costs a
   line of history rather than the wallet it is attached to. `k` is 'win' or
   'redeem', `f` and `c` are signed deltas, `t` is when it happened. */
function readEntry(e){
  if(!e||typeof e!=='object')return null;
  if(e.k!=='win'&&e.k!=='redeem')return null;
  const t=Math.floor(Number(e.t));
  const f=Math.floor(Number(e.f));
  const c=Math.floor(Number(e.c));
  if(!Number.isFinite(t)||!Number.isFinite(f)||!Number.isFinite(c))return null;
  const d=typeof e.d==='string'&&Object.prototype.hasOwnProperty.call(DIFF,e.d)?e.d:'';
  return{t,k:e.k,f,c,d};
}
/* The stored totals and history, or null if there is nothing readable and
   current there. Separate from loadWallet() because banking a prize has to
   consult the key again rather than trust what this tab read at boot.

   Version 1 is read rather than rejected. It is the same two totals with no
   ledger, so it migrates by adopting them and starting the history empty, and
   rejecting it instead would have zeroed the wallet of every player who had one
   the moment this build shipped. A version this build has never heard of is
   still refused, which is the case that rule exists for. */
function readWallet(raw=walletRaw()){
  if(raw===null)return null;
  let w;
  try{w=JSON.parse(raw)}catch{return null}
  if(!w||typeof w!=='object')return null;
  if(w.v!==WALLET_VERSION&&w.v!==1)return null;
  const entries=Array.isArray(w.ledger)?w.ledger.map(readEntry).filter(e=>e!==null):[];
  return{fries:count(w.fries),choco:count(w.choco),ledger:entries.slice(-LEDGER_MAX)};
}
/* Appends to the history that is about to be written, oldest off the end. */
function logEntry(base,entry){
  return base.concat([entry]).slice(-LEDGER_MAX);
}
/* Adds a prize to the wallet, against what is stored rather than against what
   this tab happens to hold. The player can have the game open twice: the other
   tab read its totals at boot, and if this one wrote its own over the top, every
   prize won over there would vanish. Measured before this existed: two flawless
   wins in two tabs, 20 papas then 50, left 50 stored instead of 70.

   Falling back to the in-memory totals keeps a tab whose storage has died (or
   was cleared mid-game) counting its own prizes for as long as it lives. */
function bankPrize(fries,choco){
  const raw=walletRaw();
  const stored=readWallet(raw);
  const base=stored||{fries:friesTotal,choco:chocoTotal,ledger};
  friesTotal=base.fries+fries;
  chocoTotal=base.choco+choco;
  /* Appended to the stored history, not to this tab's copy, for exactly the
     reason the totals are: the other tab's wins are in there. */
  ledger=logEntry(base.ledger,{t:Date.now(),k:'win',f:fries,c:choco,d:diffKey});
  /* Written only when the key is empty or this build could read it. Bytes it
     could not read belong to another build, most likely a newer one the player
     still has cached, and loadWallet() already refuses to zero those: saving
     here regardless would undo that on the first win, putting this tab's total
     plus the prize over a record it never read. The chips still count either
     way, because a tab that cannot write is still allowed to keep score. */
  if(stored||raw===null)saveWallet();
}
function paintWallet(){
  $('fries').textContent=friesTotal;
  $('chocos').textContent=chocoTotal;
}
/* One rule for the chocolate plural, because the win announcement and the
   ledger line describe the same event and used to disagree: a flawless Piola
   pays one chocolate, announced as "1 chocolate" and written down in the
   history as "+1 chocolates". */
const chocoWord=n=>`${n} chocolate${Math.abs(n)===1?'':'s'}`;
/* One ledger line as a sentence. Words rather than the emoji the chips use:
   this is a history somebody reads, and an emoji is nothing at all to a screen
   reader without a label beside it. */
function describeEntry(e){
  const bits=[];
  if(e.f)bits.push(`${e.f>0?'+':''}${e.f} papas`);
  if(e.c)bits.push(`${e.c>0?'+':''}${chocoWord(e.c)}`);
  const what=bits.join(', ');
  if(e.k==='redeem')return`${what} canjeadas`;
  return`${what}${e.d?` en ${DIFF[e.d].label}`:''}`;
}
/* Everything the record dialog shows, rebuilt from `stats` and the wallet. Also
   called when another tab writes either, so the numbers behind a closed dialog
   are never stale by the time it opens.

   Built with createElement and textContent throughout rather than innerHTML.
   Unlike the win banner, which interpolates numbers from a fixed table, some of
   this comes back out of localStorage, which anything running on this origin
   can write. */
function paintRecord(){
  const rows=$('recordRows');
  rows.textContent='';
  let played=0,won=0;
  for(const key of Object.keys(DIFF)){
    const row=stats.d[key];
    played+=row.played;
    won+=row.won;
    const tr=document.createElement('tr');
    /* The best time is left blank rather than filled with a placeholder when
       nothing has been won: the zero in the column beside it already says why.
       Driven by the win count, not by the time, so a win clocked at zero is
       still a time rather than a blank. */
    for(const text of [DIFF[key].label,String(row.played),String(row.won),row.won?fmt(row.best):'']){
      const td=document.createElement('td');
      td.textContent=text;
      tr.appendChild(td);
    }
    rows.appendChild(tr);
  }
  /* Wins as well as games, because only a game started on this build is counted
     as played: a player who resumed a game from before the record existed and
     won it was shown "Sin partidas todavía." beside a row reading one win and a
     real best time. */
  $('streakLine').textContent=played===0&&won===0
    ?'Sin partidas todavía.'
    :`Racha de secas: ${stats.streak}. La mejor: ${stats.bestStreak}.`;

  $('purseFries').textContent=friesTotal;
  $('purseChoco').textContent=chocoTotal;
  $('redeemFries').disabled=friesTotal<=0;
  $('redeemChoco').disabled=chocoTotal<=0;

  const list=$('ledgerList');
  list.textContent='';
  /* Newest first, which is the order somebody checking what just happened
     wants, and the opposite of the order it is stored in. */
  for(const e of ledger.slice().reverse()){
    const li=document.createElement('li');
    const what=document.createElement('span');
    what.textContent=describeEntry(e);
    const when=document.createElement('time');
    const at=new Date(e.t);
    /* A timestamp out of Date's range is still a finite number, so this is
       checked rather than trusted: an invalid date renders as "Invalid Date". */
    if(!Number.isNaN(at.getTime())){
      /* Both halves from the same local calendar day. toISOString() is UTC, so
         a prize won after eight in the evening in Chile carried a dateTime one
         day ahead of the day printed beside it. The year is in the dateTime and
         not in the text, which is where a forty entry history spanning a new
         year would otherwise show two indistinguishable "5/1" lines. */
      when.dateTime=`${at.getFullYear()}-${pad2(at.getMonth()+1)}-${pad2(at.getDate())}`;
      when.textContent=`${at.getDate()}/${at.getMonth()+1}`;
    }
    li.append(what,when);
    list.appendChild(li);
  }
}
/* On screen only while the mode is on. Not hidden with the hidden attribute:
   aria-describedby has to keep resolving to it, and a hidden element is dropped
   from the accessibility tree, taking the button's description with it. */
function showNotesHint(){
  $('notesHint').classList.toggle('visually-hidden',!notesMode);
}
/* Restarts the pop even if the chip is already mid-animation: removing the
   class is not enough on its own, the reflow between is what replays it. */
function popChip(id){
  const chip=$(id);
  chip.classList.remove('pop');void chip.offsetWidth;chip.classList.add('pop');
}
/* Hands a prize over and writes it down. The wallet was a total that only ever
   went up, with nothing to spend it on: the papas and the chocolates are things
   somebody actually pays out, and until this existed the game had no way to say
   that had happened. Redeeming clears the balance of one prize and leaves a
   ledger line behind, so the history says what was won and what was collected.

   The whole balance rather than a chosen amount, because that is the act being
   recorded: the prizes were handed over. Read from storage first and written
   back under the same two rules bankPrize() follows, so a second tab's wins are
   never redeemed away and a wallet this build cannot read is never overwritten.
   Returns what was actually redeemed, which is what the caller announces. */
function redeem(kind){
  const raw=walletRaw();
  const stored=readWallet(raw);
  /* Bytes this build cannot read belong to another build, most likely a newer
     one the player still has cached, and saveWallet() would write over them.
     bankPrize() carries on in memory when that happens because a credit that is
     not written down is only a credit lost. Here the writing down is the whole
     act: emptying the balance in memory and announcing the payout would tell
     the player their prizes had been handed over, and the next reload would put
     them all back. Refused instead, and said so. */
  if(stored===null&&raw!==null)return null;
  const base=stored||{fries:friesTotal,choco:chocoTotal,ledger};
  const choco=kind==='choco';
  const amount=choco?base.choco:base.fries;
  /* Adopt what was stored either way: this tab may have been looking at a
     number another tab has already moved on from. */
  friesTotal=base.fries;chocoTotal=base.choco;ledger=base.ledger;
  if(amount<=0)return 0;
  if(choco)chocoTotal=0;else friesTotal=0;
  ledger=logEntry(base.ledger,{t:Date.now(),k:'redeem',f:choco?0:-amount,c:choco?-amount:0,d:''});
  /* Unconditional now: the one case this used to guard against returns null
     above, so anything reaching here is a wallet that was written. */
  saveWallet();
  return amount;
}

/* ---- record ----
   Wins, best times and the flawless streak. Its own key, for the reason the
   wallet has one: winning is what clears the game save, so anything kept in
   there is deleted moments after it is earned. */
function blankStats(){
  const rows={};
  for(const key of Object.keys(DIFF))rows[key]={played:0,won:0,best:0};
  return{v:STATS_VERSION,d:rows,streak:0,bestStreak:0};
}
/* Every number arrives through count(), so a hand edited or truncated file
   degrades to zeroes rather than to NaN, which would render as "NaN" and be
   written straight back. An unknown version starts over: unlike the wallet
   there is nothing here worth refusing to overwrite, since a lost streak is not
   a lost prize. */
function readStats(){
  let raw;
  try{raw=localStorage.getItem(STATS_KEY)}catch{return null}
  if(!raw)return null;
  let s;
  try{s=JSON.parse(raw)}catch{return null}
  if(!s||typeof s!=='object'||s.v!==STATS_VERSION)return null;
  const blank=blankStats();
  const rows=s.d&&typeof s.d==='object'?s.d:{};
  for(const key of Object.keys(blank.d)){
    const row=rows[key]&&typeof rows[key]==='object'?rows[key]:{};
    blank.d[key]={played:count(row.played),won:count(row.won),best:count(row.best)};
  }
  blank.streak=count(s.streak);
  blank.bestStreak=Math.max(count(s.bestStreak),blank.streak);
  return blank;
}
function saveStats(){
  try{localStorage.setItem(STATS_KEY,JSON.stringify(stats))}catch{/* a lost record is not worth failing a game over */}
}
function loadStats(){
  stats=readStats()||blankStats();
}
/* Read back before every write, for the reason bankPrize() does it: saveStats()
   serialises the whole object, so a tab that mutates the copy it read at boot
   overwrites every game the other tab has finished since. Measured on the
   wallet before it did this, two tabs, 20 papas then 50, left 50 stored instead
   of 70; the record had the storage listener but neither write side of that
   fix. Anything unreadable leaves this tab counting into what it already had,
   which is the same fallback readStats() already applies at boot. */
function freshStats(){
  return readStats()||stats;
}
function recordPlayed(key){
  stats=freshStats();
  stats.d[key].played++;
  saveStats();
}
/* The streak counts flawless wins in a row. A plain win streak would say
   nothing here: there is no way to lose, so every game that ends, ends in a
   win, and the streak would just be the number of wins over again. */
/* Returns whether this win beat a time there was one to beat, which is the only
   caller that needs it and the only place the comparison can be made safely:
   done outside, it has to run before this function moves the count, and moving
   the call one line later silently turned every first win into a personal best
   against nothing. */
function recordWin(key,time,flawless){
  stats=freshStats();
  const row=stats.d[key];
  /* Read before the count moves, and asked of the count rather than of the time
     itself. A zero here means "never won", and a best time of zero is a real if
     unlikely value, so testing `row.best===0` treated an instant win as no win
     and left the column blank forever after. */
  const first=row.won===0;
  const beat=!first&&time<row.best;
  row.won++;
  if(first||time<row.best)row.best=time;
  stats.streak=flawless?stats.streak+1:0;
  if(stats.streak>stats.bestStreak)stats.bestStreak=stats.streak;
  saveStats();
  return beat;
}

/* Reads the wallet at boot. Anything unreadable, corrupt or from a version
   this build does not know leaves both totals at zero rather than guessing. */
function loadWallet(){
  const raw=walletRaw();
  if(raw!==null){
    const stored=readWallet(raw);
    /* Something is under the key. If this build cannot read it, leave it there:
       overwriting it with zeros would discard the wallet of a newer build the
       player still has cached, which is worse than showing nothing. */
    if(stored){friesTotal=stored.fries;chocoTotal=stored.choco;ledger=stored.ledger}
    return;
  }
  /* No wallet yet: either a new player, or one whose papas are still sitting
     in a game save from before this key existed. Carry those across. */
  try{
    const s=JSON.parse(localStorage.getItem(SAVE_KEY)||'null');
    /* Behind the same version gate loadGame() applies: a save this build would
       refuse to restore is not a record to mint papas from. count() then applies
       the same rule the stored wallet gets, rather than a second one written
       here, because both feed the total that is written back and added to
       forever. */
    friesTotal=count(s&&typeof s==='object'&&s.v===SAVE_VERSION?s.friesTotal:0);
  }catch{}
  /* Only when something was actually carried across. Writing a zero wallet here
     would be a storage event in every other open tab, and their listener adopts
     what it reads: a second tab opening after the key was evicted would take a
     tab that still held the totals in memory down to zero with it. */
  if(friesTotal)saveWallet();
}
/* Restores a saved game on boot. Returns false, leaving every global
   untouched, for: nothing saved, corrupt JSON, a getItem/localStorage
   failure, an unrecognised schema version, a malformed grid, an unknown
   diffKey, or an already-solved save: the caller (boot block) then falls
   back to showing the start dialog exactly as it does today. */
function loadGame(){
  let raw;
  try{raw=localStorage.getItem(SAVE_KEY)}catch{return false}
  if(!raw)return false;
  let s;
  try{s=JSON.parse(raw)}catch{return false}
  if(!s||typeof s!=='object'||s.v!==SAVE_VERSION)return false;
  const isGrid=a=>Array.isArray(a)&&a.length===81;
  if(!isGrid(s.puzzle)||!isGrid(s.solution)||!isGrid(s.values)||!isGrid(s.fixed)||!Array.isArray(s.notes)||s.notes.length!==81)return false;
  /* hasOwn rather than a bare lookup: every name on Object.prototype answers
     truthy to DIFF[key], so a save claiming diffKey:'constructor' restored a
     playable board with no row of the table behind it. Winning it then read
     DIFF[key].fries, which is undefined, multiplied it, and banked NaN, which
     JSON writes as null and reads back as zero: every prize the player had
     ever earned, spent on a save nobody wrote on purpose.

     hasOwnProperty.call rather than Object.hasOwn, which is Safari 15.4 and
     newer. This runs on the boot path with nothing around it to catch a throw,
     so on an older engine the whole page would die here, and only for players
     who already have a save: the first visit takes the early return above, the
     first move writes one, and the second launch is a dead board. The rest of
     this file degrades quietly on old engines rather than throwing, and there
     is no stated support floor to check a hard requirement against. */
  if(!Object.prototype.hasOwnProperty.call(DIFF,s.diffKey)||s.solved)return false;
  puzzle=s.puzzle.slice();
  solution=s.solution.slice();
  values=s.values.slice();
  fixed=s.fixed.slice();
  notes=s.notes.map(a=>new Set(Array.isArray(a)?a:[]));
  /* Bounded, not just integral: sel indexes notes[] and fixed[], and inputDigit()
     only guards sel<0. An out-of-range sel restores a playable board, then the
     first digit throws on notes[sel].clear() after values[sel] has already been
     written past the end of the grid, and the next autosave persists an 82+ cell
     board that loadGame() rejects on the following load. The game is gone. */
  sel=Number.isInteger(s.sel)&&s.sel>=0&&s.sel<81?s.sel:-1;
  /* Read through count(), the rule every total arriving from outside this tab
     already goes through, because these three come from storage a player can
     edit. Number(x)||0 accepted a negative, and mistakes is one of the two
     fields the flawless bonus is gated on: a save carrying mistakes:-3 restored,
     let three real and visible wrong entries bring the counter up to exactly 0,
     and paid double papas plus the chocolates on a board with three wrong digits
     on it.

     seconds is the same shape with a worse ending. A negative restored, rendered
     as -15:00, and recordWin() wrote it as that difficulty's best time. The next
     boot sanitised the stored best to 0 through the same count(), after which
     time<row.best could never be true again and that difficulty could never
     record a best time. Clamping here is what stops the record being poisoned;
     repairing one already poisoned is not attempted, and is noted in the PR. */
  mistakes=count(s.mistakes);
  hints=count(s.hints);
  seconds=count(s.seconds);
  diffKey=s.diffKey;
  /* hasOwnProperty for the same reason the DIFF lookup above uses it: every
     name on Object.prototype answers truthy to GRADE_WORDS[key], so a save
     claiming grade:'constructor' passed this test, made puzzleGrade NaN, and
     put "Técnica: undefined" on the win screen before saveGame() wrote the NaN
     back out as null. */
  const graded=Object.prototype.hasOwnProperty.call(GRADE_WORDS,s.grade);
  const seeded=Number.isInteger(s.seed)&&s.seed>=0;
  /* A save from before grading falls back to the tier its difficulty asks for,
     which is the best available guess, and puzzleMeasured is what stops the win
     screen presenting the guess as a measurement. */
  puzzleGrade=graded?Number(s.grade):DIFF[s.diffKey].grade;
  puzzleSeed=seeded?s.seed:0;
  puzzleMeasured=graded&&seeded;
  solved=false;playing=true;notesMode=false;pausedByDialog=false;undoStack=[];revealed=new Set();
  winTimers.forEach(clearTimeout);winTimers=[];
  $('notesBtn').setAttribute('aria-pressed','false');
  showNotesHint();
  $('diffLabel').textContent=DIFF[diffKey].label;
  $('time').textContent=fmt(seconds);
  $('stamp').classList.remove('show');
  /* seed the announcement tracker with the restored counters, so resuming a
     game with mistakes on the board does not announce them as fresh ones */
  srLast={mistakes,hints,remaining:null};
  render();
  setPaused(false);
  return true;
}

/* Falls whatever glyph it is handed: the animation is the prize mechanic, and
   papas and chocolates differ only in what rains and how much of it. */
function rain(n,glyph){
  const wrap=document.querySelector('.board-wrap');
  const w=wrap.clientWidth,h=wrap.clientHeight;
  for(let k=0;k<n;k++){
    const f=document.createElement('span');
    f.className='drop';f.textContent=glyph;
    const dur=1.1+Math.random()*1.2,delay=Math.random()*.9;
    f.style.left=`${Math.random()*(w-34)}px`;
    f.style.fontSize=`${20+Math.random()*15}px`;
    f.style.setProperty('--dur',`${dur}s`);
    f.style.setProperty('--delay',`${delay}s`);
    f.style.setProperty('--fall',`${h+100}px`);
    f.style.setProperty('--spin',`${((Math.random()*720)|0)-360}deg`);
    f.addEventListener('animationend',()=>f.remove());
    setTimeout(()=>f.remove(),(dur+delay)*1000+500);
    wrap.appendChild(f);
  }
}

function win(){
  solved=true;playing=false;
  clearSavedGame(); /* a finished game has nothing to resume into */
  clearInterval(tick);
  sel=-1;render();
  $('stamp').classList.add('show');
  const flawless=mistakes===0&&hints===0;
  const earned=DIFF[diffKey].fries*(flawless?2:1);
  const chocoEarned=flawless?DIFF[diffKey].choco:0;
  /* assertive: the win is the one event worth interrupting for, and the modal
     it belongs to only appears after ~2s of animation. The prize goes in here
     too: showOverlay() focuses the dialog's button, not the banner, so this is
     the only announcement that reliably carries it. */
  $('srAlert').textContent=`Ganaste. ${fmt(seconds)}, ${mistakes===1?'1 error':`${mistakes} errores`}, ${hints===1?'1 pista':`${hints} pistas`}.`
    +` Te llevas ${earned} papas fritas${chocoEarned?` y ${chocoWord(chocoEarned)}`:''}.`;
  const finalTime=seconds,finalMist=mistakes,finalHints=hints;
  /* Banked now, not on the timers below: those are decoration, and a player
     who closes the tab during the animation has still won the prize. The record
     is written on the same principle and for the same reason. */
  bankPrize(earned,chocoEarned);
  /* Asked of recordWin rather than computed beside it, which had two copies of
     the same test that only agreed while this line stayed above the call. A
     first win no longer counts: there was no time to beat, and claiming one
     stole the message from every first flawless win, which is the rarer thing
     and the one worth saying. */
  const beatBest=recordWin(diffKey,finalTime,flawless);
  /* reduced motion: no rain, and don't make the player wait out the animation */
  const slow=reduceMotion.matches?0:1;
  if(!reduceMotion.matches){
    winTimers.push(setTimeout(()=>rain(Math.min(earned,30),'🍟'),450));
    /* staggered: the chocolates are meant to read as a second, rarer shower
       rather than get lost among the papas. No cap, unlike the papas above:
       the most the table pays is five. */
    if(chocoEarned)winTimers.push(setTimeout(()=>rain(chocoEarned,'🍫'),700));
  }
  winTimers.push(setTimeout(()=>{
    paintWallet();
    popChip('frychip');
    if(chocoEarned)popChip('chocochip');
  },950*slow));
  winTimers.push(setTimeout(()=>{
    $('wTime').textContent=fmt(finalTime);
    $('wMist').textContent=finalMist;
    $('wHint').textContent=finalHints;
    $('winLede').textContent=
      beatBest?'Tu mejor tiempo en este nivel.':
      flawless?'La más seca: cero errores, cero pistas.':
      finalMist===0?'Sin errores. Filete.':'Costó, pero salió igual.';
    /* What the board actually was, rather than what was asked for, and the seed
       that rebuilds it. Both are textContent: the code is a number in base 36
       and the technique comes from a fixed table, but neither has any business
       being parsed as markup. */
    /* Dropped entirely for a board this build never measured, which is any game
       resumed from a save written before grading existed: the tier would be the
       one the difficulty asked for, which is the lie the grade exists to stop
       telling, and the code would be 0, which rebuilds a different board. */
    $('wCodeLine').hidden=!puzzleMeasured;
    if(puzzleMeasured){
      $('wGrade').textContent=GRADE_WORDS[puzzleGrade];
      $('wCode').textContent=puzzleSeed.toString(36);
    }
    /* What you just won, as icons. The sentence this replaced said the same
       thing three times over, and the running totals it repeated are the chips
       in the status bar, one dismissal away. The words survive for a screen
       reader, which cannot see either.

       innerHTML, and every hole in it is a number straight from the DIFF table.
       Nothing player-authored is interpolated, so there is no markup to inject. */
    $('fryBanner').innerHTML=`<b aria-hidden="true">🍟 +${earned}</b>`
      +(chocoEarned?`<b aria-hidden="true">🍫 +${chocoEarned}</b>`:'')
      +`<span class="visually-hidden">Ganaste ${earned} papas fritas${chocoEarned?` y ${chocoWord(chocoEarned)}`:''}.</span>`;
    showOverlay($('winOverlay'));
  },1900*slow));
}

/* ---- actions ---- */
function inputDigit(d){
  if(!playing||paused||sel<0||fixed[sel])return;
  if(notesMode&&values[sel]!==0)return; /* checked before snapshot(): a no-op must not evict undo history */
  snapshot();
  if(notesMode){
    if(notes[sel].has(d)){notes[sel].delete(d)}else{notes[sel].add(d)}
  }else{
    if(values[sel]===d){values[sel]=0}
    else{
      values[sel]=d;
      notes[sel].clear();
      if(d===solution[sel]){
        for(const p of PEERS[sel])notes[p].delete(d);
      }else mistakes++;
    }
  }
  render();
  saveGame();
  if(values.every((v,i)=>v===solution[i]))win();
}
function erase(){
  if(!playing||paused||sel<0||fixed[sel])return;
  if(values[sel]===0&&notes[sel].size===0)return;
  snapshot();
  values[sel]=0;notes[sel].clear();
  render();
  saveGame();
}
function undo(){
  if(!playing||paused||undoStack.length===0)return;
  const s=undoStack.pop();
  values=s.values;
  fixed=s.fixed;
  notes=s.notes.map(a=>new Set(a));
  /* render() speaks when a counter moves or the cells left cross a ten. Undoing
     a wrong digit moves neither, since a wrong digit is already counted as
     unfilled, and undo moves no focus, so no cell label is re-read either: with
     nothing here Deshacer is completely silent to a screen reader. Undoing a
     correct digit or a hint does move the count, which is why this is handed to
     render() rather than written to the element: written directly it overwrote
     the count render() had just announced, after srLast had already recorded it
     as said, so that crossing was lost for good. */
  srAction='Deshecho.';
  render();
  saveGame();
}
function hint(){
  if(!playing||paused)return;
  /* A given, and nothing else. Givens are selectable so the row, column and box
     highlighting can follow them, so a stray H while looking at one used to fall
     through to the random branch below and spend the bonus on a cell nobody
     asked about, which Deshacer no longer refunds. Refusing every ineligible
     cell instead is worse: values[sel]===solution[sel] is where sel sits after
     every correct entry, so that turns the Pista button inert on a share of the
     board that grows to all of it. Those still fall through, which is the press
     that means "help me somewhere". Announced rather than silently ignored: a
     key that does nothing and says nothing reads as one that never registered. */
  if(sel>=0&&fixed[sel]){srAction='Esa casilla ya viene dada.';render();return}
  let i=sel>=0&&!fixed[sel]&&values[sel]!==solution[sel]?sel:-1;
  if(i<0){
    const open=[];
    for(let k=0;k<81;k++)if(values[k]!==solution[k])open.push(k);
    if(open.length===0)return;
    i=open[(Math.random()*open.length)|0];
  }
  snapshot();
  values[i]=solution[i];
  fixed[i]=true;
  notes[i].clear();
  for(const p of PEERS[i])notes[p].delete(solution[i]);
  /* Once per cell. The answer was shown once, however many times it is undone
     and asked for again. */
  if(!revealed.has(i)){hints++;revealed.add(i)}
  sel=i;
  render();
  saveGame();
  if(values.every((v,k)=>v===solution[k]))win();
}

/* ---- render ---- */
/* Tracks the last-announced values so the live region only speaks on
   meaningful change, never on every cell edit (selection moves call
   render() constantly and must stay silent). remaining is bucketed by
   ten so it reads at a sane cadence instead of once per fill. */
let srLast={mistakes:0,hints:0,remaining:null};
function render(){
  const selVal=sel>=0?values[sel]:0;
  const pr=sel>=0?PEERS[sel]:null;
  let left=0;
  const counts=new Array(10).fill(0);
  for(let i=0;i<81;i++){
    const v=values[i];
    /* count only correct placements, so wrong entries never retire a digit key */
    if(v&&v===solution[i])counts[v]++;
    if(!v||v!==solution[i])left++;
    const el=cells[i];
    el.firstChild.textContent=v||'';
    const ns=el.lastChild.children;
    for(let d=1;d<=9;d++)ns[d-1].textContent=(!v&&notes[i].has(d))?d:'';
    el.className='cell'
      +(fixed[i]?' given':'')
      +(v&&v!==solution[i]?' wrong':'')
      +(i===sel?' sel':'')
      +(pr?.has(i)&&i!==sel?' peer':'')
      +(selVal&&v===selVal&&i!==sel?' same':'');
    const r=((i/9)|0)+1,c=i%9+1;
    el.setAttribute('aria-label',`Fila ${r}, columna ${c}${v?`, ${v}`:', vacía'}${fixed[i]?', dada':''}`);
  }
  for(let d=1;d<=9;d++){
    keys[d-1].querySelector('.c').textContent=Math.max(0,9-counts[d]);
    keys[d-1].classList.toggle('done',counts[d]>=9);
  }
  $('mistakes').textContent=mistakes;
  $('hints').textContent=hints;
  $('remaining').innerHTML=`<b>${left}</b> por llenar`;
  /* Screen-reader announcements: polite, batched, and gated to actual play
     so neither the boot screen nor a paused/finished board can speak.
     Mistakes and hints announce on every change (they're rare and meaningful);
     the remaining count only when it crosses into a new ten, so filling
     cells one by one does not spam the user. */
  if(playing){
    const srBits=[];
    if(srAction){srBits.push(srAction);srAction=''}
    if(mistakes!==srLast.mistakes)srBits.push(mistakes===1?'1 error':`${mistakes} errores`);
    if(hints!==srLast.hints)srBits.push(hints===1?'1 pista usada':`${hints} pistas usadas`);
    if(left!==srLast.remaining&&(srLast.remaining===null||((left/10)|0)!==((srLast.remaining/10)|0))){
      srBits.push(left===0?'tablero completo':`${left} celdas por llenar`);
    }
    if(srBits.length){
      const said=`${srBits.join('. ')}.`;
      const node=$('srStatus');
      /* An aria-atomic live region is only read out when its content changes,
         and two undos in a row produce the same sentence, so the second press
         was silent. Cleared and written back in a later task when the text would
         repeat, which is a real change either side of it. */
      if(node.textContent===said){node.textContent='';setTimeout(()=>{node.textContent=said},0)}
      else node.textContent=said;
    }
    srLast={mistakes,hints,remaining:left};
  }
}

/* ---- wiring ---- */
$('pauseBtn').addEventListener('click',()=>setPaused(!paused));
$('resumeBtn').addEventListener('click',()=>setPaused(false));
$('notesBtn').addEventListener('click',e=>{
  if(!playing||paused)return;
  notesMode=!notesMode;
  e.currentTarget.setAttribute('aria-pressed',String(notesMode));
  showNotesHint();
});
$('eraseBtn').addEventListener('click',erase);
$('undoBtn').addEventListener('click',undo);
$('hintBtn').addEventListener('click',hint);
$('newBtn').addEventListener('click',()=>{
  $('cancelNew').hidden=!playing;
  pausedByDialog=playing&&!paused;
  if(pausedByDialog)setPaused(true);
  showOverlay($('startOverlay'));
});
$('cancelNew').addEventListener('click',()=>{
  hideOverlay($('startOverlay'));
  if(pausedByDialog)setPaused(false); /* only resume if this dialog is what paused it */
  pausedByDialog=false;
});
$('againBtn').addEventListener('click',()=>{
  hideOverlay($('winOverlay'));
  $('cancelNew').hidden=true;
  showOverlay($('startOverlay'));
});

/* ---- the record dialog ----
   Opens over the start dialog rather than replacing it, so closing it puts the
   player back where they were rather than at a dead end. */
$('recordBtn').addEventListener('click',()=>{
  paintRecord();
  showOverlay($('recordOverlay'));
});
function closeRecord(){
  disarmRedeem();
  hideOverlay($('recordOverlay'));
  /* Back to what opened it, which is still on screen behind. Without this the
     focus lands on the body and the next Tab starts from the top of the page. */
  if($('startOverlay').classList.contains('show'))$('recordBtn').focus();
}
$('closeRecord').addEventListener('click',closeRecord);

/* Redeeming empties a balance and cannot be undone, so it takes two presses.
   A confirm() would do the same job in one, but it is a browser modal on top of
   a dialog on top of a dialog, and it cannot be styled or read in context. The
   armed state disarms itself, so a press left half finished does not sit there
   waiting to fire at whatever gets clicked next. */
let armedPrize=null,armTimer=null;
function disarmRedeem(){
  clearTimeout(armTimer);
  armedPrize=null;
  for(const id of ['redeemFries','redeemChoco']){
    $(id).classList.remove('arm');
    $(id).textContent='Canjear';
  }
}
document.querySelectorAll('.redeem').forEach(button=>{
  button.addEventListener('click',()=>{
    const kind=button.dataset.k;
    const word=kind==='choco'?'chocolates':'papas fritas';
    if(armedPrize!==kind){
      disarmRedeem();
      armedPrize=kind;
      button.classList.add('arm');
      button.textContent='¿Seguro?';
      /* Announced, because the only signal otherwise is a word changing on a
         button the player is no longer looking at. */
      $('srStatus').textContent=`Tocá de nuevo para canjear ${kind==='choco'?chocoTotal:friesTotal} ${word}.`;
      armTimer=setTimeout(disarmRedeem,4000);
      return;
    }
    const amount=redeem(kind);
    disarmRedeem();
    /* Before the repaint, which disables the button that has focus the moment
       its balance hits zero, and a disabled element is blurred: focus fell to
       the body from inside an open dialog and the next Tab restarted from the
       top of the page. */
    $('closeRecord').focus();
    paintWallet();
    paintRecord();
    $('srStatus').textContent=amount===null?`No se pudo canjear: hay premios guardados que esta versión no entiende.`
      :amount>0?`Canjeaste ${amount} ${word}.`:`No hay ${word} para canjear.`;
  });
});
/* The buttons advertise the technique, not the clue count, because the
   technique is now what the difficulty means and the clue count is not even
   fixed: the search moves it to reach a grade. The old copy said "34 números"
   and was a promise the generator was about to break. Both halves come from
   DIFF so neither can drift from what is generated. */
document.querySelectorAll('.diff').forEach(b=>{
  const d=DIFF[b.dataset.d];
  b.innerHTML=`${d.label} <span>${GRADE_WORDS[d.grade]}</span>`;
  b.addEventListener('click',()=>newGame(b.dataset.d));
});

document.addEventListener('keydown',e=>{
  if(!e.key)return;
  const k=e.key.toLowerCase();
  /* Checked before the start dialog, because it opens on top of it: Escape has
     to close the one in front. */
  if($('recordOverlay').classList.contains('show')){
    if(k==='escape')closeRecord();
    return;
  }
  if($('startOverlay').classList.contains('show')){
    if(k==='escape'&&!$('cancelNew').hidden)$('cancelNew').click();
    return;
  }
  if($('winOverlay').classList.contains('show'))return;
  /* let browser shortcuts through: only Ctrl/Cmd+Z is ours */
  if((e.ctrlKey||e.metaKey||e.altKey)&&k!=='z')return;
  if(k==='p'){setPaused(!paused);return}
  if(k==='escape'&&paused){setPaused(false);return}
  if(!playing||paused)return;
  if(e.key>='1'&&e.key<='9'){inputDigit(+e.key);return}
  if(k==='backspace'||k==='delete'||e.key==='0'){e.preventDefault();erase()}
  else if(k==='n')$('notesBtn').click();
  else if(k==='h')hint();
  else if(k==='z')undo();
  else if(k.startsWith('arrow')){
    e.preventDefault();
    if(sel<0){sel=0;render();saveSelectionSoon();return}
    const r=(sel/9)|0,c=sel%9;
    if(k==='arrowup'&&r>0)sel-=9;
    if(k==='arrowdown'&&r<8)sel+=9;
    if(k==='arrowleft'&&c>0)sel-=1;
    if(k==='arrowright'&&c<8)sel+=1;
    render();
    saveSelectionSoon();
  }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)setPaused(true)});
/* Another tab banked a prize while this one was open. Adopt its totals: ours
   are stale from here on, and the chips would otherwise keep showing a number
   the wallet no longer holds. Fires only in the other tabs, never the writer's,
   which is exactly the tab that needs telling. A clear() reports a null key and
   is ignored: bankPrize() falls back to memory, so this tab keeps counting. */
addEventListener('storage',e=>{
  if(e.key===STATS_KEY){
    /* The record is one player's, so the other tab's games belong in it too.
       Nothing unreadable is adopted: readStats() answers null and this tab
       keeps counting into what it already had. */
    const s=readStats();
    if(s){stats=s;paintRecord()}
    return;
  }
  if(e.key!==WALLET_KEY)return;
  const w=readWallet();
  if(!w)return;
  /* The armed press was a confirmation of a number that has just changed, and
     redeem() reads storage rather than this tab's copy: left armed, the second
     press handed over a total the player never agreed to, and paintRecord()
     below would leave the button reading "¿Seguro?" while disabling it. */
  disarmRedeem();
  friesTotal=w.fries;chocoTotal=w.choco;ledger=w.ledger;
  paintWallet();
  paintRecord();
});

/* ---- boot ---- */
/* Before loadGame(): the prizes are the player's, not the puzzle's, so they are
   painted on both paths, the resumed game and the difficulty picker alike. */
loadWallet();
loadStats();
paintWallet();
paintRecord();
/* loadGame() renders and unpauses itself when it restores something; only the
   no-save (or rejected-save) path falls through to the difficulty picker. */
if(!loadGame()){
  render();
  $('cancelNew').hidden=true;
  showOverlay($('startOverlay'));
}
/* Relative path so the worker's scope is this directory, not the account root.
   Deferred to load, feature-guarded, and failures are swallowed: an offline
   cache that cannot register must never keep the game from starting. */
if('serviceWorker' in navigator){
  /* Was this document already under a worker when it loaded? Read now, before
     anything can claim it, because it is the difference between a first ever
     install and a swap to a newer build. */
  const wasControlled=!!navigator.serviceWorker.controller;
  let registration=null,nextCheckAt=0,checking=false,reloading=false;

  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('./sw.js').then(r=>{registration=r}).catch(()=>{});
  });

  /* The update trigger an installed app otherwise does not have. A worker is
     only checked for updates on an in-scope navigation, or on a functional
     event at most once a day. A home screen web app is a single page that
     never navigates: it is resumed, not loaded. Its fetch handler serves the
     shell from cache and asks the network nothing. So a player who installs it
     and only ever switches back to it can sit on that build indefinitely,
     which is the whole failure this exists to prevent.

     Throttled, because switching between apps must not mean a request per
     focus, and skipped while hidden so a background tab does not poll. */
  const CHECK_EVERY=36e5,RETRY_AFTER=6e4;
  function checkForUpdate(){
    if(registration===null||document.hidden||checking)return;
    /* A resume with no connectivity is the ordinary way an installed app wakes
       up, and it must not spend the hour on a check that cannot reach the
       network. Refused here, before anything is spent, because reacting to the
       failure afterwards cannot work: the two engines do not agree on what a
       failure is. Measured on the built page, offline: WebKit rejects,
       Chromium resolves without having asked the network. So catching the
       rejection fixed nothing on Chromium and, on WebKit, handed back the
       throttle on every resume. onLine is false only when the device knows it
       has no connectivity, which is the case worth skipping and the one this
       is named for. */
    if(navigator.onLine===false)return;
    if(Date.now()<nextCheckAt)return;
    checking=true;
    /* The short gap is taken first and the hour granted only once a request
       has actually come back. An sw.js that 404s, times out or fails to parse
       rejects every time, and without this that is a fetch on every single app
       switch, forever, from every installed copy. */
    nextCheckAt=Date.now()+RETRY_AFTER;
    registration.update()
      .then(()=>{nextCheckAt=Date.now()+CHECK_EVERY})
      .catch(()=>{})
      .finally(()=>{checking=false});
  }
  document.addEventListener('visibilitychange',checkForUpdate);
  /* Only a restore from the back forward cache. An ordinary load already
     checked, in register() above, and would otherwise check twice on boot. */
  window.addEventListener('pageshow',e=>{if(e.persisted)checkForUpdate()});

  /* A newer worker has taken over. sw.js calls skipWaiting() and
     clients.claim(), so this fires while the old document is still on screen,
     holding markup and a cache that no longer agree. Reloading is what makes
     them agree, and it is safe: the game autosaves on every move and restores
     itself, which e2e/persistence.spec.mjs holds down.

     Not on a first install, where nothing is stale and a reload would be an
     unexplained flash for a new visitor, and never twice. */
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(!wasControlled||reloading)return;
    reloading=true;
    location.reload();
  });

  /* Installed apps are exempt from the seven day rule and from idle eviction,
     but not from eviction under storage pressure, and the save and the prize
     totals are both in localStorage. Asked for only when actually installed:
     in a browser tab this is a permission prompt in some engines, which is a
     lot to spend on a sudoku nobody has chosen to keep yet. */
  if(matchMedia('(display-mode: standalone)').matches&&navigator.storage?.persist){
    navigator.storage.persist().catch(()=>{});
  }
}
