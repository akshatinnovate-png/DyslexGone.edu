/** High-frequency "easy" vocabulary (Dale-Chall style core, trimmed to the
 *  most load-bearing ~1100 entries) plus academic/decoding trouble lists. */
export const EASY_WORDS = new Set<string>(`
a able about above across act add afraid after again against age ago agree air all almost alone along already also
always am among an and angry animal another answer any anyone anything appear apple are area arm around arrive art as
ask at ate attention aunt away baby back bad bag ball bank bar base basket bath be bean bear beat beautiful became
because become bed bee been before began begin behind being believe bell belong below belt bend beside best better
between big bird birth bit bite black blanket blew block blood blow blue board boat body boil bone book boot born
borrow both bottle bottom bought bowl box boy branch brave bread break breakfast breath bridge bright bring broke
brother brought brown brush build built bunch burn bus business busy but butter button buy by cake call came can cap
car card care careful carry case cat catch cattle caught cause cave cent center chair chance change chart chase cheap
check cheese chicken chief child children chose circle city class clean clear climb clock close cloth cloud coat
cold collect color come comfortable common company complete cook cool copy corn corner correct cost cotton could
count country couple course cover cow crack cream cross crowd cry cup cut dad dance danger dark date daughter day
dead deal dear decide deep desk did die differ different dinner direct dirt discover dish distance do doctor does dog
dollar done don't door double down draw dream dress drink drive drop dry duck during dust each ear early earth east
easy eat edge egg eight either else empty end enemy engine enough enter equal escape even evening ever every exact
example except excite exercise expect explain eye face fact fail fair fall family famous far farm fast fat father
favorite fear feed feel feet fell felt fence few field fight figure fill final find fine finger finish fire first
fish fit five fix flag flat flew floor flower fly follow food foot for force forest forget form found four free
fresh friend from front fruit full fun funny future game garden gas gate gave general get giant gift girl give glad
glass go goes gold gone good got govern grade grain grass gray great green grew ground group grow guess guide gun
had hair half hall hand happen happy hard has hat hate have he head health hear heart heat heavy held hello help her
here hide high hill him his hit hold hole home honest hope horse hospital hot hour house how huge human hundred hung
hungry hunt hurry hurt husband i ice idea if ill important in inch include indeed inside instead into iron is island
it its jar job join joy jump just keep kept key kick kill kind king kiss kitchen knee knew knife know lady lake land
language large last late laugh law lay lead learn least leave led left leg length less let letter level lie life lift
light like line lion lip list listen little live load local lock long look lose lost lot loud love low luck lunch
machine made mail main major make man many map march mark market marry master match matter may maybe me meal mean
meat meet melt member men metal middle might mile milk mind mine minute miss mix model modern moment money month moon
more morning most mother mountain mouse mouth move much music must my name nation near neck need neighbor neither
never new news next nice night nine no noise none noon nor north nose not note nothing notice now number nurse
object ocean of off offer office often oh oil old on once one only open or orange order other our out outside over
own page paid pain paint pair paper parent park part party pass past pay people perhaps person pick picture piece pig
pile pink place plain plan plant play please plenty point poor possible pound power practice present press pretty
price print prize problem produce promise proud pull push put quarter queen question quick quiet quite race radio
rain raise ran rather reach read ready real reason receive record red remember repeat reply report rest return rich
ride right ring rise river road rock roll roof room root rope rose round row rub rule run sad safe said sail salt
same sand sat save saw say scale school science sea search season seat second secret see seed seem seen sell send
sense sent sentence separate serve set seven several shade shake shall shape share sharp she sheep sheet shelf shell
shine ship shoe shoot shop short should shoulder shout show sick side sign silver simple since sing single sir sister
sit six size skin sky sleep slide slip slow small smell smile smoke smooth snake snow so soft soil sold soldier some
son song soon sorry sort sound soup south space speak special speed spell spend spoke spot spread spring square stair
stand star start state station stay step stick still stone stood stop store storm story straight strange street
stretch strike strong student study stuff such sudden sugar suit summer sun supper suppose sure surprise sweet swim
table tail take talk tall taste teach team tear teeth telephone tell ten test than thank that the their them then
there these they thick thin thing think third thirst this those though thought thousand three threw through throw
thus tie tight time tiny tire to today toe together told tomorrow tongue tonight too took tool top total touch toward
town toy track trade train travel tree trip trouble truck true trust truth try turn twelve twenty twice two type
uncle under understand unit until up upon us use usual valley value very view village visit voice wait wake walk wall
want war warm was wash waste watch water wave way we wear weather week weigh welcome well went were west wet what
wheel when where whether which while white who whole whose why wide wife wild will win wind window wing winter wire
wise wish with within without woman wonder wood word wore work world worry worth would wrap write wrong wrote yard
year yellow yes yesterday yet you young your zero
`.trim().split(/\s+/));

/** Academic-register words that reliably spike reading load for young readers. */
export const ACADEMIC_HEDGES = new Set<string>([
  'consequently','furthermore','moreover','nevertheless','notwithstanding','subsequently','therefore','thus',
  'hence','whereas','albeit','insofar','heretofore','aforementioned','predominantly','substantially',
  'approximately','constitutes','comprises','facilitates','necessitates','demonstrates','exhibits',
  'phenomenon','phenomena','hypothesis','methodology','paradigm','utilize','utilization','implement',
  'component','parameter','criterion','criteria','respectively','accordingly','pursuant',
].filter((w) => !['utilize','utilization','implement','facilitates','necessitates','demonstrates','constitutes','comprises','exhibits'].includes(w)));

/** Plain-language swaps: {hard: easy}. Applied word-boundary-safe. */
export const PLAIN_SWAPS: Record<string, string> = {
  utilize: 'use', utilizes: 'uses', utilized: 'used', utilization: 'use',
  commence: 'start', commences: 'starts', commenced: 'started',
  terminate: 'end', terminates: 'ends', terminated: 'ended',
  demonstrate: 'show', demonstrates: 'shows', demonstrated: 'showed',
  illustrate: 'show', illustrates: 'shows', illustrated: 'showed',
  approximately: 'about', additionally: 'also', consequently: 'so', subsequently: 'later',
  furthermore: 'also', moreover: 'also', therefore: 'so', thus: 'so', hence: 'so',
  nevertheless: 'even so', however: 'but', whereas: 'while', albeit: 'though',
  obtain: 'get', obtains: 'gets', obtained: 'got', acquire: 'get', acquires: 'gets',
  purchase: 'buy', purchased: 'bought', require: 'need', requires: 'needs', required: 'needed',
  sufficient: 'enough', insufficient: 'not enough', numerous: 'many', majority: 'most',
  minimum: 'least', maximum: 'most', initial: 'first', final: 'last', prior: 'before',
  assist: 'help', assists: 'helps', assisted: 'helped', attempt: 'try', attempts: 'tries',
  determine: 'find out', determines: 'finds out', determined: 'found out',
  indicate: 'show', indicates: 'shows', indicated: 'showed',
  construct: 'build', constructs: 'builds', constructed: 'built',
  modify: 'change', modifies: 'changes', modified: 'changed',
  observe: 'watch', observes: 'watches', observed: 'watched',
  component: 'part', components: 'parts', parameter: 'setting', parameters: 'settings',
  facilitate: 'help', facilitates: 'helps', implement: 'do', implements: 'does',
  magnitude: 'size', velocity: 'speed', accelerate: 'speed up', decelerate: 'slow down',
  equivalent: 'the same', equivalently: 'the same way', proportional: 'in step with',
  necessitate: 'need', necessitates: 'needs', necessitated: 'needed',
  predominant: 'main', predominantly: 'mostly', constitutes: 'is', comprises: 'is made of',
  exhibits: 'shows', exhibit: 'show', 'the reason that': 'why', 'the reason why': 'why',
  subsequent: 'next', eliminate: 'remove', eliminates: 'removes',
  transmit: 'send', transmits: 'sends', transmitted: 'sent',
  generate: 'make', generates: 'makes', generated: 'made',
  'in addition': 'also', 'as well as': 'and', 'a variety of': 'different',
  'in order to': 'to', 'due to the fact that': 'because', 'at this point in time': 'now',
  'in the event that': 'if', 'for the purpose of': 'to', 'with regard to': 'about',
  'a large number of': 'many', 'the majority of': 'most', 'prior to': 'before',
  'subsequent to': 'after', 'in close proximity to': 'near',
};

/** Letter pairs dyslexic readers most often transpose or mirror. */
export const CONFUSABLE_PAIRS: [string, string][] = [
  ['b', 'd'], ['p', 'q'], ['n', 'u'], ['m', 'w'], ['b', 'p'], ['d', 'q'],
  ['f', 't'], ['i', 'j'], ['g', 'q'], ['h', 'n'], ['a', 'o'], ['e', 'c'],
];

/** Words whose spellings trip decoders: irregular / non-phonetic. */
export const IRREGULAR_WORDS = new Set<string>([
  'the','of','one','two','said','says','was','were','come','some','done','gone','who','whose','what','where',
  'there','their','they','eye','friend','people','should','would','could','through','though','enough','rough',
  'tough','laugh','cough','island','listen','castle','knee','knife','know','write','wrong','wrap','sign','gnome',
  'business','beautiful','because','height','weight','eight','straight','answer','February','Wednesday','colonel',
  'yacht','queue','receipt','subtle','debt','doubt','rhythm','science','scissors','ocean','special','sure','sugar',
]);

/** Greek and Latin morphemes common in school science and maths.
 *  A learner who knows "photo- = light" can attack photosynthesis,
 *  photograph and photon without being told each one separately, which is
 *  the whole argument for teaching morphology over word lists. */
export const MORPHEMES: Record<string, string> = {
  photo: 'light', synth: 'put together', syn: 'together', chloro: 'green',
  phyll: 'leaf', bio: 'life', geo: 'earth', thermo: 'heat', therm: 'heat',
  hydro: 'water', aqua: 'water', aero: 'air', astro: 'star', helio: 'sun',
  micro: 'very small', macro: 'very large', mega: 'very large', milli: 'a thousandth',
  centi: 'a hundredth', kilo: 'a thousand', deci: 'a tenth', nano: 'a billionth',
  mono: 'one', uni: 'one', bi: 'two', di: 'two', tri: 'three', quad: 'four',
  penta: 'five', hexa: 'six', oct: 'eight', deca: 'ten', poly: 'many', multi: 'many',
  semi: 'half', hemi: 'half', equi: 'equal', iso: 'equal', omni: 'all',
  sub: 'under', super: 'above', trans: 'across', inter: 'between', intra: 'inside',
  circum: 'around', peri: 'around', tele: 'far away', ex: 'out of', de: 'away from',
  re: 'again', pre: 'before', post: 'after', anti: 'against', contra: 'against',
  co: 'together', con: 'together', com: 'together', dis: 'apart', non: 'not', un: 'not',
  meter: 'measure', metry: 'measuring', scope: 'to look at', graph: 'something written or drawn',
  gram: 'something written', logy: 'the study of', ology: 'the study of',
  sphere: 'a ball shape', cycle: 'a circle or a repeat', phon: 'sound', vis: 'see',
  vid: 'see', dict: 'say', duct: 'lead', duc: 'lead', port: 'carry', struct: 'build',
  scrib: 'write', script: 'write', spec: 'look', tract: 'pull', ject: 'throw',
  form: 'shape', fract: 'break', frag: 'break', rupt: 'burst', mit: 'send', miss: 'send',
  vert: 'turn', vers: 'turn', mob: 'move', mot: 'move', mov: 'move', gen: 'produce',
  cyte: 'cell', cyto: 'cell', derm: 'skin', card: 'heart', neuro: 'nerve',
  osis: 'a process', ase: 'an enzyme', ose: 'a sugar', itis: 'swelling',
};
